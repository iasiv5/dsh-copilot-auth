// refresh-flow.mjs — 「管理模型列表」client 侧状态机（协议 v3，ADR 0005 / Q32–Q36）。
// reduce 为纯函数；runEffect/advance 只使用注入的 fetchImpl（node:test 可测）。
// 状态：idle → previewing → confirming（勾选→materialize 循环；缓存证据＋删除提案时
// 自动 live 升级：闩锁、硬失败回退 materialize、软降级置 staleNotice）→ applying →
// result / pendingRestart / checking / busy / resultUnknown；recovery-needed 经
// retireConfirm → retiring → 重新预览闭环。
// 关键规则：
//  - 勾选集合即终态；选择变化经 basePreviewId 从原快照 materialize（不重新取数）
//  - 确认门按实际 diff：removed>0 ∨ clearOverrides ∨ 空目标 → 二次确认；空目标另需 empty
//  - 升级判定覆盖两条 preview-ok 迁移路径（初始进入与 confirming 内原位替换）；
//    升级在途置 materializing（确认门拦截）；硬失败回退保留勾选，软降级置 staleNotice
//  - 423 转 status 查询；apply 网络不明先查同 operationId，绝不换 ID 重发
//  - 预览过期/漂移（409 preview-stale/auth-changed/preview-invalid）→ 自动重新预览
import { routes, PROTOCOL_VERSION } from "./shared.mjs";
import { requestJson } from "./client-http.mjs";

export const initial = Object.freeze({
  name: "idle",
  flags: { catalogMode: null, blockedReason: null, scopeAvailable: true, legacyStateDetected: false },
  lastResult: null,
});

const fromRefresh = (state, refresh) => ({
  ...state,
  flags: {
    catalogMode: refresh && "catalogMode" in refresh ? refresh.catalogMode : state.flags.catalogMode,
    blockedReason: refresh && "blockedReason" in refresh ? refresh.blockedReason : state.flags.blockedReason,
    scopeAvailable: refresh ? refresh.scopeAvailable !== false : state.flags.scopeAvailable,
    legacyStateDetected: refresh?.legacyStateDetected === true,
  },
  lastResult: refresh?.lastResult ?? null,
});

const restartStates = new Set(["pending-restart"]);

// 通道门控（T10 status refresh 块 → T11 入口禁用）：catalogMode ∈ file/registry/blocked/unknown。
// file/registry 可操作；blocked/unknown 或 scope 不可用 → 不承诺可应用，入口禁用（G02／设计§4.3）。
export function refreshBlocked(flags) {
  const mode = flags?.catalogMode;
  return flags?.scopeAvailable === false || mode === "blocked" || mode === "unknown";
}

// lastSelection → effect 选择字段（逐字段在场性复制；空对象 → 不带任何选择字段）
function selectionFields(lastSelection = {}) {
  const out = {};
  if (lastSelection.selectedIds !== undefined) out.selectedIds = lastSelection.selectedIds;
  if (lastSelection.clearOverrides !== undefined) out.clearOverrides = lastSelection.clearOverrides;
  if (lastSelection.confirmEmpty !== undefined) out.confirmEmpty = lastSelection.confirmEmpty;
  return out;
}

// 升级判定：删除提案 ∧ 有效缓存 ∧ latest 目录 ∧ 闩锁未用 → 发新鲜预览（不走 basePreviewId）。
// 初始默认预览的 lastSelection 为空对象 → 升级 effect 不带选择字段，服务端按 live 数据重算默认
// （全漂移 corner 因此不可能触发空目标确认，M01 弹窗必开）。
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
    ...selectionFields(state.lastSelection),
  };
}

// 进入 confirming（两条 preview-ok 迁移路径共用）：先落确认基态，再评估自动升级。
function enterConfirming({ flags, preview, staleNotice, lastSelection }) {
  const state = {
    name: "confirming",
    flags: flags ?? initial.flags,
    preview,
    staleNotice: staleNotice === true,
    materializing: false,
    awaitingUpgrade: false,
    liveUpgradeUsed: false,
    lastSelection: lastSelection ?? {},
  };
  const effect = upgradeCandidate(state);
  if (!effect) return [state, null];
  return [{ ...state, liveUpgradeUsed: true, awaitingUpgrade: true, materializing: true }, effect];
}

export function reduce(state, event) {
  switch (state.name) {
    case "idle":
    case "failed":
    case "result":
    case "pendingRestart":
    case "busy":
    case "resultUnknown": {
      if (event.type === "start") {
        // v3 单一操作：恒为 manage（无 legacy 字面量分支）
        return [{
          name: "previewing",
          flags: state.flags ?? initial.flags,
          operation: "manage",
          catalogSource: event.catalogSource,
          stale: false,
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
          confirmEmpty: event.confirmEmpty,
        }) };
        // 选择变化：从原快照 materialize（服务端重算，沿用原有效期，不重新取数）。
        // 留在 confirming＋materializing——弹窗保持挂载、不卸载重挂。
        return [{
          name: "confirming",
          flags: state.flags ?? initial.flags,
          preview: p,
          materializing: true,
          awaitingUpgrade: false,
          liveUpgradeUsed: state.liveUpgradeUsed ?? false,
          lastSelection,
          staleNotice: state.staleNotice,
        }, {
          type: "preview",
          operation: p.operation,
          catalogSource: p.catalogSource,
          basePreviewId: p.previewId,
          ...selectionFields(lastSelection),
        }];
      }
      if (event.type === "preview-ok") {
        // materialize/切源/升级完成：预览原位替换（新 previewId 绑定新选择）。
        // 升级软降级（R4-3）：落地后证据仍非 live → staleNotice（UI 据此禁用 apply）。
        const wasUpgrade = state.awaitingUpgrade === true;
        const landed = {
          name: "confirming",
          flags: state.flags ?? initial.flags,
          preview: event.preview,
          materializing: false,
          awaitingUpgrade: false,
          liveUpgradeUsed: state.liveUpgradeUsed ?? false,
          lastSelection: state.lastSelection ?? {},
          staleNotice: (wasUpgrade && event.preview?.evidence?.source !== "live") || state.staleNotice === true,
        };
        const effect = upgradeCandidate(landed);
        if (effect) return [{ ...landed, liveUpgradeUsed: true, awaitingUpgrade: true, materializing: true }, effect];
        return [landed, null];
      }
      if (event.type === "preview-fail") {
        if (state.awaitingUpgrade === true && p) {
          // 升级硬失败回退：以升级前快照 materialize（逐字段复制 lastSelection，保留勾选）；
          // 弹窗保持挂载；回退后再失败才落 failed。
          return [{
            name: "confirming",
            flags: state.flags ?? initial.flags,
            preview: p,
            materializing: true,
            awaitingUpgrade: false,
            liveUpgradeUsed: state.liveUpgradeUsed ?? true,
            lastSelection: state.lastSelection ?? {},
            staleNotice: true,
          }, {
            type: "preview",
            operation: p.operation,
            catalogSource: p.catalogSource,
            basePreviewId: p.previewId,
            ...selectionFields(state.lastSelection),
          }];
        }
        return [{ name: "failed", flags: state.flags ?? initial.flags, error: event.error }, null];
      }
      if (event.type === "start") {
        // 显式切源（overlay/local）：生成全新预览（不隐式降级，Q7）；留在 confirming 保持弹窗挂载
        return [{
          name: "confirming",
          flags: state.flags ?? initial.flags,
          preview: p,
          materializing: true,
          awaitingUpgrade: false,
          liveUpgradeUsed: state.liveUpgradeUsed ?? false,
          lastSelection: state.lastSelection ?? {},
          staleNotice: state.staleNotice,
        }, { type: "preview", operation: p.operation, catalogSource: event.catalogSource }];
      }
      if (event.type === "confirm") {
        if (state.materializing) return [state, null]; // 物化/升级在途不得用旧 previewId 应用
        if (p.evidence?.stale === true) return [state, null]; // stale 证据不可应用（Q7）
        // 单次确认（Q37 用户裁决）：破坏性意图已由固定底栏常驻风险线在操作前完整告知，
        // 不再要求二次点击；证据门（removals-need-live）由服务端独立兜底
        return [{ name: "applying", flags: state.flags ?? initial.flags, preview: p }, { type: "apply", previewId: p.previewId, operationId: p.operationId }];
      }
      if (event.type === "cancel") return [{ ...initial, flags: state.flags ?? initial.flags, lastResult: state.lastResult ?? null }, null];
      return [state, null];
    }
    case "applying": {
      if (event.type === "apply-ok") {
        return restartStates.has(event.result?.status ?? "")
          ? [{ ...state, name: "pendingRestart", result: event.result }, null]
          : [{ ...state, name: "result", result: event.result }, null];
      }
      if (event.type === "apply-stale") {
        // 预览过期/配置漂移/授权变化 → 自动重新预览（保持操作与来源）
        return [{
          name: "previewing",
          flags: state.flags ?? initial.flags,
          operation: state.preview.operation,
          catalogSource: state.preview.catalogSource,
          stale: true,
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
          return restartStates.has(event.lastResult?.status ?? "")
            ? [{ ...state, name: "pendingRestart", result: event.lastResult }, null]
            : [{ ...state, name: "result", result: event.lastResult }, null];
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

// 副作用执行器：effect → 结果事件。只经注入的 fetchImpl；错误经 requestJson 脱敏。
export async function runEffect(effect, fetchImpl) {
  const r = routes();
  const post = (url, body) => requestJson(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...body }),
  });
  if (effect.type === "preview") {
    // 选择字段按在场性组装（R1-9）：初始预览不带；materialize/升级/回退按 effect 实际字段携带
    const res = await post(r.refreshPreview, {
      operation: effect.operation,
      ...(effect.catalogSource ? { catalogSource: effect.catalogSource } : {}),
      ...(effect.basePreviewId !== undefined ? { basePreviewId: effect.basePreviewId } : {}),
      ...(effect.selectedIds !== undefined ? { selectedIds: effect.selectedIds } : {}),
      ...(effect.clearOverrides !== undefined ? { clearOverrides: effect.clearOverrides } : {}),
      ...(effect.confirmEmpty !== undefined ? { confirmEmpty: effect.confirmEmpty } : {}),
    });
    if (res.ok) return { type: "preview-ok", preview: res.body };
    return { type: "preview-fail", error: res.error?.details?.errorCode ?? res.error?.messageKey };
  }
  if (effect.type === "apply") {
    const res = await post(r.refreshApply, { previewId: effect.previewId, operationId: effect.operationId });
    if (res.ok) return { type: "apply-ok", result: res.body?.result ?? { status: "unknown" } };
    const code = res.error?.details?.errorCode ?? "";
    const status = res.httpStatus;
    if (status === null) return { type: "apply-unknown" }; // 网络不明：先查同 operationId，绝不换 ID 重发
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

// controller：reduce → 执行 effect → 结果事件回送 reduce → 循环至无 effect。
export async function advance(state, event, fetchImpl, onState) {
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
