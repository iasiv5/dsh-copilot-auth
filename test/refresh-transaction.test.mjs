// T9：事务内核与恢复——两通道提交时点、崩溃窗口、条件回滚、retire、自愈矩阵。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransaction } from "../src/refresh-transaction.mjs";
import { loadRefreshState, saveRefreshState } from "../src/state.mjs";

const NEW_ENTRY = { id: "new-1", api: "openai-completions", provider: "github-copilot", contextWindow: 1, maxTokens: 1 };
const BASE_CATALOG = { "openai-completions": { "keep-1": { id: "keep-1", api: "openai-completions", provider: "github-copilot", contextWindow: 1, maxTokens: 1 } } };
const OVERLAY = { "openai-completions": { "new-1": NEW_ENTRY } };

function makeWorld({ writable = true, version = "0.84.4", served = ["keep-1"], registryFail = false, userLayer } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tx-"));
  const root = join(dir, "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(join(root, "dist", "providers", "data"), { recursive: true });
  const catalogFile = join(root, "dist", "providers", "data", "github-copilot.json");
  writeFileSync(catalogFile, JSON.stringify(BASE_CATALOG, null, 2) + "\n");
  const scope = { known: true, profileId: "tx", dataDir: join(dir, "data") };
  const stateIO = {
    load: () => loadRefreshState(scope).state,
    save: (s) => saveRefreshState(scope, s),
  };
  const intent = { version: 1 };
  const settings = {
    revision: 7,
    userLayer: userLayer === undefined ? { providers: { "github-copilot": { models: [{ id: "keep-1" }] } } } : userLayer,
    mutateCalls: [],
    afterMutate: null,
  };
  const viewFrom = (layer) => {
    const route = layer?.providers?.["github-copilot"] ?? {};
    const modelsPresent = route.models !== undefined && route.models !== null;
    const modelOverridesPresent = route.modelOverrides !== undefined && route.modelOverrides !== null;
    return { modelsPresent, models: modelsPresent ? route.models : null, modelOverridesPresent, modelOverrides: modelOverridesPresent ? route.modelOverrides : null };
  };
  const world = {
    dir, catalogFile, scope, stateIO, intent, settings, writable, version,
    served: [...served],
    registry: [],
  };
  const deps = {
    describeConfigView: async () => ({ view: viewFrom(settings.userLayer), effectiveView: viewFrom(settings.userLayer), revision: settings.revision }),
    mutateSettings: async (ops, expectedRevision) => {
      settings.mutateCalls.push({ ops, expectedRevision });
      if (expectedRevision !== undefined && expectedRevision !== settings.revision) {
        const e = new Error("settings conflict");
        e.code = "SETTINGS_CONFLICT";
        throw e;
      }
      const providers = (settings.userLayer.providers ??= {});
      const route = (providers["github-copilot"] ??= {});
      for (const op of ops) {
        if (op.op === "set") route[op.path[2]] = op.value;
        else delete route[op.path[2]];
      }
      settings.revision += 1;
      settings.afterMutate?.();
    },
    listServedIds: async () => new Set(world.served),
    touchRouteIdentity: async () => world.touch === true,
    readDiskCatalog: () => JSON.parse(readFileSync(catalogFile, "utf8")),
    injectRegistry: async () => (registryFail ? { ok: false, reason: "sealed" } : { ok: true, injected: ["new-1"], present: [] }),
    registryIds: async () => new Set(world.registry),
  };
  world.makeTx = (extra = {}) => createTransaction({}, {
    scope, stateIO, clock: { now: () => 1_000_000 },
    readIntentVersion: () => intent.version,
    install: { catalogFile, version, writable, unwritableReason: writable ? null : "asar" },
    deps, log: () => {},
    servedRetry: { attempts: 1, delayMs: 0 },
    ...extra,
  });
  world.touch = false;
  return world;
}

function makeSnapshot(w, {
  operationId = "op-1", operation = "supplement", selectedIds = ["new-1"],
  writeSet = { catalogEntries: true, models: true, modelOverrides: false },
  targetModels, intentVersion, addedOverlay = OVERLAY,
} = {}) {
  const view = { modelsPresent: true, models: [{ id: "keep-1" }], modelOverridesPresent: false, modelOverrides: null };
  return {
    operationId, operation, selectedIds, confirmEmpty: false,
    intentVersion: intentVersion ?? w.intent.version,
    config: { view, revision: w.settings.revision },
    catalog: { addedOverlay, resolvableIds: ["keep-1", "new-1"], provenance: { kind: "latest", piAiVersion: "0.85.1" }, catalogSource: "latest" },
    diff: {
      targetView: { modelsPresent: true, models: targetModels ?? [{ id: "keep-1" }, { id: "new-1" }], modelOverridesPresent: false, modelOverrides: null },
      writeSet, added: ["new-1"], removed: [],
    },
    evidence: { stale: false },
  };
}

const diskHas = (w, id) => Object.values(JSON.parse(readFileSync(w.catalogFile, "utf8"))).some((s) => id in s);

test("TX_PREPARE：prepared 持久失败 → 零副作用（目录零写入、mutate 零调用、无 activeOperation）", async () => {
  const w = makeWorld();
  const before = readFileSync(w.catalogFile, "utf8");
  await assert.rejects(() => w.makeTx({ failpoint: (n) => n === "before-prepared" }).runApply({ snapshot: makeSnapshot(w) }), /failpoint/);
  assert.equal(readFileSync(w.catalogFile, "utf8"), before);
  assert.equal(w.settings.mutateCalls.length, 0);
  assert.equal(w.stateIO.load().activeOperation, null);
});

test("TX_FILE：file 通道 apply 当次零 settings 写、返回 pending-restart、activeOperation 保留", async () => {
  const w = makeWorld();
  const out = await w.makeTx().runApply({ snapshot: makeSnapshot(w) });
  assert.equal(out.result.status, "pending-restart");
  assert.equal(w.settings.mutateCalls.length, 0);
  assert.ok(diskHas(w, "new-1"), "目录已原子落地");
  const st = w.stateIO.load();
  assert.equal(st.activeOperation.phase, "catalog-landed");
  assert.equal(st.restartState.reason, "refresh");
  return st;
});

test("TX_FILE boot：目录已加载＋基线未变 → 按 CAS 提交 → applied；重复 boot 幂等", async () => {
  const w = makeWorld();
  await w.makeTx().runApply({ snapshot: makeSnapshot(w) });
  const r1 = await w.makeTx().bootRecover();
  assert.equal(r1.status, "applied");
  assert.equal(w.settings.mutateCalls.length, 1, "boot 恰好提交一次");
  assert.deepEqual(w.settings.userLayer.providers["github-copilot"].models, [{ id: "keep-1" }, { id: "new-1" }]);
  const st = w.stateIO.load();
  assert.equal(st.activeOperation, null);
  assert.equal(st.restartState, null);
  assert.equal(st.lastResult.status, "applied");
  const r2 = await w.makeTx().bootRecover();
  assert.equal(r2.active, false);
  assert.equal(w.settings.mutateCalls.length, 1, "重复恢复幂等");
});

test("TX_FILE boot：提交前用户已改配置 → conflict 保留用户值不覆盖", async () => {
  const w = makeWorld();
  await w.makeTx().runApply({ snapshot: makeSnapshot(w) });
  w.settings.userLayer.providers["github-copilot"].models = [{ id: "user-9" }]; // 用户并发编辑
  w.settings.revision += 1;
  const r = await w.makeTx().bootRecover();
  assert.equal(r.status, "conflict");
  assert.equal(w.settings.mutateCalls.length, 0, "boot 零提交");
  assert.deepEqual(w.settings.userLayer.providers["github-copilot"].models, [{ id: "user-9" }], "用户值保留");
  assert.equal(w.stateIO.load().lastResult.status, "conflict");
});

test("TX_REGISTRY：registry 通道 apply 当次完成提交与验证 → applied", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1", "new-1"] });
  const out = await w.makeTx().runApply({ snapshot: makeSnapshot(w) });
  assert.equal(out.result.status, "applied");
  assert.equal(w.settings.mutateCalls.length, 1);
  assert.equal(w.stateIO.load().activeOperation, null);
});

test("TX_PURE：纯配置变化（无目录写、目标当前运行时已可解析）→ 即时 applied 无需重启", async () => {
  const w = makeWorld({ served: ["keep-1", "new-1"] });
  const out = await w.makeTx().runApply({
    snapshot: makeSnapshot(w, { writeSet: { catalogEntries: false, models: true, modelOverrides: false } }),
  });
  assert.equal(out.result.status, "applied");
  assert.equal(w.settings.mutateCalls.length, 1);
  assert.equal(w.stateIO.load().restartState, null);
});

test("TX_CONFLICT：提交前 revision 变化 → conflict 且旧 target 零写入", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1", "new-1"] });
  const snap = makeSnapshot(w);
  w.settings.revision += 1; // preview 之后用户改了配置
  const out = await w.makeTx().runApply({ snapshot: snap });
  assert.equal(out.result.status, "conflict");
  assert.equal(w.settings.mutateCalls.length, 0, "旧 target 不得写入");
});

test("TX_IDEMPOTENCY：配置提交后中断（after-mutate）→ boot 核实为 applied，不重复提交", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1", "new-1"] });
  await assert.rejects(() => w.makeTx({ failpoint: (n) => n === "after-mutate" }).runApply({ snapshot: makeSnapshot(w) }), /failpoint/);
  assert.equal(w.stateIO.load().activeOperation.phase, "configuration-committed");
  const r = await w.makeTx().bootRecover();
  assert.equal(r.result.status, "applied");
  assert.equal(w.settings.mutateCalls.length, 1, "提交已落地，boot 只核实不重发");
});

test("TX_DRIFT：boot 时 activeOperation.intentVersion 已漂移 → 不消费旧 target（recovery-needed，无 mutate）", async () => {
  const w = makeWorld();
  await w.makeTx().runApply({ snapshot: makeSnapshot(w) }); // pending-restart
  w.intent.version += 1; // 授权侧显式操作使旧意图失效
  const r = await w.makeTx().bootRecover();
  assert.equal(r.status, "recovery-needed");
  assert.equal(w.settings.mutateCalls.length, 0);
  const st = w.stateIO.load();
  assert.equal(st.activeOperation.phaseResult.status, "recovery-needed");
  assert.equal(st.activeOperation.phaseResult.error, "intent-version-drift");
});

test("TX_ZERO_SELECT：零勾选＋目录增量 → 目录落地、models 零变化、结果 pending-restart 而非 no-change", async () => {
  const w = makeWorld();
  const out = await w.makeTx().runApply({
    snapshot: makeSnapshot(w, { selectedIds: [], writeSet: { catalogEntries: true, models: false, modelOverrides: false }, targetModels: [{ id: "keep-1" }] }),
  });
  assert.equal(out.result.status, "pending-restart");
  assert.ok(diskHas(w, "new-1"));
  assert.equal(w.settings.mutateCalls.length, 0);
  assert.deepEqual(w.settings.userLayer.providers["github-copilot"].models, [{ id: "keep-1" }]);
  assert.equal(w.stateIO.load().activeOperation, null, "目录-only 无配置意图，activeOperation 即完成");
});

test("TX_ROLLBACK：registry served 缺失且当前配置仍等于本操作写入 → 回滚成功 rolled-back", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1"] }); // new-1 端不出来
  const out = await w.makeTx().runApply({ snapshot: makeSnapshot(w) });
  assert.equal(out.result.status, "rolled-back");
  assert.equal(w.settings.mutateCalls.length, 2, "提交＋受保护回滚");
  assert.deepEqual(w.settings.userLayer.providers["github-copilot"].models, [{ id: "keep-1" }], "配置回到基线");
  assert.ok(out.result.error.includes("registry-not-served"));
});

test("TX_ROLLBACK_CONFLICT：验证期间用户编辑 → rollback-conflict 保留用户值", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1"] });
  w.settings.afterMutate = () => { // 本操作提交后、验证前，用户并发改了 models
    w.settings.userLayer.providers["github-copilot"].models = [{ id: "user-9" }];
    w.settings.afterMutate = null;
  };
  const out = await w.makeTx().runApply({ snapshot: makeSnapshot(w) });
  assert.equal(out.result.status, "rollback-conflict");
  assert.deepEqual(w.settings.userLayer.providers["github-copilot"].models, [{ id: "user-9" }], "用户新修改优先");
});

test("TX_RECOVERY_REGISTRY：catalog-landed 崩溃残留（registry）→ boot 重新验证", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1", "new-1"] });
  // 制造残留：registry 通道在验证前中断
  const tx = w.makeTx({ failpoint: () => false });
  await tx.runApply({ snapshot: makeSnapshot(w) });
  // 直接手工重置为 catalog-landed 残留 + 已提交配置（模拟验证前崩溃）
  const st = w.stateIO.load();
  void st;
  const w2 = makeWorld({ writable: false, served: ["keep-1", "new-1"] });
  const s2 = w2.stateIO.load();
  s2.activeOperation = {
    operationId: "op-x", strategy: "supplement", selectedIds: ["new-1"], intentVersion: w2.intent.version,
    settingsBaseline: { view: { modelsPresent: true, models: [{ id: "keep-1" }], modelOverridesPresent: false, modelOverrides: null }, revision: 7 },
    targetView: { modelsPresent: true, models: [{ id: "keep-1" }, { id: "new-1" }], modelOverridesPresent: false, modelOverrides: null },
    writeSet: { catalogEntries: true, models: true, modelOverrides: false }, pendingOverlay: OVERLAY,
    phase: "catalog-landed", phaseResult: null, lastError: null,
  };
  w2.stateIO.save(s2);
  const r = await w2.makeTx().bootRecover();
  assert.equal(r.status, "applied");
});

test("TX_RETIRE：静止核实后清 activeOperation；幂等；drift 不消费旧 target", async () => {
  const w = makeWorld();
  await w.makeTx().runApply({ snapshot: makeSnapshot(w) }); // active: pending-restart
  const r1 = await w.makeTx().retire({ operationId: "op-1" });
  assert.equal(r1.result.status, "intent-retired");
  assert.equal(w.settings.mutateCalls.length, 0, "retire 绝不写配置");
  assert.equal(w.stateIO.load().activeOperation, null);
  const r2 = await w.makeTx().retire({ operationId: "op-1" });
  assert.equal(r2.idempotent, true);
  // drift 分支
  const w3 = makeWorld();
  await w3.makeTx().runApply({ snapshot: makeSnapshot(w3) });
  w3.intent.version += 1;
  const r3 = await w3.makeTx().retire({ operationId: "op-1" });
  assert.equal(r3.result.status, "intent-retired");
  assert.equal(r3.result.drift, true);
  assert.equal(w3.settings.mutateCalls.length, 0, "不消费旧 target");
});

test("TX_SELF_HEAL：同基线且条目已在盘 → 幂等零写入", async () => {
  const w = makeWorld();
  writeFileSync(w.catalogFile, JSON.stringify({ ...BASE_CATALOG, "openai-completions": { ...BASE_CATALOG["openai-completions"], "new-1": NEW_ENTRY } }, null, 2) + "\n");
  const s = w.stateIO.load();
  s.activated = true;
  s.appliedOverlay = OVERLAY;
  s.appliedProvenance = { sourcePiAiVersion: "0.85.1", integrity: null, appliedAgainstPiAiVersion: "0.84.4", catalogSchemaVersion: 1 };
  w.stateIO.save(s);
  const before = readFileSync(w.catalogFile, "utf8");
  await w.makeTx().bootRecover();
  assert.equal(readFileSync(w.catalogFile, "utf8"), before, "条目已原生存在 → 空操作");
  assert.equal(w.stateIO.load().lastError, null);
});

test("TX_SELF_HEAL：pi-ai 覆盖目录后按 appliedOverlay 只增重放（file → restartState=self-heal，下个 boot 清除）", async () => {
  const w = makeWorld(); // 目录被重装覆盖回 BASE（丢 new-1）
  const s = w.stateIO.load();
  s.activated = true;
  s.appliedOverlay = OVERLAY;
  s.appliedProvenance = { sourcePiAiVersion: "0.85.1", integrity: null, appliedAgainstPiAiVersion: "0.84.4", catalogSchemaVersion: 1 };
  w.stateIO.save(s);
  await w.makeTx().bootRecover();
  assert.ok(diskHas(w, "new-1"), "覆盖后重放恢复");
  assert.equal(w.stateIO.load().restartState.reason, "self-heal", "本 boot 不清除（进程未加载新目录）");
  await w.makeTx().bootRecover(); // 下个 boot：目录已加载
  assert.equal(w.stateIO.load().restartState, null);
  assert.equal(w.settings.mutateCalls.length, 0, "自愈不触碰配置");
});

test("TX_SELF_HEAL：registry 重放后 served 缺失 → 上报 lastError 不阻断", async () => {
  const w = makeWorld({ writable: false, served: ["keep-1"] });
  const s = w.stateIO.load();
  s.activated = true;
  s.appliedOverlay = OVERLAY;
  s.appliedProvenance = { sourcePiAiVersion: "0.85.1", integrity: null, appliedAgainstPiAiVersion: "0.84.4", catalogSchemaVersion: 1 };
  w.stateIO.save(s);
  await w.makeTx().bootRecover();
  assert.ok(w.stateIO.load().lastError?.includes("registry-not-served"));
});

test("TX_SELF_HEAL：跨 pi-ai 基线且条目缺失 → 不自动应用，上报 self-heal-incompatible", async () => {
  const w = makeWorld({ version: "0.90.0" });
  const before = readFileSync(w.catalogFile, "utf8");
  const s = w.stateIO.load();
  s.activated = true;
  s.appliedOverlay = OVERLAY;
  s.appliedProvenance = { sourcePiAiVersion: "0.85.1", integrity: null, appliedAgainstPiAiVersion: "0.84.4", catalogSchemaVersion: 1 };
  w.stateIO.save(s);
  await w.makeTx().bootRecover();
  assert.equal(readFileSync(w.catalogFile, "utf8"), before, "跨基线不改安装树");
  assert.ok(w.stateIO.load().lastError?.includes("self-heal-incompatible"));
});
