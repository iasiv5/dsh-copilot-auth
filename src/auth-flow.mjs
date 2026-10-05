// auth-flow.mjs — 浏览器授权状态机（T5；Q38 起「请求撤回」已移除）：串行请求、代次保护、轮询退避、卸载停止。
// 契约：createAuthFlow({fetchImpl, clock, onState}) -> {init, start, logout, refresh, dispose}
//  - 单一 init 聚合 /status；start 202 → 轮询；409 → attempt.shared 并转入对现有 attempt 的轮询
//  - 请求代次（generation）保护：慢响应不得覆盖新操作；dispose 仅停止本页请求
//  - 轮询 1 秒；连续读取失败退避 1/2/4/8/15 秒封顶；累计失败 60 秒转手动（connectivity=manual）
//  - 写操作（start）绝不自动重发
import { requestJson } from "./client-http.mjs";

const POLL_INTERVAL_MS = 1000;
const BACKOFF_STEPS_S = [1, 2, 4, 8, 15];
const AUTO_RETRY_LIMIT_MS = 60_000;
const LIVE_STATUSES = ["starting", "waiting", "finishing"];

const defaultClock = () => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});

export function createAuthFlow({ fetchImpl, clock = defaultClock(), onState = () => {} } = {}) {
  let generation = 0;
  let timer = null;
  let failures = 0;
  let backoffIdx = 0;
  let failureWindowStart = null;
  let last = { phase: "loading", connectivity: "online", shared: false };

  const emit = (patch) => {
    last = { ...last, ...patch };
    onState({ ...last });
  };
  const stale = (gen) => gen !== generation;
  const clearTimer = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (gen, delayMs, fn = () => pollTick(gen)) => {
    if (stale(gen)) return;
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      void fn();
    }, delayMs);
  };

  function applySnapshot(gen, s) {
    if (stale(gen)) return;
    emit({ attempt: s, riskLatch: s?.riskLatch ?? null });
    if (LIVE_STATUSES.includes(s?.status)) {
      emit({ phase: "waiting" });
      schedule(gen, POLL_INTERVAL_MS);
      return;
    }
    if (s?.status === "authorized") {
      emit({ phase: "authorized", error: undefined });
      return;
    }
    if (s?.status === "failed") {
      emit({ phase: "failed", error: s?.error ?? "authorization-failed" });
      return;
    }
    if (s?.status === "timed-out-unverified") {
      emit({ phase: "risk", riskKind: s.status });
      return;
    }
    emit({ phase: "idle" });
  }

  async function pollTick(gen) {
    const r = await requestJson(fetchImpl, "/copilot-auth/state", { method: "GET" });
    if (stale(gen)) return;
    if (r.ok) {
      failures = 0;
      backoffIdx = 0;
      failureWindowStart = null;
      emit({ connectivity: "online" });
      applySnapshot(gen, r.body);
      return;
    }
    failures += 1;
    if (failureWindowStart === null) failureWindowStart = clock.now();
    const cumulative = clock.now() - failureWindowStart;
    if (cumulative >= AUTO_RETRY_LIMIT_MS) {
      // 60 秒上限：转手动重试，保留最后确认的状态（连接异常文案由 UI 呈现）
      emit({ connectivity: "manual" });
      return;
    }
    emit({ connectivity: "retrying" });
    const delayS = BACKOFF_STEPS_S[Math.min(backoffIdx, BACKOFF_STEPS_S.length - 1)];
    backoffIdx += 1;
    schedule(gen, delayS * 1000);
  }

  function beginPolling(gen) {
    void pollTick(gen);
  }

  async function init() {
    const gen = ++generation;
    clearTimer();
    failures = 0;
    backoffIdx = 0;
    failureWindowStart = null;
    await initAttempt(gen);
  }

  // init 内核：/status 失败时按 1/2/4/8/15 秒退避自动重试，累计 60 秒转手动；
  // 不把加载失败伪装成「未登录」（历史缺陷：502 窗口期打开页面会显示未登录＋授权按钮）。
  async function initAttempt(gen) {
    const status = await requestJson(fetchImpl, "/copilot-auth/status", { method: "GET" });
    if (stale(gen)) return;
    if (!status.ok) {
      failures += 1;
      if (failureWindowStart === null) failureWindowStart = clock.now();
      const cumulative = clock.now() - failureWindowStart;
      if (cumulative >= AUTO_RETRY_LIMIT_MS) {
        emit({ phase: "idle", error: status.error?.messageKey, connectivity: "manual" });
        return;
      }
      emit({ phase: "loading", connectivity: "retrying", error: status.error?.messageKey });
      const delayS = BACKOFF_STEPS_S[Math.min(backoffIdx, BACKOFF_STEPS_S.length - 1)];
      backoffIdx += 1;
      schedule(gen, delayS * 1000, () => initAttempt(gen));
      return;
    }
    failures = 0;
    backoffIdx = 0;
    failureWindowStart = null;
    emit({ connectivity: "online" });
    const body = status.body ?? {};
    if (body.refresh?.scopeAvailable === false) {
      emit({ phase: "unavailable" });
      return;
    }
    emit({ status: body });
    if (body.authorization?.riskLatch) {
      emit({ riskLatch: body.authorization.riskLatch });
    }
    if (body.configured === true) {
      emit({ phase: "authorized", error: undefined });
      return;
    }
    // 未配置时回查最近一次 attempt：恢复轮询或如实呈现终态
    const r = await requestJson(fetchImpl, "/copilot-auth/state", { method: "GET" });
    if (stale(gen)) return;
    if (!r.ok) {
      emit({ phase: "idle", error: r.error?.messageKey, connectivity: "manual" });
      return;
    }
    // Q38 追加修复（真机验证发现）：凭据已不在（configured:false）时，attempt 记录里的
    // 「authorized」是退出前的历史残影而非登录态——如实回到未登录，不得翻转已登录视图
    if (r.body?.status === "authorized" && body.configured !== true) {
      emit({ phase: "idle" });
      return;
    }
    applySnapshot(gen, r.body);
  }

  async function start() {
    const gen = ++generation;
    clearTimer();
    failures = 0;
    backoffIdx = 0;
    failureWindowStart = null;
    emit({ phase: "waiting", shared: false, error: undefined, connectivity: "online" });
    const r = await requestJson(fetchImpl, "/copilot-auth/start", { method: "POST" });
    if (stale(gen)) return;
    if (r.ok) {
      beginPolling(gen);
      return;
    }
    const errorCode = r.error?.details?.errorCode;
    if (errorCode === "already-configured") {
      // 后端确认已有凭据：本页是过期的未登录视图（如短暂 read-error 窗口），
      // 直接恢复已登录视图，不发起注定失败的替换性授权
      emit({ phase: "authorized", error: undefined, shared: false });
      return;
    }
    if (r.httpStatus === 409) {
      // 共同尝试：不是失败——展示 shared 并转入对现有 attempt 的轮询
      emit({ shared: true });
      beginPolling(gen);
      return;
    }
    if (errorCode === "auth-unsafe") {
      emit({ phase: "risk", riskKind: "auth-unsafe" });
      return;
    }
    if (errorCode === "scope-unavailable" || r.httpStatus === 503) {
      emit({ phase: "unavailable" });
      return;
    }
    emit({ phase: "failed", error: errorCode ?? r.error?.messageKey });
  }

  async function logout() {
    // 退出登录（写操作，单次调用）：pending 态 → 成功后完整重跑 init 恢复真实
    // 状态（若晚到写把凭据写了回来，init 会如实显示 authorized，绝不伪报已退出）；
    // 失败回到 authorized 并保留 logoutError 供 UI 分层展示。
    const gen = ++generation;
    clearTimer();
    failures = 0;
    backoffIdx = 0;
    failureWindowStart = null;
    emit({ phase: "loading", logoutError: undefined });
    const r = await requestJson(fetchImpl, "/copilot-auth/logout", { method: "POST" });
    if (stale(gen)) return;
    if (!r.ok) {
      const code = r.error?.details?.errorCode;
      emit({ phase: "authorized", logoutError: code ?? r.error?.messageKey ?? "logout-failed" });
      return;
    }
    emit({ logoutError: undefined });
    await initAttempt(gen);
  }

  function refresh() {
    // 手动「查询状态」：完整重跑 init（status→state），可从过期的未登录/失败视图恢复
    void init();
  }

  function dispose() {
    generation += 1;
    clearTimer();
  }

  return { init, start, logout, refresh, dispose };
}
