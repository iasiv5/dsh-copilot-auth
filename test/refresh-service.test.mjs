// T8（v3）：预览服务与账号证据——manage 接线、rows 与新投影、removals-need-live 门、
// 快照生命周期、选择重算、证据门禁、幂等与忙、scope 降级。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRefreshService } from "../src/refresh-service.mjs";
import { PROTOCOL_VERSION } from "../src/shared.mjs";

const INDIVIDUAL_TOKEN = "tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;";

function streamRes(body, status = 200) {
  const chunks = [Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
    text: async () => Buffer.concat(chunks).toString("utf8"),
    body: { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }, cancel: async () => {} },
  };
}
const pickerOn = (id) => ({ id, model_picker_enabled: true });
const view = (models, modelOverrides = null) => ({
  modelsPresent: models !== null,
  models,
  modelOverridesPresent: modelOverrides !== null,
  modelOverrides,
});

function makeHarness({
  live = "ok", record, revision = 7, rawView, effectiveView, catalog, liveModels,
} = {}) {
  const scope = { known: true, profileId: "p1", dataDir: join(mkdtempSync(join(tmpdir(), "svc-")), "copilot-auth") };
  const t = { now: 1_000_000 };
  const clock = { now: () => t.now };
  const intent = { version: 3 };
  const revisionRef = { value: revision };
  const liveRef = { value: live };
  const store = { value: null };
  const stateIO = {
    load: () => store.value,
    save: (s) => { store.value = s; },
  };
  const counters = { catalog: 0, config: 0, runApply: 0 };
  const theRawView = rawView ?? view([{ id: "keep-1" }]);
  const theEffectiveView = effectiveView ?? theRawView;
  const cat = {
    catalogSource: "latest", resolvableIds: ["keep-1", "new-1", "new-2"], newEntryCount: 2,
    catalogError: null, skipped: [], normalized: null, addedOverlay: {}, provenance: {}, ...(catalog ?? {}),
  };
  const models = liveModels ?? ["keep-1", "new-1", "new-2"];
  const deps = {
    resolveCatalog: async () => {
      counters.catalog += 1;
      return { ...cat };
    },
    describeConfigView: async () => {
      counters.config += 1;
      return {
        view: { ...theRawView, models: theRawView.models === null ? null : [...theRawView.models] },
        effectiveView: theEffectiveView,
        revision: revisionRef.value,
      };
    },
  };
  const tx = {
    calls: [],
    snapshots: [],
    mode: "terminal", // terminal：runApply 直接落 lastResult；active：落 activeOperation
    deferred: null,
    runApply: async ({ snapshot }) => {
      counters.runApply += 1;
      tx.calls.push(snapshot.operationId);
      tx.snapshots.push(snapshot);
      if (tx.deferred) await tx.deferred.promise;
      const state = stateIO.load() ?? {};
      if (tx.mode === "active") {
        stateIO.save({ ...state, activeOperation: { operationId: snapshot.operationId, phase: "catalog-landed", changes: { catalogAdded: 2 } } });
        return { ok: true, operationId: snapshot.operationId, result: { status: "pending-restart", phase: "catalog-landed" } };
      }
      stateIO.save({ ...state, lastResult: { operationId: snapshot.operationId, status: "applied", changes: { modelsAdded: 1 } } });
      return { ok: true, operationId: snapshot.operationId, result: { status: "applied", changes: { modelsAdded: 1 } } };
    },
    retireCalls: [],
    retire: async ({ operationId }) => { tx.retireCalls.push(operationId); return { ok: true, status: "intent-retired" }; },
    bootRecover: async () => ({ ok: true }),
  };
  const ctx = {
    credentials: {
      readRecord: async () => (record === undefined
        ? { payload: { access: INDIVIDUAL_TOKEN, availableModelIds: ["keep-1", "new-1"] } }
        : record),
    },
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/models")) {
      if (liveRef.value === "fail") return streamRes({}, 401);
      return streamRes({ data: models.map(pickerOn) }, 200);
    }
    throw new Error("unexpected fetch: " + url);
  };
  const service = createRefreshService(ctx, {
    scope, stateIO, clock,
    readIntentVersion: () => intent.version,
    deps,
    transaction: tx,
    fetchImpl,
  });
  return { service, scope, t, clock, intent, store, counters, tx, revision: revisionRef, live: liveRef, ctx };
}

const errCode = async (p) => (await p.then(() => null, (e) => e.code));

test("preview live 成功：快照就位、evidence=live、缓存写入 fetchedAt+intentVersion", async () => {
  const h = makeHarness();
  const p = await h.service.preview({ protocolVersion: PROTOCOL_VERSION, operation: "manage", selectedIds: ["new-1"] });
  assert.equal(p.ok, true);
  assert.equal(p.evidence.source, "live");
  assert.equal(p.diff.added.length, 1);
  const cache = JSON.parse(readFileSync(join(h.scope.dataDir, "account-model-cache.json"), "utf8"));
  assert.deepEqual(cache.ids, ["keep-1", "new-1", "new-2"]);
  assert.equal(typeof cache.fetchedAt, "string");
  assert.equal(cache.intentVersion, 3);
});

test("默认选择与投影：无 selectedIds → 在列∩(账号∩可解析)；rows 三态；新投影字段就位、无 candidates", async () => {
  const h = makeHarness();
  const p = await h.service.preview({ operation: "manage" });
  assert.deepEqual(p.diff.selectedIds, ["keep-1"], "默认目标＝健康在列");
  assert.deepEqual(p.diff.added, []);
  assert.deepEqual(p.diff.removed, []);
  assert.deepEqual(p.rows.map((r) => [r.id, r.status]), [
    ["new-1", "addable"], ["new-2", "addable"], ["keep-1", "listed"],
  ], "rows 按账号序（addable）＋在列序（listed）");
  assert.equal(p.hadModels, true);
  assert.deepEqual(p.overridesMeta, { rawPresent: false, clearable: false, inheritedOnly: false });
  assert.equal(p.catalogNewEntries, 2);
  assert.equal(p.clearOverrides, false);
  assert.equal("candidates" in p.diff, false, "v3 投影不再有 candidates");
});

test("全漂移：默认空选择初始预览放行（弹窗可打开），removed＝raw 在列全表", async () => {
  const h = makeHarness({ liveModels: ["new-1"] }); // 账号不再报告 keep-1
  const p = await h.service.preview({ operation: "manage" });
  assert.equal(p.ok, true, "默认路径不受空目标确认约束");
  assert.deepEqual(p.diff.selectedIds, []);
  assert.deepEqual(p.diff.removed, [{ id: "keep-1", reason: "not-in-account" }]);
  assert.deepEqual(p.rows.map((r) => [r.id, r.status, r.reason]), [
    ["new-1", "addable", undefined],
    ["keep-1", "removal-proposal", "not-in-account"],
  ]);
});

test("materialize：新 previewId、沿用原 expiresAt、clearOverrides 回显", async () => {
  const h = makeHarness();
  const p1 = await h.service.preview({ operation: "manage" });
  h.t.now += 60 * 1000;
  const p2 = await h.service.preview({ operation: "manage", basePreviewId: p1.previewId, selectedIds: ["keep-1", "new-1"], clearOverrides: false });
  assert.notEqual(p2.previewId, p1.previewId);
  assert.equal(p2.expiresAt, p1.expiresAt, "沿用原有效期不延长");
  assert.equal(p2.clearOverrides, false);
  const p3 = await h.service.preview({ operation: "manage", basePreviewId: p2.previewId, selectedIds: ["keep-1"], clearOverrides: true });
  assert.equal(p3.clearOverrides, true);
  assert.deepEqual(p3.diff.selectedIds, ["keep-1"]);
});

test("旧操作字面量：supplement/rebuild → INVALID_OPERATION", async () => {
  const h = makeHarness();
  assert.equal(await errCode(h.service.preview({ operation: "supplement", selectedIds: [] })), "INVALID_OPERATION");
  assert.equal(await errCode(h.service.preview({ operation: "rebuild", selectedIds: [] })), "INVALID_OPERATION");
});

test("空目标：显式 [] 未确认 → empty-target-unconfirmed；确认后落显式空列表", async () => {
  const h = makeHarness();
  assert.equal(await errCode(h.service.preview({ operation: "manage", selectedIds: [] })), "empty-target-unconfirmed");
  const ok = await h.service.preview({ operation: "manage", selectedIds: [], confirmEmpty: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.diff.targetView.modelsPresent, true, "显式空列表＝已配置（防首次填充回填）");
  assert.deepEqual(ok.diff.targetView.models, []);
});

test("clearOverrides 且仅继承覆盖 → inherited-overrides-unclearable（preview 即拒）", async () => {
  const h = makeHarness({
    rawView: view([{ id: "keep-1" }], null),
    effectiveView: view([{ id: "keep-1" }], { "keep-1": { inherited: true } }),
  });
  assert.equal(await errCode(h.service.preview({ operation: "manage", clearOverrides: true })), "inherited-overrides-unclearable");
});

test("apply 门：removed>0 且证据非 live 或目录非 latest → removals-need-live；live+latest 放行并进事务", async () => {
  // 缓存证据 + 用户显式移除
  const h1 = makeHarness();
  await h1.service.preview({ operation: "manage" }); // live 成功，写缓存
  h1.live.value = "fail";
  h1.t.now += 60 * 60 * 1000; // 缓存 ≤24h 且同 intentVersion → 有效
  const cached = await h1.service.preview({ operation: "manage" });
  assert.equal(cached.evidence.source, "cache");
  const cut = await h1.service.preview({ operation: "manage", basePreviewId: cached.previewId, selectedIds: ["new-1"] });
  assert.deepEqual(cut.diff.removed, [{ id: "keep-1", reason: "unchecked" }]);
  assert.equal(await errCode(h1.service.apply({ previewId: cut.previewId, operationId: cut.operationId })), "removals-need-live");
  // live 证据 + overlay 目录 + 移除 → 同拒
  const h2 = makeHarness({ catalog: { catalogSource: "overlay", resolvableIds: ["keep-1"], newEntryCount: 0 } });
  const ov = await h2.service.preview({ operation: "manage", selectedIds: [], confirmEmpty: true });
  assert.deepEqual(ov.diff.removed, [{ id: "keep-1", reason: "unchecked" }]);
  assert.equal(await errCode(h2.service.apply({ previewId: ov.previewId, operationId: ov.operationId })), "removals-need-live");
  // live + latest 纯新增 → 放行进事务，writeSet 就位
  const h3 = makeHarness();
  const good = await h3.service.preview({ operation: "manage", selectedIds: ["keep-1", "new-1"] });
  const done = await h3.service.apply({ previewId: good.previewId, operationId: good.operationId });
  assert.equal(done.result.status, "applied");
  assert.equal(h3.tx.snapshots.length, 1);
  assert.deepEqual(h3.tx.snapshots[0].diff.writeSet, { catalogEntries: true, models: true, modelOverrides: false, overridesUnclearable: false });
});

test("live 失败且无缓存：不写缓存文件；manage 预览仅 stale 参考，apply 被拒", async () => {
  const h = makeHarness({ live: "fail", record: { payload: { access: INDIVIDUAL_TOKEN } } });
  const p = await h.service.preview({ operation: "manage" });
  assert.equal(p.evidence.stale, true, "无缓存且 live 失败 → stale 只参考");
  assert.equal(await errCode(h.service.apply({ previewId: p.previewId, operationId: p.operationId })), "EVIDENCE_STALE");
  assert.equal(existsSync(join(h.scope.dataDir, "account-model-cache.json")), false, "live 失败不写缓存");
});

test("live 失败＋缓存 ≤24h 且同 intentVersion：纯新增可应用；过期/跨版本 → stale 且 apply 被拒", async () => {
  const h = makeHarness();
  await h.service.preview({ operation: "manage" }); // live 成功，写缓存
  h.live.value = "fail";
  h.t.now += 60 * 60 * 1000; // 1h：缓存有效
  const cached = await h.service.preview({ operation: "manage", selectedIds: ["keep-1", "new-1"] });
  assert.equal(cached.evidence.source, "cache");
  assert.equal(cached.evidence.stale, false);
  const ok = await h.service.apply({ previewId: cached.previewId, operationId: cached.operationId });
  assert.equal(ok.result.status, "applied", "纯新增（无移除）缓存证据可应用");
  const stalePreview = await (async () => {
    h.t.now += 25 * 60 * 60 * 1000;
    return h.service.preview({ operation: "manage", selectedIds: ["keep-1", "new-1"] });
  })();
  assert.equal(stalePreview.evidence.stale, true);
  assert.equal(await errCode(h.service.apply({ previewId: stalePreview.previewId, operationId: stalePreview.operationId })), "EVIDENCE_STALE");
  const before = h.intent.version;
  h.intent.version = before + 1;
  const drifted = await h.service.preview({ operation: "manage", selectedIds: ["keep-1", "new-1"] });
  assert.equal(drifted.evidence.stale, true);
});

test("10 分钟边界：过期预览 apply 拒绝", async () => {
  const h = makeHarness();
  const p = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  h.t.now += 10 * 60 * 1000 + 1;
  assert.equal(await errCode(h.service.apply({ previewId: p.previewId, operationId: p.operationId })), "PREVIEW_INVALID");
});

test("选择变化从原快照重算：不重新取数、沿用原 expiresAt、签发新 operationId", async () => {
  const h = makeHarness();
  const p1 = await h.service.preview({ operation: "manage" });
  const before = { catalog: h.counters.catalog, config: h.counters.config };
  h.t.now += 60 * 1000;
  const p2 = await h.service.preview({ operation: "manage", basePreviewId: p1.previewId, selectedIds: ["keep-1", "new-1", "new-2"] });
  assert.equal(h.counters.catalog, before.catalog, "目录不重新解析");
  assert.equal(h.counters.config, before.config, "配置不重新描述");
  assert.equal(p2.expiresAt, p1.expiresAt, "沿用原有效期不延长");
  assert.notEqual(p2.previewId, p1.previewId);
  assert.notEqual(p2.operationId, p1.operationId);
  assert.deepEqual(p2.diff.added, ["new-1", "new-2"]);
});

test("operationId 绑定选择：错配的 apply 拒绝", async () => {
  const h = makeHarness();
  const p = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  assert.equal(await errCode(h.service.apply({ previewId: p.previewId, operationId: "not-mine" })), "PREVIEW_INVALID");
});

test("apply 前漂移复核：intentVersion 变化→AUTH_CHANGED；配置 revision 变化→PREVIEW_STALE", async () => {
  const h = makeHarness();
  const p = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  h.intent.version += 1;
  assert.equal(await errCode(h.service.apply({ previewId: p.previewId, operationId: p.operationId })), "AUTH_CHANGED");
  const p2 = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  h.revision.value = 8;
  assert.equal(await errCode(h.service.apply({ previewId: p2.previewId, operationId: p2.operationId })), "PREVIEW_STALE");
});

test("幂等与忙：同 operationId 返回已知结果（active/last），不同 operationId 且 active 未终结 → RESOURCE_BUSY", async () => {
  const h = makeHarness();
  h.tx.mode = "active";
  const p = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  const first = await h.service.apply({ previewId: p.previewId, operationId: p.operationId });
  assert.equal(first.result.status, "pending-restart");
  const again = await h.service.apply({ previewId: p.previewId, operationId: p.operationId });
  assert.equal(again.idempotent, true);
  assert.equal(h.counters.runApply, 1, "幂等不重复执行");
  assert.equal((await h.service.status({ operationId: p.operationId })).query, "active");
  const p2 = await h.service.preview({ operation: "manage", selectedIds: ["new-2"] });
  assert.equal(await errCode(h.service.apply({ previewId: p2.previewId, operationId: p2.operationId })), "RESOURCE_BUSY");
  const s = await h.service.status({ operationId: "never-seen" });
  assert.equal(s.query, "unknown", "unknown 不是未执行，只是不在保留窗口");
});

test("apply 串行：第二个 apply 等第一个完成后才进入内核", async () => {
  const h = makeHarness();
  let release;
  h.tx.deferred = { promise: new Promise((r) => { release = r; }) };
  const p1 = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  const p2 = await h.service.preview({ operation: "manage", selectedIds: ["new-2"] });
  const run1 = h.service.apply({ previewId: p1.previewId, operationId: p1.operationId });
  const run2 = h.service.apply({ previewId: p2.previewId, operationId: p2.operationId });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(h.tx.calls, [p1.operationId], "第二个必须排队");
  release();
  const r1 = await run1;
  const r2 = await run2;
  assert.equal(r1.result.status, "applied");
  assert.equal(r2.result.status, "applied");
  assert.deepEqual(h.tx.calls, [p1.operationId, p2.operationId]);
});

test("scope known=false：preview/apply/retire 抛 SCOPE_UNAVAILABLE", async () => {
  const clock = { now: () => 0 };
  const svc = createRefreshService({ credentials: { readRecord: async () => null } }, {
    scope: { known: false, profileId: null, dataDir: null },
    stateIO: { load: () => null, save: () => {} },
    readIntentVersion: () => 1,
    clock,
  });
  assert.equal(await errCode(svc.preview({ operation: "manage" })), "SCOPE_UNAVAILABLE");
  assert.equal(await errCode(svc.apply({ previewId: "x", operationId: "y" })), "SCOPE_UNAVAILABLE");
  assert.equal(await errCode(svc.retire({ operationId: "y" })), "SCOPE_UNAVAILABLE");
});

test("状态未知版本：apply 拒绝并要求人工核实", async () => {
  const h = makeHarness();
  h.store.value = { unknownVersion: true };
  const p = await h.service.preview({ operation: "manage", selectedIds: ["new-1"] });
  assert.equal(await errCode(h.service.apply({ previewId: p.previewId, operationId: p.operationId })), "STATE_UNKNOWN");
});

test("快照过期淘汰：TTL 过后的快照在下次 preview 入口被清扫（防长驻累积）", async () => {
  const h = makeHarness();
  await h.service.preview({ operation: "manage" });
  await h.service.preview({ operation: "manage" });
  assert.equal(h.service.snapshotCount(), 2);
  h.t.now += 10 * 60 * 1000 + 1; // 全部过期
  await h.service.preview({ operation: "manage" }); // 入口清扫 + 新建 1 个
  assert.equal(h.service.snapshotCount(), 1, "过期快照被清扫，不随预览次数累积");
});
