// refresh-service.mjs — 预览服务与账号证据（T8）。
// 职责：内存预览快照（10 分钟、选择从原快照重算、operationId 绑定选择）、
// 账号证据门禁（重建需 live；补充允许 ≤24h 同 intentVersion 缓存；stale 只参考不可应用）、
// apply 幂等（同 operationId 返回已知结果；activeOperation 未终结时新 apply 423）、
// boot/apply/retire 同一队列串行。
// 事务内核（T9）经 transaction 注入：{runApply({snapshot}), bootRecover(), retire({operationId})}。
// 目录与配置取数经 deps 注入（host.mjs 在 T10 组装）：{resolveCatalog(catalogSource), describeConfigView()}。
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic, createMutex } from "./atomic-json.mjs";
import { CREDENTIAL_KEY } from "./shared.mjs";
import { buildModelChange } from "./model-update.mjs";
import { fetchLiveAvailableModelIds } from "./copilot-models.mjs";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function flowError(code, message, extra = {}) {
  const err = new Error(message ?? code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const iso = (ts) => new Date(ts).toISOString();

// 账号证据：live GET 成功才写缓存（fetchedAt＋intentVersion）；缓存仅 ≤24h 且同
// intentVersion 时可作补充的应用依据；否则 stale——预览可展示参考，apply 被拒（Q7/Q16）。
// 重建（rebuild）永不使用缓存：live 失败即 evidence-unavailable，不退化为缓存重建。
async function resolveAccountEvidence(ctx, { scope, readIntentVersion, clock, fetchImpl }) {
  const iv = readIntentVersion();
  const cacheFile = join(scope.dataDir, "account-model-cache.json");
  const readCache = () => {
    try {
      return readJson(cacheFile);
    } catch {
      return undefined;
    }
  };
  const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
  const payload = record?.payload ?? {};
  if (payload.access) {
    try {
      const ids = await fetchLiveAvailableModelIds({ credential: payload, fetchImpl });
      const fetchedAt = iso(clock.now()); // 单次取时：缓存值与返回值同源（避免毫秒漂移）
      mkdirSync(scope.dataDir, { recursive: true });
      writeJsonAtomic(cacheFile, { ids, fetchedAt, intentVersion: iv });
      return { source: "live", ids, fetchedAt, stale: false };
    } catch { /* 回退缓存判定 */ }
  }
  const cache = readCache();
  if (cache && Array.isArray(cache.ids) && typeof cache.fetchedAt === "string"
    && Number.isFinite(Date.parse(cache.fetchedAt))
    && clock.now() - Date.parse(cache.fetchedAt) <= CACHE_TTL_MS
    && cache.intentVersion === iv) {
    return { source: "cache", ids: cache.ids, fetchedAt: cache.fetchedAt, stale: false };
  }
  return { source: "stale", ids: Array.isArray(cache?.ids) ? cache.ids : [], fetchedAt: cache?.fetchedAt ?? null, stale: true };
}

export function createRefreshService(ctx, {
  scope,
  stateIO,
  readIntentVersion,
  clock = { now: () => Date.now() },
  deps = {},
  transaction = null,
  fetchImpl,
}) {
  const requireScope = () => {
    if (!scope?.known) throw flowError("SCOPE_UNAVAILABLE", "scope-unavailable");
  };
  const queue = createMutex();
  const snapshots = new Map(); // previewId -> snapshot（内存态；重启即失效，幂等走持久状态）
  const getFetch = () => fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const resolveCatalog = deps.resolveCatalog;
  const describeConfigView = deps.describeConfigView;

  function requireDeps() {
    if (typeof resolveCatalog !== "function" || typeof describeConfigView !== "function") {
      throw flowError("DEPS_MISSING", "refresh service deps not wired");
    }
  }

  function diffFromInputs({ operation, evidence, catalog, config, selectedIds, confirmEmpty }) {
    const diff = buildModelChange({
      operation,
      rawView: config.view,
      effectiveView: config.effectiveView,
      accountIds: evidence.ids,
      resolvableIds: catalog.resolvableIds,
      selectedIds: selectedIds ?? [],
      confirmEmpty: confirmEmpty === true,
      catalogNewEntryCount: catalog.newEntryCount ?? 0,
    });
    if (!diff.allowed) throw flowError(diff.reason, diff.reason, { policy: diff.reason, warnings: diff.warnings });
    return diff;
  }

  async function preview(body = {}) {
    requireScope();
    requireDeps();
    // 过期快照淘汰（长驻进程防累积；幂等查询走持久状态，不受影响）
    const nowTs = clock.now();
    for (const [id, snap] of snapshots) {
      if (nowTs > snap.expiresAt) snapshots.delete(id);
    }
    const { operation, catalogSource, basePreviewId, selectedIds, confirmEmpty } = body;
    if (operation !== "supplement" && operation !== "rebuild") {
      throw flowError("INVALID_OPERATION", "invalid-operation");
    }
    // 选择变化：从原快照重算（不重新下载、不重新取数），沿用原 expiresAt
    if (basePreviewId !== undefined) {
      const base = snapshots.get(basePreviewId);
      if (!base || base.consumed) throw flowError("PREVIEW_INVALID", "preview-invalid");
      if (clock.now() > base.expiresAt) throw flowError("PREVIEW_INVALID", "preview-invalid", { reason: "expired" });
      const diff = diffFromInputs({
        operation: base.operation, evidence: base.evidence, catalog: base.catalog,
        config: base.config, selectedIds, confirmEmpty,
      });
      const snap = {
        ...base,
        previewId: randomUUID(),
        selectedIds: [...(selectedIds ?? [])],
        confirmEmpty: confirmEmpty === true,
        diff,
        operationId: randomUUID(),
        basePreviewId,
        consumed: false,
      };
      snapshots.set(snap.previewId, snap);
      return projectPreview(snap);
    }
    const evidence = await resolveAccountEvidence(ctx, { scope, readIntentVersion, clock, fetchImpl: getFetch() });
    if (operation === "rebuild" && evidence.source !== "live") {
      throw flowError("EVIDENCE_UNAVAILABLE", "rebuild requires a live account fetch; cache is never used for rebuild");
    }
    const catalog = await resolveCatalog(catalogSource);
    const config = await describeConfigView();
    const intentVersion = readIntentVersion();
    const diff = diffFromInputs({ operation, evidence, catalog, config, selectedIds, confirmEmpty });
    const now = clock.now();
    const snap = {
      previewId: randomUUID(),
      createdAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
      operation,
      selectedIds: [...(selectedIds ?? [])],
      confirmEmpty: confirmEmpty === true,
      evidence,
      catalog,
      config,
      intentVersion,
      diff,
      operationId: randomUUID(),
      consumed: false,
    };
    snapshots.set(snap.previewId, snap);
    return projectPreview(snap);
  }

  function projectPreview(snap) {
    return {
      ok: true,
      previewId: snap.previewId,
      operationId: snap.operationId,
      operation: snap.operation,
      expiresAt: iso(snap.expiresAt),
      evidence: { source: snap.evidence.source, fetchedAt: snap.evidence.fetchedAt, stale: snap.evidence.stale },
      catalogSource: snap.catalog.catalogSource,
      catalogError: snap.catalog.catalogError ?? null,
      skipped: snap.catalog.skipped ?? [],
      normalized: snap.catalog.normalized ?? null,
      diff: {
        targetView: snap.diff.targetView,
        candidates: snap.diff.candidates ?? null,
        added: snap.diff.added,
        removed: snap.diff.removed,
        kept: snap.diff.kept,
        warnings: snap.diff.warnings,
        writeSet: snap.diff.writeSet,
      },
    };
  }

  async function apply(body = {}) {
    requireScope();
    const { previewId, operationId } = body;
    if (typeof operationId !== "string" || typeof previewId !== "string") {
      throw flowError("INVALID_REQUEST", "previewId and operationId are required");
    }
    return queue(async () => {
      // ① 幂等：同 operationId 先查持久状态（active → 进行中结果；lastResult → 终态结果）
      const state = stateIO.load();
      if (state?.unknownVersion) throw flowError("STATE_UNKNOWN", "state unknown-version; manual review required");
      if (state?.activeOperation?.operationId === operationId) {
        return { ok: true, operationId, result: projectActive(state.activeOperation), idempotent: true };
      }
      if (state?.lastResult?.operationId === operationId) {
        return { ok: true, operationId, result: state.lastResult, idempotent: true };
      }
      // ② activeOperation 未终结（不同 operationId）→ 423
      if (state?.activeOperation) {
        throw flowError("RESOURCE_BUSY", "an operation is still active; query status or retire it first", { activeOperationId: state.activeOperation.operationId });
      }
      // ③ live preview 校验
      const snap = snapshots.get(previewId);
      if (!snap || snap.consumed) throw flowError("PREVIEW_INVALID", "preview-invalid");
      if (snap.operationId !== operationId) throw flowError("PREVIEW_INVALID", "operationId does not bind to this preview", { reason: "operation-mismatch" });
      if (clock.now() > snap.expiresAt) throw flowError("PREVIEW_INVALID", "preview-invalid", { reason: "expired" });
      // ④ 漂移复核：intentVersion / 配置 revision
      if (readIntentVersion() !== snap.intentVersion) {
        throw flowError("AUTH_CHANGED", "auth-changed: intent version moved since preview; preview again");
      }
      const current = await describeConfigView();
      if (current.revision !== snap.config.revision) {
        throw flowError("PREVIEW_STALE", "preview-stale: configuration changed since preview; preview again");
      }
      if (snap.evidence.stale) {
        throw flowError("EVIDENCE_STALE", "account evidence is stale (no trusted timestamp, expired, or auth changed); live fetch required");
      }
      if (!transaction) throw flowError("DEPS_MISSING", "transaction kernel not wired");
      snap.consumed = true;
      return transaction.runApply({ snapshot: snap });
    });
  }

  function projectActive(active) {
    return {
      operationId: active.operationId,
      status: active.phaseResult?.status ?? "pending-restart",
      phase: active.phase,
      changes: active.changes ?? null,
      error: active.lastError ?? null,
    };
  }

  async function status(body = {}) {
    requireScope();
    const state = stateIO.load();
    if (typeof body?.operationId === "string") {
      if (state?.activeOperation?.operationId === body.operationId) {
        return { query: "active", active: projectActive(state.activeOperation), lastResult: state.lastResult ?? null };
      }
      if (state?.lastResult?.operationId === body.operationId) {
        return { query: "last", lastResult: state.lastResult, active: null };
      }
      return { query: "unknown", active: state?.activeOperation ?? null, lastResult: state?.lastResult ?? null };
    }
    return { query: "none", active: state?.activeOperation ?? null, lastResult: state?.lastResult ?? null };
  }

  async function retire(body = {}) {
    requireScope();
    if (!transaction) throw flowError("DEPS_MISSING", "transaction kernel not wired");
    return queue(() => transaction.retire({ operationId: body?.operationId }));
  }

  async function bootReady() {
    requireScope();
    if (!transaction) return { ok: true, skipped: true };
    return queue(() => transaction.bootRecover());
  }

  function dispose() {
    snapshots.clear();
  }

  // 诊断/测试观察面：当前内存快照数（含未过期；过期项在下次 preview 入口清扫）
  function snapshotCount() {
    return snapshots.size;
  }

  return { preview, apply, status, retire, bootReady, dispose, snapshotCount };
}
