// refresh-transaction.mjs — apply 事务内核、boot 恢复与 retire（T9）。
// 阶段机：prepared → catalog-landed → configuration-committed → verified，
// 每阶段先持久再行动（写前意图）；两通道提交时点（接口契约「apply 提交时点」）：
//  - file 通道且 writeSet.catalogEntries：apply 只落目录并返回 pending-restart，
//    配置提交延迟到下个 boot（目录已加载＋目标可解析＋基线 view 未变，否则 conflict）
//  - registry 通道／纯配置：apply 当次完成提交与验证（纯配置即时生效，Q29）
// 回滚只在「当前配置仍等于本操作写入值」时执行，否则 rollback-conflict 保留用户值。
// bootRecover 同时承担 v1 boot 的保守激活/自愈职责（等价迁移）与 restartState 清理。
// failpoint 仅测试注入（opts.failpoint(name) 在命名边界抛错模拟崩溃窗口）。
import { writeJsonAtomic } from "./atomic-json.mjs";
import { mergeCatalog, digest } from "./catalog.mjs";
import { catalogShapeKeys } from "./catalog.mjs";
import { restartMarker, setRefreshError, clearRefreshError } from "./state.mjs";

const MODELS_PATH = ["providers", "github-copilot", "models"];
const OVERRIDES_PATH = ["providers", "github-copilot", "modelOverrides"];

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
const viewDigest = (view) => digest(canonical(view));

function overlayIds(overlay) {
  return Object.values(overlay ?? {}).flatMap((s) => Object.keys(s ?? {}));
}

function buildConfigOps(baseline, target) {
  const ops = [];
  if (target.modelsPresent) {
    ops.push({ op: "set", path: MODELS_PATH, value: target.models });
  } else if (baseline.modelsPresent) {
    ops.push({ op: "unset", path: MODELS_PATH });
  }
  if (target.modelOverridesPresent) {
    ops.push({ op: "set", path: OVERRIDES_PATH, value: target.modelOverrides });
  } else if (baseline.modelOverridesPresent) {
    ops.push({ op: "unset", path: OVERRIDES_PATH });
  }
  return ops;
}

export function createTransaction(ctx, {
  scope,
  stateIO,
  readIntentVersion,
  clock = { now: () => Date.now() },
  install,
  deps,
  log = () => {},
  failpoint = null,
  servedRetry = { attempts: 5, delayMs: 5 },
} = {}) {
  const fp = (name) => {
    if (failpoint && failpoint(name)) throw new Error(`failpoint:${name}`);
  };
  const diskIds = () => {
    try {
      const disk = deps.readDiskCatalog();
      return new Set(Object.values(disk).flatMap((s) => Object.keys(s ?? {})));
    } catch {
      return new Set();
    }
  };
  // 运行时实际可解析集合：目录文件 ∪ 进程内注册表（只读安装树才并注册表面）
  const servedIds = async () => {
    const ids = diskIds();
    if (install && install.writable !== true) {
      try {
        const reg = await deps.registryIds();
        if (reg) for (const id of reg) ids.add(id);
      } catch { /* 注册表不可用不阻断 */ }
    }
    return ids;
  };
  async function waitForServed(targetIds) {
    const want = [...new Set(targetIds)];
    for (let i = 0; i < servedRetry.attempts; i++) {
      let served = null;
      try {
        served = await deps.listServedIds();
      } catch {
        served = null;
      }
      if (served && want.every((id) => served.has(id))) return { ok: true, missing: [] };
      if (i < servedRetry.attempts - 1) await new Promise((r) => setTimeout(r, servedRetry.delayMs));
    }
    return { ok: false, missing: want };
  }

  // 落地一次目录增量：可写安装树走原子写盘（只增合并）；只读树走注册表注入。
  // 返回 {ok, wrote, mode, reason}，绝不抛。
  async function landIncrement(overlay) {
    const merged = mergeCatalog(deps.readDiskCatalog(), overlay);
    if (merged.added.length === 0) return { ok: true, wrote: false, mode: "none", reason: null, merged };
    if (install.writable) {
      writeJsonAtomic(install.catalogFile, merged.merged);
      return { ok: true, wrote: true, mode: "file", reason: null, merged };
    }
    const injected = await deps.injectRegistry(overlay, { allowedKeys: catalogShapeKeys(deps.readDiskCatalog()) });
    return { ok: injected.ok, wrote: false, mode: "registry", reason: injected.reason, merged };
  }

  function terminal(state, result) {
    // 终态原子写：lastResult 与清 activeOperation 同一次保存（不留「丢事实开新写」窗口）
    const next = { ...state, activeOperation: null, lastResult: result };
    next.intentVersion = readIntentVersion();
    stateIO.save(next);
    return { ok: true, operationId: result.operationId, result };
  }

  async function runApply({ snapshot }) {
    const state0 = stateIO.load();
    if (!state0) throw new Error("state-missing");
    const diff = snapshot.diff;
    const writeSet = diff.writeSet;
    const active = {
      operationId: snapshot.operationId,
      strategy: snapshot.operation,
      selectedIds: [...(snapshot.selectedIds ?? [])],
      confirmEmpty: snapshot.confirmEmpty === true,
      intentVersion: snapshot.intentVersion,
      settingsBaseline: { view: snapshot.config.view, revision: snapshot.config.revision },
      targetView: diff.targetView,
      writeSet,
      pendingOverlay: snapshot.catalog.addedOverlay ?? {},
      provenance: snapshot.catalog.provenance ?? null,
      appliedAgainstPiAiVersion: install?.version ?? null,
      phase: "prepared",
      createdAt: new Date(clock.now()).toISOString(),
      lastError: null,
      phaseResult: null,
    };
    fp("before-prepared");
    stateIO.save({ ...state0, activeOperation: active });
    fp("after-prepared");

    let state = stateIO.load();

    // ---- 目录落地 ----
    if (writeSet.catalogEntries && overlayIds(active.pendingOverlay).length > 0) {
      const landed = await landIncrement(active.pendingOverlay);
      if (!landed.ok) {
        return terminal(state, {
          operationId: active.operationId,
          status: "conflict",
          phase: "prepared",
          error: landed.mode === "file" ? "catalog-not-writable" : `registry-inject-failed (${landed.reason})`,
          changes: { catalogAdded: 0, modelsAdded: 0, modelsRemoved: 0 },
        });
      }
      state = stateIO.load();
      state.appliedOverlay = mergeCatalog(state.appliedOverlay, active.pendingOverlay).merged;
      state.appliedProvenance = {
        sourcePiAiVersion: active.provenance?.piAiVersion ?? null,
        integrity: active.provenance?.integrity ?? null,
        appliedAgainstPiAiVersion: install.version,
        catalogSchemaVersion: 1,
      };
      state.activated = true;
      active.phase = "catalog-landed";
      state.activeOperation = active;
      state = clearRefreshError(state);
      fp("after-catalog-landed");
      stateIO.save(state);
      state = stateIO.load();
    }

    const configWrite = writeSet.models || writeSet.modelOverrides;
    const fileChannelDeferred = install.writable === true && writeSet.catalogEntries;

    // ---- file 通道两阶段：配置提交延迟到 boot ----
    if (fileChannelDeferred) {
      if (configWrite) {
        state.restartState = restartMarker("refresh", digest(state.appliedOverlay));
        state.activeOperation = { ...active, phaseResult: { status: "pending-restart" } };
        stateIO.save(state);
        return {
          ok: true,
          operationId: active.operationId,
          result: {
            operationId: active.operationId,
            status: "pending-restart",
            phase: "catalog-landed",
            changes: { catalogAdded: overlayIds(active.pendingOverlay).length, modelsAdded: 0, modelsRemoved: 0 },
          },
        };
      }
      // 目录-only：无配置写，待重启加载即完成（结果非 no-change：目录确实落地了）
      state.restartState = restartMarker("refresh", digest(state.appliedOverlay));
      return terminal(state, {
        operationId: active.operationId,
        status: "pending-restart",
        phase: "catalog-landed",
        changes: { catalogAdded: overlayIds(active.pendingOverlay).length, modelsAdded: 0, modelsRemoved: 0 },
      });
    }

    // ---- 当次配置提交（registry 通道 / 纯配置） ----
    if (configWrite) {
      const current = await deps.describeConfigView();
      if (current.revision !== active.settingsBaseline.revision) {
        return terminal(state, {
          operationId: active.operationId,
          status: "conflict",
          phase: "catalog-landed",
          error: "settings-conflict: configuration changed since preview",
          changes: { catalogAdded: writeSet.catalogEntries ? overlayIds(active.pendingOverlay).length : 0, modelsAdded: 0, modelsRemoved: 0 },
        });
      }
      const ops = buildConfigOps(active.settingsBaseline.view, active.targetView);
      // 写前意图：先持久 configuration-committed（提交即将发生），再 mutate；
      // 崩溃于两窗之间由 boot 按「当前值==target→applied／==baseline→重提交」收敛
      state = stateIO.load();
      state.activeOperation = { ...active, phase: "configuration-committed" };
      stateIO.save(state);
      fp("before-mutate");
      try {
        await deps.mutateSettings(ops, current.revision);
      } catch (err) {
        const conflict = err?.code === "SETTINGS_CONFLICT" || /conflict/i.test(String(err?.message ?? ""));
        return terminal(stateIO.load(), {
          operationId: active.operationId,
          status: "conflict",
          phase: "configuration-committed",
          error: conflict ? "settings-conflict" : String(err?.message ?? err),
          changes: { catalogAdded: writeSet.catalogEntries ? overlayIds(active.pendingOverlay).length : 0, modelsAdded: 0, modelsRemoved: 0 },
        });
      }
      fp("after-mutate");
      state = stateIO.load();
    }

    // ---- 验证 ----
    const targetIds = (active.targetView.models ?? []).map((m) => m?.id).filter(Boolean);
    if (!install.writable && (configWrite || writeSet.catalogEntries)) {
      // registry：宿主 listModels 端到端复核（注入后宿主快照可能需要净零切换重建）
      let served = await waitForServed(targetIds);
      if (!served.ok && typeof deps.touchRouteIdentity === "function") {
        let touched = false;
        try {
          touched = await deps.touchRouteIdentity();
        } catch (err) {
          log(`copilot-auth: registry snapshot touch failed — ${String(err?.message ?? err)}`);
        }
        if (touched) served = await waitForServed(targetIds);
      }
      if (!served.ok) {
        // 自证失败：仅当当前配置仍等于本操作写入值才回滚，否则 rollback-conflict 保留用户值
        const now = await deps.describeConfigView();
        const weOwn = canonical(now.view) === canonical({ ...active.targetView });
        if (weOwn) {
          const restore = buildConfigOps(active.targetView, active.settingsBaseline.view);
          try {
            const cur = await deps.describeConfigView();
            await deps.mutateSettings(restore, cur.revision);
            return terminal(stateIO.load(), {
              operationId: active.operationId,
              status: "rolled-back",
              phase: "configuration-committed",
              error: `registry-not-served: ${served.missing.join(",")}`,
              changes: { catalogAdded: writeSet.catalogEntries ? overlayIds(active.pendingOverlay).length : 0, modelsAdded: 0, modelsRemoved: 0 },
            });
          } catch {
            return terminal(stateIO.load(), {
              operationId: active.operationId,
              status: "rollback-conflict",
              phase: "configuration-committed",
              error: `registry-not-served: ${served.missing.join(",")}`,
              changes: { catalogAdded: writeSet.catalogEntries ? overlayIds(active.pendingOverlay).length : 0, modelsAdded: 0, modelsRemoved: 0 },
            });
          }
        }
        return terminal(stateIO.load(), {
          operationId: active.operationId,
          status: "rollback-conflict",
          phase: "configuration-committed",
          error: `registry-not-served: ${served.missing.join(",")}`,
          changes: { catalogAdded: writeSet.catalogEntries ? overlayIds(active.pendingOverlay).length : 0, modelsAdded: 0, modelsRemoved: 0 },
        });
      }
    } else if (configWrite) {
      // 纯配置／可写树：re-describe 相等即验证
      const now = await deps.describeConfigView();
      if (canonical(now.view.models) !== canonical(active.targetView.models)
        || canonical(now.view.modelOverrides) !== canonical(active.targetView.modelOverrides)) {
        return terminal(stateIO.load(), {
          operationId: active.operationId,
          status: "partial",
          phase: "configuration-committed",
          error: "verification-mismatch",
          changes: { catalogAdded: 0, modelsAdded: diff.added.length, modelsRemoved: diff.removed.length },
        });
      }
    }

    state = stateIO.load();
    state.activeOperation = { ...active, phase: "verified" };
    stateIO.save(state);
    return terminal(stateIO.load(), {
      operationId: active.operationId,
      status: "applied",
      phase: "verified",
      changes: {
        catalogAdded: writeSet.catalogEntries ? overlayIds(active.pendingOverlay).length : 0,
        modelsAdded: diff.added.length,
        modelsRemoved: diff.removed.length,
      },
    });
  }

  // ---- boot 恢复：activeOperation + restartState 清理 + 保守激活/自愈（等价迁移 v1 boot） ----
  async function bootRecover() {
    let state = stateIO.load();
    if (!state) return { ok: true, skipped: true };
    let wroteDiskThisBoot = false;

    // 自愈（v1 boot 1）：仅 activated 且 pi-ai 基线未变才重放；跨基线只上报不自动应用
    if (state.activated && overlayIds(state.appliedOverlay).length > 0 && state.appliedProvenance?.appliedAgainstPiAiVersion) {
      const baseline = state.appliedProvenance.appliedAgainstPiAiVersion;
      if (install?.version === baseline) {
        const landed = await landIncrement(state.appliedOverlay);
        if (!landed.ok) {
          state = setRefreshError(state, landed.mode === "file" ? "catalog-not-writable: self-heal deferred" : `registry-inject-failed (${landed.reason}): self-heal deferred`);
          stateIO.save(state);
        } else {
          if (landed.wrote) {
            state.restartState = restartMarker("self-heal", digest(state.appliedOverlay));
            wroteDiskThisBoot = true; // 本进程尚未加载新目录：restartState 留待下个 boot 核实后清除
          }
          if (landed.mode === "registry" && landed.merged.added.length > 0) {
            // 注入当次生效：宿主快照复核，缺失即净零切换重试，仍缺失记 lastError（不写盘、不阻断）
            const ids = overlayIds(state.appliedOverlay);
            const served = await waitForServed(ids);
            if (!served.ok && ids.length > 0) {
              let recovered = false;
              if (typeof deps.touchRouteIdentity === "function") {
                let touched = false;
                try { touched = await deps.touchRouteIdentity(); } catch { /* 尽力而为 */ }
                if (touched) recovered = (await waitForServed(ids)).ok;
              }
              if (!recovered) {
                state = setRefreshError(state, `registry-not-served: ${served.missing.join(",")} — injected entries are in the registry but the route still does not serve them`);
                stateIO.save(state);
                return finish();
              }
            }
          }
          state = clearRefreshError(state);
          stateIO.save(state);
        }
      } else {
        const ids = await servedIds();
        const missing = overlayIds(state.appliedOverlay).filter((id) => !ids.has(id));
        if (missing.length > 0) {
          state = setRefreshError(state, `self-heal-incompatible: pi-ai ${install?.version} != baseline ${baseline}, missing ${missing.join(",")}`);
          stateIO.save(state);
        }
      }
    }

    return finish();

    async function finish() {
      let st = stateIO.load();
      // restartState 清理（v1 boot 2b）：期望条目已可解析即清除（不携带 settings 意图）；
      // 本 boot 刚写盘的除外（当前进程目录快照未加载新条目）
      if (st.restartState && install && !wroteDiskThisBoot) {
        const ids = await servedIds();
        if (overlayIds(st.appliedOverlay).every((id) => ids.has(id))) {
          st.restartState = null;
          st = clearRefreshError(st);
          stateIO.save(st);
        }
      }
      st = stateIO.load();
      const active = st?.activeOperation;
      if (!active) return { ok: true, active: false };

      // intentVersion 漂移：不消费旧 target，标记 recovery-needed（用户经 retire 显式结束后重新预览）
      if (active.intentVersion !== readIntentVersion()) {
        const next = stateIO.load();
        next.activeOperation = { ...active, phaseResult: { status: "recovery-needed", error: "intent-version-drift" } };
        stateIO.save(next);
        return { ok: true, active: true, status: "recovery-needed" };
      }

      if (active.phase === "prepared") {
        // 崩溃窗口：目录可能已落地也可能没有——兼容 gate 通过后幂等重放，进入 catalog-landed 语义
        if (active.writeSet?.catalogEntries && overlayIds(active.pendingOverlay).length > 0) {
          if (install?.version !== active.appliedAgainstPiAiVersion) {
            const next = stateIO.load();
            next.activeOperation = { ...active, phaseResult: { status: "recovery-needed", error: "prepared-incompatible" } };
            stateIO.save(setRefreshError(next, "prepared-incompatible"));
            return { ok: true, active: true, status: "recovery-needed" };
          }
          const landed = await landIncrement(active.pendingOverlay);
          if (!landed.ok) {
            const next = stateIO.load();
            next.activeOperation = { ...active, phaseResult: { status: "recovery-needed", error: landed.mode === "file" ? "catalog-not-writable" : `registry-inject-failed (${landed.reason})` } };
            next.activeOperation.lastError = next.activeOperation.phaseResult.error;
            stateIO.save(setRefreshError(next, next.activeOperation.phaseResult.error));
            return { ok: true, active: true, status: "recovery-needed" };
          }
          const next = stateIO.load();
          next.appliedOverlay = mergeCatalog(next.appliedOverlay, active.pendingOverlay).merged;
          next.appliedProvenance = next.appliedProvenance ?? {
            sourcePiAiVersion: null, integrity: null, appliedAgainstPiAiVersion: install.version, catalogSchemaVersion: 1,
          };
          next.activated = true;
          next.activeOperation = { ...active, phase: "catalog-landed" };
          stateIO.save(clearRefreshError(next));
        }
      }

      const a = stateIO.load()?.activeOperation;
      if (!a) return { ok: true, active: false };

      if (a.phase === "catalog-landed") {
        const configWrite = a.writeSet?.models || a.writeSet?.modelOverrides;
        if (install?.writable === true && a.writeSet?.catalogEntries && configWrite) {
          // file 通道延迟提交：目录已加载（新进程）→可解析前置→基线 CAS→verified
          const ids = await servedIds();
          const targetIds = (a.targetView.models ?? []).map((m) => m?.id).filter(Boolean);
          const unresolvable = targetIds.filter((id) => !ids.has(id));
          if (unresolvable.length > 0) {
            const next = stateIO.load();
            next.activeOperation = { ...a, phaseResult: { status: "recovery-needed", error: `target-unresolvable: ${unresolvable.join(",")}` } };
            stateIO.save(setRefreshError(next, `target-unresolvable: ${unresolvable.join(",")}`));
            return { ok: true, active: true, status: "recovery-needed" };
          }
          const now = await deps.describeConfigView();
          const baselineDigestNow = viewDigest(now.view);
          const baselineDigestThen = viewDigest(a.settingsBaseline.view);
          const targetDigest = viewDigest(a.targetView);
          if (canonical(now.view.models) === canonical(a.targetView.models)) {
            // 已等于 target（崩溃于提交后）→ 幂等消费
            return terminalize("applied", "verified");
          }
          if (baselineDigestNow === baselineDigestThen) {
            const ops = buildConfigOps(a.settingsBaseline.view, a.targetView);
            try {
              await deps.mutateSettings(ops, now.revision);
              return terminalize("applied", "verified");
            } catch {
              return terminalize("conflict", "catalog-landed", "settings-conflict at boot commit");
            }
          }
          // 基线漂移：用户值优先，不覆盖
          return terminalize("conflict", "catalog-landed", "settings-conflict: configuration changed since preview");
          function terminalize(status, phase, error) {
            const st = stateIO.load();
            st.activeOperation = null;
            st.lastResult = { operationId: a.operationId, status, phase, error: error ?? null, changes: { catalogAdded: overlayIds(a.pendingOverlay ?? {}).length, modelsAdded: 0, modelsRemoved: 0 } };
            if (status === "applied") st.restartState = null;
            st.intentVersion = readIntentVersion();
            stateIO.save(st);
            return { ok: true, active: false, status };
          }
        }
        // registry／目录-only 的 catalog-landed 残留（崩溃于验证前）：重新验证
        const targetIds = (a.targetView.models ?? []).map((m) => m?.id).filter(Boolean);
        const served = await waitForServed(targetIds);
        const st = stateIO.load();
        st.activeOperation = null;
        st.lastResult = served.ok
          ? { operationId: a.operationId, status: "applied", phase: "verified", changes: { catalogAdded: overlayIds(a.pendingOverlay ?? {}).length, modelsAdded: 0, modelsRemoved: 0 } }
          : { operationId: a.operationId, status: "partial", phase: "catalog-landed", error: `registry-not-served: ${served.missing.join(",")}`, changes: { catalogAdded: overlayIds(a.pendingOverlay ?? {}).length, modelsAdded: 0, modelsRemoved: 0 } };
        st.intentVersion = readIntentVersion();
        stateIO.save(st);
        return { ok: true, active: false, status: st.lastResult.status };
      }

      if (a.phase === "configuration-committed") {
        // 崩溃窗口收敛：当前值==target（提交已落地）→ applied；==baseline（提交未落地）→ 重提交；
        // 其余（用户并发修改，归属不明）→ rollback-conflict 保留用户值，绝不覆盖
        const now = await deps.describeConfigView();
        if (canonical(now.view.models) === canonical(a.targetView.models)
          && canonical(now.view.modelOverrides) === canonical(a.targetView.modelOverrides)) {
          return terminal(stateIO.load(), { operationId: a.operationId, status: "applied", phase: "verified", changes: { catalogAdded: 0, modelsAdded: 0, modelsRemoved: 0 } });
        }
        if (canonical(now.view.models) === canonical(a.settingsBaseline.view.models)
          && canonical(now.view.modelOverrides) === canonical(a.settingsBaseline.view.modelOverrides)) {
          const ops = buildConfigOps(a.settingsBaseline.view, a.targetView);
          try {
            await deps.mutateSettings(ops, now.revision);
            return terminal(stateIO.load(), { operationId: a.operationId, status: "applied", phase: "verified", changes: { catalogAdded: 0, modelsAdded: 0, modelsRemoved: 0 } });
          } catch {
            return terminal(stateIO.load(), { operationId: a.operationId, status: "conflict", phase: "configuration-committed", error: "settings-conflict at boot recommit", changes: { catalogAdded: 0, modelsAdded: 0, modelsRemoved: 0 } });
          }
        }
        return terminal(stateIO.load(), { operationId: a.operationId, status: "rollback-conflict", phase: "configuration-committed", error: "commit-gap: configuration neither baseline nor target; user value preserved", changes: { catalogAdded: 0, modelsAdded: 0, modelsRemoved: 0 } });
      }

      return { ok: true, active: true, status: a.phaseResult?.status ?? a.phase };
    }
  }

  // ---- retire：静止核实后清 activeOperation（服务队列内串行即静止；绝不写配置） ----
  async function retire({ operationId } = {}) {
    const state = stateIO.load();
    const active = state?.activeOperation;
    if (!active) {
      if (state?.lastResult?.operationId === operationId) return { ok: true, idempotent: true, result: state.lastResult };
      return { ok: false, error: "not-active" };
    }
    if (operationId !== undefined && active.operationId !== operationId) {
      return { ok: false, error: "operation-mismatch" };
    }
    const drift = active.intentVersion !== readIntentVersion();
    const result = {
      operationId: active.operationId,
      status: "intent-retired",
      phase: active.phase,
      drift,
      changes: null,
      error: drift ? "intent-version-drift: old target not consumed" : null,
    };
    const next = { ...state, activeOperation: null, lastResult: result };
    next.intentVersion = readIntentVersion();
    stateIO.save(next);
    return { ok: true, result };
  }

  return { runApply, bootRecover, retire };
}
