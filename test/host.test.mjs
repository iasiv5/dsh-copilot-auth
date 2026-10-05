import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { tgz } from "./helpers.mjs";
import plugin from "../src/host.mjs";
import { PROTOCOL_VERSION } from "../src/shared.mjs";

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
                  const row = { ns: "llm-pi-ai", revision, user: ctx.script.userLayer };
                  // 0.1.7+ describe 行带 value（base+user 合成）；仅脚本显式给值时模拟
                  if (ctx.script.valueLayer !== undefined) row.value = ctx.script.valueLayer;
                  return [row];
                } },
    llm: { listModels: async () => ctx.script.served ?? [] },
    script: { notices: [], record: {}, userLayer: undefined, valueLayer: undefined, ...script },
    opts,
  };
  // T3 起 host 依赖 profileContext 解析 scope（缺省 503）；默认提供临时 profile，
  // script.noProfileContext=true 时省略以覆盖 known=false 降级分支；
  // opts.profileContext 可共享目录（boot 恢复测试的第二实例）。
  if (!ctx.script.noProfileContext) {
    ctx.profileContext = opts.profileContext ?? { name: "test", dir: join(mkdtempSync(join(tmpdir(), "host-profile-")), "profile") };
  }
  // 0.1.7 起 settings.get 已移除，mock 不再提供 get：readConfiguredRoute 走 describe
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
  await h({ headers: { host: "127.0.0.1:8815", ...req.headers }, method: req.method ?? "GET", body: req.body, url: req.url }, res);
  return res; };

test("插件身份与路由注册", () => {
  const ctx = makeCtx();
  assert.equal(plugin.name, "copilot-auth");
  assert.deepEqual(plugin.inject, ["webServer", "authorization", "credentials", "settings", "llm"]);
  assert.ok(ctx.routes.every((r) => r.kind === "exact"), "路由必须都是 exact");
  assert.deepEqual(ctx.routes.map((r) => r.path).sort(),
    ["/copilot-auth/cancel", "/copilot-auth/logout", "/copilot-auth/refresh/apply", "/copilot-auth/refresh/preview", "/copilot-auth/refresh/retire", "/copilot-auth/start", "/copilot-auth/state", "/copilot-auth/status"]);
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

test("begin 以 cancelled resolve 时映射为待核实并锁存风险（D-01 软撤回，不再映射 failed）", async () => {
  const ctx = makeCtx();
  ctx.authorization.begin = async () => ({ status: "cancelled" });
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const res = await call(handler(ctx, "/state"));
  assert.equal(res.body.status, "withdrawal-pending-unverified");
  assert.ok(res.body.riskLatch, "cancelled 源结果也置风险锁存");
});

test("设备码 notice 经 state 可见；waiting 期间二次 start 返回 409", async () => {
  const ctx = makeCtx();
  ctx.authorization.begin = async (req) => { for (const n of ctx.script.notices) req.interaction.notify(n); await new Promise(() => {}); }; // 送达 notices 后永不完成（评审 Agent 注 2026-09-03：原 override 丢弃 interaction，notice 永不进 attempt，断言必挂——原样实测 7 条仅 6 绿）
  ctx.script.notices = [{ message: "Enter this code", url: "https://github.com/login/device", code: "ABCD-1234" }];
  await call(handler(ctx, "/start"), { method: "POST" });
  const state = await call(handler(ctx, "/state"));
  assert.equal(state.body.status, "waiting");
  assert.deepEqual(state.body.notices.at(-1), { message: "Enter this code", url: "https://github.com/login/device", code: "ABCD-1234" });
  const again = await call(handler(ctx, "/start"), { method: "POST" });
  assert.equal(again.code, 409);
});

test("status 与 logout 操作固定 credential key；静止态退出可用并真实删除", async () => {
  const ctx = makeCtx();
  ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant" } };
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.configured, true);
  assert.equal(status.body.authorization.credential, "present");
  // v1.2.10：静止态（无尝试/无锁存）退出可用；能力位自 v1.2.11 起只含 logout
  assert.deepEqual(status.body.authorization.capabilities, { logout: true });
  const out = await call(handler(ctx, "/logout"), { method: "POST" });
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, { ok: true });
  assert.deepEqual(ctx.credentials.deleteRecordCalls, ["llm-pi-ai/github-copilot"]);
  const after = await call(handler(ctx, "/status"));
  assert.equal(after.body.configured, false, "退出后凭据不在（删后核实）");
});

test("logout 安全门：进行中尝试与风险锁存期拒绝，status capabilities 如实降级", async () => {
  // 进行中尝试：POST /start 后 attempt starting → logout 409
  const ctx = makeCtx();
  ctx.authorization.begin = () => new Promise(() => {});
  await call(handler(ctx, "/start"), { method: "POST" });
  const statusLive = await call(handler(ctx, "/status"));
  assert.equal(statusLive.body.authorization.capabilities.logout, false, "尝试进行中退出不可用");
  const out = await call(handler(ctx, "/logout"), { method: "POST" });
  assert.equal(out.code, 409);
  assert.equal(out.body.error, "already running");
  assert.deepEqual(ctx.credentials.deleteRecordCalls, []);
  // 风险锁存：cancelled 结局设锁存 → logout 409 logout-unsafe
  const ctx2 = makeCtx();
  ctx2.authorization.begin = async () => ({ status: "cancelled" });
  await call(handler(ctx2, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const out2 = await call(handler(ctx2, "/logout"), { method: "POST" });
  assert.equal(out2.code, 409);
  assert.equal(out2.body.error, "logout-unsafe");
  assert.deepEqual(ctx2.credentials.deleteRecordCalls, []);
});

test("scope known=false（缺 profileContext）：写路由 503，status 带 scopeAvailable:false 且不伪成功", async () => {
  const ctx = makeCtx({ noProfileContext: true });
  assert.equal((await call(handler(ctx, "/start"), { method: "POST" })).code, 503);
  assert.equal((await call(handler(ctx, "/cancel"), { method: "POST" })).code, 503);
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.code, 200);
  assert.equal(status.body.refresh.scopeAvailable, false);
});

test("authorized 后把发现的可用模型写入用户 settings 的模型目录（目录外 id 排除）", async () => {
  const ctx = makeCtx();
  // 凭据在授权完成时才物化：start 的 already-configured 门要求开始时无凭据
  ctx.authorization.begin = async () => {
    ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.6-luna", "gpt-5.4", "gemini-3.8-flash"] } } };
    return { status: "authorized" };
  };
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

test("登录时目录已存在（含空列表）则不写入——用户精简不被重置（describe user 层，0.1.5- 形态）", async () => {
  const custom = [{ id: "gpt-5.4" }, { id: "claude-opus-4.8" }, { id: "gemini-3.7-flash" }];
  for (const models of [custom, []]) {
    const ctx = makeCtx({ userLayer: { providers: { "github-copilot": { models } } } });
    ctx.authorization.begin = async () => {
      ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.4", "gemini-3.8-flash"] } } };
      return { status: "authorized" };
    };
    await call(handler(ctx, "/start"), { method: "POST" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctx.settings.mutateCalls.length, 0, `models=${JSON.stringify(models)} 应视作用户所有`);
  }
});

test("登录时目录已存在于 describe value 层则不写入（0.1.7+ 合成视图形态）", async () => {
  const ctx = makeCtx({
    valueLayer: { providers: { "github-copilot": { models: [{ id: "gpt-5.4" }] } } },
  });
  ctx.authorization.begin = async () => {
    ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.4", "gemini-3.8-flash"] } } };
    return { status: "authorized" };
  };
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 0, "value 层已配置的目录应视作用户所有");
});

test("仅 modelOverrides 也算用户所有，登录不写入", async () => {
  const ctx = makeCtx({
    userLayer: { providers: { "github-copilot": { modelOverrides: { "gpt-5.4": { displayName: "我的 GPT" } } } } },
  });
  ctx.authorization.begin = async () => {
    ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { type: "oauth", availableModelIds: ["gpt-5.4"] } } };
    return { status: "authorized" };
  };
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 0);
});

test("模型同步失败时经 /status 暴露 syncError", async () => {
  const ctx = makeCtx();
  ctx.script.served = [{ id: "gpt-5.4" }];
  ctx.settings.mutate = async () => { throw new Error("validation boom"); };
  ctx.authorization.begin = async () => {
    ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } } };
    return { status: "authorized" };
  };
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

test("已有凭据时 start 拒绝 409 already-configured：不调 begin（Q21 初始授权条件）", async () => {
  const ctx = makeCtx();
  ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } } };
  const res = await call(handler(ctx, "/start"), { method: "POST" });
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "already-configured");
  assert.deepEqual(ctx.authorization.beginCalls, []);
});

// ==================== T4: 首次填充 handoff 保护 ====================

test("HANDOFF_撤回后晚到的 authorized：凭据事实可见但 settings 零写入", async () => {
  const ctx = makeCtx({ served: [{ id: "gpt-5.4" }] });
  let settle;
  ctx.authorization.begin = () => new Promise((r) => { settle = (v) => { ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } } }; r(v); }; });
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 5));
  const cancelRes = await call(handler(ctx, "/cancel"), { method: "POST" }); // V2（mock 无 cancel → unavailable）
  assert.equal(cancelRes.body.withdrawalDelivery, "unavailable");
  settle({ status: "authorized" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 0, "晚到成功不得生成配置意图");
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.configured, true, "凭据事实仍如实展示");
  const state = await call(handler(ctx, "/state"));
  assert.equal(state.body.status, "authorized");
  assert.equal(state.body.staleIntent, true);
});

test("HANDOFF_取数 await 期间意图再变：提交前复核失败，不 mutate", async () => {
  const ctx = makeCtx({ served: [{ id: "gpt-5.4" }] });
  let settle;
  let releaseRecord;
  ctx.authorization.begin = () => new Promise((r) => { settle = (v) => { ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } } }; r(v); }; });
  ctx.credentials.readRecord = () => new Promise((r) => { releaseRecord = r; }); // 取数挂起，制造竞态窗口
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 5));
  settle({ status: "authorized" });
  await new Promise((r) => setTimeout(r, 5)); // runSync 进入并 await readRecord
  await call(handler(ctx, "/cancel"), { method: "POST" }); // 取数期间 V2
  releaseRecord({ kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 0, "提交前重核失败必须跳过写入");
});

test("HANDOFF_正常授权（版本未变）：填充恰好一次", async () => {
  const ctx = makeCtx({ served: [{ id: "gpt-5.4" }] });
  ctx.authorization.begin = async () => {
    ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant", payload: { availableModelIds: ["gpt-5.4"] } } };
    return { status: "authorized" };
  };
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.mutateCalls.length, 1);
  assert.deepEqual(ctx.settings.mutateCalls[0].ops[0].value, [{ id: "gpt-5.4" }]);
});


// ==================== T10: refresh v2（preview/apply/retire/status 协议） ====================

const FIXTURE_0844 = readFileSync(new URL("./fixtures/catalog-0844.json", import.meta.url), "utf8");
const INDIVIDUAL_TOKEN = "tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;";
const GPTB_ENTRY = { id: "gpt-b", api: "openai-completions", provider: "github-copilot", contextWindow: 200000, maxTokens: 8192 };
const OVERLAY = { "openai-completions": { "gpt-b": GPTB_ENTRY } };
const TGZ_ENTRY_PATH = "package/dist/providers/data/github-copilot.json";

// 搭一个与生产同构的假安装树：node_modules/@earendil-works/pi-ai/{package.json,dist/...}
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

// fetchImpl 路由：/models → live 行为；pi-ai metadata/tarball → npm 行为
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

function latestWithGptb() {
  return {
    "openai-completions": {
      "gpt-a": JSON.parse(FIXTURE_0844)["openai-completions"]["gpt-a"],
      "gpt-b": GPTB_ENTRY,
    },
  };
}

// 标准可写安装 ctx：live 账号 [gpt-a,gpt-b]、npm latest 含 gpt-b、用户已配置 gpt-a
function makeRefreshCtx(script = {}, opts = {}) {
  const inst = makeInstall();
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { access: INDIVIDUAL_TOKEN, availableModelIds: ["gpt-a", "gpt-b"] } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }] } } },
    served: [{ id: "gpt-a" }, { id: "gpt-b" }],
    ...script,
  }, {
    catalogFile: inst.catalogFile,
    stateFile: inst.stateFile,
    overlayFile: inst.overlayFile,
    fetchImpl: fetchImplFor({ live: "ok", npm: "ok", latestCatalog: latestWithGptb(), modelsData: [pickerOn("gpt-a"), pickerOn("gpt-b")] }),
    ...opts,
  });
  ctx.inst = inst;
  return ctx;
}

const post = (ctx, suffix, body) => call(handler(ctx, suffix), { method: "POST", body });

test("REFRESH_V2_协议门禁：缺 protocolVersion → 400 upgrade-required；未知 catalogSource → 400", async () => {
  const ctx = makeRefreshCtx();
  const noProto = await post(ctx, "/refresh/preview", { operation: "manage" });
  assert.equal(noProto.code, 400);
  assert.equal(noProto.body.error, "upgrade-required");
  const badSource = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", catalogSource: "bogus" });
  assert.equal(badSource.code, 400);
  assert.equal(badSource.body.error, "invalid-catalog-source");
  const badOp = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "mirror" });
  assert.equal(badOp.code, 400);
  assert.equal(badOp.body.error, "invalid-operation");
});

test("REFRESH_V3_preview live：证据/来源/差异/rows/新投影字段就位；默认选择＝健康在列", async () => {
  const ctx = makeRefreshCtx();
  const res = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage" });
  assert.equal(res.code, 200);
  const b = res.body;
  assert.equal(b.evidence.source, "live");
  assert.equal(b.catalogSource, "latest");
  assert.deepEqual(b.diff.selectedIds, ["gpt-a"], "默认目标＝在列∩(账号∩可解析)");
  assert.deepEqual(b.diff.added, [], "默认零追加");
  assert.deepEqual(b.diff.removed, []);
  assert.ok(b.operationId && b.previewId && b.expiresAt);
  assert.deepEqual(b.diff.writeSet, { catalogEntries: true, models: false, modelOverrides: false, overridesUnclearable: false });
  assert.deepEqual(b.rows.map((r) => [r.id, r.status]), [["gpt-b", "addable"], ["gpt-a", "listed"]], "rows 三态就位");
  assert.equal(b.hadModels, true);
  assert.deepEqual(b.overridesMeta, { rawPresent: false, clearable: false, inheritedOnly: false });
  assert.equal(b.catalogNewEntries, 1);
  assert.equal(b.clearOverrides, false);
  assert.equal("candidates" in b.diff, false, "v3 投影不再有 candidates");
});

test("REFRESH_V2_apply file 通道：当次零 settings 写、pending-restart、目录落地；boot 后 applied", async () => {
  const ctx = makeRefreshCtx({ applyOps: true });
  const pv = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: ["gpt-a", "gpt-b"] });
  const ap = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv.body.previewId, operationId: pv.body.operationId });
  assert.equal(ap.code, 200);
  assert.equal(ap.body.result.status, "pending-restart");
  assert.equal(ctx.settings.mutateCalls.length, 0, "file 通道配置提交延迟到 boot");
  const disk = JSON.parse(readFileSync(ctx.inst.catalogFile, "utf8"));
  assert.ok("gpt-b" in disk["openai-completions"], "目录已原子落地");
  // 模拟重启：第二实例共享 profile 目录与安装树，bootReady 完成延迟提交
  const ctx2 = makeCtx({
    applyOps: true,
    record: { "llm-pi-ai/github-copilot": { kind: "grant" } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }] } } },
    served: [{ id: "gpt-a" }, { id: "gpt-b" }],
  }, {
    catalogFile: ctx.inst.catalogFile,
    stateFile: ctx.inst.stateFile,
    overlayFile: ctx.inst.overlayFile,
    profileContext: ctx.profileContext,
    fetchImpl: fetchImplFor({ live: "401", npm: "fail" }),
  });
  await ctx2.bootReady;
  assert.equal(ctx2.settings.mutateCalls.length, 1, "boot 按基线 CAS 提交一次");
  const status = await call(handler(ctx2, "/status"));
  assert.equal(status.body.refresh.lastResult.status, "applied");
  assert.equal(status.body.refresh.pendingRestart, false);
  assert.deepEqual(ctx2.script.userLayer.providers["github-copilot"].models, [{ id: "gpt-a" }, { id: "gpt-b" }]);
});

test("REFRESH_V2_幂等：同 operationId 重复 apply 返回已知结果且不重复执行", async () => {
  const ctx = makeRefreshCtx({ applyOps: true });
  const pv = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: ["gpt-b"] });
  const first = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv.body.previewId, operationId: pv.body.operationId });
  assert.equal(first.body.result.status, "pending-restart");
  const again = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv.body.previewId, operationId: pv.body.operationId });
  assert.equal(again.code, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.result.status, "pending-restart");
});

test("REFRESH_V2_忙与 retire：activeOperation 未终结时新 apply 423；retire 闭环后放行", async () => {
  const ctx = makeRefreshCtx({ applyOps: true });
  const pv1 = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: ["gpt-b"] });
  await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv1.body.previewId, operationId: pv1.body.operationId });
  const pv2 = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage" });
  const busy = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv2.body.previewId, operationId: pv2.body.operationId });
  assert.equal(busy.code, 423);
  assert.equal(busy.body.error, "resource-busy");
  const retire = await post(ctx, "/refresh/retire", { protocolVersion: PROTOCOL_VERSION, operationId: pv1.body.operationId });
  assert.equal(retire.code, 200);
  assert.equal(retire.body.result.status, "intent-retired");
  const after = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv2.body.previewId, operationId: pv2.body.operationId });
  assert.equal(after.code, 200, "旧意图显式结束后新 apply 放行");
});

test("REFRESH_V2_status 三态：active／last／unknown；字段齐备且 GET 不写探针", async () => {
  const ctx = makeRefreshCtx({ applyOps: true });
  const pv = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: ["gpt-b"] });
  const ap = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv.body.previewId, operationId: pv.body.operationId });
  assert.equal(ap.body.result.status, "pending-restart");
  const active = await call(handler(ctx, "/status"), { url: `/copilot-auth/status?operationId=${pv.body.operationId}` });
  assert.equal(active.body.operation.query, "active");
  const unknown = await call(handler(ctx, "/status"), { url: "/copilot-auth/status?operationId=never" });
  assert.equal(unknown.body.operation.query, "unknown");
  await post(ctx, "/refresh/retire", { protocolVersion: PROTOCOL_VERSION, operationId: pv.body.operationId });
  const last = await call(handler(ctx, "/status"), { url: `/copilot-auth/status?operationId=${pv.body.operationId}` });
  assert.equal(last.body.operation.query, "last");
  assert.equal(last.body.operation.lastResult.status, "intent-retired");
  // 字段齐备（Q23：通道分类来自启动缓存，GET 不执行写探针）
  const dataDir = join(ctx.inst.root, "dist", "providers", "data");
  const before = readdirSync(dataDir).sort().join(",");
  const s1 = await call(handler(ctx, "/status"));
  const s2 = await call(handler(ctx, "/status"));
  assert.equal(readdirSync(dataDir).sort().join(","), before, "GET status 不产生/残留任何探针文件");
  const rf = s2.body.refresh;
  for (const k of ["scopeAvailable", "catalogWritable", "catalogMode", "blockedReason", "registryInjected", "registryVia", "registryInstanceMismatch", "catalogFile", "settingsNotServed", "activeOperation", "lastResult", "pendingRestart", "legacyStateDetected", "piAiVersion", "catalogDigest"]) {
    assert.ok(k in rf, `status.refresh.${k} 必须存在`);
  }
  assert.equal(rf.catalogMode, "file");
  assert.equal(rf.catalogWritable, true);
  assert.equal(rf.scopeAvailable, true);
  assert.equal(rf.piAiVersion, "0.84.4");
});

test("REFRESH_V2_registry 通道：只读安装树 apply 当次注入＋提交＋验证，无需重启", async () => {
  const inst = makeInstall();
  const ctx = makeCtx({
    applyOps: true,
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { access: INDIVIDUAL_TOKEN, availableModelIds: ["gpt-a", "gpt-b"] } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }] } } },
    served: [{ id: "gpt-a" }, { id: "gpt-b" }],
  }, {
    catalogFile: inst.catalogFile,
    stateFile: inst.stateFile,
    overlayFile: inst.overlayFile,
    writableProbe: () => false, // 只读安装树（desktop asar 形态）
    injectRegistry: async () => ({ ok: true, injected: ["gpt-b"], present: [], via: "bare" }),
    fetchImpl: fetchImplFor({ live: "ok", npm: "ok", latestCatalog: latestWithGptb(), modelsData: [pickerOn("gpt-a"), pickerOn("gpt-b")] }),
  });
  const pv = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: ["gpt-b"] });
  const ap = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: pv.body.previewId, operationId: pv.body.operationId });
  assert.equal(ap.code, 200);
  assert.equal(ap.body.result.status, "applied");
  assert.equal(ctx.settings.mutateCalls.length, 1);
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.refresh.lastResult.status, "applied");
  assert.equal(status.body.refresh.pendingRestart, false);
});

test("REFRESH_V3_空目标：默认空选择（全漂移）放行；显式 [] 未确认 → 409；确认后落显式空列表", async () => {
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant", payload: { access: INDIVIDUAL_TOKEN } } },
    userLayer: { providers: { "github-copilot": { models: [{ id: "gpt-a" }] } } },
  }, {
    catalogFile: makeInstall().catalogFile,
    fetchImpl: fetchImplFor({ live: "ok", modelsData: [] }), // 账号权威空集合；npm 失败回 local
  });
  const drift = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage" });
  assert.equal(drift.code, 200, "默认空选择（全漂移）放行，弹窗必须能打开（M01）");
  assert.deepEqual(drift.body.diff.removed, [{ id: "gpt-a", reason: "not-in-account" }]);
  const gated = await post(ctx, "/refresh/apply", { protocolVersion: PROTOCOL_VERSION, previewId: drift.body.previewId, operationId: drift.body.operationId });
  assert.equal(gated.code, 409);
  assert.equal(gated.body.error, "removals-need-live", "移除类变更在 local 目录下被 apply 门拒绝（路由级 409 兜底）");
  const denied = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: [] });
  assert.equal(denied.code, 409);
  assert.equal(denied.body.error, "empty-target-unconfirmed");
  const ok = await post(ctx, "/refresh/preview", { protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: [], confirmEmpty: true });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.diff.targetView.modelsPresent, true, "显式空列表＝已配置（防首次填充回填）");
  assert.deepEqual(ok.body.diff.targetView.models, []);
});

test("REFRESH_V2_state-corrupt：损坏 v2 状态经 /status.refresh.lastError 暴露且原件留存", async () => {
  const ctx = makeRefreshCtx();
  await ctx.bootReady; // 先让 boot 序列落定，再注入损坏（避免竞态）
  const stateFile = join(ctx.profileContext.dir, "copilot-auth", "refresh-state.json");
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, "{ broken");
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.refresh.lastError, "state-corrupt");
  assert.ok(readdirSync(dirname(stateFile)).some((f) => f.includes(".corrupt-")), "原件改名留存");
});

test("REFRESH_V2_legacy：旧 v1 全局状态文件 → legacyStateDetected（只读，不消费）", async () => {
  const inst = makeInstall();
  writeFileSync(inst.stateFile, JSON.stringify({ version: 1, activated: true, journal: { phase: "prepared" } }));
  const ctx = makeCtx({
    record: { "llm-pi-ai/github-copilot": { kind: "grant" } },
  }, {
    catalogFile: inst.catalogFile,
    stateFile: inst.stateFile,
    overlayFile: inst.overlayFile,
    fetchImpl: fetchImplFor({ live: "401", npm: "fail" }),
  });
  await ctx.bootReady;
  const status = await call(handler(ctx, "/status"));
  assert.equal(status.body.refresh.legacyStateDetected, true);
  assert.equal(status.body.refresh.activated, false, "不自动继承 v1 激活");
});

test("方法守卫：GET 打 POST 路由 / POST 打 GET 路由 → 405 method not allowed", async () => {
  const ctx = makeCtx();
  assert.equal((await call(handler(ctx, "/start"), { method: "GET" })).code, 405);
  assert.equal((await call(handler(ctx, "/status"), { method: "POST" })).code, 405);
  assert.equal((await call(handler(ctx, "/refresh/apply"), { method: "GET" })).code, 405);
});
