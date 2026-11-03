// service↔kernel 真集成测试（评审 Q3/Q6 收口沉淀，2026-11-03）：
// service 单测的 fake 内核无法保证镜像真内核全部分支（Q3 实录：idempotent 分支缺位＝假绿，
// 见 know-how 032 §7 与评审台账 .dsh-research/copilot-auth-review-20261103/scratch/），
// 本文件用**真实 createTransaction** 挂进真实 createRefreshService（假对象只留 I/O），
// 机械捕获 mock 漂移与内核分支变化。探针原形：scratch/probe-invalidated-v2.mjs（评审台账）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransaction } from "../src/refresh-transaction.mjs";
import { createRefreshService } from "../src/refresh-service.mjs";
import { loadRefreshState, saveRefreshState } from "../src/state.mjs";

const BASE_CATALOG = { "openai-completions": { "keep-1": { id: "keep-1", api: "openai-completions", provider: "github-copilot", contextWindow: 1, maxTokens: 1 } } };
const OVERLAY = { "openai-completions": { "new-1": { id: "new-1", api: "openai-completions", provider: "github-copilot", contextWindow: 1, maxTokens: 1 } } };

function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), "integration-"));
  const root = join(dir, "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(join(root, "dist", "providers", "data"), { recursive: true });
  const catalogFile = join(root, "dist", "providers", "data", "github-copilot.json");
  writeFileSync(catalogFile, JSON.stringify(BASE_CATALOG, null, 2) + "\n");
  const scope = { known: true, profileId: "integration", dataDir: join(dir, "data") };
  const stateIO = { load: () => loadRefreshState(scope).state, save: (s) => saveRefreshState(scope, s) };
  const settings = { revision: 7, mutateCalls: [], userLayer: { providers: { "github-copilot": { models: [{ id: "keep-1" }] } } }, afterMutate: null };
  const viewFrom = (layer) => {
    const route = layer?.providers?.["github-copilot"] ?? {};
    return { modelsPresent: route.models !== undefined && route.models !== null, models: route.models ?? null, modelOverridesPresent: false, modelOverrides: null };
  };
  const deps = {
    describeConfigView: async () => ({ view: viewFrom(settings.userLayer), effectiveView: viewFrom(settings.userLayer), revision: settings.revision }),
    mutateSettings: async (ops) => {
      settings.mutateCalls.push(ops);
      const providers = (settings.userLayer.providers ??= {});
      const route = (providers["github-copilot"] ??= {});
      for (const op of ops) { if (op.op === "set") route[op.path[2]] = op.value; else delete route[op.path[2]]; }
      settings.revision += 1; settings.afterMutate?.();
    },
    listServedIds: async () => new Set(["keep-1"]),
    touchRouteIdentity: async () => false,
    readDiskCatalog: () => JSON.parse(readFileSync(catalogFile, "utf8")),
    injectRegistry: async () => ({ ok: true, injected: ["new-1"], present: [] }),
    registryIds: async () => new Set([]),
  };
  const intent = { version: 1 };
  const tx = createTransaction({}, {
    scope, stateIO, clock: { now: () => 1_000_000 },
    readIntentVersion: () => intent.version,
    install: { catalogFile, version: "0.84.4", writable: true, unwritableReason: null },
    deps, log: () => {}, servedRetry: { attempts: 1, delayMs: 0 },
  });
  const service = createRefreshService({}, {
    scope, stateIO, clock: { now: () => 1_000_000 },
    readIntentVersion: () => intent.version,
    deps, transaction: tx, fetchImpl: async () => { throw new Error("not used"); },
  });
  return { stateIO, intent, settings, tx, service };
}

function makeSnapshot(w) {
  const view = { modelsPresent: true, models: [{ id: "keep-1" }], modelOverridesPresent: false, modelOverrides: null };
  return {
    operationId: "op-1", operation: "supplement", selectedIds: ["new-1"], confirmEmpty: false,
    intentVersion: w.intent.version,
    config: { view, revision: w.settings.revision },
    catalog: { addedOverlay: OVERLAY, resolvableIds: ["keep-1", "new-1"], provenance: { kind: "latest", piAiVersion: "0.85.1" }, catalogSource: "latest" },
    diff: { targetView: { modelsPresent: true, models: [{ id: "keep-1" }, { id: "new-1" }], modelOverridesPresent: false, modelOverrides: null }, writeSet: { catalogEntries: true, models: true, modelOverrides: false }, added: ["new-1"], removed: [] },
    evidence: { stale: false },
  };
}

test("INTEGRATE_INVALIDATE_A：全新 profile（无事可作废）→ invalidated:false 不虚报（评审 Q3 回归）", async () => {
  const w = makeWorld();
  const inv = await w.service.invalidateForAuthAction("logout");
  assert.deepEqual(inv, { ok: true, invalidated: false });
  assert.equal(w.stateIO.load().activeOperation, null);
});

test("INTEGRATE_INVALIDATE_B：pending-restart 活跃操作被终结 → error 逐字 + activeOperation 清空", async () => {
  const w = makeWorld();
  await w.tx.runApply({ snapshot: makeSnapshot(w) });
  const inv = await w.service.invalidateForAuthAction("auth-start");
  assert.equal(inv.ok, true);
  assert.equal(inv.invalidated, true);
  assert.equal(inv.result?.status, "intent-retired");
  assert.equal(inv.result?.error, "superseded-by-auth-action:auth-start");
  assert.equal(w.stateIO.load().activeOperation, null);
  assert.deepEqual(w.settings.mutateCalls, [], "作废绝不写配置");
  // B2：终结后再来一次（幂等，无事可作废）
  const inv2 = await w.service.invalidateForAuthAction("logout");
  assert.deepEqual(inv2, { ok: true, invalidated: false });
});

test("INTEGRATE_INVALIDATE_C：非法 source → INVALID_SOURCE", async () => {
  const w = makeWorld();
  await assert.rejects(() => w.service.invalidateForAuthAction("nope"), (e) => e.code === "INVALID_SOURCE");
});
