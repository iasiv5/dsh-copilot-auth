// model-update.mjs — 纯模型变更策略（v3）：管理模型列表＝目标状态编辑（ADR 0005）。
// 纯函数，不触碰网络/磁盘/settings；视图形状与 host.mjs viewFromUserLayer 同构：
//   {modelsPresent, models, modelOverridesPresent, modelOverrides}
// 语义（设计§4.1/§4.2 2026-10-05 修订 / Q32–Q36）：
//  - 单一操作 manage：勾选集合即期望终态；selectedIds 缺省 → 在列∩(账号∩可解析)（与 UI 初始态一致）
//  - 被保留模型维持原对象/顺序/定制；被移除模型定制随模型消失（overrides 按 kept 过滤，
//    唯一定制模型被移除时 present:false → unset，防重加复活定制）
//  - rows：addable（账号∩可解析−在列）/ listed（在列∩(账号∩可解析)）/ removal-proposal
//    （在列−(账号∩可解析)，reason 优先级：不在账号→not-in-account，否则 unresolvable）
//  - removed：raw 在列全表−勾选；reason：not-in-account → unresolvable → unchecked（用户主动取消健康行）
//  - 空目标确认仅约束用户显式提交的空选择（selectedIds!==undefined）；确认后落显式空列表
//    （modelsPresent:true, models:[]，防 unset 后首次填充静默回填）
//  - clearOverrides：清除可清除定制（present:false）；仅继承覆盖（raw 缺失而 effective 有）→ 阻止该项
export function buildModelChange({
  operation,
  rawView,
  effectiveView,
  accountIds,
  resolvableIds,
  selectedIds,
  clearOverrides = false,
  confirmEmpty = false,
  catalogNewEntryCount = 0,
}) {
  if (operation !== "manage") {
    return {
      allowed: false, reason: "invalid-operation", targetView: null, rows: [], selectedIds: [],
      added: [], removed: [], kept: [], warnings: [], removalClass: false,
      overridesMeta: { rawPresent: false, clearable: false, inheritedOnly: false },
      writeSet: { catalogEntries: false, models: false, modelOverrides: false, overridesUnclearable: false },
    };
  }
  const accounts = [...new Set((Array.isArray(accountIds) ? accountIds : []).filter((x) => typeof x === "string"))];
  const resolvable = new Set((Array.isArray(resolvableIds) ? resolvableIds : []).filter((x) => typeof x === "string"));
  const raw = rawView ?? { modelsPresent: false, models: null, modelOverridesPresent: false, modelOverrides: null };
  const eff = effectiveView ?? raw;
  const rawModels = raw.modelsPresent && Array.isArray(raw.models) ? raw.models : [];
  const rawIds = rawModels.map((m) => m?.id).filter((x) => typeof x === "string");
  const rawIdSet = new Set(rawIds);
  const accountSet = new Set(accounts);
  const effModels = eff.modelsPresent && Array.isArray(eff.models) ? eff.models : [];
  void effModels;

  const overridesKeys = raw.modelOverridesPresent && raw.modelOverrides && typeof raw.modelOverrides === "object"
    ? Object.keys(raw.modelOverrides) : [];
  const rawPresent = overridesKeys.length > 0;
  const effOverrides = eff.modelOverridesPresent && eff.modelOverrides && typeof eff.modelOverrides === "object"
    ? Object.keys(eff.modelOverrides) : [];
  const inheritedOnly = !rawPresent && effOverrides.length > 0;
  const overridesMeta = { rawPresent, clearable: rawPresent, inheritedOnly };

  const inUniverse = (id) => accountSet.has(id) && resolvable.has(id);
  const addable = accounts.filter((id) => resolvable.has(id) && !rawIdSet.has(id));
  const addableSet = new Set(addable);
  const rows = [
    ...addable.map((id) => ({ id, status: "addable", customized: false })),
    ...rawIds.filter((id) => inUniverse(id)).map((id) => ({ id, status: "listed", customized: overridesKeys.includes(id) })),
    ...rawIds.filter((id) => !inUniverse(id)).map((id) => ({
      id,
      status: "removal-proposal",
      reason: accountSet.has(id) ? "unresolvable" : "not-in-account",
      customized: overridesKeys.includes(id),
    })),
  ];

  // 选择规范化：缺省 → listed（与 UI 初始勾选态一致）；显式（含 []）→ 用户意图
  const explicitSelection = selectedIds !== undefined;
  const requested = explicitSelection
    ? [...new Set((Array.isArray(selectedIds) ? selectedIds : []).filter((x) => typeof x === "string"))]
    : rawIds.filter((id) => inUniverse(id));
  const selectedSet = new Set(requested);
  const warnings = [];
  for (const id of requested) {
    if (addableSet.has(id) || rawIdSet.has(id)) continue;
    warnings.push({ id, reason: accountSet.has(id) && !resolvable.has(id) ? "unresolvable" : "invalid-selection" });
  }

  const kept = rawIds.filter((id) => selectedSet.has(id));
  const keptSet = new Set(kept);
  const added = addable.filter((id) => selectedSet.has(id));
  const removed = rawIds
    .filter((id) => !selectedSet.has(id))
    .map((id) => ({
      id,
      reason: !accountSet.has(id) ? "not-in-account" : !resolvable.has(id) ? "unresolvable" : "unchecked",
    }));
  const removalClass = removed.length > 0;

  if (clearOverrides && inheritedOnly) {
    return {
      allowed: false, reason: "inherited-overrides-unclearable", targetView: null, rows, selectedIds: requested,
      added, removed, kept, warnings, removalClass,
      overridesMeta,
      writeSet: { catalogEntries: catalogNewEntryCount > 0, models: false, modelOverrides: false, overridesUnclearable: true },
    };
  }
  if (explicitSelection && rawIds.length > 0 && requested.length === 0 && !confirmEmpty) {
    return {
      allowed: false, reason: "empty-target-unconfirmed", targetView: null, rows, selectedIds: requested,
      added, removed, kept, warnings, removalClass,
      overridesMeta,
      writeSet: { catalogEntries: catalogNewEntryCount > 0, models: false, modelOverrides: false, overridesUnclearable: false },
    };
  }

  const keptRawModels = rawModels.filter((m) => keptSet.has(m?.id));
  const modelsPresent = raw.modelsPresent || requested.length > 0;
  const models = modelsPresent ? [...keptRawModels, ...added.map((id) => ({ id }))] : null;
  const clearable = rawPresent;
  let modelOverridesPresent;
  let modelOverrides;
  if (clearOverrides && clearable) {
    modelOverridesPresent = false;
    modelOverrides = null;
  } else if (rawPresent) {
    const filtered = {};
    for (const key of overridesKeys) if (keptSet.has(key)) filtered[key] = raw.modelOverrides[key];
    modelOverridesPresent = Object.keys(filtered).length > 0;
    modelOverrides = modelOverridesPresent ? filtered : null;
  } else {
    modelOverridesPresent = raw.modelOverridesPresent;
    modelOverrides = raw.modelOverrides;
  }

  return {
    allowed: true,
    reason: null,
    rows,
    selectedIds: requested,
    added,
    removed,
    kept,
    warnings,
    removalClass,
    overridesMeta,
    targetView: { modelsPresent, models, modelOverridesPresent, modelOverrides },
    writeSet: {
      catalogEntries: catalogNewEntryCount > 0,
      models: added.length > 0 || removalClass || (!raw.modelsPresent && requested.length > 0),
      modelOverrides: clearOverrides && clearable,
      overridesUnclearable: false,
    },
  };
}
