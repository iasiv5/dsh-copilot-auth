// model-update.mjs — 纯模型变更策略（T6）：补充/重建的目标视图、增删保留与原因、writeSet。
// 纯函数，不触碰网络/磁盘/settings；视图形状与 host.mjs viewFromUserLayer 同构：
//   {modelsPresent, models, modelOverridesPresent, modelOverrides}
// 语义（设计§4.1 / Q1/Q5/Q6/Q8/Q15）：
//  - 补充：保留全部现有对象/顺序/modelOverrides，仅追加勾选且可解析去重后的候选；默认空选择
//  - 重建：目标＝账号∩可解析 的纯 {id} 列表，清空本路由 modelOverrides；空交集需 confirmEmpty
//  - 继承限制：base 继承的 modelOverrides（raw 缺失而 effective 存在）无法经用户层 unset 清除 → 受限
//  - 不可解析现有项保留＋warning，不暗删
export function buildModelChange({
  operation,
  rawView,
  effectiveView,
  accountIds,
  resolvableIds,
  selectedIds,
  confirmEmpty = false,
  catalogNewEntryCount = 0,
}) {
  if (operation !== "supplement" && operation !== "rebuild") {
    return { allowed: false, reason: "invalid-operation", targetView: null, added: [], removed: [], kept: [], warnings: [{ reason: "invalid-operation" }], writeSet: { catalogEntries: false, models: false, modelOverrides: false } };
  }
  const accounts = [...new Set((Array.isArray(accountIds) ? accountIds : []).filter((x) => typeof x === "string"))];
  const resolvable = new Set((Array.isArray(resolvableIds) ? resolvableIds : []).filter((x) => typeof x === "string"));
  const raw = rawView ?? { modelsPresent: false, models: null, modelOverridesPresent: false, modelOverrides: null };
  const eff = effectiveView ?? raw;
  const rawModels = raw.modelsPresent && Array.isArray(raw.models) ? raw.models : [];
  const rawIds = rawModels.map((m) => m?.id).filter((x) => typeof x === "string");
  const effModels = eff.modelsPresent && Array.isArray(eff.models) ? eff.models : [];
  const effIds = effModels.map((m) => m?.id).filter((x) => typeof x === "string");
  const warnings = [];
  for (const id of rawIds) {
    if (!resolvable.has(id)) warnings.push({ id, reason: "unresolvable" });
  }
  const catalogEntries = catalogNewEntryCount > 0;

  if (operation === "supplement") {
    const existing = new Set(rawIds);
    const candidates = accounts.filter((id) => resolvable.has(id) && !existing.has(id));
    const candidateSet = new Set(candidates);
    const seen = new Set();
    const added = [];
    for (const id of Array.isArray(selectedIds) ? selectedIds : []) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      if (candidateSet.has(id)) {
        added.push(id);
      } else if (existing.has(id)) {
        warnings.push({ id, reason: "already-configured" });
      } else if (accounts.includes(id) && !resolvable.has(id)) {
        warnings.push({ id, reason: "unresolvable" });
      } else {
        warnings.push({ id, reason: "invalid-selection" });
      }
    }
    const models = added.length > 0 ? [...rawModels, ...added.map((id) => ({ id }))] : rawModels;
    const modelsPresent = raw.modelsPresent || added.length > 0;
    const overridesUnclearable = false;
    return {
      allowed: true,
      reason: null,
      candidates, // 候选＝账号∩可解析−已有（Q5：默认全不勾选，勾选后 materialize 新预览）
      targetView: {
        modelsPresent,
        models: modelsPresent ? models : null,
        modelOverridesPresent: raw.modelOverridesPresent,
        modelOverrides: raw.modelOverrides,
      },
      added,
      removed: [],
      kept: effIds.filter((id) => existing.has(id)),
      warnings,
      writeSet: { catalogEntries, models: added.length > 0, modelOverrides: false, overridesUnclearable },
    };
  }

  // rebuild
  const effOverrides = eff.modelOverridesPresent && eff.modelOverrides && typeof eff.modelOverrides === "object"
    ? Object.keys(eff.modelOverrides) : [];
  if (!raw.modelOverridesPresent && effOverrides.length > 0) {
    return {
      allowed: false,
      reason: "inherited-overrides-unclearable",
      targetView: null, added: [], removed: [], kept: [], warnings,
      writeSet: { catalogEntries, models: false, modelOverrides: false, overridesUnclearable: true },
    };
  }
  const intersection = accounts.filter((id) => resolvable.has(id));
  if (intersection.length === 0 && !confirmEmpty) {
    return {
      allowed: false,
      reason: "empty-intersection-unconfirmed",
      targetView: null, added: [], removed: [], kept: [], warnings,
      writeSet: { catalogEntries, models: false, modelOverrides: false, overridesUnclearable: false },
    };
  }
  const target = new Set(intersection);
  const accountSet = new Set(accounts);
  const removed = effIds
    .filter((id) => !target.has(id))
    .map((id) => ({ id, reason: accountSet.has(id) ? "unresolvable" : "not-in-account" }));
  const rawOverridesPresent = raw.modelOverridesPresent && raw.modelOverrides && Object.keys(raw.modelOverrides).length > 0;
  return {
    allowed: true,
    reason: null,
    candidates: null, // 重建目标固定为账号∩可解析交集，无逐项勾选
    targetView: {
      modelsPresent: true,
      models: intersection.map((id) => ({ id })),
      modelOverridesPresent: false,
      modelOverrides: null,
    },
    added: intersection.filter((id) => !new Set(effIds).has(id)),
    removed,
    kept: intersection.filter((id) => new Set(effIds).has(id)),
    warnings,
    writeSet: { catalogEntries, models: true, modelOverrides: rawOverridesPresent, overridesUnclearable: false },
  };
}
