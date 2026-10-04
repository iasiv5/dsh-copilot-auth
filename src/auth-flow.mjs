// auth-flow.mjs — 浏览器授权状态机（T5）：串行请求、代次保护、轮询退避、卸载停止。
// 契约：createAuthFlow({fetchImpl, clock, onState}) -> {init, start, cancel, refresh, dispose}
//  - 单一 init 聚合 /status；start 202 → 轮询；409 → attempt.shared 并转入对现有 attempt 的轮询
//  - 请求代次（generation）保护：慢响应不得覆盖新操作；dispose 仅停止本页请求
//  - 轮询 1 秒；连续读取失败退避 1/2/4/8/15 秒封顶；累计失败 60 秒转手动（connectivity=manual）
//  - 写操作（start/cancel）绝不自动重发
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
  const schedule = (gen, delayMs) => {
    if (stale(gen)) return;
    clearTimer();
    timer = clock.setTimeout(() => {
      timer = null;
      void pollTick(gen);
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
    if (s?.status === "withdrawal-pending-unverified" || s?.status === "timed-out-unverified") {
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
    const status = await requestJson(fetchImpl, "/copilot-auth/status", { method: "GET" });
    if (stale(gen)) return;
    if (!status.ok) {
      emit({ phase: "idle", error: status.error?.messageKey });
      return;
    }
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
      emit({ phase: "authorized" });
      return;
    }
    // 未配置时回查最近一次 attempt：恢复轮询或如实呈现终态
    const r = await requestJson(fetchImpl, "/copilot-auth/state", { method: "GET" });
    if (stale(gen)) return;
    if (!r.ok) {
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

  async function cancel() {
    // 写操作：单次调用，绝不自动重发
    const r = await requestJson(fetchImpl, "/copilot-auth/cancel", { method: "POST" });
    if (r.ok) {
      emit({ withdrawalDelivery: r.body?.withdrawalDelivery ?? "unavailable" });
      return;
    }
    emit({ withdrawalDelivery: "failed", error: r.error?.details?.errorCode ?? r.error?.messageKey });
  }

  function refresh() {
    // 手动重试（60 秒上限后）：恢复自动轮询并重置失败窗口
    const gen = ++generation;
    clearTimer();
    failures = 0;
    backoffIdx = 0;
    failureWindowStart = null;
    emit({ connectivity: "online" });
    void pollTick(gen);
  }

  function dispose() {
    generation += 1;
    clearTimer();
  }

  return { init, start, cancel, refresh, dispose };
}
