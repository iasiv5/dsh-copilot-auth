// T1：requestJson HTTP/JSON 解析与错误脱敏 + shared 路由契约。
import test from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "../src/client-http.mjs";
import { CREDENTIAL_KEY, ROUTE_PREFIX, PROTOCOL_VERSION, routes } from "../src/shared.mjs";

function res({ status = 200, body = "", contentType = "application/json" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

test("200 JSON ok:true → ok 且无 error", async () => {
  const r = await requestJson(async () => res({ body: JSON.stringify({ ok: true, x: 1 }) }), "/u");
  assert.equal(r.ok, true);
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body.x, 1);
  assert.equal(r.error, undefined);
});

test("502 HTML 代理页 → bad-gateway，保留状态码且不透传页面内容", async () => {
  const html = "<html><body>Bad Gateway & secret ghp_abcdef123456</body></html>";
  const r = await requestJson(async () => res({ status: 502, body: html, contentType: "text/html" }), "/u");
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 502);
  assert.equal(r.error.messageKey, "bad-gateway");
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes("<html"));
  assert.ok(!serialized.includes("Bad Gateway"));
  assert.ok(!serialized.includes("ghp_"));
});

test("空响应体 → bad-response", async () => {
  const r = await requestJson(async () => res({ body: "" }), "/u");
  assert.equal(r.ok, false);
  assert.equal(r.error.messageKey, "bad-response");
  assert.equal(r.httpStatus, 200);
});

test("坏 JSON（无 HTML 头）→ bad-response", async () => {
  const r = await requestJson(async () => res({ body: "{not json" }), "/u");
  assert.equal(r.error.messageKey, "bad-response");
  assert.equal(r.httpStatus, 200);
});

test("网络拒绝 → network-error 且 httpStatus=null", async () => {
  const r = await requestJson(async () => { throw new Error("ECONNREFUSED secret"); }, "/u");
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, null);
  assert.equal(r.error.messageKey, "network-error");
  assert.ok(!JSON.stringify(r).includes("ECONNREFUSED"));
});

test("409 {ok:false,error:'already running'} → errorCode 原样保留（安全形状）", async () => {
  const r = await requestJson(async () => res({ status: 409, body: JSON.stringify({ ok: false, error: "already running" }) }), "/u");
  assert.equal(r.ok, false);
  assert.equal(r.error.details.errorCode, "already running");
  assert.equal(r.error.details.httpStatus, 409);
});

test("含疑似 token 的错误串 → 脱敏为 http-error，秘密不进 details", async () => {
  const secret = "ghp_SecretToken123+/abc";
  const r = await requestJson(async () => res({ status: 500, body: JSON.stringify({ ok: false, error: secret }) }), "/u");
  assert.equal(r.error.details.errorCode, "http-error");
  assert.ok(!JSON.stringify(r).includes(secret));
});

test("写调用失败不自动重发（fetch 恰好调用一次）", async () => {
  let calls = 0;
  await requestJson(async () => { calls++; return res({ status: 502, body: "x", contentType: "text/html" }); }, "/u");
  assert.equal(calls, 1);
});

test("shared 契约：前缀/凭据键不变，新路由与协议版本就位", () => {
  assert.equal(CREDENTIAL_KEY, "llm-pi-ai/github-copilot");
  assert.equal(ROUTE_PREFIX, "/copilot-auth");
  assert.equal(PROTOCOL_VERSION, 2);
  const r = routes();
  assert.deepEqual(r.start, "/copilot-auth/start");
  assert.deepEqual(r.state, "/copilot-auth/state");
  assert.deepEqual(r.status, "/copilot-auth/status");
  assert.deepEqual(r.logout, "/copilot-auth/logout");
  assert.deepEqual(r.cancel, "/copilot-auth/cancel");
  assert.deepEqual(r.refreshPreview, "/copilot-auth/refresh/preview");
  assert.deepEqual(r.refreshApply, "/copilot-auth/refresh/apply");
  assert.deepEqual(r.refreshRetire, "/copilot-auth/refresh/retire");
  assert.equal(Object.keys(r).length, 8);
});
