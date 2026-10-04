// host 半区：cordis 插件。注册 8 条 exact 路由，把内置 github-copilot 的
// OAuth 设备码流（ctx.authorization）暴露给 Web client（T3 授权控制器），并提供
// 「补充模型／重建模型列表」双入口（T8 预览服务 + T9 事务内核，协议 v2）。
// 数据级目录补丁（只增）与供应链守卫复用 catalog/catalog-fetch/catalog-registry；
// pi-ai 代码版本不动；只读 GET /models 适配显式耦合 pi-ai 0.84.4（见 GLOSSARY 与 ADR 0001）。
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_KEY, PROTOCOL_VERSION, routes } from "./shared.mjs";
import { readJson, writeJsonAtomic, createMutex } from "./atomic-json.mjs";
import { createAuthorizationController, sanitizeAuthError } from "./auth-host.mjs";
import { resolveRuntimeScope } from "./runtime-scope.mjs";
import { mergeCatalog, digest, findPiAiInstallation, classifyCatalogTarget, normalizeRemoteCatalog, catalogShapeKeys } from "./catalog.mjs";
import { fetchLatestCatalog } from "./catalog-fetch.mjs";
import { injectCatalogEntries, registryModelIds, registryVia, registryInstanceMismatch, loadRegistryModules } from "./catalog-registry.mjs";
import { loadRefreshState, saveRefreshState } from "./state.mjs";
import { createRefreshService } from "./refresh-service.mjs";
import { createTransaction } from "./refresh-transaction.mjs";

export const name = "copilot-auth";
export const inject = ["webServer", "authorization", "credentials", "settings", "llm"];

// 内置覆盖层的收割来源版本（integrity 记录于 README「模型目录刷新」章节）
const OVERLAY_SOURCE_VERSION = "0.85.1";

const defaultStateFile = () => join(homedir(), ".dsh", "copilot-auth-state.json");
const defaultOverlayFile = () => fileURLToPath(new URL("./catalog-overlay.json", import.meta.url));
const realClock = { now: () => Date.now() };

// pi-ai 目录数据文件定位层：从进程入口逐级向上找 node_modules/@earendil-works/pi-ai。
function findCatalogFile() {
  try {
    let dir = dirname(realpathSync(process.argv?.[1] ?? ""));
    for (let depth = 0; depth < 8; depth++) {
      const dataFile = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "github-copilot.json");
      if (existsSync(dataFile)) return dataFile;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* 安装树结构变化时回退 */ }
  return null;
}

// 读取 github-copilot 的「可解析模型 id → 协议」映射（目录文件 ∪ 进程内注册表）。
async function readCatalogModelIds(install, log) {
  const byId = {};
  try {
    const dataFile = install?.catalogFile ?? findCatalogFile();
    if (dataFile) {
      const data = JSON.parse(readFileSync(dataFile, "utf8"));
      for (const [api, section] of Object.entries(data)) {
        for (const id of Object.keys(section ?? {})) byId[id] ??= api;
      }
    }
  } catch { /* 安装树结构变化时回退 */ }
  try {
    const ids = install && install.writable !== true ? await registryModelIds(install, log) : null;
    if (ids) for (const id of ids) byId[id] ??= "registry";
  } catch { /* 注册表不可用不阻断同步 */ }
  return Object.keys(byId).length > 0 ? byId : null;
}

// 登录成功（handoff 完好）后首次填充：可写集合＝账号可用 ∩ 内置目录已描述；
// 目录保护：models 键存在（含空列表）或 modelOverrides 视作用户所有，同步让路。
function readConfiguredRoute(ctx) {
  try {
    const desc = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
    const section = desc?.value ?? desc?.user;
    return section?.providers?.["github-copilot"] ?? {};
  } catch {
    return {};
  }
}

async function syncAvailableModels(ctx, opts = {}) {
  const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
  const available = record?.payload?.availableModelIds;
  if (!Array.isArray(available) || available.length === 0) return;
  const route = readConfiguredRoute(ctx);
  const modelsConfigured = route.models !== undefined && route.models !== null;
  const overridesConfigured = !!route.modelOverrides
    && typeof route.modelOverrides === "object"
    && Object.keys(route.modelOverrides).length > 0;
  if (modelsConfigured || overridesConfigured) return;
  const catalog = await readCatalogModelIds(safeInstall(opts), (m) => ctx.logger?.info?.(m));
  let ids;
  if (catalog) {
    ids = available.filter((id) => catalog[id] !== undefined);
  } else {
    const served = new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
    ids = available.filter((id) => served.has(id));
  }
  if (ids.length === 0) return;
  // T4 首次填充保护：提交前重核 handoff 仍完好（同 attempt、originIntentVersion 仍当前、
  // 无撤回/超时标记）——取数 await 期间意图已变则只记录事实，不写配置。
  if (opts.handoff) {
    const intact = typeof opts.handoffIntact === "function" ? opts.handoffIntact(opts.handoff) : false;
    if (!intact) {
      // 计划 T4「记录跳过原因」：留可 grep 痕迹（attemptId/意图版本），不误报为失败
      ctx.logger?.info?.(
        "copilot-auth: first-fill skipped — handoff stale (attemptId=%s, originIntentVersion=%s)",
        opts.handoff.attemptId ?? "?", opts.handoff.originIntentVersion ?? "?",
      );
      return;
    }
  }
  // 真 CAS：携带 expectedRevision 提交，与用户并发编辑互斥（冲突抛 SETTINGS_CONFLICT）
  const desc = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
  await ctx.settings.mutate("llm-pi-ai", [
    { op: "set", path: ["providers", "github-copilot", "models"], value: ids.map((id) => ({ id })) },
  ], desc?.revision);
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === null || origin === "") return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function json(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function guard(req, res, method) {
  if (!sameOrigin(req)) {
    json(res, 403, { ok: false, error: "forbidden origin" });
    return false;
  }
  if (req.method !== method) {
    json(res, 405, { ok: false, error: "method not allowed" });
    return false;
  }
  return true;
}

function readBody(req) {
  if (req.body !== undefined) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// 版本与 catalog 同根解析：注入 catalogFile 时 version 取其所在根的 package.json。
// 可写性分类（ADR 0002）：desktop asar 形态只读——读正常、写必拒，结构化失败。
function resolveInstall(opts) {
  let install;
  if (opts.catalogFile) {
    if (opts.piAiVersion) {
      install = { catalogFile: opts.catalogFile, version: opts.piAiVersion };
    } else {
      const root = dirname(dirname(dirname(dirname(opts.catalogFile))));
      const packageJsonFile = join(root, "package.json");
      const pkg = JSON.parse(readFileSync(packageJsonFile, "utf8"));
      install = { catalogFile: opts.catalogFile, packageJsonFile, version: pkg.version };
    }
  } else {
    const found = findPiAiInstallation();
    if (!found) throw new Error("pi-ai installation not found");
    install = found;
  }
  return { ...install, ...classifyCatalogTarget(install.catalogFile, opts.writableProbe) };
}

function safeInstall(opts = {}) {
  try {
    return resolveInstall(opts);
  } catch {
    return null;
  }
}

function readLocalCatalog(opts) {
  const install = resolveInstall(opts);
  const bytes = readFileSync(install.catalogFile);
  return {
    file: install.catalogFile,
    bytes,
    catalog: JSON.parse(bytes.toString("utf8")),
    writable: install.writable,
    unwritableReason: install.unwritableReason,
  };
}

class InvalidModeError extends Error {}

// R3-3 严格分支：仅 mode==="overlay" 读内置覆盖层；normal npm 失败只回
// catalogSource:"local"（绝不隐式读 overlay）；未知 mode → 400。
async function resolveCatalogSource(opts, mode, fetchImpl, allowedKeys) {
  if (mode === "overlay") {
    const raw = readJson(opts.overlayFile ?? defaultOverlayFile());
    if (raw === undefined) throw new Error("bundled overlay file missing");
    const normalized = normalizeRemoteCatalog(raw, { allowedKeys });
    return {
      catalog: normalized.catalog,
      normalized: { renamed: normalized.renamed, skipped: normalized.skipped },
      catalogSource: "overlay",
      catalogError: null,
      provenance: { kind: "overlay", piAiVersion: OVERLAY_SOURCE_VERSION, integrity: null },
    };
  }
  if (mode !== undefined && mode !== "latest") throw new InvalidModeError(String(mode));
  try {
    const r = await fetchLatestCatalog({ fetchImpl });
    const normalized = normalizeRemoteCatalog(r.catalog, { allowedKeys });
    return {
      catalog: normalized.catalog,
      normalized: { renamed: normalized.renamed, skipped: normalized.skipped },
      catalogSource: "latest",
      catalogError: null,
      provenance: { kind: "latest", piAiVersion: r.piAiVersion, integrity: r.integrity },
    };
  } catch (error) {
    return {
      catalog: readLocalCatalog(opts).catalog,
      normalized: null,
      catalogSource: "local",
      catalogError: String(error?.message ?? error),
      provenance: { kind: "local" },
    };
  }
}

// settings 双视图（T8/T9 取数面）：raw user 层 + base+user 合成层 + 同次 revision。
// 缺席一律 null 占位（非 undefined），保证持久化无损与逐字节比较可行。
function viewFromUserLayer(user) {
  let route = {};
  if (user && typeof user === "object" && !Array.isArray(user)) {
    const r = user.providers?.["github-copilot"];
    if (r && typeof r === "object" && !Array.isArray(r)) route = r;
  }
  const modelsPresent = route.models !== undefined && route.models !== null;
  const modelOverridesPresent = route.modelOverrides !== undefined && route.modelOverrides !== null;
  return {
    modelsPresent,
    models: modelsPresent ? route.models : null,
    modelOverridesPresent,
    modelOverrides: modelOverridesPresent ? route.modelOverrides : null,
  };
}

function describeRouteView(ctx) {
  const empty = { view: viewFromUserLayer(undefined), effectiveView: viewFromUserLayer(undefined), revision: null };
  try {
    const d = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
    if (!d) return empty;
    return {
      view: viewFromUserLayer(d.user),
      effectiveView: viewFromUserLayer(d.value ?? d.user),
      revision: d.revision,
    };
  } catch {
    return empty;
  }
}

function overlayEntryIds(overlay) {
  return Object.values(overlay ?? {}).flatMap((s) => Object.keys(s ?? {}));
}

// 路由当前端出的模型 id 集合；宿主 API 不可用时返回 null（无从判断，不误报）。
async function servedModelIds(ctx) {
  try {
    return new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
  } catch {
    return null;
  }
}

function configuredModelIds(ctx) {
  const models = readConfiguredRoute(ctx).models;
  return new Set((Array.isArray(models) ? models : []).map((m) => m?.id).filter(Boolean));
}

// 诊断口径：已注入条目中，被 settings 引用却没能从路由端出来的 id（ADR 0003）。
async function registryServedDiagnostics(ctx, overlayIds) {
  const referenced = [...new Set(overlayIds)].filter((id) => configuredModelIds(ctx).has(id));
  if (referenced.length === 0) return { referenced, missing: [] };
  const served = await servedModelIds(ctx);
  if (served === null) return { referenced, missing: null };
  return { referenced, missing: referenced.filter((id) => !served.has(id)) };
}

// 净零切换（ADR 0003 增补 v1.2.7）：同值写不改变配置对象身份、宿主快照不重建；
// 两次真内容变化（displayName 加空格再复原）推动快照重建，净效果＝用户配置一字不改。
async function touchRouteIdentity(ctx, log) {
  void log;
  const describe = () => ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
  const first = describe();
  const route = first?.user?.providers?.["github-copilot"];
  if (!first || !route || typeof route !== "object" || Array.isArray(route)) return false;
  const hadOwn = Object.prototype.hasOwnProperty.call(route, "displayName");
  const current = hadOwn ? route.displayName : undefined;
  const probeBase = typeof current === "string" && current.length > 0 ? current : "GitHub Copilot";
  const path = ["providers", "github-copilot", "displayName"];
  await ctx.settings.mutate("llm-pi-ai", [{ op: "set", path, value: `${probeBase} ` }], first.revision);
  const second = describe();
  await ctx.settings.mutate("llm-pi-ai", [hadOwn ? { op: "set", path, value: current } : { op: "unset", path }], second?.revision);
  return true;
}

// intentVersion 持久层（T3 契约）：`<dataDir>/auth-intent.json` 原子写；
// scope 未知时读写一律抛错 → 写路由 503，不伪成功。
function createIntentIO(scope) {
  const file = scope?.known ? join(scope.dataDir, "auth-intent.json") : null;
  return {
    read() {
      if (!file) throw new Error("scope-unavailable");
      const raw = readJson(file);
      return typeof raw?.intentVersion === "number" ? raw.intentVersion : 0;
    },
    bump() {
      if (!file) throw new Error("scope-unavailable");
      mkdirSync(scope.dataDir, { recursive: true });
      const cur = readJson(file);
      const next = (typeof cur?.intentVersion === "number" ? cur.intentVersion : 0) + 1;
      writeJsonAtomic(file, { version: 1, intentVersion: next, updatedAt: new Date().toISOString() });
      return next;
    },
  };
}

// 服务错误 → HTTP 投影（白名单 code，脱敏）
function serviceError(res, err) {
  const map = {
    SCOPE_UNAVAILABLE: [503, "scope-unavailable"],
    INVALID_OPERATION: [400, "invalid-operation"],
    INVALID_REQUEST: [400, "bad-request"],
    INVALID_CATALOG_SOURCE: [400, "invalid-catalog-source"],
    INSTALL_UNRESOLVED: [409, "install-unresolved"],
    PREVIEW_INVALID: [409, "preview-invalid"],
    PREVIEW_STALE: [409, "preview-stale"],
    AUTH_CHANGED: [409, "auth-changed"],
    EVIDENCE_UNAVAILABLE: [409, "evidence-unavailable"],
    EVIDENCE_STALE: [409, "evidence-stale"],
    RESOURCE_BUSY: [423, "resource-busy"],
    STATE_UNKNOWN: [409, "state-unknown"],
    DEPS_MISSING: [500, "service-not-wired"],
  };
  const m = map[err?.code];
  if (m) {
    json(res, m[0], { ok: false, error: m[1], reason: err.reason ?? null });
    return;
  }
  // 策略拒绝（empty-intersection-unconfirmed／inherited-overrides-unclearable 等）
  json(res, 409, { ok: false, error: sanitizeAuthError(err) });
}

export function apply(ctx, opts = {}) {
  const r = routes();
  const scope = resolveRuntimeScope(ctx);
  const intentIO = createIntentIO(scope);
  const legacyPath = opts.stateFile ?? defaultStateFile();
  const log = (m) => ctx.logger?.info?.(m);
  let lastSyncError;
  const refreshMutex = createMutex(); // 预览串行（apply/retire 在服务队列内串行）

  // v2 状态读写层（profile 隔离；unknownVersion 以标记对象上抛给服务层拒绝）
  const stateIO = {
    load: () => {
      const loaded = loadRefreshState(scope, { legacyPath });
      if (loaded.flags.unknownVersion) return { unknownVersion: true };
      return loaded.state;
    },
    save: (state) => saveRefreshState(scope, state),
  };

  // 模型目录同步只在登录成功（且 handoff 完好）后执行；失败经 /status 暴露 syncError。
  const runSync = (handoff) => syncAvailableModels(ctx, { ...opts, handoff, handoffIntact: controller.handoffIntact }).then(() => {
    lastSyncError = undefined;
  }).catch((err) => {
    lastSyncError = String(err?.message ?? err);
    ctx.logger?.warn?.("copilot-auth: model sync failed: %s", lastSyncError);
  });

  // 授权控制器（T3）：软撤回＋风险锁存；退出/重新授权在当前宿主下统一禁用。
  const controller = createAuthorizationController(ctx, {
    scope,
    intentIO,
    onAuthorized: (handoff) => { void runSync(handoff); },
  });

  // ---- 初始化期能力探测（Q23：GET status 不执行写探针，通道分类来自此处缓存） ----
  let installInfo = null;
  try {
    installInfo = resolveInstall(opts);
  } catch {
    installInfo = null;
  }
  let catalogMode = "unknown";
  let blockedReason = installInfo ? null : "install-unresolved";
  if (installInfo) {
    if (installInfo.writable === true) {
      catalogMode = "file";
    } else {
      // 只读安装树：注册表面可用性探测（boot 期一次，异步；不写任何文件）
      void loadRegistryModules(installInfo, log).then((m) => {
        if (m?.via) catalogMode = "registry";
        else {
          catalogMode = "blocked";
          blockedReason = "inject-unavailable";
        }
      }).catch(() => {
        catalogMode = "blocked";
        blockedReason = "inject-unavailable";
      });
    }
  }

  // ---- 事务内核（T9）与服务（T8）接线 ----
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const transaction = installInfo ? createTransaction(ctx, {
    scope,
    stateIO,
    readIntentVersion: () => intentIO.read(),
    clock: realClock,
    install: installInfo,
    deps: {
      describeConfigView: () => describeRouteView(ctx),
      mutateSettings: (ops, expectedRevision) => ctx.settings.mutate("llm-pi-ai", ops, expectedRevision),
      listServedIds: () => servedModelIds(ctx),
      touchRouteIdentity: () => touchRouteIdentity(ctx, log),
      readDiskCatalog: () => JSON.parse(readFileSync(installInfo.catalogFile, "utf8")),
      injectRegistry: (overlay, { allowedKeys }) => (opts.injectRegistry ?? injectCatalogEntries)(installInfo, overlay, { log, allowedKeys }),
      registryIds: () => (opts.registryIds ?? registryModelIds)(installInfo, log),
    },
    log,
    servedRetry: { attempts: 5, delayMs: 150 },
  }) : null;

  const resolveCatalogForService = async (catalogSource) => {
    if (!installInfo) {
      const err = new Error("install-unresolved");
      err.code = "INSTALL_UNRESOLVED";
      throw err;
    }
    if (catalogSource !== undefined && !["latest", "local", "overlay"].includes(catalogSource)) {
      const err = new Error("invalid-catalog-source");
      err.code = "INVALID_CATALOG_SOURCE";
      throw err;
    }
    const local = readLocalCatalog(opts);
    let resolved;
    if (catalogSource === "local") {
      resolved = { catalog: local.catalog, normalized: null, catalogSource: "local", catalogError: null, provenance: { kind: "local" } };
    } else {
      resolved = await resolveCatalogSource(opts, catalogSource === "overlay" ? "overlay" : undefined, fetchImpl, catalogShapeKeys(local.catalog));
    }
    const merged = mergeCatalog(local.catalog, resolved.catalog);
    const resolvableIds = Object.values(merged.merged).flatMap((s) => Object.keys(s ?? {}));
    return {
      catalogSource: resolved.catalogSource,
      catalogError: resolved.catalogError,
      skipped: merged.skipped,
      normalized: resolved.normalized,
      addedOverlay: merged.addedOverlay,
      resolvableIds,
      newEntryCount: overlayEntryIds(merged.addedOverlay).length,
      provenance: resolved.provenance,
    };
  };

  const refreshService = createRefreshService(ctx, {
    scope,
    stateIO,
    readIntentVersion: () => intentIO.read(),
    clock: realClock,
    deps: {
      resolveCatalog: resolveCatalogForService,
      describeConfigView: () => describeRouteView(ctx),
    },
    transaction,
    fetchImpl,
  });

  // 启动序列（boot 恢复＋保守激活/自愈，T9 bootRecover）；绝不阻断挂载。
  void refreshService.bootReady()
    .catch((err) => {
      ctx.logger?.warn?.("copilot-auth: refresh boot failed: %s", String(err?.message ?? err));
    })
    .finally(() => opts.onBootDone?.());

  // ==================== 授权路由（T3/T4） ====================

  ctx.webServer.register({
    kind: "exact",
    path: r.start,
    handler: (req, res) => {
      if (!guard(req, res, "POST")) return;
      if (!scope.known) {
        json(res, 503, { ok: false, error: "scope-unavailable" });
        return;
      }
      try {
        const { attemptId } = controller.start();
        json(res, 202, { ok: true, attemptId });
      } catch (err) {
        if (err?.code === "ATTEMPT_RUNNING") {
          json(res, 409, { ok: false, error: "already running", attemptId: err.attemptId });
          return;
        }
        if (err?.code === "AUTH_UNSAFE") {
          json(res, 409, { ok: false, error: "auth-unsafe" });
          return;
        }
        json(res, 500, { ok: false, error: sanitizeAuthError(err) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.cancel,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      if (!scope.known) {
        json(res, 503, { ok: false, error: "scope-unavailable" });
        return;
      }
      try {
        const { withdrawalDelivery } = await controller.cancel();
        json(res, 200, { ok: true, withdrawalDelivery });
      } catch (err) {
        json(res, 500, { ok: false, error: sanitizeAuthError(err) });
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.state,
    handler: (req, res) => {
      if (!guard(req, res, "GET")) return;
      json(res, 200, controller.snapshot());
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.status,
    handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      // describeRecord 只回传 presence，不把含 token 的 GrantRecord 拉进内存。
      let credential = "absent";
      try {
        const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY);
        credential = info?.configured === true ? "present" : "absent";
      } catch {
        credential = "read-error";
      }
      const authSnapshot = controller.snapshot();
      // refresh 块：只读聚合（通道分类来自启动期缓存；GET 不执行写探针，Q23）
      const loaded = loadRefreshState(scope, { legacyPath });
      const st = loaded.flags.unknownVersion ? null : loaded.state;
      let catalogDigest = null;
      if (installInfo) {
        try {
          catalogDigest = digest(readFileSync(installInfo.catalogFile));
        } catch {
          catalogDigest = null;
        }
      }
      let registryViaNow = null;
      let registryMismatch = null;
      try {
        registryViaNow = registryVia();
        registryMismatch = registryInstanceMismatch();
      } catch { /* 诊断字段缺失不阻断 */ }
      const refresh = {
        scopeAvailable: scope.known,
        catalogWritable: installInfo ? installInfo.writable === true : null,
        catalogMode,
        blockedReason,
        registryInjected: st ? overlayEntryIds(st.appliedOverlay).length : 0,
        registryVia: registryViaNow,
        registryInstanceMismatch: registryMismatch,
        catalogFile: installInfo?.catalogFile ?? null,
        settingsNotServed: (await registryServedDiagnostics(ctx, st ? overlayEntryIds(st.appliedOverlay) : [])).missing,
        activated: st?.activated === true,
        activeOperation: st?.activeOperation ?? null,
        lastResult: st?.lastResult ?? null,
        pendingRestart: !!st?.restartState || st?.activeOperation?.phaseResult?.status === "pending-restart",
        legacyStateDetected: loaded.flags.legacyStateDetected === true,
        stateUnknownVersion: loaded.flags.unknownVersion === true,
        piAiVersion: installInfo?.version ?? null,
        catalogDigest,
        lastError: st?.lastError ?? null,
      };
      // GET status 的 operationId 查询三态（active / last / unknown；unknown≠未执行）
      let operation = null;
      const opId = typeof req.url === "string" ? new URL(req.url, "http://local").searchParams.get("operationId") : null;
      if (opId) {
        try {
          operation = await refreshService.status({ operationId: opId });
        } catch {
          operation = { query: "unknown" };
        }
      }
      json(res, 200, {
        configured: credential === "present",
        syncError: lastSyncError,
        authorization: {
          credential,
          attempt: authSnapshot,
          riskLatch: authSnapshot.riskLatch,
          capabilities: { logout: false, reauthorize: false },
        },
        refresh,
        ...(operation ? { operation } : {}),
      });
    },
  });

  // 退出登录：当前宿主桥接无法证明安全退出（D-01），统一拒绝且绝不 deleteRecord。
  ctx.webServer.register({
    kind: "exact",
    path: r.logout,
    handler: (req, res) => {
      if (!guard(req, res, "POST")) return;
      json(res, 403, { ok: false, error: "logout-safety-unavailable" });
    },
  });

  // ==================== 模型管理路由（协议 v2，T8/T9/T10） ====================

  const requireProtocol = (res, body) => {
    if (body?.protocolVersion !== PROTOCOL_VERSION) {
      json(res, 400, { ok: false, error: "upgrade-required" });
      return false;
    }
    return true;
  };

  ctx.webServer.register({
    kind: "exact",
    path: r.refreshPreview,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { ok: false, error: "bad-body" });
        return;
      }
      if (!requireProtocol(res, body)) return;
      try {
        const out = await refreshMutex(() => refreshService.preview(body ?? {}));
        json(res, 200, out);
      } catch (err) {
        if (err instanceof InvalidModeError) {
          json(res, 400, { ok: false, error: "invalid-mode" });
          return;
        }
        serviceError(res, err);
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.refreshApply,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { ok: false, error: "bad-body" });
        return;
      }
      if (!requireProtocol(res, body)) return;
      try {
        const out = await refreshService.apply(body ?? {});
        json(res, 200, out);
      } catch (err) {
        serviceError(res, err);
      }
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.refreshRetire,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { ok: false, error: "bad-body" });
        return;
      }
      if (!requireProtocol(res, body)) return;
      try {
        const out = await refreshService.retire(body ?? {});
        if (out.ok === false) {
          json(res, 409, { ok: false, error: out.error ?? "not-active" });
          return;
        }
        json(res, 200, out);
      } catch (err) {
        serviceError(res, err);
      }
    },
  });
}

export default { name, inject, apply };
