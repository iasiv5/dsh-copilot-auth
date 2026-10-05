// T6（v3）：buildModelChange manage 目标状态语义——rows 三态、增删留与原因、
// 定制随模型走、空目标显式确认、clearOverrides、writeSet。
import test from "node:test";
import assert from "node:assert/strict";
import { buildModelChange } from "../src/model-update.mjs";

const view = (models, modelOverrides = null) => ({
  modelsPresent: models !== null,
  models,
  modelOverridesPresent: modelOverrides !== null,
  modelOverrides,
});

// 账号：a/d/e 在账号且可解析；dead-cat 在账号但不可解析；b 可解析；ghost 两者皆非
const BASE = {
  operation: "manage",
  accountIds: ["a", "b", "c", "d", "dead-cat", "e"],
  resolvableIds: ["a", "b", "c", "d", "e"],
};

test("默认选择＝在列∩(账号∩可解析)：健康在列全保（对象/顺序逐字）、writeSet 全 false", () => {
  const models = [{ id: "a", displayName: "我的A" }, { id: "b" }, { id: "c", maxTokens: 99 }];
  const raw = view(models, { a: { displayName: "x" } });
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.selectedIds, ["a", "b", "c"]);
  assert.deepEqual(r.targetView.models, models, "现有对象逐字保留（含顺序与定制字段）");
  assert.deepEqual(r.targetView.modelOverrides, { a: { displayName: "x" } });
  assert.equal(r.targetView.modelOverridesPresent, true);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.removed, []);
  assert.equal(r.removalClass, false);
  assert.deepEqual(r.writeSet, { catalogEntries: false, models: false, modelOverrides: false, overridesUnclearable: false });
});

test("默认选择漂移：removal-proposal 全部进 removed 且带原因，removalClass=true", () => {
  const raw = view([{ id: "a" }, { id: "dead-acc" }, { id: "dead-cat" }]);
  const r = buildModelChange({
    ...BASE, accountIds: ["a", "dead-cat", "e"], resolvableIds: ["a", "e"],
    rawView: raw, effectiveView: raw,
  });
  assert.deepEqual(r.removed, [
    { id: "dead-acc", reason: "not-in-account" },
    { id: "dead-cat", reason: "unresolvable" },
  ]);
  assert.equal(r.removalClass, true);
  assert.deepEqual(r.selectedIds, ["a"]);
  assert.deepEqual(r.added, []);
});

test("勾选候选：追加末尾且按账号预览顺序（与勾选顺序无关）", () => {
  const raw = view([{ id: "a" }]);
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, selectedIds: ["a", "c", "b"] });
  assert.deepEqual(r.removed, [], "在列行保持勾选 → 无移除");
  assert.deepEqual(r.added, ["b", "c"], "候选按账号报告顺序追加");
  assert.deepEqual(r.targetView.models, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(r.targetView.modelsPresent, true);
  assert.equal(r.writeSet.models, true);
});

test("取消勾选：健康行 reason=unchecked；removal-proposal 行按原因；定制随移除消失、其他保留", () => {
  const raw = view(
    [{ id: "a", displayName: "定制A" }, { id: "b" }, { id: "dead-acc" }, { id: "dead-cat" }],
    { a: { displayName: "x" }, "dead-acc": { y: 1 } },
  );
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, selectedIds: ["a"] });
  assert.deepEqual(r.removed, [
    { id: "b", reason: "unchecked" },
    { id: "dead-acc", reason: "not-in-account" },
    { id: "dead-cat", reason: "unresolvable" },
  ]);
  assert.equal(r.removalClass, true);
  assert.deepEqual(r.targetView.modelOverrides, { a: { displayName: "x" } }, "被移除模型定制不保留，其他保留");
  assert.equal(r.targetView.modelOverridesPresent, true);
  assert.equal(r.writeSet.models, true);
});

test("取消勾选唯一定制模型 → modelOverridesPresent:false（unset 防重加复活定制）", () => {
  const raw = view([{ id: "a" }, { id: "b" }], { a: { displayName: "x" } });
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, selectedIds: ["b"] });
  assert.deepEqual(r.removed, [{ id: "a", reason: "unchecked" }]);
  assert.equal(r.targetView.modelOverridesPresent, false);
  assert.equal(r.targetView.modelOverrides, null);
});

test("挽留：removal-proposal 行显式勾选 → 进 kept、不进 removed、其定制保留", () => {
  const raw = view([{ id: "a" }, { id: "dead-acc" }], { "dead-acc": { y: 1 } });
  const r = buildModelChange({
    ...BASE, accountIds: ["a"], resolvableIds: ["a"],
    rawView: raw, effectiveView: raw, selectedIds: ["a", "dead-acc"],
  });
  assert.deepEqual(r.kept, ["a", "dead-acc"]);
  assert.deepEqual(r.removed, []);
  assert.equal(r.removalClass, false);
  assert.deepEqual(r.targetView.modelOverrides, { "dead-acc": { y: 1 } });
  assert.equal(r.writeSet.models, false, "勾选集＝原集合 → 零变化");
});

test("rows 三态、customized 标记与原因优先级；rows 不随勾选变化", () => {
  const raw = view([{ id: "a" }, { id: "dead-acc" }, { id: "dead-cat" }], { a: { o: 1 }, "dead-acc": { p: 2 } });
  const inputs = { ...BASE, accountIds: ["a", "dead-cat", "e"], resolvableIds: ["a", "e"], rawView: raw, effectiveView: raw };
  const r = buildModelChange({ ...inputs, selectedIds: [], confirmEmpty: true });
  const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.deepEqual(byId.e, { id: "e", status: "addable", customized: false });
  assert.deepEqual(byId.a, { id: "a", status: "listed", customized: true });
  assert.deepEqual(byId["dead-acc"], { id: "dead-acc", status: "removal-proposal", reason: "not-in-account", customized: true });
  assert.deepEqual(byId["dead-cat"], { id: "dead-cat", status: "removal-proposal", reason: "unresolvable", customized: false });
  const r2 = buildModelChange({ ...inputs, selectedIds: ["a", "e"] });
  assert.deepEqual(r2.rows, r.rows, "rows 按来源固定，不随勾选迁移");
});

test("clearOverrides：布尔清零、值置 null、writeSet.modelOverrides=true、meta 就位", () => {
  const raw = view([{ id: "a" }, { id: "b" }], { a: { displayName: "x" } });
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, clearOverrides: true });
  assert.equal(r.allowed, true);
  assert.equal(r.targetView.modelOverridesPresent, false);
  assert.equal(r.targetView.modelOverrides, null);
  assert.equal(r.writeSet.modelOverrides, true);
  assert.deepEqual(r.overridesMeta, { rawPresent: true, clearable: true, inheritedOnly: false });
});

test("clearOverrides 且仅继承覆盖 → allowed:false inherited-overrides-unclearable", () => {
  const raw = view([{ id: "a" }], null);
  const eff = view([{ id: "a" }], { a: { inherited: true } });
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: eff, clearOverrides: true });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "inherited-overrides-unclearable");
  assert.equal(r.writeSet.overridesUnclearable, true);
  assert.deepEqual(r.overridesMeta, { rawPresent: false, clearable: false, inheritedOnly: true });
});

test("空目标：显式 [] 需 confirmEmpty；确认后落显式空列表；rawIds=0 无需确认；默认路径全漂移放行", () => {
  const raw = view([{ id: "a" }, { id: "b" }]);
  const denied = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, selectedIds: [] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "empty-target-unconfirmed");
  const ok = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, selectedIds: [], confirmEmpty: true });
  assert.equal(ok.allowed, true);
  assert.equal(ok.targetView.modelsPresent, true, "显式空列表＝已配置（防首次填充回填）");
  assert.deepEqual(ok.targetView.models, []);
  assert.equal(ok.writeSet.models, true);
  const emptyCfg = view([]);
  const noop = buildModelChange({ ...BASE, rawView: emptyCfg, effectiveView: emptyCfg, selectedIds: [] });
  assert.equal(noop.allowed, true, "rawIds=0 无清除对象，不需要 confirmEmpty");
  assert.equal(noop.writeSet.models, false);
  const drift = buildModelChange({
    ...BASE, accountIds: ["x2", "e"], resolvableIds: ["e"],
    rawView: view([{ id: "x1" }, { id: "x2" }]), effectiveView: view([{ id: "x1" }, { id: "x2" }]),
  });
  assert.equal(drift.allowed, true, "默认路径（无 selectedIds）不受空目标确认约束");
  assert.deepEqual(drift.removed, [
    { id: "x1", reason: "not-in-account" },
    { id: "x2", reason: "unresolvable" },
  ]);
  assert.equal(drift.removalClass, true);
});

test("无配置零选择：无操作；目录增量只进 catalogEntries", () => {
  const raw = view(null);
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.selectedIds, []);
  assert.equal(r.targetView.modelsPresent, false);
  assert.deepEqual(r.writeSet, { catalogEntries: false, models: false, modelOverrides: false, overridesUnclearable: false });
  const withCatalog = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, catalogNewEntryCount: 2 });
  assert.equal(withCatalog.writeSet.catalogEntries, true);
  assert.equal(withCatalog.writeSet.models, false);
});

test("非法选择过滤＋warnings（去重保序）；非 manage operation 拒绝", () => {
  const raw = view([{ id: "a" }]);
  const r = buildModelChange({ ...BASE, rawView: raw, effectiveView: raw, selectedIds: ["a", "a", "b", "ghost", "dead-cat"] });
  assert.deepEqual(r.selectedIds, ["a", "b", "ghost", "dead-cat"], "去重保序，非法不过滤只警告");
  assert.ok(r.warnings.some((w) => w.id === "ghost" && w.reason === "invalid-selection"));
  assert.ok(r.warnings.some((w) => w.id === "dead-cat" && w.reason === "unresolvable"), "在账号但不可解析且不在列 → unresolvable");
  assert.deepEqual(r.added, ["b"]);
  const bad = buildModelChange({ ...BASE, operation: "supplement", rawView: raw, effectiveView: raw, selectedIds: [] });
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, "invalid-operation");
  const bad2 = buildModelChange({ ...BASE, operation: "rebuild", rawView: raw, effectiveView: raw, selectedIds: [] });
  assert.equal(bad2.allowed, false);
  assert.equal(bad2.reason, "invalid-operation");
});
