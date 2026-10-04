// T5：浏览器授权状态机——串行、代次保护、409 共同尝试、退避、60s 手动、dispose。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAuthFlow } from "../src/auth-flow.mjs";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const delays = [];
  return {
    now: () => now,
    delays,
    setTimeout: (fn, ms) => { const id = ++seq; delays.push(ms); timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    advance: (ms) => {
      now += ms;
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, { fn, at }] of [...timers]) {
          if (at <= now) { timers.delete(id); fn(); progressed = true; }
        }
      }
    },
    pending: () => timers.size,
  };
}

const jsonResponse = (spec) => ({
  status: spec.status ?? 200,
  ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
  headers: { get: () => spec.contentType ?? "application/json" },
  text: async () => spec.body ?? "{}",
});

// fetch 路由：按 URL 配置响应；defer 请求入队，release 可逐个放行并覆写响应
function makeFetch() {
  const responses = new Map();
  const calls = [];
  const defers = new Map(); // url -> [releaseFn...]
  const fetchImpl = async (url) => {
    calls.push(url);
    const spec = responses.get(url) ?? {};
    if (spec.defer) return await new Promise((resolve) => {
      const list = defers.get(url) ?? [];
      list.push((override) => resolve(jsonResponse(override ?? spec)));
      defers.set(url, list);
    });
    return jsonResponse(spec);
  };
  const release = (url, override) => {
    const list = defers.get(url) ?? [];
    const r = list.shift();
    if (r) r(override);
  };
  return { fetchImpl, respond: (url, spec) => responses.set(url, spec), calls, release };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const snapLive = (status = "waiting") => JSON.stringify({ attemptId: "a1", status, riskLatch: null });

test("慢 init 不覆盖新操作：init 的迟到结果被代次丢弃", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/status", { defer: true, body: JSON.stringify({ configured: false }) });
  http.respond("/copilot-auth/state", { body: snapLive("waiting") });
  http.respond("/copilot-auth/start", { status: 202, body: JSON.stringify({ ok: true, attemptId: "a2" }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  void flow.init();
  await flow.start(); // 新操作取代 init（generation 递增）
  await tick();
  http.release("/copilot-auth/status"); // init 的慢响应现在才返回
  await tick();
  assert.ok(!states.some((s) => s.phase === "idle"), "迟到的 init 不得把页面拉回 idle");
  assert.equal(states.at(-1).phase, "waiting");
});

test("start→409：展示共同尝试并转入对现有 attempt 的轮询（不当作失败）", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/start", { status: 409, body: JSON.stringify({ ok: false, error: "already running", attemptId: "a1" }) });
  http.respond("/copilot-auth/state", { body: snapLive("waiting") });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.start();
  await tick();
  assert.equal(states.at(-1).shared, true);
  assert.equal(states.at(-1).phase, "waiting", "409 不是失败");
  assert.ok(http.calls.includes("/copilot-auth/state"), "409 后必须轮询现有 attempt");
});

test("轮询乱序被代次丢弃：旧代迟到响应不覆盖新视图", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  // /state 全部挂起，逐个放行：先放行旧代（authorized 旧事实），再放行新代（waiting）
  http.respond("/copilot-auth/state", { defer: true, body: JSON.stringify({ attemptId: "a-old", status: "authorized", riskLatch: null }) });
  http.respond("/copilot-auth/start", { status: 202, body: JSON.stringify({ ok: true }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.start(); // gen1 轮询挂起
  await flow.start(); // gen2 轮询挂起（旧代被取代）
  await tick();
  http.release("/copilot-auth/state"); // 放行 gen1 的响应（authorized 旧事实）
  await tick();
  http.release("/copilot-auth/state", { body: snapLive("waiting") }); // 放行 gen2 的响应（waiting）
  await tick();
  assert.ok(!states.some((s) => s.phase === "authorized"), "旧代响应不得把新视图改成 authorized");
  assert.equal(states.at(-1).phase, "waiting");
});

test("HTML 502 映射 messageKey；退避 1/2/4/8/15 封顶；累计 60 秒转手动", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/state", { status: 502, body: "<html>Bad Gateway</html>", contentType: "text/html" });
  http.respond("/copilot-auth/start", { status: 202, body: JSON.stringify({ ok: true }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.start();
  await tick(); // 第一次 pollTick 失败 → schedule 1s
  assert.equal(states.at(-1).connectivity, "retrying");
  assert.ok(!JSON.stringify(states.at(-1)).includes("Bad Gateway"), "不得透传代理页文本");
  let guard = 0;
  const expectedS = [1, 2, 4, 8, 15, 15, 15];
  for (let i = 0; i < expectedS.length && guard++ < 20; i++) {
    assert.notEqual(states.at(-1).connectivity, "manual", `第 ${i + 1} 次失败后仍在自动重试窗口内`);
    clock.advance(expectedS[i] * 1000 + 1);
    await tick();
  }
  assert.equal(states.at(-1).connectivity, "manual", "累计失败 60 秒后转手动");
  assert.deepEqual(clock.delays, expectedS.map((s) => s * 1000), "退避序列 1/2/4/8/15 封顶");
  assert.equal(clock.pending(), 0, "转手动后不再自动轮询");
});

test("dispose：停止本页轮询，无悬挂定时器", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  http.respond("/copilot-auth/state", { body: snapLive("waiting") });
  http.respond("/copilot-auth/start", { status: 202, body: JSON.stringify({ ok: true }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: () => {} });
  await flow.start();
  await tick();
  assert.ok(clock.pending() > 0);
  flow.dispose();
  assert.equal(clock.pending(), 0);
});

test("cancel：delivery 映射；随后轮询见 withdrawal-pending-unverified → risk 相", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/cancel", { status: 200, body: JSON.stringify({ ok: true, withdrawalDelivery: "unavailable" }) });
  http.respond("/copilot-auth/state", { body: JSON.stringify({ attemptId: "a1", status: "withdrawal-pending-unverified", riskLatch: { reason: "withdrawal-requested" } }) });
  http.respond("/copilot-auth/start", { status: 202, body: JSON.stringify({ ok: true, attemptId: "a1" }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.start();
  await tick();
  await flow.cancel();
  assert.equal(states.at(-1).withdrawalDelivery, "unavailable");
  clock.advance(1001); // 下一轮轮询
  await tick();
  assert.equal(states.at(-1).phase, "risk");
  assert.equal(states.at(-1).riskKind, "withdrawal-pending-unverified");
  assert.equal(http.calls.filter((c) => c === "/copilot-auth/cancel").length, 1, "写操作不自动重发");
});

test("手动 refresh 恢复自动轮询并重置失败窗口", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/state", { status: 502, body: "<html>x</html>", contentType: "text/html" });
  http.respond("/copilot-auth/start", { status: 202, body: JSON.stringify({ ok: true }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.start();
  let guard = 0;
  while (states.at(-1).connectivity !== "manual" && guard++ < 20) {
    clock.advance(16000);
    await tick();
  }
  assert.equal(states.at(-1).connectivity, "manual");
  http.respond("/copilot-auth/state", { body: snapLive("waiting") }); // 网络恢复
  flow.refresh();
  await tick();
  assert.equal(states.at(-1).connectivity, "online");
  assert.equal(states.at(-1).phase, "waiting");
});

test("init 失败：退避自动重试，服务恢复后恢复 authorized（不再卡死在过期视图）", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/status", { status: 502, body: "<html>Bad Gateway</html>", contentType: "text/html" });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.init();
  assert.equal(states.at(-1).connectivity, "retrying");
  clock.advance(1001); // 第 1 次重试仍失败
  await tick();
  assert.equal(states.at(-1).connectivity, "retrying");
  http.respond("/copilot-auth/status", { body: JSON.stringify({ configured: true }) });
  clock.advance(2001); // 第 2 次重试成功
  await tick();
  assert.equal(states.at(-1).phase, "authorized");
  assert.equal(clock.pending(), 0, "恢复后不再有重试定时器");
});

test("init 持续失败：累计 60 秒转手动，phase=idle 且保留 messageKey（不冒充未登录）", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/status", { status: 502, body: "<html>x</html>", contentType: "text/html" });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.init();
  let guard = 0;
  while (states.at(-1).connectivity !== "manual" && guard++ < 20) {
    clock.advance(16000);
    await tick();
  }
  assert.equal(states.at(-1).connectivity, "manual");
  assert.equal(states.at(-1).phase, "idle");
  assert.equal(states.at(-1).error, "bad-gateway");
  assert.equal(clock.pending(), 0);
});

test("手动 refresh 完整重跑 init：从过期未登录视图恢复 authorized", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/status", { body: JSON.stringify({ configured: false }) });
  http.respond("/copilot-auth/state", { body: JSON.stringify({ attemptId: null, status: "idle", riskLatch: null }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.init();
  assert.equal(states.at(-1).phase, "idle");
  http.respond("/copilot-auth/status", { body: JSON.stringify({ configured: true }) });
  flow.refresh(); // 「查询状态」
  await tick();
  assert.equal(states.at(-1).phase, "authorized");
});

test("start 收到 409 already-configured：恢复 authorized，不轮询不报错", async () => {
  const http = makeFetch();
  const clock = fakeClock();
  const states = [];
  http.respond("/copilot-auth/start", { status: 409, body: JSON.stringify({ ok: false, error: "already-configured" }) });
  const flow = createAuthFlow({ fetchImpl: http.fetchImpl, clock, onState: (s) => states.push(s) });
  await flow.start();
  await tick();
  assert.equal(states.at(-1).phase, "authorized");
  assert.equal(http.calls.filter((c) => c === "/copilot-auth/state").length, 0, "不发起对 attempt 的轮询");
});

test("WIRING_client.jsx：createAuthFlow 必须显式注入 fetchImpl", () => {
  // 回归锚：v1.2.8 漏传 fetchImpl → requestJson 把 TypeError 吞成 network-error →
  // 授权页恒「未登录」、点登录恒「失败」且不发出任何请求（2026-10-04 实机实证）。
  const src = readFileSync(new URL("../src/client.jsx", import.meta.url), "utf8");
  const m = src.match(/createAuthFlow\(\{[^}]*\}\)/g) ?? [];
  assert.ok(m.length >= 1, "client.jsx 应存在 createAuthFlow 接线");
  for (const call of m) {
    assert.match(call, /fetchImpl\s*:/, `漏传 fetchImpl 的接线：${call}`);
  }
});
