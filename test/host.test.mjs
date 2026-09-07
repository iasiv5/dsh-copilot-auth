import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tgz } from "./helpers.mjs";
import plugin from "../src/host.mjs";

function makeCtx(script = {}, opts = {}) {
  const ctx = {
    routes: [],
    webServer: { register: (r) => ctx.routes.push(r) },
    authorization: { beginCalls: [], begin: async (req) => {
      ctx.authorization.beginCalls.push(req);
      for (const n of ctx.script.notices) req.interaction.notify(n);
      if (ctx.script.prompt) await req.interaction.prompt(ctx.script.prompt);
      if (ctx.script.reject) throw new Error(ctx.script.reject);
      return { status: "authorized" };
    } },
    credentials: { describeRecord: async (k) => ({ configured: ctx.script.record?.[k] !== undefined }),
                   readRecord: async (k) => ctx.script.record?.[k],
                   deleteRecordCalls: [], deleteRecord: async (k) => { ctx.credentials.deleteRecordCalls.push(k); ctx.script.record = {}; return true; } },
    settings: { mutateCalls: [], describeCalls: 0,
                mutate: async (ns, ops, expectedRevision) => {
                  ctx.settings.mutateCalls.push({ ns, ops, expectedRevision });
                  if (ctx.script.mutateError) throw new Error(ctx.script.mutateError);
                  if (ctx.script.mutateConflict || (expectedRevision !== undefined && expectedRevision !== (ctx.script.revision ?? 1))) {
                    const e = new Error(`settings conflict: expected ${expectedRevision}, actual ${ctx.script.revision ?? 1}`);
                    e.code = "SETTINGS_CONFLICT";
                    throw e;
                  }
                  if (ctx.script.applyOps) {
                    const doc = (ctx.script.userLayer ??= {});
                    for (const op of ops) {
                      let node = doc;
                      for (let i = 0; i < op.path.length - 1; i++) node = (node[op.path[i]] ??= {});
                      if (op.op === "set") node[op.path.at(-1)] = op.value;
                      else delete node[op.path.at(-1)];
                    }
                    ctx.script.revision = (ctx.script.revision ?? 1) + 1;
                  }
                },
                describe: () => {
                  ctx.settings.describeCalls++;
                  if (ctx.script.descriptor === null) return [];
                  const revision = ctx.script.revision ?? 1;
                  // 并发写注入钩子：describe 返回后、mutate 前让 revision 过期
                  if (ctx.script.bumpAfterDescribe) ctx.script.revision = revision + 1;
                  return [{ ns: "llm-pi-ai", revision, user: ctx.script.userLayer }];
                } },
    llm: { listModels: async () => ctx.script.served ?? [] },
    script: { notices: [], record: {}, configured: undefined, userLayer: undefined, ...script },
    opts,
  };
  ctx.settings.get = () => ctx.script.configured;
  // 默认隔离：未显式注入 stateFile 时给临时文件，测试绝不触碰真实 ~/.dsh 状态
  let bootDone;
  ctx.bootReady = new Promise((r) => { bootDone = r; });
  const effectiveOpts = { stateFile: join(mkdtempSync(join(tmpdir(), "host-state-")), "state.json"), onBootDone: bootDone, ...opts };
  ctx.opts = effectiveOpts;
  plugin.apply(ctx, effectiveOpts);
  return ctx;
}
const handler = (ctx, suffix) => ctx.routes.find((r) => r.path.endsWith(suffix)).handler;
const call = async (h, req = {}) => { const res = { code: 0, body: null,
  writeHead(c) { this.code = c; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ headers: { host: "127.0.0.1:8815", ...req.headers }, method: req.method ?? "GET", body: req.body }, res);
  return res; };

test("插件身份与路由注册", () => {
  const ctx = makeCtx();
  assert.equal(plugin.name, "copilot-auth");
  assert.deepEqual(plugin.inject, ["webServer", "authorization", "credentials", "settings", "llm"]);
  assert.ok(ctx.routes.every((r) => r.kind === "exact"), "六条路由必须都是 exact");
  assert.deepEqual(ctx.routes.map((r) => r.path).sort(),
    ["/copilot-auth/logout", "/copilot-auth/refresh/apply", "/copilot-auth/refresh/preview", "/copilot-auth/start", "/copilot-auth/state", "/copilot-auth/status"]);
});

test("start 调起 begin：key/method 正确，企业域名提问自动答空串", async () => {
  const ctx = makeCtx();
  ctx.script.prompt = { kind: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" };
  const res = await call(handler(ctx, "/start"), { method: "POST", headers: { origin: "http://127.0.0.1:8815" } });
  assert.equal(res.code, 202);
  const [req] = ctx.authorization.beginCalls;
  assert.equal(req.key, "llm-pi-ai/github-copilot");
  assert.equal(req.method, "oauth");
});

test("unexpected prompt 使 attempt 失败并进入 failed 态", async () => {
  const ctx = makeCtx();
  ctx.script.prompt = { kind: "secret", message: "Enter API key" };
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const res = await call(handler(ctx, "/state"));
  assert.equal(res.body.status, "failed");
  assert.ok(res.body.error.includes("unexpected prompt"));
});

test("begin 以 cancelled resolve 时映射为 failed（AuthorizationOutcome 双态）", async () => {
  const ctx = makeCtx();
  ctx.authorization.begin = async () => ({ status: "cancelled" });
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const res = await call(handler(ctx, "/state"));
  assert.equal(res.body.status, "failed");
  assert.match(res.body.error, /取消/);
});

test("设备码 notice 经 state 可见；running 期间二次 start 返回 409", async () => {
  const ctx = makeCtx();
  ctx.authorization.begin = async (req) => { for (const n of ctx.script.notices) req.interaction.notify(n); await new Promise(() => {}); }; // 送达 notices 后永不完成（评审 Agent 注 2026-09-03：原 override 丢弃 interaction，notice 永不进 attempt，断言必挂——原样实测 7 条仅 6 绿）
  ctx.script.notices = [{ message: "Enter this code", url: "https://github.com/login/device", code: "ABCD-1234" }];
  await call(handler(ctx, "/start"), { method: "POST" });
  const state = await call(handler(ctx, "/state"));
  assert.equal(state.body.status, "running");
  assert.deepEqual(state.body.notices.at(-1), { message: "Enter this code", url: "https://github.com/login/device", code: "ABCD-1234" });
  const again = await call(handler(ctx, "/start"), { method: "POST" });
  assert.equal(again.code, 409);
});

test("status 与 logout 操作固定 credential key", async () => {
  const ctx = makeCtx();
  ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant" } };
  assert.equal((await call(handler(ctx, "/status"))).body.configured, true);
  const out = await call(handler(ctx, "/logout"), { method: "POST" });
  assert.equal(out.body.ok, true);
  assert.deepEqual(ctx.credentials.deleteRecordCalls, ["llm-pi-ai/github-copilot"]);
  const again = await call(handler(ctx, "/logout"), { method: "POST" }); // 评审 Agent 注 2026-09-03：补 v1-A2 的「无记录时同样 ok:true」断言（首次 logout 已清空 record，此即无记录形态）
  assert.equal(again.body.ok, true);
});

test("authorized 后把发现的可用模型写入用户 settings 的模型目录（目录外 id 排除）", async () => {
  const ctx = makeCtx();
  ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.6-luna", "gpt-5.4", "gemini-3.8-flash"] } } };
  ctx.script.served = [{ id: "gpt-5.6-luna" }, { id: "gpt-5.4" }]; // 运行时目录未描述 gemini-3.8-flash
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 1);
  const { ns, ops } = ctx.settings.mutateCalls[0];
  assert.equal(ns, "llm-pi-ai");
  assert.deepEqual(ops[0].path, ["providers", "github-copilot", "models"]);
  assert.deepEqual(ops[0].value, [{ id: "gpt-5.6-luna" }, { id: "gpt-5.4" }]);
});

test("挂载不再同步模型目录——即使已登录也不触碰用户 settings", async () => {
  const ctx = makeCtx({ record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.4", "gemini-3.8-flash"] } } }, served: [{ id: "gpt-5.4" }] });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 0);
});

test("登录时目录已存在（含空列表）则不写入——用户精简不被重置", async () => {
  const custom = [{ id: "gpt-5.4" }, { id: "claude-opus-4.8" }, { id: "gemini-3.7-flash" }];
  for (const models of [custom, []]) {
    const ctx = makeCtx({
      record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.4", "gemini-3.8-flash"] } } },
      configured: { providers: { "github-copilot": { models } } },
    });
    await call(handler(ctx, "/start"), { method: "POST" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx.settings.mutateCalls.length, 0, `models=${JSON.stringify(models)} 应视作用户所有`);
  }
});

test("仅 modelOverrides 也算用户所有，登录不写入", async () => {
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.4"] } } },
    configured: { providers: { "github-copilot": { modelOverrides: { "gpt-5.4": { displayName: "我的 GPT" } } } } },
  });
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 0);
});

test("模型同步失败时经 /status 暴露 syncError", async () => {
  const ctx = makeCtx();
  ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } } };
  ctx.script.served = [{ id: "gpt-5.4" }];
  ctx.settings.mutate = async () => { throw new Error("validation boom"); };
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const res = await call(handler(ctx, "/status"));
  assert.equal(res.body.syncError, "validation boom");
});

test("跨站 Origin 拒绝 403，同源/无 Origin 放行", async () => {
  const ctx = makeCtx();
  assert.equal((await call(handler(ctx, "/start"), { method: "POST", headers: { origin: "http://evil.example" } })).code, 403);
  assert.equal((await call(handler(ctx, "/state"))).code, 200);
});

// ==================== Task 8: refresh preview/apply ====================

const FIXTURE_0844 = readFileSync(new URL("./fixtures/catalog-0844.json", import.meta.url), "utf8");
const INDIVIDUAL_TOKEN = "tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;";
const GPTB_ENTRY = { id: "gpt-b", api: "openai-completions", provider: "github-copilot", contextWindow: 200000, maxTokens: 8192 };
const OVERLAY = { "openai-completions": { "gpt-b": GPTB_ENTRY } };
const TGZ_ENTRY_PATH = "package/dist/providers/data/github-copilot.json";

// 搭一个与生产同构的假安装树：node_modules/@earendil-works/pi-ai/{package.json,dist/...}
// （catalogFile 与 version 同根解析，R3-8）
function makeInstall() {
  const dir = mkdtempSync(join(tmpdir(), "host-"));
  const root = join(dir, "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(join(root, "dist", "providers", "data"), { recursive: true });
  const catalogFile = join(root, "dist", "providers", "data", "github-copilot.json");
  writeFileSync(catalogFile, FIXTURE_0844);
  const packageJsonFile = join(root, "package.json");
  writeFileSync(packageJsonFile, JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.84.4" }));
  const stateFile = join(dir, "state.json");
  const overlayFile = join(dir, "overlay.json");
  writeFileSync(overlayFile, JSON.stringify(OVERLAY, null, 2) + "\n");
  return { dir, root, catalogFile, packageJsonFile, stateFile, overlayFile };
}

// mock Response：body 异步可迭代 + cancel（catalog-fetch 的 readCapped 需要）+ json()
function streamRes(body, status = 200) {
  const chunks = (Array.isArray(body) ? body : [body]).map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), "utf8")));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `STATUS-${status}`,
    headers: { get: () => null },
    json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
    text: async () => Buffer.concat(chunks).toString("utf8"),
    body: {
      async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
      cancel: async () => {},
    },
  };
}

function npmOk(latestCatalog) {
  const buf = tgz([{ name: TGZ_ENTRY_PATH, content: JSON.stringify(latestCatalog) }]);
  const integrity = "sha512-" + createHash("sha512").update(buf).digest("base64");
  const meta = JSON.stringify({
    "dist-tags": { latest: "0.85.1" },
    versions: { "0.85.1": { dist: { tarball: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz", integrity } } },
  });
  return { buf, integrity, meta };
}

// fetchImpl 路由：/models → live 行为；含 @earendil-works/pi-ai 且非 .tgz → metadata；.tgz → tarball
function fetchImplFor({ live = "401", npm = "fail", latestCatalog = null, modelsData = null } = {}) {
  const npmData = npm === "ok" ? npmOk(latestCatalog) : null;
  return async (url) => {
    if (url.endsWith("/models")) {
      if (live === "401") return streamRes({}, 401);
      return streamRes(JSON.stringify({ data: modelsData ?? [] }), 200);
    }
    if (url.includes("@earendil-works/pi-ai")) {
      if (npm === "fail") throw new Error("npm unreachable");
      if (url.includes(".tgz")) return streamRes([npmData.buf]);
      return streamRes(npmData.meta);
    }
    throw new Error("unexpected fetch: " + url);
  };
}

const pickerOn = (id) => ({ id, model_picker_enabled: true });

test("preview live 成功：source=live、catalogSource=latest、removed 含已失效、digest 组与 skipped 就位", async () => {
  const inst = makeInstall();
  const latest = {
    "openai-completions": {
      "gpt-a": JSON.parse(FIXTURE_0844)["openai-completions"]["gpt-a"],
      "gpt-b": GPTB_ENTRY,
      bad: { id: "bad", api: "openai-completions", provider: "openai", contextWindow: 1, maxTokens: 1 },
    },
  };
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { access: INDIVIDUAL_TOKEN, availableModelIds: ["gpt-a"] } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }, { id: "gpt-dead" }] } } },
  }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile,
       fetchImpl: fetchImplFor({ live: "ok", npm: "ok", latestCatalog: latest, modelsData: [pickerOn("gpt-a"), pickerOn("gpt-b"), pickerOn("ghost")] }) });
  const res = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: {} });
  assert.equal(res.code, 200);
  const b = res.body;
  assert.equal(b.ok, true);
  assert.equal(b.source, "live");
  assert.equal(b.catalogSource, "latest");
  assert.equal(b.catalogError, null);
  assert.deepEqual(b.removed, ["gpt-dead"], "已失效模型进 removed");
  assert.deepEqual(b.added, ["gpt-b"]);
  assert.deepEqual(b.kept, ["gpt-a"]);
  assert.deepEqual(b.target, ["gpt-a", "gpt-b"], "ghost 目录不可解析被排除");
  assert.equal(b.skipped.length, 1, "非法条目进 skipped 不静默");
  assert.equal(b.skipped[0].id, "bad");
  for (const k of ["settings", "available", "catalog", "remote"]) {
    assert.match(b.digests[k], /^[0-9a-f]{64}$/, `digests.${k} 必须是 sha256 hex`);
  }
});

test("preview 回退：/models 401 → source=cache；npm 失败 → catalogSource=local + catalogError，且不读 overlay（R3-3）", async () => {
  const inst = makeInstall();
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { access: INDIVIDUAL_TOKEN, availableModelIds: ["gpt-a", "gpt-b"] } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }] } } },
  }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile,
       fetchImpl: fetchImplFor({ live: "401", npm: "fail" }) });
  const res = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: {} });
  assert.equal(res.code, 200);
  assert.equal(res.body.source, "cache");
  assert.equal(res.body.catalogSource, "local");
  assert.ok(res.body.catalogError, "catalogError 非空");
  assert.deepEqual(res.body.added, [], "overlay 独有的 gpt-b 不得出现在 local 模式的 added（R3-3）");
  assert.deepEqual(res.body.target, ["gpt-a"]);
});

test("preview：npm 成功但目录无新增仍 catalogSource=latest（Y3，UI 不靠空数组猜）", async () => {
  const inst = makeInstall();
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a"] } } },
  }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile,
       fetchImpl: fetchImplFor({ npm: "ok", latestCatalog: JSON.parse(FIXTURE_0844) }) });
  const res = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: {} });
  assert.equal(res.body.catalogSource, "latest");
  assert.ok(Array.isArray(res.body.skipped));
});

test("preview/apply：未知 mode → 400 invalid-mode", async () => {
  const inst = makeInstall();
  const ctx = makeCtx({}, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  const p = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "nightly" } });
  assert.equal(p.code, 400);
  assert.equal(p.body.error, "invalid-mode");
  const a = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "nightly", digests: {} } });
  assert.equal(a.code, 400);
  assert.equal(a.body.error, "invalid-mode");
});

test("R2-5 三件套：latest preview→overlay apply 409；overlay→overlay 成功；overlay 文件变化 409", async () => {
  const inst = makeInstall();
  const opts = { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor({ npm: "ok", latestCatalog: JSON.parse(FIXTURE_0844) }) };
  const script = { record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a", "gpt-b"] } } } };
  // ① latest preview → mode:overlay apply → 409（digest 与 mode 严格对应）
  let ctx = makeCtx(script, opts);
  const p1 = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: {} });
  const a1 = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p1.body.digests } });
  assert.equal(a1.code, 409);
  assert.equal(a1.body.error, "preview-stale");
  // ② overlay preview → overlay apply → 成功
  ctx = makeCtx(script, opts);
  const p2 = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  assert.equal(p2.body.catalogSource, "overlay");
  const a2 = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p2.body.digests } });
  assert.equal(a2.code, 200);
  // ③ overlay preview 后 overlayFile 内容变化 → 409（换全新安装树避免前两步状态干扰）
  const inst2 = makeInstall();
  ctx = makeCtx(script, { ...opts, catalogFile: inst2.catalogFile, stateFile: inst2.stateFile, overlayFile: inst2.overlayFile });
  const p3 = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  writeFileSync(inst2.overlayFile, JSON.stringify({ "openai-completions": { "gpt-b": GPTB_ENTRY, "gpt-c": { ...GPTB_ENTRY, id: "gpt-c" } } }) + "\n");
  const a3 = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p3.body.digests } });
  assert.equal(a3.code, 409);
  assert.equal(a3.body.error, "preview-stale");
});

test("R3-2 字段级漂移：preview 后改 displayName / override 值 → 409 且目录与 state 零写入", async () => {
  const inst = makeInstall();
  const before = readFileSync(inst.catalogFile);
  const script = {
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a", "gpt-b"] } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }], modelOverrides: { "gpt-a": { displayName: "X" } } } } },
  };
  const opts = { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() };
  const ctx = makeCtx(script, opts);
  const p = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  // ① 同 id 条目改 displayName → settings digest 必须漂移
  ctx.script.userLayer = { providers: { "github-copilot": { models: [{ id: "gpt-a", displayName: "改名" }], modelOverrides: { "gpt-a": { displayName: "X" } } } } };
  let a = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p.body.digests } });
  assert.equal(a.code, 409);
  assert.deepEqual(readFileSync(inst.catalogFile), before, "目录零写入");
  assert.equal(existsSync(inst.stateFile), false, "state 零写入");
  // ② 仅改 override 键的值 → 同样 409
  ctx.script.userLayer = { providers: { "github-copilot": { models: [{ id: "gpt-a" }], modelOverrides: { "gpt-a": { displayName: "Y" } } } } };
  a = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p.body.digests } });
  assert.equal(a.code, 409);
  assert.deepEqual(readFileSync(inst.catalogFile), before);
  assert.equal(existsSync(inst.stateFile), false);
});

test("raw 视图 digest 区分「键缺失」与「显式空数组/空对象」（R3-2 canonical）", async () => {
  const inst = makeInstall();
  const opts = { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() };
  const script = { record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a"] } } } };
  const absent = await call(handler(makeCtx(script, opts), "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  const emptyModels = await call(handler(makeCtx({ ...script, userLayer: { providers: { "github-copilot": { models: [] } } } }, opts), "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  const emptyOverrides = await call(handler(makeCtx({ ...script, userLayer: { providers: { "github-copilot": { modelOverrides: {} } } } }, opts), "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  assert.notEqual(absent.body.digests.settings, emptyModels.body.digests.settings, "models 缺失 vs [] 必须漂移");
  assert.notEqual(absent.body.digests.settings, emptyOverrides.body.digests.settings, "modelOverrides 缺失 vs {} 必须漂移");
});

test("apply 正常：journal 终态/目录补丁/state/appliedProvenance 全链路", async () => {
  const inst = makeInstall();
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a", "gpt-b", "ghost"] } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a", displayName: "定制" }, { id: "gpt-dead" }], modelOverrides: { "gpt-dead": { maxTokens: 1024 } } } } },
  }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  const p = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  assert.deepEqual(p.body.customizationReset, { modelEntryIds: ["gpt-a"], modelOverrideIds: ["gpt-dead"] }, "customizationReset 名单（Y3-6）");
  const a = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p.body.digests } });
  assert.equal(a.code, 200);
  assert.deepEqual(a.body, { ok: true, restartRequired: true });
  // 目录含新条目且旧条目原样（只增不更新）
  const catalog = JSON.parse(readFileSync(inst.catalogFile, "utf8"));
  assert.deepEqual(catalog["openai-completions"]["gpt-b"], GPTB_ENTRY);
  assert.deepEqual(catalog["openai-completions"]["gpt-a"], JSON.parse(FIXTURE_0844)["openai-completions"]["gpt-a"]);
  // state 全链路
  const state = JSON.parse(readFileSync(inst.stateFile, "utf8"));
  assert.equal(state.activated, true);
  assert.equal(state.restartState.reason, "refresh");
  assert.equal(state.journal.phase, "catalog-committed-needs-restart");
  assert.deepEqual(state.journal.pendingOverlay, OVERLAY, "pendingOverlay 为 catalog-shaped 增量（R3-4）");
  assert.equal(state.journal.appliedAgainstPiAiVersion, "0.84.4");
  assert.deepEqual(state.journal.targetIds, ["gpt-a", "gpt-b"], "ghost 目录不可解析不入 target");
  assert.deepEqual(state.appliedOverlay, OVERLAY, "appliedOverlay 与 catalog 同构、无插件私有字段");
  assert.deepEqual(state.appliedProvenance, {
    sourcePiAiVersion: "0.85.1", integrity: null, appliedAgainstPiAiVersion: "0.84.4", catalogSchemaVersion: 1,
  });
  assert.equal(state.lastError, null);
});

test("apply digest 漂移（篡改 settings digest）→ 409 preview-stale，目录与 stateFile 均未变", async () => {
  const inst = makeInstall();
  const before = readFileSync(inst.catalogFile);
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a"] } } },
  }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  const p = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  const a = await call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: { ...p.body.digests, settings: "0".repeat(64) } } });
  assert.equal(a.code, 409);
  assert.equal(a.body.error, "preview-stale");
  assert.deepEqual(readFileSync(inst.catalogFile), before);
  assert.equal(existsSync(inst.stateFile), false);
});

test("apply 并发：mutex 串行，第二个因 catalog 已变 409；500 后后续 apply 仍执行（settled-tail 不中毒）", async () => {
  const inst = makeInstall();
  const script = { record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-a", "gpt-b"] } } } };
  const opts = { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() };
  const ctx = makeCtx(script, opts);
  const p = await call(handler(ctx, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  const [r1, r2] = await Promise.all([
    call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p.body.digests } }),
    call(handler(ctx, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p.body.digests } }),
  ]);
  assert.equal(r1.code, 200, "第一个 apply 成功");
  assert.equal(r2.code, 409, "第二个重算 digest：catalog 已被第一个改写 → preview-stale");
  // settled-tail 不中毒：第一个 apply 500（删 package.json 使版本解析失败）后第二个仍执行
  const inst2 = makeInstall();
  const ctx2 = makeCtx(script, { ...opts, catalogFile: inst2.catalogFile, stateFile: inst2.stateFile, overlayFile: inst2.overlayFile });
  const p2v = await call(handler(ctx2, "/refresh/preview"), { method: "POST", body: { mode: "overlay" } });
  renameSync(inst2.packageJsonFile, inst2.packageJsonFile + ".bak");
  const f1 = await call(handler(ctx2, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p2v.body.digests } });
  assert.equal(f1.code, 500, "版本解析失败 → 500，journal 不留（失败在 write-ahead 之前）");
  assert.equal(existsSync(inst2.stateFile), false);
  renameSync(inst2.packageJsonFile + ".bak", inst2.packageJsonFile);
  const f2 = await call(handler(ctx2, "/refresh/apply"), { method: "POST", body: { mode: "overlay", digests: p2v.body.digests } });
  assert.equal(f2.code, 200, "mutex 拒绝后不中毒，后续任务照常执行");
});

// ==================== Task 9: 启动序列（prepared 恢复 / 激活门 / 自愈 / 真 CAS） ====================

import { freshState, createJournal, advanceJournal, restartMarker } from "../src/state.mjs";
import { digest } from "../src/catalog.mjs";

const tick = () => {}; // 保留占位：Task 9 起一律 await ctx.bootReady（确定性等待 boot settle）
const loadStateFile = (f) => JSON.parse(readFileSync(f, "utf8"));

function overlayEntry() {
  return JSON.parse(JSON.stringify(OVERLAY)); // 防跨用例串改
}

// 构造 journal（默认 prepared；committed=true 时推进到 catalog-committed-needs-restart）
function makeJournal(inst, { committed = false, baseline, targetIds = ["gpt-a", "gpt-b"], against = "0.84.4" } = {}) {
  const j = createJournal({
    settingsBaseline: baseline,
    targetIds,
    pendingOverlay: overlayEntry(),
    appliedAgainstPiAiVersion: against,
    catalogBaselineDigest: digest(readFileSync(inst.catalogFile)),
    patchedCatalogDigest: digest(Buffer.from(JSON.stringify(mergeFixture(), null, 2) + "\n", "utf8")),
    source: { kind: "overlay", piAiVersion: "0.85.1", integrity: null },
  });
  return committed ? advanceJournal(j) : j;
}

// fixture + overlay 合并后的目录对象
function mergeFixture() {
  return { "openai-completions": { ...JSON.parse(FIXTURE_0844)["openai-completions"], "gpt-b": overlayEntry()["openai-completions"]["gpt-b"] } };
}

// 把已打补丁的目录写到安装树（模拟「目录已 rename」的崩溃现场）
function writePatchedCatalog(inst) {
  writeFileSync(inst.catalogFile, JSON.stringify(mergeFixture(), null, 2) + "\n");
}

const BASELINE = { modelsPresent: true, models: [{ id: "gpt-a" }], modelOverridesPresent: false, modelOverrides: null };
const baselineUserLayer = () => ({ providers: { "github-copilot": { models: [{ id: "gpt-a" }] } } }); // 工厂：applyOps 用例会就地改写 userLayer，禁止共享可变夹具
const PROVENANCE_0844 = { sourcePiAiVersion: "0.85.1", integrity: null, appliedAgainstPiAiVersion: "0.84.4", catalogSchemaVersion: 1 };

test("R2-1 注入点①：journal=prepared 已写、目录未 rename → 启动幂等补全，本 boot 不同步 settings", async () => {
  const inst = makeInstall();
  const state = { ...freshState(), journal: makeJournal(inst, { baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer() }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const catalog = JSON.parse(readFileSync(inst.catalogFile, "utf8"));
  assert.ok(catalog["openai-completions"]["gpt-b"], "目录补齐 pendingOverlay");
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.activated, true, "恢复先于激活门：activated=false 也补全");
  assert.equal(after.journal.phase, "catalog-committed-needs-restart");
  assert.equal(after.restartState.reason, "refresh");
  assert.equal(ctx.settings.mutateCalls.length, 0, "本 boot 写了目录 → 禁止 settings 同步");
});

test("R2-1 注入点②：目录已 rename、appliedOverlay/activated 未存 → 启动幂等补全并推进", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst); // 目录已提交
  const state = { ...freshState(), journal: makeJournal(inst, { baseline: BASELINE }) }; // activated=false, appliedOverlay={}
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer(), applyOps: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.activated, true);
  assert.deepEqual(after.appliedOverlay, overlayEntry(), "appliedOverlay 补存");
  assert.equal(after.journal, null, "目录上 boot 已就绪 → CAS 同 boot 消费 journal");
  assert.equal(ctx.settings.mutateCalls.length, 1, "目录在上一崩溃 boot 已写入，本 boot 同步安全");
  assert.deepEqual(ctx.script.userLayer.providers["github-copilot"].models, [{ id: "gpt-a" }, { id: "gpt-b" }]);
});

test("R2-1 注入点③：activated 已存但相位未推进 → 启动推进并消费", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer(), applyOps: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.journal, null);
  assert.equal(after.activated, true);
  assert.equal(after.lastError, null);
  assert.equal(ctx.settings.mutateCalls.length, 1);
});

test("R3-1：prepared 恢复先过兼容 gate——跨版本 → prepared-incompatible，目录零写入、journal 保留", async () => {
  const inst = makeInstall();
  const before = readFileSync(inst.catalogFile);
  const state = { ...freshState(), journal: makeJournal(inst, { baseline: BASELINE, against: "0.84.4" }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer() }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor(), piAiVersion: "0.85.0" });
  await ctx.bootReady;
  assert.deepEqual(readFileSync(inst.catalogFile), before, "目录零写入");
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.journal.phase, "prepared", "journal 保留可重试");
  assert.match(after.lastError, /prepared-incompatible/);
  const status = await call(handler(ctx, "/status"));
  assert.match(status.body.refresh.lastError, /prepared-incompatible/);
});

test("R9：未激活 + 本地目录缺条目 + 无 journal → 启动不写目录、不落状态文件", async () => {
  const inst = makeInstall();
  const before = readFileSync(inst.catalogFile);
  const ctx = makeCtx({}, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.deepEqual(readFileSync(inst.catalogFile), before);
  assert.equal(existsSync(inst.stateFile), false);
});

test("R7：已激活 + appliedOverlay 条目缺失 + 同基线 → 自愈重放，restartState=self-heal，本 boot 不同步 settings", async () => {
  const inst = makeInstall();
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844 };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer() }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const catalog = JSON.parse(readFileSync(inst.catalogFile, "utf8"));
  assert.ok(catalog["openai-completions"]["gpt-b"], "自愈重放写目录");
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.restartState.reason, "self-heal");
  assert.equal(ctx.settings.mutateCalls.length, 0, "本 boot 禁止 settings 同步（R7）");
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.refresh.pendingRestart, true);
});

test("R2-2 + R3-5：跨 boot restartState 清除——单独存在时不触碰 describe/mutate", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, restartState: restartMarker("self-heal", digest(overlayEntry())) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const before = readFileSync(inst.catalogFile);
  const ctx = makeCtx({ userLayer: baselineUserLayer() }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.deepEqual(readFileSync(inst.catalogFile), before, "本 boot 无目录写入");
  assert.equal(ctx.settings.describeCalls, 0, "restartState 单独存在时不得调 describe");
  assert.equal(ctx.settings.mutateCalls.length, 0);
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.restartState, null, "expected entries 已在目录 → 仅清 restartState");
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.refresh.pendingRestart, false);
});

test("兼容 gate：跨版本且条目已原生存在 → 空操作；有缺失 → self-heal-incompatible 不写安装树", async () => {
  // ① 条目已原生存在 → 空操作
  let inst = makeInstall();
  writePatchedCatalog(inst);
  let state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844 };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  let ctx = makeCtx({}, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor(), piAiVersion: "0.85.0" });
  await ctx.bootReady;
  let after = loadStateFile(inst.stateFile);
  assert.equal(after.lastError, null, "条目已原生存在 → 空操作不报错");
  // ② 有缺失 → 不写安装树 + self-heal-incompatible
  inst = makeInstall();
  const before = readFileSync(inst.catalogFile);
  state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844 };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  ctx = makeCtx({}, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor(), piAiVersion: "0.85.0" });
  await ctx.bootReady;
  assert.deepEqual(readFileSync(inst.catalogFile), before, "跨版本有缺失不写安装树");
  after = loadStateFile(inst.stateFile);
  assert.match(after.lastError, /self-heal-incompatible/);
  const status = await call(handler(ctx, "/status"));
  assert.match(status.body.refresh.lastError, /self-heal-incompatible/);
});

test("R2-3 真 CAS：baseline 匹配 → mutate 携带 expectedRevision=7 并消费 journal", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer(), revision: 7, applyOps: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 1);
  const { ns, ops, expectedRevision } = ctx.settings.mutateCalls[0];
  assert.equal(ns, "llm-pi-ai");
  assert.equal(expectedRevision, 7, "真 CAS：携带 describe 读到的 revision");
  assert.deepEqual(ops, [
    { op: "set", path: ["providers", "github-copilot", "models"], value: [{ id: "gpt-a" }, { id: "gpt-b" }] },
    { op: "unset", path: ["providers", "github-copilot", "modelOverrides"] },
  ]);
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.journal, null, "成功消费 journal");
  assert.equal(after.lastError, null);
});

test("R2-3：mutate 抛 SETTINGS_CONFLICT → journal 保留、lastError=conflict、状态不删除", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer(), revision: 7, mutateConflict: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.journal.phase, "catalog-committed-needs-restart", "冲突保留 journal");
  assert.match(after.lastError, /conflict/);
});

test("并发写注入：describe 之后 revision 过期 → 本次同步被拒绝且不覆盖", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const before = baselineUserLayer();
  const ctx = makeCtx({ userLayer: baselineUserLayer(), revision: 7, bumpAfterDescribe: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 1);
  assert.equal(ctx.settings.mutateCalls[0].expectedRevision, 7);
  assert.deepEqual(ctx.script.userLayer, before, "冲突时用户层未被覆盖");
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.journal.phase, "catalog-committed-needs-restart");
  assert.match(after.lastError, /conflict/);
});

test("R2-4：仅 modelOverrides 的初始配置 → 同一 mutate 内 set models + unset modelOverrides", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const baseline = { modelsPresent: false, models: null, modelOverridesPresent: true, modelOverrides: { "gpt-a": { displayName: "X" } } };
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline, targetIds: ["gpt-a", "gpt-b"] }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: { providers: { "github-copilot": { modelOverrides: { "gpt-a": { displayName: "X" } } } } }, applyOps: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 1);
  const ops = ctx.settings.mutateCalls[0].ops;
  assert.deepEqual(ops, [
    { op: "set", path: ["providers", "github-copilot", "models"], value: [{ id: "gpt-a" }, { id: "gpt-b" }] },
    { op: "unset", path: ["providers", "github-copilot", "modelOverrides"] },
  ], "models 与 modelOverrides 在同一 mutate 内 set/unset");
  const route = ctx.script.userLayer.providers["github-copilot"];
  assert.deepEqual(route.models, [{ id: "gpt-a" }, { id: "gpt-b" }]);
  assert.equal(route.modelOverrides, undefined, "modelOverrides 被 unset");
  assert.equal(loadStateFile(inst.stateFile).journal, null);
});

test("Y1：empty target → mutate value 为 []", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const baseline = { modelsPresent: true, models: [{ id: "gpt-dead" }], modelOverridesPresent: false, modelOverrides: null };
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline, targetIds: [] }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-dead" }] } } }, applyOps: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 1);
  assert.deepEqual(ctx.settings.mutateCalls[0].ops[0], { op: "set", path: ["providers", "github-copilot", "models"], value: [] });
});

test("幂等：当前配置已等于 target 形状 → 消费 journal 不再 mutate", async () => {
  const inst = makeInstall();
  writePatchedCatalog(inst);
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }, { id: "gpt-b" }] } } } }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 0, "已是 target → 幂等消费不 mutate");
  assert.equal(loadStateFile(inst.stateFile).journal, null);
});

test("Y2-3 语义前置：目录被无害重格式化（字节变、条目全在）→ whole-file digest 不符也照常同步", async () => {
  const inst = makeInstall();
  // 重格式化：4 空格缩进（与 makeJournal 计算的 patchedCatalogDigest 不符）
  writeFileSync(inst.catalogFile, JSON.stringify(mergeFixture(), null, 4) + "\n");
  const journal = makeJournal(inst, { committed: true, baseline: BASELINE }); // patchedCatalogDigest 基于 2 空格
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, journal };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer(), applyOps: true }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 1, "语义前置（targetIds 全部可解析）通过即同步，不看 whole-file digest");
  assert.equal(loadStateFile(inst.stateFile).journal, null);
});

test("targetIds 目录不可解析 → 语义前置拒绝同步，journal 保留", async () => {
  // 现实场景：local 模式 apply（addedOverlay 为空）后目录文件被手动还原——
  // appliedOverlay 空 → 自愈无事可做，CAS 语义前置必须拦住不可解析的 targetIds
  const inst = makeInstall(); // 目录未打补丁：gpt-b 不可解析
  const state = { ...freshState(), activated: true, appliedOverlay: {}, appliedProvenance: PROVENANCE_0844, journal: makeJournal(inst, { committed: true, baseline: BASELINE }) };
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({ userLayer: baselineUserLayer() }, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  assert.equal(ctx.settings.mutateCalls.length, 0);
  const after = loadStateFile(inst.stateFile);
  assert.equal(after.journal.phase, "catalog-committed-needs-restart");
  assert.match(after.lastError, /unresolvable/);
});

test("state-corrupt：损坏状态隔离，/status.refresh.lastError=state-corrupt 且激活丢失（自愈停用）", async () => {
  const inst = makeInstall();
  writeFileSync(inst.stateFile, "{corrupted");
  const ctx = makeCtx({}, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.refresh.lastError, "state-corrupt");
  assert.equal(status.body.refresh.activated, false);
  const quarantined = readdirSync(inst.dir).filter((n) => n.includes(".corrupt-"));
  assert.equal(quarantined.length, 1, "损坏文件改名留存");
});

test("/status.refresh 扩展字段：activated/pendingRestart/phase/piAiVersion/catalogDigest/catalogFile", async () => {
  const inst = makeInstall();
  const state = { ...freshState(), activated: true, appliedOverlay: overlayEntry(), appliedProvenance: PROVENANCE_0844, restartState: restartMarker("refresh", digest(overlayEntry())) };
  writePatchedCatalog(inst);
  writeFileSync(inst.stateFile, JSON.stringify(state, null, 2) + "\n");
  const ctx = makeCtx({}, { catalogFile: inst.catalogFile, stateFile: inst.stateFile, overlayFile: inst.overlayFile, fetchImpl: fetchImplFor() });
  await ctx.bootReady;
  const status = await call(handler(ctx, "/status"));
  const r = status.body.refresh;
  assert.equal(r.activated, true);
  assert.equal(r.pendingRestart, false, "boot 已清 restartState");
  assert.equal(r.phase, null);
  assert.equal(r.lastError, null);
  assert.equal(r.piAiVersion, "0.84.4");
  assert.equal(r.catalogFile, inst.catalogFile);
  const expectedDigest = createHash("sha256").update(readFileSync(inst.catalogFile)).digest("hex");
  assert.equal(r.catalogDigest, expectedDigest, "catalogDigest 绑定实际加载副本（R4-5）");
});
