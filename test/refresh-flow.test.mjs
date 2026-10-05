// T11（v3）：客户端模型流——manage 勾选 materialize、diff 化确认门、自动 live 升级
// （闩锁/回退/软降级）、423/unknown、retire 闭环、预览过期重置、显式切源、双击安全、
// 通道门控（blocked/unknown/scope 不可用）。
import test from "node:test";
import assert from "node:assert/strict";
import { initial, reduce, advance, refreshBlocked } from "../src/refresh-flow.mjs";
import { PROTOCOL_VERSION } from "../src/shared.mjs";

const jsonResponse = (spec) => ({
  status: spec.status ?? 200,
  ok: (spec.status ?? 200) >= 200 && (spec.status ?? 200) < 300,
  headers: { get: () => "application/json" },
  text: async () => JSON.stringify(spec.body ?? { ok: true }),
});

const row = (id, status, extra = {}) => ({ id, status, customized: false, ...extra });
const previewBody = (over = {}) => ({
  ok: true,
  previewId: over.previewId ?? "pv-1",
  operationId: over.operationId ?? "op-1",
  operation: "manage",
  expiresAt: "2026-10-04T12:00:00.000Z",
  evidence: over.evidence ?? { source: "live", fetchedAt: "2026-10-04T11:50:00.000Z", stale: false },
  catalogSource: over.catalogSource ?? "latest",
  catalogError: over.catalogError ?? null,
  skipped: [],
  hadModels: over.hadModels ?? true,
  clearOverrides: over.clearOverrides ?? false,
  catalogNewEntries: over.catalogNewEntries ?? 0,
  overridesMeta: over.overridesMeta ?? { rawPresent: false, clearable: false, inheritedOnly: false },
  rows: over.rows ?? [row("a", "listed"), row("b", "addable"), row("c", "addable")],
  diff: over.diff ?? {
    targetView: { modelsPresent: true, models: [{ id: "a" }], modelOverridesPresent: false, modelOverrides: null },
    selectedIds: over.selectedIds ?? ["a"],
    added: over.added ?? [],
    removed: over.removed ?? [],
    kept: ["a"],
    warnings: [],
    writeSet: { catalogEntries: true, models: false, modelOverrides: false, overridesUnclearable: false },
  },
});
// 预览携带删除提案（含用户取消勾选健康行的 unchecked）
const withRemoval = (over = {}) => previewBody({
  ...over,
  diff: {
    targetView: { modelsPresent: true, models: [{ id: "a" }], modelOverridesPresent: false, modelOverrides: null },
    selectedIds: over.selectedIds ?? ["a"],
    added: [],
    removed: over.removed ?? [{ id: "dead", reason: "not-in-account" }],
    kept: over.kept ?? ["a"],
    warnings: [],
    writeSet: { catalogEntries: true, models: true, modelOverrides: false, overridesUnclearable: false },
  },
});

// fetch 路由：记录 URL 与请求体；可按 URL 配置响应（respond）或一次性响应队列（respondOnce，FIFO）或挂起
function makeFetch() {
  const calls = [];
  const bodies = [];
  const routes = new Map();
  const once = new Map();
  const wrapped = async (url, init) => {
    calls.push(url);
    if (init?.body) bodies.push({ url, body: JSON.parse(init.body) });
    const q = once.get(url);
    let spec;
    if (q && q.length > 0) spec = q.shift();
    else spec = routes.get(url) ?? { body: { ok: true } };
    if (spec.defer) return await spec.defer();
    return jsonResponse(spec);
  };
  wrapped.calls = calls;
  wrapped.bodies = bodies;
  wrapped.respond = (url, spec) => routes.set(url, spec);
  wrapped.respondOnce = (url, spec) => {
    const q = once.get(url);
    if (q) q.push(spec);
    else once.set(url, [spec]);
  };
  return wrapped;
}

const P = "/copilot-auth/refresh/preview";
const A = "/copilot-auth/refresh/apply";
const R = "/copilot-auth/refresh/retire";
const S = "/copilot-auth/status";

test("start：operation 恒为 manage（无 legacy 字面量分支），preview 请求体就位", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "rebuild" }, f);
  assert.equal(s.name, "confirming");
  const body = f.bodies.find((x) => x.url === P)?.body;
  assert.equal(body.operation, "manage");
  s = await advance(initial, { type: "start", operation: "manage" }, f);
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.operation, "manage");
});

test("预览→确认：勾选经 basePreviewId materialize、纯新增单次确认后 apply", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  assert.equal(s.name, "confirming");
  assert.deepEqual(s.preview.rows.map((r) => r.id), ["a", "b", "c"]);
  f.respond(P, { body: previewBody({ previewId: "pv-2", operationId: "op-2", added: ["b"], selectedIds: ["a", "b"] }) });
  s = await advance(s, { type: "select", selectedIds: ["a", "b"] }, f);
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.previewId, "pv-2");
  const materialize = f.bodies.find((x) => x.url === P && x.body.basePreviewId === "pv-1");
  assert.ok(materialize, "选择变化必须走 basePreviewId");
  assert.deepEqual(materialize.body.selectedIds, ["a", "b"]);
  f.respond(A, { body: { ok: true, operationId: "op-2", result: { status: "applied", changes: { modelsAdded: 1 } } } });
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "result");
  assert.equal(s.result.status, "applied");
  const applyBody = f.bodies.find((x) => x.url === A);
  assert.deepEqual([applyBody.body.previewId, applyBody.body.operationId], ["pv-2", "op-2"]);
  assert.equal(applyBody.body.protocolVersion, PROTOCOL_VERSION);
});

test("确认门矩阵：removed>0 / clearOverrides / 空目标 各自需二次确认；纯新增单次放行", async () => {
  const f = makeFetch();
  f.respond(A, { body: { ok: true, operationId: "op-1", result: { status: "applied" } } });
  // 纯新增：单次确认
  f.respond(P, { body: previewBody({ previewId: "pv-add", added: ["b"], selectedIds: ["a", "b"] }) });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "result", "纯新增单次确认放行");
  // removed>0：缺二次确认被拒
  f.respond(P, { body: withRemoval({ previewId: "pv-rm" }) });
  s = await advance(initial, { type: "start", operation: "manage" }, f);
  let before = f.calls.length;
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "confirming");
  assert.equal(f.calls.length, before, "删除类缺二次确认不发 apply");
  s = await advance(s, { type: "confirm", second: true, empty: false }, f);
  assert.equal(s.name, "result");
  // clearOverrides：缺二次确认被拒
  f.respond(P, { body: previewBody({ previewId: "pv-co", clearOverrides: true, overridesMeta: { rawPresent: true, clearable: true, inheritedOnly: false } }) });
  s = await advance(initial, { type: "start", operation: "manage" }, f);
  before = f.calls.length;
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "confirming");
  assert.equal(f.calls.length, before, "清除定制缺二次确认不发 apply");
  s = await advance(s, { type: "confirm", second: true, empty: false }, f);
  assert.equal(s.name, "result");
  // 空目标：二次确认之外还需 empty 单独确认
  f.respond(P, { body: withRemoval({ previewId: "pv-empty", selectedIds: [], removed: [{ id: "a", reason: "unchecked" }] }) });
  s = await advance(initial, { type: "start", operation: "manage" }, f);
  before = f.calls.length;
  s = await advance(s, { type: "confirm", second: true, empty: false }, f);
  assert.equal(s.name, "confirming", "空目标未单独确认不发 apply");
  assert.equal(f.calls.length, before);
  s = await advance(s, { type: "confirm", second: true, empty: true }, f);
  assert.equal(s.name, "result");
});

test("select 事件字段透传：selectedIds/clearOverrides/confirmEmpty 进 effect（含空目标派生）", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  f.respond(P, { body: withRemoval({ previewId: "pv-2", selectedIds: [], removed: [{ id: "a", reason: "unchecked" }] }) });
  s = await advance(s, { type: "select", selectedIds: [], clearOverrides: true, confirmEmpty: true }, f);
  const materialize = f.bodies.find((x) => x.url === P && x.body.basePreviewId === "pv-1");
  assert.deepEqual(materialize.body.selectedIds, []);
  assert.equal(materialize.body.clearOverrides, true);
  assert.equal(materialize.body.confirmEmpty, true);
});

test("select 物化期间留在 confirming（materializing），预览原位替换——弹窗不卸载重挂", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  const states = [];
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  let release;
  f.respond(P, { defer: () => new Promise((r) => { release = () => r(jsonResponse({ body: previewBody({ previewId: "pv-2", operationId: "op-2", added: ["b"], selectedIds: ["a", "b"] }) })); }) });
  const pending = advance(s, { type: "select", selectedIds: ["a", "b"] }, f, (mid) => states.push(mid));
  await new Promise((r) => setTimeout(r, 10));
  const mid = states.at(-1);
  assert.equal(mid.name, "confirming", "物化期间弹窗必须保持挂载（不得切回 previewing）");
  assert.equal(mid.materializing, true);
  assert.equal(mid.preview.previewId, "pv-1", "旧预览原位保留");
  release();
  const done = await pending;
  assert.equal(done.name, "confirming");
  assert.equal(done.materializing, false);
  assert.equal(done.preview.previewId, "pv-2");
});

test("materializing 期间 confirm 被忽略（不得用旧 previewId 应用）", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  const states = [];
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  let release;
  f.respond(P, { defer: () => new Promise((r) => { release = () => r(jsonResponse({ body: previewBody({ previewId: "pv-2", operationId: "op-2", added: ["b"], selectedIds: ["a", "b"] }) })); }) });
  const pending = advance(s, { type: "select", selectedIds: ["a", "b"] }, f, (mid) => states.push(mid));
  await new Promise((r) => setTimeout(r, 10));
  const out = await advance(states.at(-1), { type: "confirm", second: false, empty: false }, f);
  assert.equal(out.name, "confirming");
  assert.equal(out.materializing, true);
  assert.equal(f.calls.filter((u) => u === A).length, 0, "物化中不得发起 apply");
  release();
  await pending;
});

test("自动 live 升级：缓存＋删除提案 → 初始 preview-ok 触发新鲜预览（闩锁/无选择字段/软降级/硬失败回退）", async () => {
  // ① 初始预览（cache＋removed）→ preview-ok 后自动升级，effect 不带 basePreviewId、不带选择字段
  const f = makeFetch();
  const states = [];
  f.respondOnce(P, { body: withRemoval({ evidence: { source: "cache", fetchedAt: "2026-10-04T10:00:00.000Z", stale: false } }) });
  f.respond(P, { body: withRemoval({ previewId: "pv-live", operationId: "op-live" }) }); // 升级后 live
  const s = await advance(initial, { type: "start", operation: "manage" }, f, (mid) => states.push(mid));
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.previewId, "pv-live");
  const upgrade = f.bodies.filter((x) => x.url === P)[1];
  assert.ok(upgrade, "必须发起升级预览");
  assert.equal(upgrade.body.basePreviewId, undefined, "升级是新鲜预览，不走 basePreviewId");
  assert.equal(upgrade.body.selectedIds, undefined, "初始默认预览升级不带选择字段（服务端按 live 重算默认）");
  const midUpgrade = states.find((x) => x.awaitingUpgrade === true);
  assert.ok(midUpgrade, "升级在途置 awaitingUpgrade");
  assert.equal(midUpgrade.materializing, true, "升级在途 materializing（确认门拦截）");
  // 升级在途 confirm 被忽略
  assert.equal(f.calls.filter((c) => c === A).length, 0);
  // ④ awaitingUpgrade 期间 confirm 被拒
  const f4 = makeFetch();
  f4.respondOnce(P, { body: withRemoval({ evidence: { source: "cache", fetchedAt: "x", stale: false } }) });
  f4.respond(P, { defer: () => new Promise(() => {}) }); // 升级挂起（不 resolve）
  const s4states = [];
  void advance(initial, { type: "start", operation: "manage" }, f4, (m) => s4states.push(m));
  await new Promise((r) => setTimeout(r, 10));
  const mid4 = s4states.at(-1);
  assert.equal(mid4.awaitingUpgrade, true);
  const out4 = await advance(mid4, { type: "confirm", second: true, empty: true }, f4);
  assert.equal(out4.name, "confirming", "升级在途不得提交");
  assert.equal(f4.calls.filter((c) => c === A).length, 0);
  // ⑤ 全漂移＋cache：初始预览（无选择字段）放行后升级，同样不带选择字段
  const f5 = makeFetch();
  f5.respondOnce(P, { body: withRemoval({ selectedIds: [], removed: [{ id: "a", reason: "unchecked" }], evidence: { source: "cache", fetchedAt: "x", stale: false } }) });
  f5.respond(P, { body: withRemoval({ previewId: "pv-live5", operationId: "op-live5" }) });
  const s5 = await advance(initial, { type: "start", operation: "manage" }, f5);
  assert.equal(s5.preview.previewId, "pv-live5");
  const up5 = f5.bodies.filter((x) => x.url === P)[1];
  assert.equal(up5.body.selectedIds, undefined, "全漂移默认空选择升级不带 selectedIds（不会触发空目标确认）");
  // ⑥ 软降级：升级后 preview-ok 仍落 cache → staleNotice 置位、不再升级、不落 failed
  const f6 = makeFetch();
  f6.respondOnce(P, { body: withRemoval({ previewId: "pv-cache0", operationId: "op-cache0", evidence: { source: "cache", fetchedAt: "x", stale: false } }) });
  f6.respond(P, { body: withRemoval({ previewId: "pv-soft", operationId: "op-soft", evidence: { source: "cache", fetchedAt: "y", stale: false } }) });
  const s6 = await advance(initial, { type: "start", operation: "manage" }, f6);
  assert.equal(s6.name, "confirming", "软降级不落 failed");
  assert.equal(s6.liveUpgradeUsed, true);
  assert.equal(s6.staleNotice, true, "软降级必须置 staleNotice");
  assert.equal(f6.bodies.filter((x) => x.url === P).length, 2, "闩锁已消耗，不再重试升级");
  // ② 闩锁消耗后：同会话再落 cache＋删除预览不再升级
  const f2 = makeFetch();
  f2.respond(P, { body: withRemoval({ previewId: "pv-1", evidence: { source: "cache", fetchedAt: "x", stale: false } }) });
  const confirmed = { name: "confirming", flags: initial.flags, preview: previewBody({ previewId: "pv-0" }), liveUpgradeUsed: true, lastSelection: {}, staleNotice: false };
  const [s2, fx2] = reduce(confirmed, { type: "preview-ok", preview: withRemoval({ previewId: "pv-1", evidence: { source: "cache", fetchedAt: "y", stale: false } }) });
  assert.equal(fx2, null, "闩锁已消耗不升级");
  assert.equal(s2.preview.previewId, "pv-1");
  // ③ live / stale / 非 latest 目录不触发升级
  for (const [evidence, catalogSource] of [
    [{ source: "live", fetchedAt: "x", stale: false }, "latest"],
    [{ source: "stale", fetchedAt: null, stale: true }, "latest"],
    [{ source: "cache", fetchedAt: "x", stale: false }, "overlay"],
  ]) {
    const st = { name: "confirming", flags: initial.flags, preview: withRemoval({ previewId: "pv-x", evidence, catalogSource }), liveUpgradeUsed: false, lastSelection: {} };
    const [, fx] = reduce(st, { type: "preview-ok", preview: withRemoval({ previewId: "pv-y", evidence, catalogSource }) });
    assert.equal(fx, null, `${evidence.source}/${catalogSource} 不触发升级`);
  }
});

test("升级硬失败回退：preview-fail → 以升级前快照 materialize（逐字段复制 lastSelection，保留勾选）", async () => {
  const f = makeFetch();
  f.respondOnce(P, { body: withRemoval({ previewId: "pv-cache", operationId: "op-cache", evidence: { source: "cache", fetchedAt: "x", stale: false } }) });
  f.respondOnce(P, { defer: () => Promise.reject(new TypeError("fetch failed")) }); // 升级硬失败（requestJson → preview-fail）
  f.respond(P, { body: withRemoval({ previewId: "pv-fallback", operationId: "op-fallback", evidence: { source: "cache", fetchedAt: "x", stale: false } }) });
  const s = await advance(initial, { type: "start", operation: "manage" }, f);
  assert.equal(s.name, "confirming", "硬失败回退不落 failed");
  assert.equal(s.preview.previewId, "pv-fallback", "回退物化落地");
  assert.equal(s.staleNotice, true, "回退后置 staleNotice");
  assert.equal(s.liveUpgradeUsed, true, "闩锁保持消耗");
  assert.equal(s.awaitingUpgrade, false);
  const bodies = f.bodies.filter((x) => x.url === P);
  assert.equal(bodies.length, 3, "初始＋升级＋回退三次 preview");
  assert.equal(bodies[1].body.basePreviewId, undefined);
  assert.equal(bodies[2].body.basePreviewId, "pv-cache", "回退以升级前快照为基");
  assert.equal(bodies[2].body.selectedIds, undefined, "lastSelection 空对象 → 无选择字段");
  // lastSelection 非空：回退 effect 逐字段复制
  const withSel = { name: "confirming", flags: initial.flags, preview: previewBody({ previewId: "pv-cache" }), awaitingUpgrade: true, materializing: true, liveUpgradeUsed: true, lastSelection: { selectedIds: ["a"], clearOverrides: false }, staleNotice: false };
  const [, fx] = reduce(withSel, { type: "preview-fail", error: "network-error" });
  assert.equal(fx.type, "preview");
  assert.equal(fx.basePreviewId, "pv-cache");
  assert.deepEqual(fx.selectedIds, ["a"]);
  assert.equal(fx.clearOverrides, false);
  // 回退 materialize 也失败 → 落 failed
  const st = { name: "confirming", flags: initial.flags, preview: previewBody({ previewId: "pv-cache" }), awaitingUpgrade: false, materializing: true, liveUpgradeUsed: true, lastSelection: {}, staleNotice: true };
  const [failed] = reduce(st, { type: "preview-fail", error: "network-error" });
  assert.equal(failed.name, "failed");
});

test("stale 证据：确认被忽略（Q7 无有效缓存阻止应用）", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody({ evidence: { source: "stale", fetchedAt: null, stale: true } }) });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  assert.equal(s.preview.evidence.stale, true);
  const before = f.calls.length;
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "confirming");
  assert.equal(f.calls.length, before, "stale 证据不得应用");
});

test("零勾选＋目录增量：结果为 pending-restart（目录落地、列表零变化），非 no-change", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody({ catalogNewEntries: 2 }) });
  f.respond(A, { body: { ok: true, operationId: "op-1", result: { status: "pending-restart", changes: { catalogAdded: 2, modelsAdded: 0 } } } });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "pendingRestart");
  assert.equal(s.result.changes.catalogAdded, 2);
  assert.notEqual(s.result.status, "no-change");
});

test("423 转 status 查询：activeOperation → busy；apply 网络不明 → 查同 ID 不重发", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  f.respond(A, { status: 423, body: { ok: false, error: "resource-busy" } });
  f.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "file", activeOperation: { operationId: "op-other", phase: "catalog-landed" }, lastResult: null } } });
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "busy");
  assert.equal(s.active.operationId, "op-other");
  assert.equal(f.calls.filter((c) => c === A).length, 1, "忙时不重发 apply");
  f.respond(P, { body: previewBody({ previewId: "pv-9", operationId: "op-9" }) });
  s = await advance(s, { type: "start", operation: "manage" }, f);
  f.respond(A, { defer: () => Promise.reject(new Error("network down")) });
  f.respond(`${S}?operationId=op-9`, { body: { operation: { query: "unknown" }, refresh: { scopeAvailable: true } } });
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "resultUnknown");
  assert.equal(s.operationId, "op-9");
  assert.equal(f.calls.filter((c) => c === A).length, 2, "未知结果只查询不重复 POST");
  assert.ok(f.calls.some((c) => c === `${S}?operationId=op-9`));
});

test("recovery-needed → retire 确认 → 重新预览闭环", async () => {
  const f = makeFetch();
  const resultState = { ...initial, name: "result", flags: initial.flags, result: { operationId: "op-old", status: "recovery-needed" } };
  let s = reduce(resultState, { type: "retire-request" })[0];
  assert.equal(s.name, "retireConfirm");
  f.respond(R, { body: { ok: true, result: { operationId: "op-old", status: "intent-retired" } } });
  f.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "file", lastResult: { operationId: "op-old", status: "intent-retired" }, activeOperation: null } } });
  s = await advance(s, { type: "retire-confirm" }, f);
  assert.equal(s.name, "result");
  assert.equal(s.result.status, "intent-retired");
  f.respond(P, { body: previewBody({ previewId: "pv-new", operationId: "op-new" }) });
  s = await advance(s, { type: "start", operation: "manage" }, f);
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.operationId, "op-new");
});

test("预览过期/漂移（409 preview-stale）→ 自动重新预览并重置确认", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  f.respond(A, { status: 409, body: { ok: false, error: "preview-stale" } });
  f.respond(P, { body: previewBody({ previewId: "pv-2", operationId: "op-2" }) });
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "confirming");
  assert.equal(s.staleNotice, true, "重新预览后带 stale 提示");
  assert.equal(s.preview.previewId, "pv-2");
});

test("本地来源失败 → 显式切源 overlay 生成新预览（不隐式降级，Q7）", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody({ catalogSource: "local", catalogError: "npm unreachable" }) });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  assert.equal(s.preview.catalogSource, "local");
  f.respond(P, { body: previewBody({ catalogSource: "overlay", previewId: "pv-o", operationId: "op-o" }) });
  s = await advance(s, { type: "start", catalogSource: "overlay" }, f);
  assert.equal(s.preview.catalogSource, "overlay");
  const overlayReq = f.bodies.find((x) => x.url === P && x.body.catalogSource === "overlay");
  assert.ok(overlayReq, "切源必须是显式新预览请求");
});

test("applying 期间重复 confirm 被忽略（慢响应不覆盖/双击只发一次）", async () => {
  const f = makeFetch();
  let release;
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "manage" }, f);
  f.respond(A, { defer: () => new Promise((r) => { release = r; }) });
  const p = advance(s, { type: "confirm", second: false, empty: false }, f);
  await new Promise((r) => setTimeout(r, 5));
  const [s2, fx2] = reduce({ name: "applying", preview: s.preview }, { type: "confirm" });
  assert.equal(s2.name, "applying");
  assert.equal(fx2, null);
  release(jsonResponse({ body: { ok: true, operationId: "op-1", result: { status: "applied" } } }));
  s = await p;
  assert.equal(s.name, "result");
  assert.equal(f.calls.filter((c) => c === A).length, 1);
});

test("通道门控：blocked/unknown/scope 不可用时入口禁用（G02），flags 经 hydrate 正确投影", async () => {
  const f1 = makeFetch();
  f1.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "blocked", blockedReason: "inject-unavailable" } } });
  let s = await advance(initial, { type: "init" }, f1);
  assert.equal(s.name, "idle");
  assert.equal(s.flags.catalogMode, "blocked");
  assert.equal(refreshBlocked(s.flags), true, "blocked 入口必须禁用");
  const f2 = makeFetch();
  f2.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "unknown", blockedReason: "install-unresolved" } } });
  s = await advance(initial, { type: "init" }, f2);
  assert.equal(refreshBlocked(s.flags), true, "unknown 不承诺可应用，入口必须禁用");
  const f3 = makeFetch();
  f3.respond(S, { body: { refresh: { scopeAvailable: false, catalogMode: "file" } } });
  s = await advance(initial, { type: "init" }, f3);
  assert.equal(s.flags.scopeAvailable, false);
  assert.equal(refreshBlocked(s.flags), true, "scope 不可用入口必须禁用");
  const f4 = makeFetch();
  f4.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "registry" } } });
  s = await advance(initial, { type: "init" }, f4);
  assert.equal(refreshBlocked(s.flags), false, "registry 通道入口可用");
  assert.equal(refreshBlocked({ catalogMode: "file", scopeAvailable: true }), false);
  assert.equal(refreshBlocked({ catalogMode: null, scopeAvailable: true }), false, "旧宿主缺字段不误伤");
});
