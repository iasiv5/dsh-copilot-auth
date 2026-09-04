import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/host.mjs";

function makeCtx() {
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
                   deleteRecordCalls: [], deleteRecord: async (k) => { ctx.credentials.deleteRecordCalls.push(k); ctx.script.record = {}; return true; } },
    script: { notices: [], record: {} },
  };
  plugin.apply(ctx, {});
  return ctx;
}
const handler = (ctx, suffix) => ctx.routes.find((r) => r.path.endsWith(suffix)).handler;
const call = async (h, req = {}) => { const res = { code: 0, body: null,
  writeHead(c) { this.code = c; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ headers: { host: "127.0.0.1:8815", ...req.headers }, method: req.method ?? "GET" }, res);
  return res; };

test("插件身份与路由注册", () => {
  const ctx = makeCtx();
  assert.equal(plugin.name, "copilot-auth");
  assert.deepEqual(plugin.inject, ["webServer", "authorization", "credentials"]);
  assert.ok(ctx.routes.every((r) => r.kind === "exact"), "四条路由必须都是 exact");
  assert.deepEqual(ctx.routes.map((r) => r.path).sort(),
    ["/copilot-auth/logout", "/copilot-auth/start", "/copilot-auth/state", "/copilot-auth/status"]);
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

test("跨站 Origin 拒绝 403，同源/无 Origin 放行", async () => {
  const ctx = makeCtx();
  assert.equal((await call(handler(ctx, "/start"), { method: "POST", headers: { origin: "http://evil.example" } })).code, 403);
  assert.equal((await call(handler(ctx, "/state"))).code, 200);
});
