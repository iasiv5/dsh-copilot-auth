// T6：buildModelChange 纯策略——补充/重建、writeSet、继承限制。
import test from "node:test";
import assert from "node:assert/strict";
import { buildModelChange } from "../src/model-update.mjs";

const view = (models, modelOverrides = null) => ({
  modelsPresent: models !== null,
  models,
  modelOverridesPresent: modelOverrides !== null,
  modelOverrides,
});
const RAW_EMPTY = view(null, null);

test("补充：默认空选择 → 列表零变化、完整保留对象/顺序/modelOverrides", () => {
  const models = [{ id: "a", displayName: "我的A" }, { id: "b" }, { id: "c", maxTokens: 99 }];
  const raw = view(models, { a: { displayName: "x" } });
  const r = buildModelChange({
    operation: "supplement", rawView: raw, effectiveView: raw,
    accountIds: ["a", "b", "c", "d"], resolvableIds: ["a", "b", "c", "d", "e"], selectedIds: [],
  });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.targetView.models, models, "现有对象逐字保留（含顺序与定制字段）");
  assert.deepEqual(r.targetView.modelOverrides, { a: { displayName: "x" } });
  assert.deepEqual(r.added, []);
  assert.equal(r.writeSet.models, false);
  assert.equal(r.writeSet.modelOverrides, false);
});

test("补充：勾选追加——只接受可解析且去重，非法选择进 warnings", () => {
  const raw = view([{ id: "a" }]);
  const r = buildModelChange({
    operation: "supplement", rawView: raw, effectiveView: raw,
    accountIds: ["b", "c", "ghost"], resolvableIds: ["a", "b", "c", "d"],
    selectedIds: ["b", "b", "c", "d", "ghost", "a"],
  });
  assert.deepEqual(r.added, ["b", "c"], "ghost 不可解析、d 不在账号列表、a 已存在，均不入列");
  assert.deepEqual(r.targetView.models, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.ok(r.warnings.some((w) => w.id === "ghost" && w.reason === "unresolvable"));
  assert.ok(r.warnings.some((w) => w.id === "a" && w.reason === "already-configured"));
  assert.ok(r.warnings.some((w) => w.id === "d" && w.reason === "invalid-selection"), "不在账号列表的选择无效");
  assert.equal(r.writeSet.models, true);
});

test("补充：raw 未配置 models 时勾选创建列表；零勾选保持未配置", () => {
  const r1 = buildModelChange({
    operation: "supplement", rawView: RAW_EMPTY, effectiveView: RAW_EMPTY,
    accountIds: ["a", "b"], resolvableIds: ["a", "b"], selectedIds: ["b"],
  });
  assert.deepEqual(r1.targetView.models, [{ id: "b" }]);
  assert.equal(r1.targetView.modelsPresent, true);
  const r2 = buildModelChange({
    operation: "supplement", rawView: RAW_EMPTY, effectiveView: RAW_EMPTY,
    accountIds: ["a"], resolvableIds: ["a"], selectedIds: [],
  });
  assert.equal(r2.targetView.modelsPresent, false, "零勾选不创建配置");
  assert.equal(r2.writeSet.models, false);
});

test("重建：纯 ID 列表＋清空本路由 modelOverrides；removed 带原因；kept 就位", () => {
  const raw = view([{ id: "a", displayName: "定制" }, { id: "dead" }], { a: { displayName: "x" }, dead: { y: 1 } });
  const r = buildModelChange({
    operation: "rebuild", rawView: raw, effectiveView: raw,
    accountIds: ["b", "a", "ghost"], resolvableIds: ["a", "b"], selectedIds: [], confirmEmpty: false,
  });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.targetView.models, [{ id: "b" }, { id: "a" }], "按账号顺序的纯 ID 条目");
  assert.equal(r.targetView.modelOverridesPresent, false, "重建清空本路由 modelOverrides");
  assert.deepEqual(r.added, ["b"]);
  assert.deepEqual(r.removed, [{ id: "dead", reason: "not-in-account" }], "dead 不在账号列表");
  assert.deepEqual(r.kept, ["a"]);
  assert.equal(r.writeSet.models, true);
  assert.equal(r.writeSet.modelOverrides, true);
});

test("重建：账号有但目录不可解析的现有项按 unresolvable 移除", () => {
  const raw = view([{ id: "ghost" }, { id: "a" }]);
  const r = buildModelChange({
    operation: "rebuild", rawView: raw, effectiveView: raw,
    accountIds: ["ghost", "a"], resolvableIds: ["a"], selectedIds: [],
  });
  assert.deepEqual(r.removed, [{ id: "ghost", reason: "unresolvable" }]);
});

test("重建：空交集需 confirmEmpty=true 才允许", () => {
  const raw = view([{ id: "a" }]);
  const base = { operation: "rebuild", rawView: raw, effectiveView: raw, accountIds: [], resolvableIds: ["a"], selectedIds: [] };
  const denied = buildModelChange({ ...base, confirmEmpty: false });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "empty-intersection-unconfirmed");
  const ok = buildModelChange({ ...base, confirmEmpty: true });
  assert.equal(ok.allowed, true);
  assert.deepEqual(ok.targetView.models, []);
  assert.deepEqual(ok.removed, [{ id: "a", reason: "not-in-account" }]);
});

test("重建：base 继承的 modelOverrides 无法经用户层清除 → 受限并说明", () => {
  const raw = view([{ id: "a" }], null);
  const eff = view([{ id: "a" }], { a: { displayName: "base 定制" } });
  const r = buildModelChange({
    operation: "rebuild", rawView: raw, effectiveView: eff,
    accountIds: ["a"], resolvableIds: ["a"], selectedIds: [],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "inherited-overrides-unclearable");
});

test("补充：不可解析的现有项保留并出 warning（不暗删，Q15）", () => {
  const raw = view([{ id: "a" }, { id: "ghost" }]);
  const r = buildModelChange({
    operation: "supplement", rawView: raw, effectiveView: raw,
    accountIds: ["a", "b"], resolvableIds: ["a", "b"], selectedIds: ["b"],
  });
  assert.deepEqual(r.targetView.models.map((m) => m.id), ["a", "ghost", "b"], "ghost 保留原位");
  assert.ok(r.warnings.some((w) => w.id === "ghost" && w.reason === "unresolvable"));
});

test("writeSet：目录增量独立成维（零勾选＋目录增量不是 no-change）", () => {
  const raw = view([{ id: "a" }]);
  const r = buildModelChange({
    operation: "supplement", rawView: raw, effectiveView: raw,
    accountIds: ["a", "b"], resolvableIds: ["a", "b"], selectedIds: [], catalogNewEntryCount: 2,
  });
  assert.equal(r.writeSet.catalogEntries, true);
  assert.equal(r.writeSet.models, false);
  assert.equal(r.writeSet.modelOverrides, false);
});
