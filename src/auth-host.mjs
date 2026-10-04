// auth-host.mjs — 授权控制器（T3）：单实例尝试、软撤回＋风险锁存、禁用退出/重授权、
// intentVersion 与首次填充 handoff。
// 契约见 docs/plans/2026-10-04-copilot-auth-models-unified-implementation-plan.md：
//  - start：先 intentIO.bump() 持久 intentVersion+1（失败不发 begin），再 begin；202 先行语义保留
//  - cancel：先 bump，再调用宿主撤销（invoked/unavailable/failed），设进程内 riskLatch
//  - logout/reauthorize：一律拒绝 logout-safety-unavailable，绝不 deleteRecord
//  - onAuthorized(handoff) 仅在 outcome=authorized 且 originIntentVersion 仍当前且无撤回/超时标记时触发
//  - riskLatch 进程级：重挂/dispose 不清；15 分钟等待超时由 snapshot 以注入 clock 惰性判定
import { randomUUID } from "node:crypto";
import { CREDENTIAL_KEY } from "./shared.mjs";

export const WAIT_LIMIT_MS = 15 * 60 * 1000;
const LIVE_STATUSES = ["starting", "waiting", "finishing"];

// 授权错误脱敏：仅保留安全字符集（字母/数字/空格/点/冒号/逗号/连字符），
// 阻断上游异常文本或疑似 token（含 = ; / + _ 等的串）进入状态面。
const SAFE_AUTH_ERROR = /^[A-Za-z0-9 .,:-]{1,140}$/;

export function sanitizeAuthError(err) {
  const msg = String(err?.message ?? err);
  return SAFE_AUTH_ERROR.test(msg) ? msg : "authorization-failed";
}

function authError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

export function createAuthorizationController(ctx, { scope, intentIO, clock = { now: () => Date.now() }, onAuthorized } = {}) {
  let attempt = null;
  let riskLatch = null; // { reason, at } — 进程级风险锁存，本进程生命周期内不解除

  const setRiskLatch = (reason) => {
    if (!riskLatch) riskLatch = { reason, at: clock.now() };
  };

  const requireScope = () => {
    if (!scope?.known) throw authError("SCOPE_UNAVAILABLE", "scope-unavailable");
  };

  function start() {
    requireScope();
    if (riskLatch) throw authError("AUTH_UNSAFE", "auth-unsafe", { riskLatch });
    if (attempt && LIVE_STATUSES.includes(attempt.status)) {
      throw authError("ATTEMPT_RUNNING", "already running", { attemptId: attempt.attemptId });
    }
    // 先持久意图版本，失败不发 begin（安全门拒绝动作不产生副作用）
    const originIntentVersion = intentIO.bump();
    const a = {
      attemptId: randomUUID(),
      status: "starting",
      startedAt: clock.now(),
      notices: [],
      originIntentVersion,
      withdrawalRequested: false,
      timedOut: false,
      withdrawalDelivery: undefined,
      error: undefined,
      staleIntent: false,
    };
    attempt = a;
    const interaction = {
      notify: (notice) => {
        if (attempt !== a) return;
        a.notices.push(notice);
        if (notice && typeof notice === "object") {
          if (a.status === "starting") a.status = "waiting";
          if (typeof notice.code === "string") a.code = notice.code;
          if (typeof notice.url === "string") a.url = notice.url;
          if (typeof notice.expiresAt === "string") a.expiresAt = notice.expiresAt;
        }
      },
      // 企业域名提问答空串（github.com 组织账号）；其余 prompt 都是未预期的
      prompt: (p) => {
        if (p && typeof p.message === "string" && p.message.includes("Enterprise")) {
          return Promise.resolve("");
        }
        return Promise.reject(new Error("unexpected prompt: " + (p?.message ?? String(p))));
      },
    };
    // 响应先行：begin 以后台任务执行，start 返回路径不得 await begin
    void Promise.resolve()
      .then(() => ctx.authorization.begin({ key: CREDENTIAL_KEY, method: "oauth", interaction }))
      .then((outcome) => {
        if (attempt !== a) return;
        if (outcome && outcome.status === "authorized") {
          const versionStillCurrent = a.originIntentVersion === intentIO.read();
          const intact = versionStillCurrent && !a.withdrawalRequested && !a.timedOut;
          a.status = "authorized";
          a.staleIntent = !intact;
          if (intact && typeof onAuthorized === "function") {
            // 释放意图：handoff 只携带来源标识，晚到事实不生成新意图（T4 消费前再核）
            onAuthorized({
              attemptId: a.attemptId,
              originIntentVersion: a.originIntentVersion,
              authorizedAt: new Date(clock.now()).toISOString(),
            });
          }
        } else {
          // 宿主 cancelled 只是源结果：晚写不可排除，转待核实并锁存风险（D-01 软撤回）
          a.status = "withdrawal-pending-unverified";
          setRiskLatch("withdrawal-unverified");
        }
      })
      .catch((err) => {
        if (attempt !== a) return;
        a.status = "failed";
        a.error = sanitizeAuthError(err);
      });
    return { attemptId: a.attemptId };
  }

  async function cancel() {
    requireScope();
    // 先持久失效本地旧意图，再发撤回调用
    intentIO.bump();
    let withdrawalDelivery = "unavailable";
    if (attempt) {
      attempt.withdrawalRequested = true;
      if (LIVE_STATUSES.includes(attempt.status)) attempt.status = "withdrawal-pending-unverified";
    }
    const cancelFn = ctx.authorization?.cancel;
    if (typeof cancelFn === "function") {
      try {
        await cancelFn(CREDENTIAL_KEY);
        withdrawalDelivery = "invoked";
      } catch {
        withdrawalDelivery = "failed";
      }
    }
    // 任何响应都不承诺晚写停止：风险锁存待核实
    setRiskLatch("withdrawal-requested");
    return { withdrawalDelivery };
  }

  function logout() {
    // 当前宿主无法证明安全退出（D-01）：统一拒绝，不调用 deleteRecord
    throw authError("LOGOUT_UNAVAILABLE", "logout-safety-unavailable");
  }

  function snapshot() {
    // 15 分钟本地等待上限：惰性判定（无后台定时器），不伪造设备码倒计时
    if (attempt && LIVE_STATUSES.includes(attempt.status) && clock.now() > attempt.startedAt + WAIT_LIMIT_MS) {
      attempt.status = "timed-out-unverified";
      attempt.timedOut = true;
      setRiskLatch("wait-timeout");
    }
    if (!attempt) {
      return { attemptId: null, status: "idle", startedAt: null, waitDeadline: null, riskLatch };
    }
    return {
      attemptId: attempt.attemptId,
      status: attempt.status,
      startedAt: attempt.startedAt,
      code: attempt.code,
      url: attempt.url,
      expiresAt: attempt.expiresAt,
      waitDeadline: attempt.startedAt + WAIT_LIMIT_MS,
      withdrawalDelivery: attempt.withdrawalDelivery,
      riskLatch,
      staleIntent: attempt.staleIntent,
      notices: [...attempt.notices],
      error: attempt.error,
    };
  }

  // T4 消费：handoff 是否仍完好（同 attempt、版本仍当前、无撤回/超时标记）
  function handoffIntact(handoff) {
    if (!attempt || !handoff) return false;
    return attempt.attemptId === handoff.attemptId
      && attempt.originIntentVersion === handoff.originIntentVersion
      && attempt.originIntentVersion === intentIO.read()
      && !attempt.withdrawalRequested
      && !attempt.timedOut;
  }

  return { start, cancel, logout, snapshot, handoffIntact };
}
