window.__ModuleLoader__.load({
	id: "@inventec/dsh-copilot-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/shared.mjs
var ROUTE_PREFIX = "/copilot-auth";
var PROTOCOL_VERSION = 3;
var routes = () => ({
  start: `${ROUTE_PREFIX}/start`,
  state: `${ROUTE_PREFIX}/state`,
  status: `${ROUTE_PREFIX}/status`,
  logout: `${ROUTE_PREFIX}/logout`,
  cancel: `${ROUTE_PREFIX}/cancel`,
  refreshPreview: `${ROUTE_PREFIX}/refresh/preview`,
  refreshApply: `${ROUTE_PREFIX}/refresh/apply`,
  refreshRetire: `${ROUTE_PREFIX}/refresh/retire`
});

// src/client-http.mjs
var SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9 -]{0,79}$/;
var SAFE_CONTENT_TYPE = /^[\w./+-]{0,100}$/;
function sanitizeErrorCode(value) {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : "http-error";
}
var SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9 -]{0,127}$/;
function deepSanitize(value) {
  if (typeof value === "string") return SAFE_STRING.test(value) ? value : void 0;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const s = deepSanitize(v);
      if (s !== void 0) out[k] = s;
    }
    return out;
  }
  return void 0;
}
function sanitizeContentType(value) {
  if (typeof value !== "string" || !SAFE_CONTENT_TYPE.test(value)) return void 0;
  return value;
}
async function requestJson(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return { ok: false, httpStatus: null, body: void 0, error: { messageKey: "network-error", details: {} } };
  }
  const httpStatus = res.status;
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  if (typeof text !== "string" || text.trim() === "") {
    return {
      ok: false,
      httpStatus,
      body: void 0,
      error: { messageKey: httpStatus >= 500 ? "bad-gateway" : "bad-response", details: { httpStatus } }
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const contentType = sanitizeContentType(res.headers?.get?.("content-type"));
    const looksHtml = contentType?.includes("html") || /^\s*<(?:!doctype|html)/i.test(text);
    const messageKey = httpStatus >= 500 || looksHtml ? "bad-gateway" : "bad-response";
    const details2 = { httpStatus };
    if (contentType !== void 0) details2.contentType = contentType;
    return { ok: false, httpStatus, body: void 0, error: { messageKey, details: details2 } };
  }
  const ok = res.ok && body?.ok !== false;
  if (ok) return { ok: true, httpStatus, body, error: void 0 };
  const details = {};
  if (!res.ok) details.httpStatus = httpStatus;
  const errorCode = sanitizeErrorCode(body?.error);
  if (errorCode !== void 0) details.errorCode = errorCode;
  return { ok: false, httpStatus, body: deepSanitize(body), error: { messageKey: "http-error", details } };
}

// src/refresh-flow.mjs
var initial = Object.freeze({
  name: "idle",
  flags: { catalogMode: null, blockedReason: null, scopeAvailable: true, legacyStateDetected: false },
  lastResult: null
});
var fromRefresh = (state, refresh) => ({
  ...state,
  flags: {
    catalogMode: refresh && "catalogMode" in refresh ? refresh.catalogMode : state.flags.catalogMode,
    blockedReason: refresh && "blockedReason" in refresh ? refresh.blockedReason : state.flags.blockedReason,
    scopeAvailable: refresh ? refresh.scopeAvailable !== false : state.flags.scopeAvailable,
    legacyStateDetected: refresh?.legacyStateDetected === true
  },
  lastResult: refresh?.lastResult ?? null
});
var restartStates = /* @__PURE__ */ new Set(["pending-restart"]);
function refreshBlocked(flags) {
  const mode = flags?.catalogMode;
  return flags?.scopeAvailable === false || mode === "blocked" || mode === "unknown";
}
function selectionFields(lastSelection = {}) {
  const out = {};
  if (lastSelection.selectedIds !== void 0) out.selectedIds = lastSelection.selectedIds;
  if (lastSelection.clearOverrides !== void 0) out.clearOverrides = lastSelection.clearOverrides;
  if (lastSelection.confirmEmpty !== void 0) out.confirmEmpty = lastSelection.confirmEmpty;
  return out;
}
function upgradeCandidate(state) {
  const p = state.preview;
  if (!p || state.liveUpgradeUsed) return null;
  if ((p.diff?.removed?.length ?? 0) === 0) return null;
  if (p.evidence?.source !== "cache" || p.evidence?.stale === true) return null;
  if (p.catalogSource !== "latest") return null;
  return {
    type: "preview",
    operation: p.operation,
    catalogSource: p.catalogSource,
    ...selectionFields(state.lastSelection)
  };
}
function enterConfirming({ flags, preview, staleNotice, lastSelection }) {
  const state = {
    name: "confirming",
    flags: flags ?? initial.flags,
    preview,
    staleNotice: staleNotice === true,
    materializing: false,
    awaitingUpgrade: false,
    liveUpgradeUsed: false,
    lastSelection: lastSelection ?? {}
  };
  const effect = upgradeCandidate(state);
  if (!effect) return [state, null];
  return [{ ...state, liveUpgradeUsed: true, awaitingUpgrade: true, materializing: true }, effect];
}
function reduce(state, event) {
  switch (state.name) {
    case "idle":
    case "failed":
    case "result":
    case "pendingRestart":
    case "busy":
    case "resultUnknown": {
      if (event.type === "start") {
        return [{
          name: "previewing",
          flags: state.flags ?? initial.flags,
          operation: "manage",
          catalogSource: event.catalogSource,
          stale: false
        }, { type: "preview", operation: "manage", catalogSource: event.catalogSource }];
      }
      if (event.type === "init" && state.name === "idle") return [state, { type: "status" }];
      if (event.type === "check" && state.name === "resultUnknown") {
        return [{ ...state, name: "checking", operationId: state.operationId }, { type: "statusQuery", operationId: state.operationId }];
      }
      if (event.type === "retire-request" && state.name === "result") {
        return [{ name: "retireConfirm", result: state.result }, null];
      }
      if (event.type === "dismiss" && state.name === "failed") {
        return [{ ...initial, flags: state.flags }, null];
      }
      if (event.type === "hydrate") {
        const refresh = event.status?.refresh;
        if (!event.status) return [state, null];
        if (refresh?.lastError === "state-corrupt") return [{ ...state, name: "failed", error: "state-corrupt" }, null];
        const base = fromRefresh({ ...initial, name: "idle" }, refresh);
        if (restartStates.has(refresh?.lastResult?.status ?? "") || refresh?.pendingRestart === true) {
          return [{ ...base, name: "pendingRestart", result: refresh.lastResult }, null];
        }
        const st = refresh?.lastResult?.status;
        if (st && ["recovery-needed", "rollback-conflict", "conflict", "partial", "rolled-back", "intent-retired", "applied"].includes(st)) {
          return [{ ...base, name: "result", result: refresh.lastResult }, null];
        }
        if (refresh?.activeOperation) return [{ ...base, name: "busy", active: refresh.activeOperation }, null];
        return [base, null];
      }
      return [state, null];
    }
    case "previewing": {
      if (event.type === "preview-ok") {
        return enterConfirming({ flags: state.flags ?? initial.flags, preview: event.preview, staleNotice: state.stale === true });
      }
      if (event.type === "preview-fail") return [{ name: "failed", flags: state.flags ?? initial.flags, error: event.error }, null];
      return [state, null];
    }
    case "confirming": {
      const p = state.preview;
      if (event.type === "select") {
        const lastSelection = { ...selectionFields({
          selectedIds: event.selectedIds,
          clearOverrides: event.clearOverrides,
          confirmEmpty: event.confirmEmpty
        }) };
        return [{
          name: "confirming",
          flags: state.flags ?? initial.flags,
          preview: p,
          materializing: true,
          awaitingUpgrade: false,
          liveUpgradeUsed: state.liveUpgradeUsed ?? false,
          lastSelection,
          staleNotice: state.staleNotice
        }, {
          type: "preview",
          operation: p.operation,
          catalogSource: p.catalogSource,
          basePreviewId: p.previewId,
          ...selectionFields(lastSelection)
        }];
      }
      if (event.type === "preview-ok") {
        const wasUpgrade = state.awaitingUpgrade === true;
        const landed = {
          name: "confirming",
          flags: state.flags ?? initial.flags,
          preview: event.preview,
          materializing: false,
          awaitingUpgrade: false,
          liveUpgradeUsed: state.liveUpgradeUsed ?? false,
          lastSelection: state.lastSelection ?? {},
          staleNotice: wasUpgrade && event.preview?.evidence?.source !== "live" || state.staleNotice === true
        };
        const effect = upgradeCandidate(landed);
        if (effect) return [{ ...landed, liveUpgradeUsed: true, awaitingUpgrade: true, materializing: true }, effect];
        return [landed, null];
      }
      if (event.type === "preview-fail") {
        if (state.awaitingUpgrade === true && p) {
          return [{
            name: "confirming",
            flags: state.flags ?? initial.flags,
            preview: p,
            materializing: true,
            awaitingUpgrade: false,
            liveUpgradeUsed: state.liveUpgradeUsed ?? true,
            lastSelection: state.lastSelection ?? {},
            staleNotice: true
          }, {
            type: "preview",
            operation: p.operation,
            catalogSource: p.catalogSource,
            basePreviewId: p.previewId,
            ...selectionFields(state.lastSelection)
          }];
        }
        return [{ name: "failed", flags: state.flags ?? initial.flags, error: event.error }, null];
      }
      if (event.type === "start") {
        return [{
          name: "confirming",
          flags: state.flags ?? initial.flags,
          preview: p,
          materializing: true,
          awaitingUpgrade: false,
          liveUpgradeUsed: state.liveUpgradeUsed ?? false,
          lastSelection: state.lastSelection ?? {},
          staleNotice: state.staleNotice
        }, { type: "preview", operation: p.operation, catalogSource: event.catalogSource }];
      }
      if (event.type === "confirm") {
        if (state.materializing) return [state, null];
        if (p.evidence?.stale === true) return [state, null];
        const removedCount = (p.diff?.removed ?? []).length;
        const emptyTarget = (p.diff?.selectedIds ?? []).length === 0 && p.hadModels === true;
        const needsEscalate = removedCount > 0 || p.clearOverrides === true || emptyTarget;
        if (needsEscalate && event.second !== true) return [state, null];
        if (emptyTarget && event.empty !== true) return [state, null];
        return [{ name: "applying", flags: state.flags ?? initial.flags, preview: p }, { type: "apply", previewId: p.previewId, operationId: p.operationId }];
      }
      if (event.type === "cancel") return [{ ...initial, flags: state.flags ?? initial.flags, lastResult: state.lastResult ?? null }, null];
      return [state, null];
    }
    case "applying": {
      if (event.type === "apply-ok") {
        return restartStates.has(event.result?.status ?? "") ? [{ ...state, name: "pendingRestart", result: event.result }, null] : [{ ...state, name: "result", result: event.result }, null];
      }
      if (event.type === "apply-stale") {
        return [{
          name: "previewing",
          flags: state.flags ?? initial.flags,
          operation: state.preview.operation,
          catalogSource: state.preview.catalogSource,
          stale: true
        }, { type: "preview", operation: state.preview.operation, catalogSource: state.preview.catalogSource }];
      }
      if (event.type === "apply-busy") {
        return [{ ...state, name: "checking" }, { type: "status" }];
      }
      if (event.type === "apply-unknown") {
        return [{ ...state, name: "checking", operationId: state.preview.operationId }, { type: "statusQuery", operationId: state.preview.operationId }];
      }
      if (event.type === "apply-fail") return [{ ...state, name: "failed", error: event.error }, null];
      return [state, null];
    }
    case "checking": {
      if (event.type === "query-result") {
        if (event.query === "active") return [{ ...state, name: "busy", active: event.active }, null];
        if (event.query === "last") {
          return restartStates.has(event.lastResult?.status ?? "") ? [{ ...state, name: "pendingRestart", result: event.lastResult }, null] : [{ ...state, name: "result", result: event.lastResult }, null];
        }
        return [{ ...state, name: "resultUnknown", operationId: state.operationId }, null];
      }
      if (event.type === "hydrate") {
        const refresh = event.status?.refresh;
        if (refresh?.activeOperation) return [{ ...state, name: "busy", active: refresh.activeOperation }, null];
        if (refresh?.lastResult) return [{ ...state, name: "result", result: refresh.lastResult }, null];
        return [{ ...state, name: "resultUnknown", operationId: state.operationId }, null];
      }
      return [state, null];
    }
    case "retireConfirm": {
      if (event.type === "retire-confirm") {
        return [{ name: "retiring", operationId: state.result?.operationId, result: state.result }, { type: "retire", operationId: state.result?.operationId }];
      }
      if (event.type === "cancel") return [{ name: "result", result: state.result }, null];
      return [state, null];
    }
    case "retiring": {
      if (event.type === "retire-ok") return [{ ...state, name: "checking" }, { type: "status" }];
      if (event.type === "retire-fail") return [{ name: "result", result: state.result, retireError: event.error }, null];
      return [state, null];
    }
    default:
      return [state, null];
  }
}
async function runEffect(effect, fetchImpl) {
  const r = routes();
  const post = (url, body) => requestJson(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body })
  });
  if (effect.type === "preview") {
    const res = await post(r.refreshPreview, {
      operation: effect.operation,
      ...effect.catalogSource ? { catalogSource: effect.catalogSource } : {},
      ...effect.basePreviewId !== void 0 ? { basePreviewId: effect.basePreviewId } : {},
      ...effect.selectedIds !== void 0 ? { selectedIds: effect.selectedIds } : {},
      ...effect.clearOverrides !== void 0 ? { clearOverrides: effect.clearOverrides } : {},
      ...effect.confirmEmpty !== void 0 ? { confirmEmpty: effect.confirmEmpty } : {}
    });
    if (res.ok) return { type: "preview-ok", preview: res.body };
    return { type: "preview-fail", error: res.error?.details?.errorCode ?? res.error?.messageKey };
  }
  if (effect.type === "apply") {
    const res = await post(r.refreshApply, { previewId: effect.previewId, operationId: effect.operationId });
    if (res.ok) return { type: "apply-ok", result: res.body?.result ?? { status: "unknown" } };
    const code = res.error?.details?.errorCode ?? "";
    const status = res.httpStatus;
    if (status === null) return { type: "apply-unknown" };
    if (status === 423 || code === "resource-busy") return { type: "apply-busy" };
    if (status === 409 && ["preview-stale", "auth-changed", "preview-invalid"].includes(code)) {
      return { type: "apply-stale", error: code };
    }
    return { type: "apply-fail", error: code || res.error?.messageKey };
  }
  if (effect.type === "retire") {
    const res = await post(r.refreshRetire, { operationId: effect.operationId });
    if (res.ok) return { type: "retire-ok", result: res.body?.result ?? null };
    return { type: "retire-fail", error: res.error?.details?.errorCode ?? res.error?.messageKey };
  }
  if (effect.type === "status") {
    const res = await requestJson(fetchImpl, r.status, { method: "GET" });
    if (res.ok) return { type: "hydrate", status: res.body };
    return { type: "hydrate", status: null };
  }
  if (effect.type === "statusQuery") {
    const res = await requestJson(fetchImpl, `${r.status}?operationId=${encodeURIComponent(effect.operationId ?? "")}`, { method: "GET" });
    if (res.ok && res.body?.operation) {
      return { type: "query-result", query: res.body.operation.query, active: res.body.operation.active, lastResult: res.body.operation.lastResult };
    }
    return { type: "query-result", query: "unknown" };
  }
  throw new Error(`unknown effect: ${effect.type}`);
}
async function advance(state, event, fetchImpl, onState) {
  let [s, fx] = reduce(state, event);
  onState?.(s);
  let guard = 0;
  while (fx) {
    if (guard++ > 8) throw new Error("effect loop guard");
    const resultEvent = await runEffect(fx, fetchImpl);
    [s, fx] = reduce(s, resultEvent);
    onState?.(s);
  }
  return s;
}

// src/auth-flow.mjs
var POLL_INTERVAL_MS = 1e3;
var BACKOFF_STEPS_S = [1, 2, 4, 8, 15];
var AUTO_RETRY_LIMIT_MS = 6e4;
var LIVE_STATUSES = ["starting", "waiting", "finishing"];
var defaultClock = () => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id)
});
function createAuthFlow({ fetchImpl, clock = defaultClock(), onState = () => {
} } = {}) {
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
      emit({ phase: "authorized", error: void 0 });
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
      emit({ connectivity: "manual" });
      return;
    }
    emit({ connectivity: "retrying" });
    const delayS = BACKOFF_STEPS_S[Math.min(backoffIdx, BACKOFF_STEPS_S.length - 1)];
    backoffIdx += 1;
    schedule(gen, delayS * 1e3);
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
      schedule(gen, delayS * 1e3, () => initAttempt(gen));
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
      emit({ phase: "authorized", error: void 0 });
      return;
    }
    const r = await requestJson(fetchImpl, "/copilot-auth/state", { method: "GET" });
    if (stale(gen)) return;
    if (!r.ok) {
      emit({ phase: "idle", error: r.error?.messageKey, connectivity: "manual" });
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
    emit({ phase: "waiting", shared: false, error: void 0, connectivity: "online" });
    const r = await requestJson(fetchImpl, "/copilot-auth/start", { method: "POST" });
    if (stale(gen)) return;
    if (r.ok) {
      beginPolling(gen);
      return;
    }
    const errorCode = r.error?.details?.errorCode;
    if (errorCode === "already-configured") {
      emit({ phase: "authorized", error: void 0, shared: false });
      return;
    }
    if (r.httpStatus === 409) {
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
    const r = await requestJson(fetchImpl, "/copilot-auth/cancel", { method: "POST" });
    if (r.ok) {
      emit({ withdrawalDelivery: r.body?.withdrawalDelivery ?? "unavailable" });
      return;
    }
    emit({ withdrawalDelivery: "failed", error: r.error?.details?.errorCode ?? r.error?.messageKey });
  }
  async function logout() {
    const gen = ++generation;
    clearTimer();
    failures = 0;
    backoffIdx = 0;
    failureWindowStart = null;
    emit({ phase: "loading", logoutError: void 0 });
    const r = await requestJson(fetchImpl, "/copilot-auth/logout", { method: "POST" });
    if (stale(gen)) return;
    if (!r.ok) {
      const code = r.error?.details?.errorCode;
      emit({ phase: "authorized", logoutError: code ?? r.error?.messageKey ?? "logout-failed" });
      return;
    }
    emit({ logoutError: void 0 });
    await initAttempt(gen);
  }
  function refresh() {
    void init();
  }
  function dispose() {
    generation += 1;
    clearTimer();
  }
  return { init, start, cancel, logout, refresh, dispose };
}

// src/client.jsx
var import_jsx_runtime = require("react/jsx-runtime");
var name = "copilot-auth-ui";
var inject = ["slots", "locale"];
var DICTS = {
  en: {
    nav: "GHC Settings",
    title: "GitHub Copilot",
    intro: "Authorize with a personal or organization account on github.com that has Copilot access. No API token is required.",
    idle: "Not signed in",
    waiting: "Waiting for you to authorize on GitHub",
    authorized: "Signed in",
    failed: "Failed",
    loading: "\u2026",
    login: "Sign in",
    logout: "Sign out",
    withdrawAuth: "Request withdrawal",
    withdrawal: "Withdrawal requested; the outcome remains unverified.",
    withdrawalUnavailable: "The withdrawal request could not be sent to the host; the outcome remains unverified.",
    authUnsafe: "Safe completion of the authorization flow is unconfirmed. Sign-out and a new authorization attempt are unavailable.",
    attemptTimeout: "Authorization wait timed out; the outcome remains unverified. A new authorization attempt is unavailable. Check the status or verify it manually.",
    attemptShared: "An authorization attempt is already running in this instance.",
    unavailable: "This runtime lacks the capabilities needed to apply changes safely.",
    connection: "Connection lost. The last confirmed status is shown.",
    retryNow: "Check status",
    copyFailed: "Copy failed. Select and copy the device code manually.",
    riskBadge: "Outcome unverified",
    codeHint: "Open the link below and enter this code to finish signing in:",
    copy: "Copy",
    copied: "Copied \u2713",
    unknown: "Unknown error",
    netConnect: "Cannot reach GitHub. Check this machine's network or proxy settings.",
    netDns: "Cannot resolve github.com. Check DNS or network settings.",
    netCert: "GitHub certificate verification failed. A corporate proxy or TLS inspection may be intercepting the connection.",
    netGeneric: "The authorization request failed over the network.",
    statusUnknown: "Status unknown",
    errNetwork: "Network error: cannot reach the authorization service. Retrying automatically.",
    errGateway: "Gateway error: the DSH service may be restarting. Retrying automatically.",
    errBadResponse: "Unexpected response from the authorization service.",
    errHttp: "The authorization request failed. Check status and retry.",
    logoutScope: "This removes Copilot authorization from this credential store and affects other instances using it. It does not delete your GitHub account.",
    logoutFailed: "Sign-out did not complete; authorization credentials may remain. Please retry.",
    // ---- Model management (protocol v3, design §5 / ADR 0005) ----
    manageModels: "Manage model list",
    selectAll: "Select all",
    selectNone: "Deselect all",
    alignAction: "Align with account & catalog",
    groupAddable: "Available to add",
    groupListed: "In list",
    groupRemoval: "Proposed for removal",
    retain: "Keep: re-check to retain",
    customizedBadge: "Customized",
    clearOverrides: "Also clear all model customizations.",
    inheritedOverrides: "Inherited model customizations cannot be cleared here.",
    clearRisk: "This clears the Copilot model list and its model customizations. Confirm clearing separately.",
    secondConfirm: "This is destructive. Click again to confirm.",
    applyChanges: "Apply changes",
    removalRisk: "{count} listed model(s) will be removed; their customizations are removed with them.",
    summaryLine: "After applying: {total} model(s) \u2014 {kept} kept \xB7 {added} added \xB7 {removed} removed",
    catalogNotice: "{count} catalog entries will be added",
    noChanges: "No changes and no new catalog entries.",
    removalNeedsLive: "Removals require live account evidence",
    removedAccount: "Not reported by this account",
    removedUnresolvable: "Not resolvable by the current catalog",
    skippedModels: "Upstream entries skipped by validation",
    srcLive: "Account models: live",
    srcCache: "Account models: cached at {time}; removals require upgrading to live evidence",
    srcStale: "The cache has no trusted timestamp, is expired, or belongs to changed authorization; reference only.",
    srcLatest: "Catalog source: latest pi-ai from npm",
    srcLocal: "Catalog source: local (npm fetch failed)",
    srcOverlay: "Catalog source: bundled overlay (offline bootstrap)",
    overlayBtn: "Preview with bundled overlay",
    previewStale: "Configuration or data changed. Preview and confirm again.",
    none: "(none)",
    applying: "Applying\u2026",
    refreshing: "Fetching preview\u2026",
    cancel: "Cancel",
    applied: "Changes are active. No restart is needed.",
    pendingRestart: "Changes are saved and require restarting this instance's service or application. Refreshing the page alone is not enough.",
    conflict: "Configuration changed. To protect your edits, preview and confirm again.",
    partial: "Changes were only partially applied. Review the current status and recovery guidance.",
    rolledBack: "This operation's model configuration changes were rolled back. Catalog data may still have been added.",
    rollbackConflict: "Newer configuration was detected and preserved. Automatic rollback did not complete.",
    busy: "Another operation is using this resource. Please retry shortly.",
    unknownResult: "Completion has not been confirmed. Check the current status before submitting again.",
    recoveryNeeded: "A previous configuration intent is stale or conflicted. End it before applying new changes.",
    retireBtn: "End previous configuration intent",
    retireTitle: "End previous configuration intent",
    retireConfirmText: "End the intent only; existing changes are not rolled back or undone.",
    legacy: "Legacy shared recovery state was found. It will not be applied automatically; preview and confirm in this profile.",
    techDetails: "Technical details",
    stateCorrupt: "State file was corrupted and quarantined. Preview and confirm again.",
    blockedReasons: {
      "inject-unavailable": "The in-process catalog registry is unavailable in this installation.",
      "install-unresolved": "The pi-ai installation could not be located."
    }
  },
  zh: {
    nav: "GHC\u8BBE\u7F6E",
    title: "GitHub Copilot",
    intro: "\u4F7F\u7528\u5177\u6709 Copilot \u6743\u9650\u7684 github.com \u4E2A\u4EBA\u6216\u7EC4\u7EC7\u8D26\u53F7\u6388\u6743\uFF0C\u65E0\u9700\u586B\u5199 API Token\u3002",
    idle: "\u672A\u767B\u5F55",
    waiting: "\u7B49\u5F85\u4F60\u5728 GitHub \u5B8C\u6210\u6388\u6743",
    authorized: "\u5DF2\u767B\u5F55",
    failed: "\u5931\u8D25",
    loading: "\u2026",
    login: "\u6388\u6743\u767B\u5F55",
    logout: "\u9000\u51FA\u767B\u5F55",
    withdrawAuth: "\u8BF7\u6C42\u64A4\u56DE",
    withdrawal: "\u64A4\u56DE\u8BF7\u6C42\u5DF2\u53D1\u9001\uFF0C\u7ED3\u679C\u4ECD\u5F85\u6838\u5B9E\u3002",
    withdrawalUnavailable: "\u672A\u80FD\u5411\u5BBF\u4E3B\u53D1\u9001\u64A4\u56DE\u8BF7\u6C42\uFF0C\u7ED3\u679C\u4ECD\u5F85\u6838\u5B9E\u3002",
    authUnsafe: "\u5C1A\u4E0D\u80FD\u786E\u8BA4\u6388\u6743\u6D41\u7A0B\u5DF2\u5B89\u5168\u7ED3\u675F\uFF0C\u6682\u4E0D\u80FD\u9000\u51FA\u6216\u53D1\u8D77\u65B0\u7684\u6388\u6743\u5C1D\u8BD5\u3002",
    attemptTimeout: "\u7B49\u5F85\u6388\u6743\u8D85\u65F6\uFF0C\u7ED3\u679C\u4ECD\u5F85\u6838\u5B9E\u3002\u5F53\u524D\u4E0D\u80FD\u53D1\u8D77\u65B0\u7684\u6388\u6743\u5C1D\u8BD5\uFF0C\u8BF7\u67E5\u8BE2\u72B6\u6001\u6216\u4EBA\u5DE5\u6838\u5B9E\u3002",
    attemptShared: "\u6B64\u5B9E\u4F8B\u5DF2\u6709\u6388\u6743\u6B63\u5728\u8FDB\u884C\u3002",
    connection: "\u8FDE\u63A5\u5F02\u5E38\uFF0C\u663E\u793A\u7684\u662F\u6700\u540E\u786E\u8BA4\u7684\u72B6\u6001\u3002",
    retryNow: "\u67E5\u8BE2\u72B6\u6001",
    copyFailed: "\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u8BBE\u5907\u7801\u590D\u5236\u3002",
    riskBadge: "\u7ED3\u679C\u5F85\u6838\u5B9E",
    codeHint: "\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u4E0B\u9762\u7684\u94FE\u63A5\uFF0C\u8F93\u5165\u8FD9\u4E32\u4EE3\u7801\u5B8C\u6210\u6388\u6743\uFF1A",
    copy: "\u590D\u5236",
    copied: "\u5DF2\u590D\u5236 \u2713",
    unknown: "\u672A\u77E5\u9519\u8BEF",
    netConnect: "\u65E0\u6CD5\u8FDE\u63A5 GitHub\uFF1A\u8BF7\u68C0\u67E5\u672C\u673A\u7F51\u7EDC\u6216\u4EE3\u7406\u8BBE\u7F6E\u3002",
    netDns: "\u65E0\u6CD5\u89E3\u6790 GitHub \u57DF\u540D\uFF1A\u8BF7\u68C0\u67E5 DNS \u6216\u7F51\u7EDC\u8BBE\u7F6E\u3002",
    netCert: "GitHub \u8BC1\u4E66\u6821\u9A8C\u5931\u8D25\uFF1A\u53EF\u80FD\u5B58\u5728\u4F01\u4E1A\u4EE3\u7406\u6216 TLS \u68C0\u67E5\u62E6\u622A\u3002",
    netGeneric: "\u6388\u6743\u8BF7\u6C42\u7F51\u7EDC\u5931\u8D25\u3002",
    statusUnknown: "\u72B6\u6001\u672A\u77E5",
    errNetwork: "\u7F51\u7EDC\u5F02\u5E38\uFF1A\u65E0\u6CD5\u8FDE\u63A5\u6388\u6743\u670D\u52A1\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8BD5\u3002",
    errGateway: "\u7F51\u5173\u9519\u8BEF\uFF1ADSH \u670D\u52A1\u53EF\u80FD\u6B63\u5728\u91CD\u542F\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8BD5\u3002",
    errBadResponse: "\u6388\u6743\u670D\u52A1\u8FD4\u56DE\u5F02\u5E38\u54CD\u5E94\u3002",
    errHttp: "\u6388\u6743\u8BF7\u6C42\u5931\u8D25\u3002\u8BF7\u67E5\u8BE2\u72B6\u6001\u540E\u91CD\u8BD5\u3002",
    logoutScope: "\u5C06\u6E05\u9664\u6B64\u51ED\u636E\u5E93\u4E2D\u7684 Copilot \u6388\u6743\uFF0C\u4F7F\u7528\u540C\u4E00\u51ED\u636E\u5E93\u7684\u5176\u4ED6\u5B9E\u4F8B\u4E5F\u4F1A\u53D7\u5230\u5F71\u54CD\u3002\u6B64\u64CD\u4F5C\u4E0D\u6CE8\u9500 GitHub \u8D26\u53F7\u3002",
    logoutFailed: "\u9000\u51FA\u767B\u5F55\u672A\u5B8C\u6210\uFF0C\u6388\u6743\u51ED\u636E\u4ECD\u53EF\u80FD\u5B58\u5728\u3002\u8BF7\u91CD\u8BD5\u3002",
    // ---- 模型管理（协议 v3，设计§5 / ADR 0005） ----
    manageModels: "\u7BA1\u7406\u6A21\u578B\u5217\u8868",
    selectAll: "\u5168\u9009",
    selectNone: "\u53D6\u6D88\u5168\u9009",
    alignAction: "\u5BF9\u9F50\u8D26\u53F7\u4E0E\u76EE\u5F55",
    groupAddable: "\u53EF\u65B0\u589E",
    groupListed: "\u5728\u5217",
    groupRemoval: "\u5F85\u5220\u9664\u5019\u9009",
    retain: "\u633D\u7559\uFF1A\u91CD\u65B0\u52FE\u9009\u4EE5\u4FDD\u7559",
    customizedBadge: "\u6709\u5B9A\u5236",
    clearOverrides: "\u540C\u65F6\u6E05\u9664\u5168\u90E8\u6A21\u578B\u5B9A\u5236\u3002",
    inheritedOverrides: "\u5B58\u5728\u7EE7\u627F\u7684\u6A21\u578B\u5B9A\u5236\uFF0C\u65E0\u6CD5\u5728\u6B64\u6E05\u9664\u3002",
    clearRisk: "\u672C\u6B21\u5C06\u6E05\u7A7A Copilot \u6A21\u578B\u5217\u8868\u5E76\u6E05\u9664\u5176\u6A21\u578B\u5B9A\u5236\u3002\u8BF7\u5355\u72EC\u786E\u8BA4\u6E05\u7A7A\u3002",
    secondConfirm: "\u6B64\u64CD\u4F5C\u5177\u6709\u7834\u574F\u6027\uFF0C\u8BF7\u518D\u6B21\u70B9\u51FB\u786E\u8BA4\u3002",
    applyChanges: "\u5E94\u7528\u66F4\u6539",
    removalRisk: "\u5C06\u79FB\u9664 {count} \u4E2A\u5728\u5217\u6A21\u578B\uFF0C\u5176\u5B9A\u5236\u968F\u4E4B\u6E05\u9664\u3002",
    summaryLine: "\u5E94\u7528\u540E\u5171 {total} \u4E2A\uFF1A\u4FDD\u7559 {kept} \xB7 \u65B0\u589E {added} \xB7 \u79FB\u9664 {removed}",
    catalogNotice: "\u76EE\u5F55\u5C06\u65B0\u589E {count} \u6761\u63CF\u8FF0",
    noChanges: "\u65E0\u9700\u66F4\u6539\uFF0C\u76EE\u5F55\u4E5F\u65E0\u65B0\u6570\u636E\u3002",
    removalNeedsLive: "\u79FB\u9664\u7C7B\u66F4\u6539\u9700\u8981\u5B9E\u65F6\u8D26\u53F7\u8BC1\u636E",
    removedAccount: "\u8D26\u53F7\u672A\u62A5\u544A",
    removedUnresolvable: "\u76EE\u5F55\u65E0\u6CD5\u89E3\u6790",
    skippedModels: "\u88AB\u6821\u9A8C\u8DF3\u8FC7\u7684\u4E0A\u6E38\u6761\u76EE",
    srcLive: "\u8D26\u53F7\u6A21\u578B\uFF1A\u5B9E\u65F6\u83B7\u53D6",
    srcCache: "\u8D26\u53F7\u6A21\u578B\uFF1A\u7F13\u5B58\uFF0C\u83B7\u53D6\u4E8E {time}\uFF1B\u79FB\u9664\u7C7B\u66F4\u6539\u9700\u5347\u7EA7\u4E3A\u5B9E\u65F6\u8BC1\u636E",
    srcStale: "\u7F13\u5B58\u7F3A\u5C11\u53EF\u4FE1\u65F6\u95F4\u3001\u5DF2\u8FC7\u671F\u6216\u6388\u6743\u5DF2\u53D8\u5316\uFF0C\u4EC5\u4F9B\u53C2\u8003\u3002",
    srcLatest: "\u76EE\u5F55\u6765\u6E90\uFF1Anpm \u6700\u65B0 pi-ai",
    srcLocal: "\u76EE\u5F55\u6765\u6E90\uFF1A\u672C\u5730\u76EE\u5F55\uFF08npm \u62C9\u53D6\u5931\u8D25\uFF09",
    srcOverlay: "\u76EE\u5F55\u6765\u6E90\uFF1A\u5185\u7F6E\u8986\u76D6\u5C42\uFF08\u79BB\u7EBF bootstrap\uFF09",
    overlayBtn: "\u6539\u7528\u5185\u7F6E\u76EE\u5F55\u6570\u636E\u9884\u89C8",
    previewStale: "\u914D\u7F6E\u6216\u6570\u636E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u5E76\u786E\u8BA4\u3002",
    none: "\uFF08\u65E0\uFF09",
    applying: "\u5E94\u7528\u4E2D\u2026",
    refreshing: "\u62C9\u53D6\u9884\u89C8\u4E2D\u2026",
    cancel: "\u53D6\u6D88",
    applied: "\u66F4\u6539\u5DF2\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002",
    pendingRestart: "\u66F4\u6539\u5DF2\u4FDD\u5B58\uFF0C\u5F85\u91CD\u542F\u751F\u6548\u3002\u8BF7\u91CD\u542F\u8FD0\u884C\u6B64\u5B9E\u4F8B\u7684\u670D\u52A1\u6216\u5E94\u7528\uFF1B\u4EC5\u5237\u65B0\u9875\u9762\u4E0D\u4F1A\u751F\u6548\u3002",
    conflict: "\u914D\u7F6E\u5DF2\u53D8\u5316\u3002\u4E3A\u4FDD\u62A4\u4F60\u7684\u4FEE\u6539\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u5E76\u786E\u8BA4\u3002",
    partial: "\u66F4\u6539\u672A\u5B8C\u5168\u5E94\u7528\uFF0C\u8BF7\u67E5\u770B\u5F53\u524D\u72B6\u6001\u548C\u6062\u590D\u5EFA\u8BAE\u3002",
    rolledBack: "\u672C\u6B21\u6A21\u578B\u914D\u7F6E\u66F4\u6539\u5DF2\u56DE\u6EDA\u3002\u76EE\u5F55\u6570\u636E\u53EF\u80FD\u4ECD\u5DF2\u8865\u5145\u3002",
    rollbackConflict: "\u68C0\u6D4B\u5230\u66F4\u65B0\u7684\u914D\u7F6E\uFF0C\u5DF2\u4FDD\u7559\u4F60\u7684\u4FEE\u6539\uFF1B\u81EA\u52A8\u56DE\u6EDA\u672A\u5B8C\u6210\u3002",
    busy: "\u53E6\u4E00\u4E2A\u64CD\u4F5C\u6B63\u5728\u5904\u7406\u6B64\u8D44\u6E90\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
    unknownResult: "\u5C1A\u672A\u786E\u8BA4\u64CD\u4F5C\u5B8C\u6210\u3002\u8BF7\u6838\u5B9E\u5F53\u524D\u72B6\u6001\uFF0C\u52FF\u91CD\u590D\u63D0\u4EA4\u3002",
    recoveryNeeded: "\u5B58\u5728\u5DF2\u5931\u6548\u6216\u51B2\u7A81\u7684\u65E7\u914D\u7F6E\u610F\u56FE\uFF0C\u8BF7\u5148\u7ED3\u675F\u65E7\u610F\u56FE\u518D\u5E94\u7528\u65B0\u66F4\u6539\u3002",
    retireBtn: "\u7ED3\u675F\u65E7\u914D\u7F6E\u610F\u56FE",
    retireTitle: "\u7ED3\u675F\u65E7\u914D\u7F6E\u610F\u56FE",
    retireConfirmText: "\u53EA\u7ED3\u675F\u65E7\u610F\u56FE\uFF0C\u4E0D\u56DE\u6EDA\u6216\u64A4\u9500\u5DF2\u53D1\u751F\u7684\u66F4\u6539\u3002",
    legacy: "\u68C0\u6D4B\u5230\u65E7\u7684\u5171\u4EAB\u6062\u590D\u72B6\u6001\u3002\u4E0D\u4F1A\u81EA\u52A8\u5E94\u7528\uFF0C\u8BF7\u5728\u5F53\u524D profile \u91CD\u65B0\u9884\u89C8\u786E\u8BA4\u3002",
    techDetails: "\u6280\u672F\u8BE6\u60C5",
    stateCorrupt: "\u6062\u590D\u72B6\u6001\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u539F\u4EF6\u5DF2\u4FDD\u7559\u3002\u8BF7\u91CD\u65B0\u9884\u89C8\u786E\u8BA4\u3002",
    unavailable: "\u5F53\u524D\u8FD0\u884C\u65F6\u7F3A\u5C11\u5B89\u5168\u5E94\u7528\u6240\u9700\u7684\u80FD\u529B\uFF0C\u6682\u4E0D\u80FD\u5E94\u7528\u66F4\u6539\u3002",
    blockedReasons: {
      "inject-unavailable": "\u5F53\u524D\u5B89\u88C5\u7684\u8FDB\u7A0B\u5185\u76EE\u5F55\u6CE8\u518C\u8868\u4E0D\u53EF\u7528\u3002",
      "install-unresolved": "\u65E0\u6CD5\u5B9A\u4F4D pi-ai \u5B89\u88C5\u3002"
    }
  }
};
var NAV_TEXTS = Object.keys(DICTS).map((locale) => DICTS[locale].nav);
function blockedReasonText(t, flags) {
  const reason = flags?.blockedReason;
  if (reason && t("blockedReasons")?.[reason]) return t("blockedReasons")[reason];
  return t("unavailable");
}
function httpErrorText(t, key) {
  return {
    "network-error": t("errNetwork"),
    "bad-gateway": t("errGateway"),
    "bad-response": t("errBadResponse"),
    "http-error": t("errHttp")
  }[key];
}
var COPILOT_ICON_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="flex:none"><path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"/><path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/></svg>';
function enforceNavIcon(labelText) {
  if (!labelText) return;
  for (const cell of document.querySelectorAll("button")) {
    const spans = cell.querySelectorAll("span");
    const labelSpan = spans[spans.length - 1];
    if (!labelSpan || labelSpan.textContent !== labelText) continue;
    if (cell.dataset.copilotIcon === "1") continue;
    const gear = cell.querySelector("svg");
    if (!gear) continue;
    gear.style.display = "none";
    const holder = document.createElement("span");
    holder.innerHTML = COPILOT_ICON_SVG;
    const svg = holder.firstElementChild;
    const cls = gear.className && typeof gear.className === "object" ? gear.className.baseVal : gear.className;
    if (cls) svg.setAttribute("class", cls);
    cell.dataset.copilotIcon = "1";
    gear.after(svg);
  }
}
function startNavIconEnforcer(getLabelText) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  let queued = false;
  const run = () => {
    queued = false;
    try {
      enforceNavIcon(getLabelText());
    } catch {
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}
var styles = {
  section: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 12, fontFamily: "inherit" },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" },
  intro: { margin: 0, fontSize: 14, lineHeight: "22px", opacity: 0.75 },
  badgeRow: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  badge: { fontSize: 12, lineHeight: "18px" },
  button: {
    height: 32,
    padding: "0 14px",
    fontSize: 14,
    borderRadius: 16,
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit"
  },
  primary: { background: "#4c6ef5", color: "#fff" },
  secondary: { background: "transparent", color: "inherit", border: "1px solid currentColor", opacity: 0.8 },
  card: {
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: 12,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10
  },
  codeHint: { margin: 0, fontSize: 13, lineHeight: "20px", opacity: 0.85 },
  codeRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  code: { fontSize: 24, fontWeight: 700, letterSpacing: 2, fontVariantNumeric: "tabular-nums" },
  link: { fontSize: 13, color: "#4c6ef5" },
  error: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#e03131" },
  banner: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#f59f00" },
  modalMask: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 1e3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24
  },
  // 弹窗背景/文字由 sampleThemeSurface() 在渲染时采样覆盖（皮肤可能把 bg-base
  // 做成半透明磨砂，弹窗必须不透明）；此处仅为兜底
  modal: {
    background: "var(--dsw-alias-bg-base, #fff)",
    color: "var(--dsw-alias-label-primary, inherit)",
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: 12,
    maxWidth: 560,
    width: "100%",
    maxHeight: "80vh",
    overflowY: "auto",
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)"
  },
  modalTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  modalText: { margin: 0, fontSize: 13, lineHeight: "20px", opacity: 0.85 },
  diffList: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "20px" },
  added: { color: "#37b24d" },
  removed: { color: "#e03131" },
  skipped: { color: "#f59f00" },
  muted: { opacity: 0.6 },
  risk: { margin: 0, fontSize: 12, lineHeight: "18px", color: "#e8590c" },
  modalActions: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 },
  mono: { fontFamily: "ui-monospace, monospace" }
};
var badgeColor = { idle: "#adb5bd", waiting: "#f59f00", authorized: "#37b24d", failed: "#e03131", loading: "#adb5bd", risk: "#f59f00", unavailable: "#adb5bd" };
function sampleThemeSurface() {
  if (typeof document === "undefined") return { bg: "#fff", fg: "inherit" };
  const cs = getComputedStyle(document.body);
  const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
  const bg = m ? `rgb(${m[1].split(",").slice(0, 3).join(",")})` : "#fff";
  return { bg, fg: cs.color || "inherit" };
}
function RefreshModal({ t, flow, onSelect, onConfirm, onCancel, onOverlay }) {
  const p = flow.preview;
  const isStale = p.evidence?.stale === true;
  const degradedCatalog = p.catalogSource === "local" || p.catalogSource === "overlay";
  const locked = isStale || degradedCatalog;
  const rows = p.rows ?? [];
  const addableIds = rows.filter((r) => r.status === "addable").map((r) => r.id);
  const rawAllIds = rows.filter((r) => r.status !== "addable").map((r) => r.id);
  const removalRows = rows.filter((r) => r.status === "removal-proposal");
  const [localSel, setLocalSel] = (0, import_react.useState)(null);
  const [coChecked, setCoChecked] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    setLocalSel(null);
    setCoChecked(p.clearOverrides === true);
  }, [p.diff]);
  const lockedIds = rows.filter((r) => r.status === "removal-proposal" && locked).map((r) => r.id);
  const selected = (() => {
    const s = new Set(localSel ?? (p.diff?.selectedIds ?? []));
    for (const id of lockedIds) s.add(id);
    return s;
  })();
  const confirmEmptyOf = (set) => set.size === 0 && p.hadModels === true;
  const emitSel = (nextSet) => {
    setLocalSel(nextSet);
    const ce = confirmEmptyOf(nextSet);
    onSelect({ selectedIds: [...nextSet], clearOverrides: coChecked, ...ce ? { confirmEmpty: true } : {} });
  };
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    emitSel(next);
  };
  const toggleClearOverrides = (v) => {
    setCoChecked(v);
    const ce = confirmEmptyOf(selected);
    onSelect({ selectedIds: [...selected], clearOverrides: v, ...ce ? { confirmEmpty: true } : {} });
  };
  const keptCount = rawAllIds.filter((id) => selected.has(id)).length;
  const addedCount = addableIds.filter((id) => selected.has(id)).length;
  const removedCount = rawAllIds.length - keptCount;
  const total = keptCount + addedCount;
  const emptyTarget = confirmEmptyOf(selected);
  const needsEscalate = removedCount > 0 || coChecked || emptyTarget;
  const applyBlocked = isStale || removedCount > 0 && (p.evidence?.source !== "live" || degradedCatalog);
  const [stage, setStage] = (0, import_react.useState)(0);
  const cancelRef = (0, import_react.useRef)(null);
  const surface = (0, import_react.useRef)(null);
  if (!surface.current) surface.current = sampleThemeSurface();
  (0, import_react.useEffect)(() => {
    setStage(0);
  }, [p.previewId]);
  (0, import_react.useEffect)(() => {
    if (stage > 0) cancelRef.current?.focus();
  }, [stage]);
  const escCancel = (e) => {
    if (e.key === "Escape") onCancel();
  };
  const confirmClick = () => {
    if (isStale || applyBlocked) return;
    if (!needsEscalate) {
      onConfirm({ second: false, empty: false });
      return;
    }
    if (stage === 0) {
      setStage(1);
      return;
    }
    if (emptyTarget && stage === 1) {
      setStage(2);
      return;
    }
    onConfirm({ second: true, empty: emptyTarget });
  };
  const sourceLine = [
    p.evidence?.source === "live" ? t("srcLive") : p.evidence?.source === "cache" ? t("srcCache").replace("{time}", String(p.evidence?.fetchedAt ?? "")) : null,
    p.catalogSource === "latest" ? t("srcLatest") : p.catalogSource === "overlay" ? t("srcOverlay") : t("srcLocal")
  ].filter(Boolean).join(" \xB7 ");
  const groupDefs = [
    { key: "groupAddable", items: rows.filter((r) => r.status === "addable") },
    { key: "groupListed", items: rows.filter((r) => r.status === "listed") },
    { key: "groupRemoval", items: removalRows, retain: true }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.modalMask, role: "dialog", "aria-modal": "true", onKeyDown: escCancel, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...styles.modal, background: surface.current.bg, color: surface.current.fg, height: "min(80vh, 680px)", padding: 0, overflow: "hidden" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "18px 20px 6px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: styles.modalTitle, children: t("manageModels") }),
      flow.staleNotice && !(!isStale && p.evidence?.source !== "live" && p.catalogSource === "latest") && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        t("previewStale")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: sourceLine }),
      isStale && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        t("srcStale")
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { flex: 1, overflowY: "auto", minHeight: 0, scrollbarGutter: "stable", padding: "0 20px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 0" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: { ...styles.button, ...styles.secondary, height: 24, fontSize: 12 },
            onClick: () => emitSel(/* @__PURE__ */ new Set([...addableIds, ...rawAllIds])),
            children: t("selectAll")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: { ...styles.button, ...styles.secondary, height: 24, fontSize: 12 },
            onClick: () => emitSel(new Set(lockedIds)),
            children: t("selectNone")
          }
        ),
        removalRows.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: { ...styles.button, ...styles.secondary, height: 24, fontSize: 12, ...locked ? { opacity: 0.5, cursor: "not-allowed" } : null },
            disabled: locked,
            title: locked ? t("removalNeedsLive") : void 0,
            onClick: () => emitSel(/* @__PURE__ */ new Set([...addableIds, ...rows.filter((r) => r.status === "listed").map((r) => r.id)])),
            children: t("alignAction")
          }
        )
      ] }),
      groupDefs.map(({ key, items, retain }) => items.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: { ...styles.modalText, fontWeight: 600, margin: "6px 0 2px" }, title: retain ? t("retain") : void 0, children: [
          t(key),
          "\uFF08",
          items.length,
          "\uFF09"
        ] }),
        items.map((r) => {
          const forceKept = r.status === "removal-proposal" && locked;
          const checked = forceKept || selected.has(r.id);
          return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked, disabled: forceKept, onChange: () => toggle(r.id) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.mono, children: r.id }),
            r.status === "removal-proposal" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.removed, fontSize: 12 }, children: t(r.reason === "unresolvable" ? "removedUnresolvable" : "removedAccount") }),
            r.customized === true && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.muted, fontSize: 12 }, children: t("customizedBadge") })
          ] }, r.id);
        })
      ] }, key)),
      (p.overridesMeta?.clearable || p.overridesMeta?.inheritedOnly) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { padding: "4px 0" }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: coChecked, disabled: !p.overridesMeta?.clearable, onChange: (e) => toggleClearOverrides(e.target.checked) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: p.overridesMeta?.clearable ? void 0 : { ...styles.muted, fontSize: 13 }, children: t(p.overridesMeta?.clearable ? "clearOverrides" : "inheritedOverrides") })
      ] }) }),
      (p.skipped ?? []).length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: styles.modalText, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("summary", { children: [
          t("skippedModels"),
          "\uFF08",
          p.skipped.length,
          "\uFF09"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: styles.diffList, children: p.skipped.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: styles.skipped, children: [
          s.id,
          " \u2014 ",
          s.reason
        ] }, s.id)) })
      ] }),
      ((p.diff?.warnings ?? []).length > 0 || p.catalogError) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: styles.modalText, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { children: t("techDetails") }),
        (p.diff?.warnings ?? []).length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: styles.diffList, children: (p.diff?.warnings ?? []).map((w, i) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: styles.skipped, children: [
          w.id,
          " \u2014 ",
          w.reason
        ] }, w.id ?? i)) }),
        p.catalogError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.mono, fontSize: 12 }, children: p.catalogError })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: "8px 20px 16px" }, children: [
      (removedCount > 0 || coChecked || stage >= 1) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginBottom: 4 }, children: [
        removedCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
          "\u26A0 ",
          t("removalRisk").replace("{count}", String(removedCount))
        ] }),
        coChecked && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
          "\u26A0 ",
          t("clearOverrides")
        ] }),
        stage >= 1 && removedCount === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
          "\u26A0 ",
          t("secondConfirm")
        ] }),
        emptyTarget && stage >= 2 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
          "\u26A0 ",
          t("clearRisk")
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.modalText, margin: 0 }, children: total === 0 && removedCount === 0 && (p.catalogNewEntries ?? 0) === 0 ? t("noChanges") : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        t("summaryLine").replace("{total}", String(total)).replace("{kept}", String(keptCount)).replace("{added}", String(addedCount)).replace("{removed}", String(removedCount)),
        (p.catalogNewEntries ?? 0) > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          " \xB7 ",
          t("catalogNotice").replace("{count}", String(p.catalogNewEntries))
        ] })
      ] }) }),
      removedCount > 0 && applyBlocked && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        t("removalNeedsLive")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.modalActions, children: [
        p.catalogSource === "local" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary, marginRight: "auto" }, onClick: onOverlay, children: t("overlayBtn") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { ref: cancelRef, type: "button", style: { ...styles.button, ...styles.secondary }, onClick: onCancel, children: t("cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: { ...styles.button, ...styles.primary, ...applyBlocked ? { opacity: 0.5, cursor: "not-allowed" } : null },
            disabled: applyBlocked,
            onClick: confirmClick,
            children: t("applyChanges")
          }
        )
      ] })
    ] })
  ] }) });
}
function RetireDialog({ t, onConfirm, onCancel }) {
  const cancelRef = (0, import_react.useRef)(null);
  const surface = (0, import_react.useRef)(null);
  if (!surface.current) surface.current = sampleThemeSurface();
  (0, import_react.useEffect)(() => {
    cancelRef.current?.focus();
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.modalMask, role: "dialog", "aria-modal": "true", onKeyDown: (e) => {
    if (e.key === "Escape") onCancel();
  }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...styles.modal, background: surface.current.bg, color: surface.current.fg, maxWidth: 420 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: styles.modalTitle, children: t("retireTitle") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: t("retireConfirmText") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.modalActions, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { ref: cancelRef, type: "button", style: { ...styles.button, ...styles.secondary }, onClick: onCancel, children: t("cancel") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary }, onClick: onConfirm, children: t("retireBtn") })
    ] })
  ] }) });
}
function ConfirmDialog({ title, body, confirmText, cancelText, onConfirm, onCancel }) {
  const cancelRef = (0, import_react.useRef)(null);
  const surface = (0, import_react.useRef)(null);
  if (!surface.current) surface.current = sampleThemeSurface();
  (0, import_react.useEffect)(() => {
    cancelRef.current?.focus();
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.modalMask, role: "dialog", "aria-modal": "true", onKeyDown: (e) => {
    if (e.key === "Escape") onCancel();
  }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...styles.modal, background: surface.current.bg, color: surface.current.fg, maxWidth: 460 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: styles.modalTitle, children: title }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: body }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.modalActions, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { ref: cancelRef, type: "button", style: { ...styles.button, ...styles.secondary }, onClick: onCancel, children: cancelText }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary }, onClick: onConfirm, children: confirmText })
    ] })
  ] }) });
}
function CopilotSection({ t = (key) => DICTS.en[key] ?? key }) {
  const [auth, setAuth] = (0, import_react.useState)({ phase: "loading", connectivity: "online", shared: false });
  const [copied, setCopied] = (0, import_react.useState)(false);
  const [copyFail, setCopyFail] = (0, import_react.useState)(false);
  const [logoutConfirm, setLogoutConfirm] = (0, import_react.useState)(false);
  const [flow, setFlow] = (0, import_react.useState)(initial);
  const flowRef = (0, import_react.useRef)(flow);
  const authFlowRef = (0, import_react.useRef)(null);
  if (!authFlowRef.current && typeof fetch === "function") {
    authFlowRef.current = createAuthFlow({ fetchImpl: fetch, onState: (s) => setAuth(s) });
  }
  const drive = (event) => advance(flowRef.current, event, fetch, (next) => {
    flowRef.current = next;
    setFlow(next);
  }).catch(() => {
  });
  (0, import_react.useEffect)(() => {
    drive({ type: "init" });
  }, []);
  (0, import_react.useEffect)(() => {
    void authFlowRef.current?.init();
    return () => authFlowRef.current?.dispose();
  }, []);
  const login = () => {
    setCopied(false);
    setCopyFail(false);
    void authFlowRef.current?.start();
  };
  const withdraw = () => {
    void authFlowRef.current?.cancel();
  };
  const checkStatus = () => {
    void authFlowRef.current?.refresh();
  };
  const doLogout = () => {
    setLogoutConfirm(false);
    void authFlowRef.current?.logout();
  };
  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyFail(false);
      setTimeout(() => setCopied(false), 2e3);
    } catch {
      setCopyFail(true);
    }
  };
  const phase = auth.phase;
  const attempt = auth.attempt;
  const notices = [...attempt?.notices ?? []].reverse();
  const codeNotice = typeof attempt?.code === "string" && attempt.code !== "" ? { code: attempt.code, url: attempt.url } : (() => {
    const n = notices.find((x) => x && typeof x.code === "string" && x.code !== "");
    return n ? { code: n.code, url: n.url } : null;
  })();
  const badgeText = phase === "risk" ? t("riskBadge") : phase === "loading" ? t("loading") : phase === "idle" && auth.error ? t("statusUnknown") : t(phase);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: styles.title, children: t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: t("intro") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.badgeRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.dot, background: badgeColor[phase] ?? "#adb5bd" } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.badge, children: badgeText })
    ] }),
    auth.connectivity !== "online" && phase !== "loading" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
      "\u26A0 ",
      t("connection")
    ] }),
    auth.connectivity === "manual" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: checkStatus, children: t("retryNow") }) }),
    phase === "waiting" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      auth.shared && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u24D8 ",
        t("attemptShared")
      ] }),
      codeNotice && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.codeHint, children: t("codeHint") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.codeRow, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.code, children: codeNotice.code }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: () => copyCode(codeNotice.code), children: copied ? t("copied") : t("copy") })
        ] }),
        codeNotice.url && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { style: styles.link, href: codeNotice.url, target: "_blank", rel: "noreferrer", children: codeNotice.url }),
        copyFail && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: t("copyFailed") })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: withdraw, children: t("withdrawAuth") }) })
    ] }),
    phase === "risk" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        t("authUnsafe")
      ] }),
      auth.riskKind === "withdrawal-pending-unverified" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: auth.withdrawalDelivery === "invoked" ? t("withdrawal") : t("withdrawalUnavailable") }),
      auth.riskKind === "timed-out-unverified" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: t("attemptTimeout") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: checkStatus, children: t("retryNow") }) })
    ] }),
    phase === "unavailable" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
      "\u26A0 ",
      t("unavailable")
    ] }),
    phase === "failed" && attempt?.error && (() => {
      const m = /^fetch failed \(([A-Za-z0-9_]+)\)$/.exec(attempt.error);
      if (!m) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: attempt.error });
      const code = m[1];
      const human = code === "ENOTFOUND" ? t("netDns") : code.startsWith("CERT") || code.includes("SIGNATURE") ? t("netCert") : t("netConnect");
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: human }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...styles.modalText, opacity: 0.6 }, children: attempt.error })
      ] });
    })(),
    phase === "failed" && !attempt?.error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        httpErrorText(t, auth.error) ?? t("unknown")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: checkStatus, children: t("retryNow") }) })
    ] }),
    phase === "idle" && auth.error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
      "\u26A0 ",
      httpErrorText(t, auth.error) ?? t("unknown")
    ] }),
    phase === "authorized" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }, children: [
        (() => {
          const logoutAvailable = auth.status?.authorization?.capabilities?.logout === true;
          return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              style: { ...styles.button, ...styles.secondary, ...logoutAvailable ? null : { opacity: 0.5, cursor: "not-allowed" } },
              disabled: !logoutAvailable,
              title: logoutAvailable ? t("logoutScope") : t("authUnsafe"),
              onClick: () => setLogoutConfirm(true),
              children: t("logout")
            }
          );
        })(),
        ["previewing", "applying", "checking", "retiring"].includes(flow.name) ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary, opacity: 0.5 }, disabled: true, children: flow.name === "applying" ? t("applying") : t("refreshing") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: { ...styles.button, ...styles.primary, ...refreshBlocked(flow.flags) ? { opacity: 0.5, cursor: "not-allowed" } : null },
            disabled: refreshBlocked(flow.flags),
            onClick: () => drive({ type: "start", operation: "manage" }),
            children: t("manageModels")
          }
        )
      ] }),
      auth.logoutError && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.error, children: [
        "\u26A0 ",
        auth.logoutError === "logout-unsafe" ? t("authUnsafe") : t("logoutFailed")
      ] }),
      refreshBlocked(flow.flags) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        blockedReasonText(t, flow.flags)
      ] }),
      flow.flags?.legacyStateDetected && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u24D8 ",
        t("legacy")
      ] }),
      flow.name === "pendingRestart" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u26A0 ",
        t("pendingRestart")
      ] }),
      flow.name === "busy" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
        "\u24D8 ",
        t("busy")
      ] }),
      flow.name === "resultUnknown" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.error, children: [
          "\u26A0 ",
          t("unknownResult")
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: () => drive({ type: "check" }), children: t("retryNow") }) })
      ] }),
      flow.name === "result" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        (() => {
          const st = flow.result?.status;
          const key = {
            applied: "applied",
            conflict: "conflict",
            partial: "partial",
            "rolled-back": "rolledBack",
            "rollback-conflict": "rollbackConflict",
            "recovery-needed": "recoveryNeeded",
            "intent-retired": "recoveryNeeded"
          }[st];
          return key ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: st === "applied" ? styles.banner : styles.error, children: [
            st === "applied" ? "\u2713" : "\u26A0",
            " ",
            t(key)
          ] }) : null;
        })(),
        ["recovery-needed", "rollback-conflict", "intent-retired"].includes(flow.result?.status) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: () => drive({ type: "retire-request" }), children: t("retireBtn") }) }),
        flow.result?.error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: styles.modalText, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { children: t("techDetails") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.mono, fontSize: 12 }, children: flow.result.error })
        ] })
      ] }),
      flow.name === "failed" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: flow.error === "state-corrupt" ? t("stateCorrupt") : flow.error })
    ] }),
    flow.name === "confirming" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      RefreshModal,
      {
        t,
        flow,
        onSelect: ({ selectedIds, clearOverrides, confirmEmpty }) => drive({ type: "select", selectedIds, clearOverrides, confirmEmpty }),
        onConfirm: (opts) => drive({ type: "confirm", ...opts }),
        onCancel: () => drive({ type: "cancel" }),
        onOverlay: () => drive({ type: "start", catalogSource: "overlay" })
      }
    ),
    flow.name === "retireConfirm" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      RetireDialog,
      {
        t,
        onConfirm: () => drive({ type: "retire-confirm" }),
        onCancel: () => drive({ type: "cancel" })
      }
    ),
    logoutConfirm && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      ConfirmDialog,
      {
        title: t("logout"),
        body: t("logoutScope"),
        confirmText: t("logout"),
        cancelText: t("cancel"),
        onCancel: () => setLogoutConfirm(false),
        onConfirm: doLogout
      }
    ),
    (phase === "idle" || phase === "failed") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary }, onClick: login, children: t("login") }) })
  ] });
}
function apply(ctx) {
  ctx.locale.register("copilot-auth", DICTS);
  const t = ctx.locale.bind("copilot-auth");
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "copilot", order: 11, label: () => t("nav"), inject: () => ({ t }) },
    CopilotSection
  ));
  startNavIconEnforcer(() => t("nav"));
}

		return module.exports;
	}
});
