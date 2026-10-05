// T3：授权控制器——单实例尝试、超时风险锁存、禁用退出、handoff。（Q38：软撤回已移除）
import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizationController, WAIT_LIMIT_MS } from "../src/auth-host.mjs";

function makeHarness({ begin } = {}) {
  let now = 1000;
  const clock = { now: () => now };
  const intentIO = {
    version: 0,
    bumpFail: false,
    read() { return this.version; },
    bump() {
      if (this.bumpFail) throw new Error("intent persist failed");
      this.version += 1;
      return this.version;
    },
  };
  const handoffs = [];
  const calls = { begin: 0 };
  const ctx = {
    authorization: {
      begin: async (req) => { calls.begin++; return begin ? begin(req, h) : { status: "authorized" }; },
    },
    credentials: {
      describeRecord: async () => ({ configured: h.credentialsPresent === true }),
      deleteRecord: async () => { h.deleteCalls = (h.deleteCalls ?? 0) + 1; h.credentialsPresent = false; return true; },
    },
  };
  const h = {
    calls, clock, handoffs, intentIO,
    credentials: ctx.credentials,
    credentialsPresent: false,
    advance: (ms) => { now += ms; },
    controller: createAuthorizationController(ctx, {
      scope: { known: true, profileId: "p1", dataDir: "/tmp/x" },
      intentIO,
      clock,
      onAuthorized: (x) => handoffs.push(x),
    }),
  };
  return h;
}

test("AUTH_start：202 语义返回 attemptId，单实例；运行中再 start 抛 ATTEMPT_RUNNING", async () => {
  const h = makeHarness({ begin: () => new Promise(() => {}) }); // 永不完成
  const { attemptId } = await h.controller.start();
  assert.equal(typeof attemptId, "string");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.calls.begin, 1);
  assert.equal(h.controller.snapshot().status, "starting");
  await assert.rejects(() => h.controller.start(), (e) => e.code === "ATTEMPT_RUNNING" && e.attemptId === attemptId);
  assert.equal(h.calls.begin, 1, "运行中不得再次调用 begin");
});

test("AUTH_start：intentVersion 先持久（bump 先于 begin），持久失败不调用 begin", async () => {
  const h = makeHarness();
  h.intentIO.bumpFail = true;
  await assert.rejects(() => h.controller.start(), /intent persist failed/);
  assert.equal(h.calls.begin, 0, "安全门失败的动作不得产生 SDK 副作用");
});

test("AUTH_start：riskLatch 存在时新 start 被拒（authUnsafe；Q38 起锁存仅来自等待超时）", async () => {
  const h = makeHarness({ begin: () => new Promise(() => {}) });
  await h.controller.start();
  h.advance(WAIT_LIMIT_MS + 1);
  h.controller.snapshot(); // 惰性判定置锁存
  await assert.rejects(() => h.controller.start(), (e) => e.code === "AUTH_UNSAFE");
});

test("AUTH_logout：静止状态（无尝试/无锁存）→ deleteRecord＋删后核实＋bump 意图", async () => {
  const h = makeHarness();
  h.credentialsPresent = true;
  const v0 = h.intentIO.version;
  const r = await h.controller.logout();
  assert.deepEqual(r, { ok: true });
  assert.equal(h.deleteCalls, 1);
  assert.equal(h.credentialsPresent, false, "凭据已删除");
  assert.equal(h.intentIO.version, v0 + 1, "退出先 bump 本 profile 意图版本");
  const info = await h.credentials.describeRecord();
  assert.equal(info.configured, false, "删后核实：凭据确实不在");
});

test("AUTH_logout：进行中尝试（begin 晚写窗口）拒绝 ATTEMPT_RUNNING，不触碰凭据", async () => {
  const h = makeHarness({ begin: () => new Promise(() => {}) });
  await h.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  h.credentialsPresent = true; // 模拟晚到写：尝试进行中凭据出现
  await assert.rejects(() => h.controller.logout(), (e) => e.code === "ATTEMPT_RUNNING");
  assert.equal(h.deleteCalls ?? 0, 0);
});

test("AUTH_logout：风险锁存期（等待超时未核实）拒绝 LOGOUT_UNSAFE", async () => {
  const h = makeHarness({ begin: () => new Promise(() => {}) });
  await h.controller.start(); // 未登录状态下的尝试（already-configured 门不拦）
  h.advance(WAIT_LIMIT_MS + 1);
  h.controller.snapshot(); // 惰性判定置锁存
  h.credentialsPresent = true; // 模拟晚到写：锁存期内凭据出现
  await assert.rejects(() => h.controller.logout(), (e) => e.code === "LOGOUT_UNSAFE");
  assert.equal(h.deleteCalls ?? 0, 0);
});

test("AUTH_logout：删除后凭据仍在（晚到写）→ LOGOUT_FAILED 不伪报成功", async () => {
  const h = makeHarness();
  h.credentialsPresent = true;
  h.credentials.describeRecord = async () => ({ configured: true }); // 晚到写把凭据写了回来
  await assert.rejects(() => h.controller.logout(), (e) => e.code === "LOGOUT_FAILED");
  assert.equal(h.deleteCalls, 1);
});

test("AUTH_logout：deleteRecord 失败/返回 false → LOGOUT_FAILED", async () => {
  const h = makeHarness();
  h.credentialsPresent = true;
  h.credentials.deleteRecord = async () => false;
  await assert.rejects(() => h.controller.logout(), (e) => e.code === "LOGOUT_FAILED");
  const h2 = makeHarness();
  h2.credentialsPresent = true;
  h2.credentials.deleteRecord = async () => { throw new Error("boom"); };
  await assert.rejects(() => h2.controller.logout(), (e) => e.code === "LOGOUT_FAILED");
});

test("AUTH_outcome_cancelled（防御路径，Q38 后 UI 不可达）：映射 failed 且不设锁存", async () => {
  const h = makeHarness({ begin: () => ({ status: "cancelled" }) });
  await h.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  const s = h.controller.snapshot();
  assert.equal(s.status, "failed", "撤回通道移除后 cancelled 无晚写风险源，防御性映射 failed");
  assert.equal(s.error, "authorization-cancelled");
  assert.equal(s.riskLatch ?? null, null);
});

test("AUTH_outcome_authorized：版本仍当前 → onAuthorized 收到 handoff", async () => {
  const h = makeHarness({ begin: () => ({ status: "authorized" }) });
  const { attemptId } = await h.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().status, "authorized");
  assert.equal(h.handoffs.length, 1);
  assert.equal(h.handoffs[0].attemptId, attemptId);
  assert.equal(h.handoffs[0].originIntentVersion, 1);
});

test("AUTH_outcome_authorized 晚到（版本已变）：只更新事实，不回调 handoff", async () => {
  let settle;
  const h = makeHarness({ begin: () => new Promise((r) => { settle = r; }) });
  await h.controller.start();
  h.intentIO.bump(); // V2：其他显式操作使意图版本漂移
  settle({ status: "authorized" });
  await new Promise((r) => setTimeout(r, 5));
  const s = h.controller.snapshot();
  assert.equal(s.status, "authorized");
  assert.equal(s.staleIntent, true, "晚到成功标记 staleIntent");
  assert.equal(h.handoffs.length, 0, "不得生成新配置意图");
});

test("AUTH_unexpected_prompt：attempt 失败且错误脱敏", async () => {
  const h = makeHarness({
    begin: async (req) => { await req.interaction.prompt({ kind: "secret", message: "Enter API key" }); return { status: "authorized" }; },
  });
  await h.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  const s = h.controller.snapshot();
  assert.equal(s.status, "failed");
  assert.ok(String(s.error).includes("unexpected prompt"));
});

test("AUTH_timeout：超过 15 分钟等待上限 → timed-out-unverified＋锁存＋新 start 被拒；晚到成功不回调", async () => {
  let settle;
  const h = makeHarness({ begin: () => new Promise((r) => { settle = r; }) });
  await h.controller.start();
  h.advance(WAIT_LIMIT_MS + 1);
  const s = h.controller.snapshot();
  assert.equal(s.status, "timed-out-unverified");
  assert.ok(s.riskLatch);
  await assert.rejects(() => h.controller.start(), (e) => e.code === "AUTH_UNSAFE");
  await new Promise((r) => setTimeout(r, 5)); // 等 begin 微任务跑完，settle 已被捕获
  settle({ status: "authorized" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().staleIntent, true);
  assert.equal(h.handoffs.length, 0);
});

test("AUTH_notice：设备码/URL 进入 snapshot，状态转 waiting", async () => {
  const h = makeHarness({
    begin: (req, harness) => {
      req.interaction.notify({ message: "Enter code", url: "https://github.com/login/device", code: "ABCD-1234" });
      return new Promise(() => {});
    },
  });
  await h.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  const s = h.controller.snapshot();
  assert.equal(s.status, "waiting");
  assert.equal(s.code, "ABCD-1234");
  assert.equal(s.url, "https://github.com/login/device");
  assert.equal(s.waitDeadline, 1000 + WAIT_LIMIT_MS);
});

test("AUTH_already_configured：已有凭据时 start 拒绝且不调 begin；describeRecord 失败不阻断", async () => {
  const h = makeHarness({ begin: () => new Promise(() => {}) });
  h.credentialsPresent = true;
  await assert.rejects(() => h.controller.start(), (e) => e.code === "ALREADY_CONFIGURED");
  assert.equal(h.calls.begin, 0, "替换性授权尝试不得发起（Q21 初始授权条件）");
  // 凭据读取失败（读不到≠存在）：放行初始授权
  const h2 = makeHarness({ begin: () => new Promise(() => {}) });
  h2.credentials.describeRecord = async () => { throw new Error("boom"); };
  const { attemptId } = await h2.controller.start();
  assert.equal(typeof attemptId, "string");
  assert.equal(h2.calls.begin, 1);
});

test("AUTH_cause_code：网络层失败附 cause.code，桌面/代理类环境问题一眼可辨", async () => {
  const h = makeHarness({ begin: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } }); } });
  await h.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().error, "fetch failed (ETIMEDOUT)");
  // 证书类失败码同样保留（企业 TLS 检查场景）
  const h2 = makeHarness({ begin: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }); } });
  await h2.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h2.controller.snapshot().error, "fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
  // cause 无 code / 非白名单形状：维持原脱敏行为，不泄漏
  const h3 = makeHarness({ begin: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "secret token ghp_x" } }); } });
  await h3.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h3.controller.snapshot().error, "fetch failed");
  const h4 = makeHarness({ begin: async () => { throw Object.assign(new Error("fetch failed"), { cause: { message: "connect ETIMEDOUT 1.2.3.4:443" } }); } });
  await h4.controller.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(h4.controller.snapshot().error, "fetch failed");
});
