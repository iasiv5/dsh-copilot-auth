// state.mjs — 持久状态的唯一读写层（薄层，落盘逻辑都在 atomic-json）。
// v1.2.8 起 v1 函数族（loadState/saveState/journal 系列）已删除：生产路径自 v2 只走
// schema 2 函数（loadRefreshState/saveRefreshState），v1 全局状态文件自 T10 起只读检测。
// restartMarker 为 v2 事务内核（refresh-transaction.mjs）仍在使用的 restartState 构造器。
// 损坏语义（沿用 v1 规则）：解析失败/形状非法 → 改名留存 .corrupt-<ts> 不覆盖，
// 返回带 state-corrupt 的安全态，且后续普通保存不得抹掉留存文件。
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./atomic-json.mjs";

export const RESTART_REASONS = ["refresh", "self-heal"];

// restartState 只表达「目录写入需跨 boot 加载」，不携带 settings 意图。
export function restartMarker(reason, expectedEntriesDigest) {
  if (!RESTART_REASONS.includes(reason)) {
    throw new Error(`unknown restart reason: ${reason}`);
  }
  return { reason, expectedEntriesDigest, since: new Date().toISOString() };
}

// ==================== schema 2：profile 隔离的刷新状态（T7） ====================
// 文件：<dataDir>/refresh-state.json（dataDir 由 runtime-scope 解析，profile 私有）。
// 旧 v1 全局文件（~/.dsh/copilot-auth-state.json）只读检测（legacyStateDetected），
// 绝不自动消费其 journal/overlay——历史条目经新 preview 重新确认采用（Q14/Q19）。
// 损坏改名留存 .corrupt-<ts> 不覆盖，沿用 v1 语义；未知 version 拒绝执行并保留原件。
export const REFRESH_STATE_VERSION = 2;

export function freshRefreshState(profileId) {
  return {
    version: REFRESH_STATE_VERSION,
    profileId: profileId ?? null,
    activated: false,
    appliedOverlay: {},
    appliedProvenance: null,
    intentVersion: 0, // 信息性镜像：权威来源是 auth-intent.json（T3）
    activeOperation: null,
    lastResult: null,
    restartState: null,
    lastError: null,
    lastErrorAt: null,
  };
}

export function refreshStateFile(scope) {
  return join(scope.dataDir, "refresh-state.json");
}

export function loadRefreshState(scope, { legacyPath } = {}) {
  if (!scope?.known) {
    return { state: freshRefreshState(null), flags: { scopeUnavailable: true } };
  }
  const path = refreshStateFile(scope);
  let raw;
  let corrupt = false;
  try {
    raw = readJson(path);
  } catch {
    corrupt = true;
  }
  if (!corrupt && raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    corrupt = true;
  }
  if (corrupt) {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch { /* 改名失败不阻断安全态返回 */ }
    const s = freshRefreshState(scope.profileId);
    s.lastError = "state-corrupt";
    s.lastErrorAt = new Date().toISOString();
    return { state: s, flags: {} };
  }
  if (raw === undefined) {
    const flags = {};
    if (legacyPath && existsSync(legacyPath)) flags.legacyStateDetected = true;
    return { state: freshRefreshState(scope.profileId), flags };
  }
  if (raw.version !== REFRESH_STATE_VERSION) {
    // 未来/未知 schema：原件保留，不解析不消费，调用方禁写（要求重新预览/人工核实）
    return { state: null, flags: { unknownVersion: true, preservedPath: path } };
  }
  return { state: { ...freshRefreshState(scope.profileId), ...raw, version: REFRESH_STATE_VERSION }, flags: {} };
}

export function saveRefreshState(scope, state) {
  if (!scope?.known) throw new Error("scope-unavailable");
  if (!state || state.version !== REFRESH_STATE_VERSION) {
    throw new Error("refuse-save-unknown-version");
  }
  mkdirSync(scope.dataDir, { recursive: true });
  writeJsonAtomic(refreshStateFile(scope), state);
}

export function setRefreshError(state, error) {
  return { ...state, lastError: String(error?.message ?? error), lastErrorAt: new Date().toISOString() };
}

export function clearRefreshError(state) {
  return { ...state, lastError: null, lastErrorAt: null };
}
