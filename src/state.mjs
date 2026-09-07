// state.mjs — 持久状态的唯一读写层（薄层，落盘逻辑都在 atomic-json）。
// 状态文件：~/.dsh/copilot-auth-state.json（路径由 host 决定），原子写。
// lastError 规则（R3-6）：顶层 lastError/lastErrorAt 是唯一诊断面；journal 相位内
// 错误同时投影顶层；任一相位成功推进/消费时清除；state 损坏改名留存 .corrupt-<ts>
// 不覆盖，返回带 state-corrupt 的安全态，且后续普通保存不得抹掉留存文件。
import { renameSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./atomic-json.mjs";

export const STATE_VERSION = 1;
export const CATALOG_IDENTITY = { packageName: "@earendil-works/pi-ai", catalogSchemaVersion: 1 };
export const JOURNAL_PHASES = ["prepared", "catalog-committed-needs-restart"];
export const RESTART_REASONS = ["refresh", "self-heal"];

export function freshState() {
  return {
    version: STATE_VERSION,
    activated: false,
    restartState: null,
    appliedOverlay: {}, // 与 catalog 同构，不夹带插件私有字段
    appliedProvenance: null, // { sourcePiAiVersion, integrity, appliedAgainstPiAiVersion, catalogSchemaVersion: 1 }
    journal: null,
    lastError: null,
    lastErrorAt: null,
  };
}

export function loadState(path) {
  let raw;
  let corrupt = false;
  try {
    raw = readJson(path);
  } catch {
    corrupt = true;
  }
  if (!corrupt && raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    corrupt = true; // 解析成功但形状非法同样按损坏处理
  }
  if (corrupt) {
    // 解析失败/形状非法 → 改名留存 .corrupt-<ts>，返回安全态
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch { /* 改名失败不阻断安全态返回 */ }
    const s = freshState();
    s.lastError = "state-corrupt";
    s.lastErrorAt = new Date().toISOString();
    return s;
  }
  if (raw === undefined) return freshState();
  // 迁移：未知/缺失字段回落默认（当前仅 version 1）
  return { ...freshState(), ...raw, version: STATE_VERSION };
}

export function saveState(path, state) {
  writeJsonAtomic(path, state);
}

export function setLastError(state, error) {
  return { ...state, lastError: String(error?.message ?? error), lastErrorAt: new Date().toISOString() };
}

export function clearLastError(state) {
  return { ...state, lastError: null, lastErrorAt: null };
}

// journal 相位转移辅助：仅在 prepared → catalog-committed-needs-restart 单向前进。
export function createJournal({
  settingsBaseline, targetIds, pendingOverlay, appliedAgainstPiAiVersion,
  catalogBaselineDigest, patchedCatalogDigest, source,
}) {
  return {
    phase: "prepared",
    createdAt: new Date().toISOString(),
    appliedAgainstPiAiVersion,
    catalogIdentity: { ...CATALOG_IDENTITY },
    settingsBaseline, // raw user 层完整配置视图（R3-2）
    targetIds,
    pendingOverlay, // catalog-shaped 增量（R3-4），provenance 不夹带在条目里
    catalogBaselineDigest,
    patchedCatalogDigest,
    source, // { kind: "latest" | "overlay" | "local", piAiVersion?, integrity? }
    lastError: null,
  };
}

export function advanceJournal(journal) {
  if (journal?.phase !== "prepared") {
    throw new Error(`cannot advance journal from phase ${journal?.phase}`);
  }
  return { ...journal, phase: "catalog-committed-needs-restart" };
}

// restartState 只表达「目录写入需跨 boot 加载」（R3-5），不携带 settings 意图。
export function restartMarker(reason, expectedEntriesDigest) {
  if (!RESTART_REASONS.includes(reason)) {
    throw new Error(`unknown restart reason: ${reason}`);
  }
  return { reason, expectedEntriesDigest, since: new Date().toISOString() };
}
