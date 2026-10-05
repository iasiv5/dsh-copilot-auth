// auth-host.mjs — 授权控制器（T3；Q38 起软撤回已移除）：单实例尝试、等待超时风险锁存、
// 禁用退出、intentVersion 与首次填充 handoff。
// 契约见 docs/plans/2026-10-04-copilot-auth-models-unified-implementation-plan.md：
//  - start：先 intentIO.bump() 持久 intentVersion+1（失败不发 begin），再 begin；202 先行语义保留
//  - logout：静止态（无 LIVE attempt＋无 riskLatch）deleteRecord＋删后核实；
//    尝试进行中/风险锁存期拒绝。「重新授权」概念随 v1.2.11 移除（退出＋登录分步即可）
//  - onAuthorized(handoff) 仅在 outcome=authorized 且 originIntentVersion 仍当前且无超时标记时触发
//  - riskLatch 进程级：重挂/dispose 不清；15 分钟等待超时由 snapshot 以注入 clock 惰性判定
//  - Q38（2026-10-05）：「请求撤回」按钮与 /cancel 路由移除——撤销本地轮询的价值自限
//    （15 分钟超时自然收敛），而其进程级锁存会把用户锁进「登录成功却不能退出」的死局
import { randomUUID } from "node:crypto";
import { CREDENTIAL_KEY } from "./shared.mjs";

export const WAIT_LIMIT_MS = 15 * 60 * 1000;
// 进行中的授权尝试状态：begin 的晚写窗口，期间退出/撤回类操作一律拒绝
export const LIVE_STATUSES = ["starting", "waiting", "finishing"];

// 授权错误脱敏：仅保留安全字符集（字母/数字/空格/点/冒号/逗号/连字符），
// 阻断上游异常文本或疑似 token（含 = ; / + _ 等的串）进入状态面。
const SAFE_AUTH_ERROR = /^[A-Za-z0-9 .,:-]{1,140}$/;
// 网络层失败码（undici cause.code）：严格大写/数字/下划线白名单，
// 如 ETIMEDOUT/ECONNRESET/ENOTFOUND/UNABLE_TO_VERIFY_LEAF_SIGNATURE
const SAFE_CAUSE_CODE = /^[A-Z0-9_]{3,60}$/;

export function sanitizeAuthError(err) {
  const msg = String(err?.message ?? err);
  const base = SAFE_AUTH_ERROR.test(msg) ? msg : "authorization-failed";
  // v1.2.18：网络层失败的原话（如 Node 的 "fetch failed"）不携带任何定位信息，
  // 追加 cause.code（严格白名单）让桌面/代理类环境问题一眼可辨（主人 2026-10-05 裁决）
  const causeCode = String(err?.cause?.code ?? "");
  if (SAFE_CAUSE_CODE.test(causeCode)) return `${base} (${causeCode})`;
  return base;
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

  async function start() {
    requireScope();
    if (riskLatch) throw authError("AUTH_UNSAFE", "auth-unsafe", { riskLatch });
    if (attempt && LIVE_STATUSES.includes(attempt.status)) {
      throw authError("ATTEMPT_RUNNING", "already running", { attemptId: attempt.attemptId });
    }
    // 初始授权条件（设计 Q21）：已有凭据时禁止新的授权尝试——那是对既有授权的
    // 隐式替换（历史实证：已登录状态下点「授权登录」，begin 带着已存在的凭据发起
    // 设备流，attempt 永远停在 starting，最终以「失败」收场）。「重新授权」在宿主
    // 可证明安全前默认禁用。describeRecord 自身失败不阻断（读不到≠存在）。
    try {
      const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY);
      if (info?.configured === true) throw authError("ALREADY_CONFIGURED", "already-configured");
    } catch (err) {
      if (err?.code === "ALREADY_CONFIGURED") throw err;
    }
    // 先持久意图版本，失败不发 begin（安全门拒绝动作不产生副作用）
    const originIntentVersion = intentIO.bump();
    const a = {
      attemptId: randomUUID(),
      status: "starting",
      startedAt: clock.now(),
      notices: [],
      originIntentVersion,
      timedOut: false,
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
          const intact = versionStillCurrent && !a.timedOut;
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
          // Q38：撤回通道已移除，cancelled 结局防御性映射为 failed（无晚写风险源，不设锁存）
          a.status = "failed";
          a.error = outcome?.status === "cancelled" ? "authorization-cancelled" : "authorization-failed";
        }
      })
      .catch((err) => {
        if (attempt !== a) return;
        a.status = "failed";
        a.error = sanitizeAuthError(err);
      });
    return { attemptId: a.attemptId };
  }

  async function logout() {
    // 退出安全条件（v1.2.10 起，经主人裁决替代 D-01 全禁策略）：
    // ① 无进行中的授权尝试（begin 晚写窗口）② 无风险锁存（Q38 起仅剩等待超时未核实）。
    // 满足后凭据库视为静止：deleteRecord＋删除后 describe 复核；晚到写无法绝对
    // 排除，以复核与状态页如实展示兜底——退出未核实成功绝不伪报成功。
    requireScope();
    if (attempt && LIVE_STATUSES.includes(attempt.status)) {
      throw authError("ATTEMPT_RUNNING", "already running", { attemptId: attempt.attemptId });
    }
    if (riskLatch) throw authError("LOGOUT_UNSAFE", "logout-unsafe");
    // 本 profile 显式操作：旧预览/模型配置意图先行失效（失败则不动凭据）
    intentIO.bump();
    try {
      const deleted = await ctx.credentials.deleteRecord(CREDENTIAL_KEY);
      if (deleted === false) throw authError("LOGOUT_FAILED", "logout-failed");
    } catch (err) {
      if (err?.code === "LOGOUT_FAILED") throw err;
      throw authError("LOGOUT_FAILED", "logout-failed");
    }
    try {
      const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY);
      if (info?.configured === true) throw authError("LOGOUT_FAILED", "logout-failed");
    } catch (err) {
      if (err?.code === "LOGOUT_FAILED") throw err;
      throw authError("LOGOUT_FAILED", "logout-failed");
    }
    // Q38 追加修复（真机验证发现）：退出成功后清掉 attempt 残影——否则 /state 继续报告
    // 历史「authorized」，客户端会把残影误当登录态，UI 翻回已登录，表现为「退出没作用」
    attempt = null;
    return { ok: true };
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
      riskLatch,
      staleIntent: attempt.staleIntent,
      notices: [...attempt.notices],
      error: attempt.error,
    };
  }

  // T4 消费：handoff 是否仍完好（同 attempt、版本仍当前、无超时标记）
  function handoffIntact(handoff) {
    if (!attempt || !handoff) return false;
    return attempt.attemptId === handoff.attemptId
      && attempt.originIntentVersion === handoff.originIntentVersion
      && attempt.originIntentVersion === intentIO.read()
      && !attempt.timedOut;
  }

  return { start, logout, snapshot, handoffIntact };
}
