// T11：客户端模型流（协议 v2）——勾选 materialize、确认门、423/unknown、retire 闭环、
// 预览过期重置、显式切源、双击安全、通道门控（blocked/unknown/scope 不可用）。
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

const previewBody = (over = {}) => ({
  ok: true,
  previewId: over.previewId ?? "pv-1",
  operationId: over.operationId ?? "op-1",
  operation: over.operation ?? "supplement",
  expiresAt: "2026-10-04T12:00:00.000Z",
  evidence: over.evidence ?? { source: "live", fetchedAt: "2026-10-04T11:50:00.000Z", stale: false },
  catalogSource: over.catalogSource ?? "latest",
  catalogError: null,
  skipped: [],
  diff: over.diff ?? {
    targetView: { modelsPresent: true, models: [{ id: "a" }], modelOverridesPresent: false, modelOverrides: null },
    candidates: ["b", "c"],
    added: over.added ?? [],
    removed: [],
    kept: ["a"],
    warnings: [],
    writeSet: { catalogEntries: true, models: false, modelOverrides: false },
  },
});

// fetch 路由：记录 URL 与请求体；可按 URL 配置响应或挂起
function makeFetch() {
  const calls = [];
  const bodies = [];
  const routes = new Map();
  const wrapped = async (url, init) => {
    calls.push(url);
    if (init?.body) bodies.push({ url, body: JSON.parse(init.body) });
    const spec = routes.get(url) ?? { body: { ok: true } };
    if (spec.defer) return await spec.defer();
    return jsonResponse(spec);
  };
  wrapped.calls = calls;
  wrapped.bodies = bodies;
  wrapped.respond = (url, spec) => routes.set(url, spec);
  return wrapped;
}

const P = "/copilot-auth/refresh/preview";
const A = "/copilot-auth/refresh/apply";
const R = "/copilot-auth/refresh/retire";
const S = "/copilot-auth/status";

test("预览→确认：候选就位、勾选经 basePreviewId materialize、确认后 apply", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
  assert.equal(s.name, "confirming");
  assert.deepEqual(s.preview.diff.candidates, ["b", "c"]);
  // 勾选 b：materialize（服务端从原快照重算，不重新取数）
  f.respond(P, { body: previewBody({ previewId: "pv-2", operationId: "op-2", added: ["b"] }) });
  s = await advance(s, { type: "select", selectedIds: ["b"] }, f);
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.previewId, "pv-2");
  const materialize = f.bodies.find((x) => x.url === P && x.body.basePreviewId === "pv-1");
  assert.ok(materialize, "选择变化必须走 basePreviewId");
  assert.deepEqual(materialize.body.selectedIds, ["b"]);
  // 确认（补充无需二次确认）→ apply 携带 previewId+operationId
  f.respond(A, { body: { ok: true, operationId: "op-2", result: { status: "applied", changes: { modelsAdded: 1 } } } });
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "result");
  assert.equal(s.result.status, "applied");
  const applyBody = f.bodies.find((x) => x.url === A);
  assert.deepEqual([applyBody.body.previewId, applyBody.body.operationId], ["pv-2", "op-2"]);
  assert.equal(applyBody.body.protocolVersion, PROTOCOL_VERSION);
});

test("select 物化期间留在 confirming（materializing），预览原位替换——弹窗不卸载重挂", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  const states = [];
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
  let release;
  f.respond(P, { defer: () => new Promise((r) => { release = () => r(jsonResponse({ body: previewBody({ previewId: "pv-2", operationId: "op-2", added: ["b"] }) })); }) });
  const pending = advance(s, { type: "select", selectedIds: ["b"] }, f, (mid) => states.push(mid));
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
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
  let release;
  f.respond(P, { defer: () => new Promise((r) => { release = () => r(jsonResponse({ body: previewBody({ previewId: "pv-2", operationId: "op-2", added: ["b"] }) })); }) });
  const pending = advance(s, { type: "select", selectedIds: ["b"] }, f, (mid) => states.push(mid));
  await new Promise((r) => setTimeout(r, 10));
  const out = await advance(states.at(-1), { type: "confirm", second: false, empty: false }, f);
  assert.equal(out.name, "confirming");
  assert.equal(out.materializing, true);
  assert.equal(f.calls.filter((u) => u === A).length, 0, "物化中不得发起 apply");
  release();
  await pending;
});

test("零勾选＋目录增量：结果为 pending-restart（目录落地、列表零变化），非 no-change", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody({ added: [] }) });
  f.respond(A, { body: { ok: true, operationId: "op-1", result: { status: "pending-restart", changes: { catalogAdded: 2, modelsAdded: 0 } } } });
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "pendingRestart");
  assert.equal(s.result.changes.catalogAdded, 2);
  assert.equal(s.result.changes.modelsAdded, 0);
  assert.notEqual(s.result.status, "no-change");
});

test("重建确认门：未二次确认/空目标未单独确认 → 不发包", async () => {
  const f = makeFetch();
  const rebuildPreview = previewBody({
    operation: "rebuild",
    diff: {
      targetView: { modelsPresent: true, models: [{ id: "a" }, { id: "b" }], modelOverridesPresent: false, modelOverrides: null },
      candidates: null,
      added: ["b"],
      removed: [{ id: "dead", reason: "not-in-account" }],
      kept: ["a"],
      warnings: [],
      writeSet: { catalogEntries: true, models: true, modelOverrides: false },
    },
  });
  f.respond(P, { body: rebuildPreview });
  let s = await advance(initial, { type: "start", operation: "rebuild" }, f);
  assert.equal(s.name, "confirming");
  const before = f.calls.length;
  s = await advance(s, { type: "confirm", second: false, empty: false }, f); // 缺二次确认
  assert.equal(s.name, "confirming", "确认被忽略");
  assert.equal(f.calls.length, before, "未发 apply");
  f.respond(A, { body: { ok: true, operationId: "op-1", result: { status: "applied" } } });
  s = await advance(s, { type: "confirm", second: true, empty: false }, f);
  assert.equal(s.name, "result");
  // 空目标：额外需要 empty 确认
  f.respond(P, { body: previewBody({ operation: "rebuild", diff: { targetView: { modelsPresent: true, models: [], modelOverridesPresent: false, modelOverrides: null }, candidates: null, added: [], removed: [{ id: "a", reason: "not-in-account" }], kept: [], warnings: [], writeSet: { catalogEntries: false, models: true, modelOverrides: false } } }) });
  s = await advance(s, { type: "start", operation: "rebuild" }, f);
  const calls2 = f.calls.length;
  s = await advance(s, { type: "confirm", second: true, empty: false }, f); // 空集合未单独确认
  assert.equal(s.name, "confirming");
  assert.equal(f.calls.length, calls2);
});

test("stale 证据：确认被忽略（Q7 无有效缓存阻止应用）", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody({ evidence: { source: "stale", fetchedAt: null, stale: true } }) });
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
  assert.equal(s.preview.evidence.stale, true);
  const before = f.calls.length;
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "confirming");
  assert.equal(f.calls.length, before, "stale 证据不得应用");
});

test("423 转 status 查询：activeOperation → busy；apply 网络不明 → 查同 ID 不重发", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
  f.respond(A, { status: 423, body: { ok: false, error: "resource-busy" } });
  f.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "file", activeOperation: { operationId: "op-other", phase: "catalog-landed" }, lastResult: null } } });
  s = await advance(s, { type: "confirm", second: false, empty: false }, f);
  assert.equal(s.name, "busy");
  assert.equal(s.active.operationId, "op-other");
  assert.equal(f.calls.filter((c) => c === A).length, 1, "忙时不重发 apply");
  // 网络不明：只查同 operationId
  f.respond(P, { body: previewBody({ previewId: "pv-9", operationId: "op-9" }) });
  s = await advance(s, { type: "start", operation: "supplement" }, f);
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
  // 终结且无阻碍负债 → 新预览可用
  f.respond(P, { body: previewBody({ previewId: "pv-new", operationId: "op-new" }) });
  s = await advance(s, { type: "start", operation: "supplement" }, f);
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.operationId, "op-new");
});

test("预览过期/漂移（409 preview-stale）→ 自动重新预览并重置确认", async () => {
  const f = makeFetch();
  f.respond(P, { body: previewBody() });
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
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
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
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
  let s = await advance(initial, { type: "start", operation: "supplement" }, f);
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
  // hydrate 投影：blocked
  const f1 = makeFetch();
  f1.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "blocked", blockedReason: "inject-unavailable" } } });
  let s = await advance(initial, { type: "init" }, f1);
  assert.equal(s.name, "idle");
  assert.equal(s.flags.catalogMode, "blocked");
  assert.equal(s.flags.blockedReason, "inject-unavailable");
  assert.equal(refreshBlocked(s.flags), true, "blocked 入口必须禁用");
  // unknown
  const f2 = makeFetch();
  f2.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "unknown", blockedReason: "install-unresolved" } } });
  s = await advance(initial, { type: "init" }, f2);
  assert.equal(refreshBlocked(s.flags), true, "unknown 不承诺可应用，入口必须禁用");
  // scope 不可用
  const f3 = makeFetch();
  f3.respond(S, { body: { refresh: { scopeAvailable: false, catalogMode: "file" } } });
  s = await advance(initial, { type: "init" }, f3);
  assert.equal(s.flags.scopeAvailable, false);
  assert.equal(refreshBlocked(s.flags), true, "scope 不可用入口必须禁用");
  // 可操作通道不受影响
  const f4 = makeFetch();
  f4.respond(S, { body: { refresh: { scopeAvailable: true, catalogMode: "registry" } } });
  s = await advance(initial, { type: "init" }, f4);
  assert.equal(refreshBlocked(s.flags), false, "registry 通道入口可用");
  assert.equal(refreshBlocked({ catalogMode: "file", scopeAvailable: true }), false);
  assert.equal(refreshBlocked({ catalogMode: null, scopeAvailable: true }), false, "旧宿主缺字段不误伤");
});
