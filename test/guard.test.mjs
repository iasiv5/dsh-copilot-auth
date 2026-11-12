// 路由信任栅栏单元测试：官方 requestRejection 守卫式委派 + 本地 Host/同源回落栅栏。
// 背景（2026-11-12 PR 评审同源问题排查）：原 guard 仅校验 Origin===Host，
// DNS rebinding（Origin 与 Host 均为攻击者域）可穿透；现官方指纹围栏优先，
// 服务缺席回落「Host ∈ loopback∪宿主信任名单 + sec-fetch-site + Origin/Host」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuard } from "../src/host.mjs";

const res = () => ({ code: 0, body: null, writeHead(c) { this.code = c; }, end(b) { this.body = b ? JSON.parse(b) : null; } });
const req = (over = {}) => ({ headers: { host: "127.0.0.1:3080", ...over }, method: "POST", url: "/copilot-auth/start" });
const noCtx = {}; // 无 get：官方服务缺席 → 回落本地栅栏

test("本地栅栏：loopback Host + 同源 → 放行；method 不符 → 405", () => {
  const g = createGuard(noCtx);
  const r1 = res();
  assert.equal(g(req(), r1, "POST"), true);
  assert.equal(r1.code, 0);
  const r2 = res();
  assert.equal(g(req(), r2, "GET"), false);
  assert.equal(r2.code, 405);
});

test("本地栅栏：DNS rebinding 形态（Origin=Host=攻击者域）→ 403", () => {
  const g = createGuard(noCtx);
  const r = res();
  const ok = g(req({ host: "attacker.example", origin: "http://attacker.example", "sec-fetch-site": "same-origin" }), r, "POST");
  assert.equal(ok, false);
  assert.equal(r.code, 403);
  assert.equal(r.body?.error, "forbidden origin");
});

test("本地栅栏：跨站 sec-fetch-site → 403；Host 缺失 → 403", () => {
  const g = createGuard(noCtx);
  const r1 = res();
  assert.equal(g(req({ "sec-fetch-site": "cross-site" }), r1, "POST"), false);
  assert.equal(r1.code, 403);
  const r2 = res();
  assert.equal(g({ headers: {}, method: "POST" }, r2, "POST"), false);
  assert.equal(r2.code, 403);
});

test("官方围栏优先：requestRejection 拒绝 → 官方状态码原样下发", () => {
  const ctx = { get: () => ({ requestRejection: () => 401 }) };
  const g = createGuard(ctx);
  const r = res();
  assert.equal(g(req(), r, "POST"), false);
  assert.equal(r.code, 401);
});

test("官方围栏放行 → 仍要求本地栅栏通过（纵深防御）", () => {
  const ctx = { get: () => ({ requestRejection: () => undefined }) };
  const g = createGuard(ctx);
  const r1 = res();
  assert.equal(g(req(), r1, "POST"), true);
  const r2 = res();
  assert.equal(g(req({ host: "attacker.example", origin: "http://attacker.example" }), r2, "POST"), false);
  assert.equal(r2.code, 403);
});

test("官方服务缺席 → 回落放行；requestRejection 抛错 → fail-closed 403", () => {
  const gAbsent = createGuard({ get: () => undefined });
  const r1 = res();
  assert.equal(gAbsent(req(), r1, "POST"), true);
  const gThrow = createGuard({ get: () => ({ requestRejection: () => { throw new Error("boom"); } }) });
  const r2 = res();
  assert.equal(gThrow(req(), r2, "POST"), false);
  assert.equal(r2.code, 403);
});

test("宿主信任名单：非 loopback 但在 trustedHosts → 放行", () => {
  const ctx = { get: (name) => (name === "webStartup" ? { trustedHosts: ["ob-harness.example"] } : undefined) };
  const g = createGuard(ctx);
  const r = res();
  const ok = g(req({ host: "ob-harness.example", origin: "https://ob-harness.example", "sec-fetch-site": "same-origin" }), r, "POST");
  assert.equal(ok, true);
});
