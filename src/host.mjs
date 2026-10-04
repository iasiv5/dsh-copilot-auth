// host 半区：cordis 插件。注册 6 条 exact 路由，把内置 github-copilot 的
// OAuth 设备码流（ctx.authorization）暴露给 Web client，并提供「手动刷新可用
// 模型目录」（数据级目录补丁，pi-ai 代码版本不动；只读 GET /models 适配显式
// 耦合 pi-ai 0.84.4，详见 GLOSSARY.md 与 ADR 0001）。
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_KEY, routes } from "./shared.mjs";
import { readJson, writeJsonAtomic, createMutex } from "./atomic-json.mjs";
import { createAuthorizationController, sanitizeAuthError } from "./auth-host.mjs";
import { resolveRuntimeScope } from "./runtime-scope.mjs";
import { mergeCatalog, diffModels, digest, findPiAiInstallation, classifyCatalogTarget, normalizeRemoteCatalog, catalogShapeKeys } from "./catalog.mjs";
import { fetchLatestCatalog } from "./catalog-fetch.mjs";
import { injectCatalogEntries, registryModelIds, registryVia, registryInstanceMismatch } from "./catalog-registry.mjs";
import { fetchLiveAvailableModelIds } from "./copilot-models.mjs";
import { loadState, saveState, freshState, createJournal, advanceJournal, restartMarker, setLastError, clearLastError } from "./state.mjs";

export const name = "copilot-auth";
export const inject = ["webServer", "authorization", "credentials", "settings", "llm"];

// 内置覆盖层的收割来源版本（Task 7，integrity 记录于 README「模型目录刷新」章节）
const OVERLAY_SOURCE_VERSION = "0.85.1";

// pi-ai 目录数据文件定位层（从 readCatalogModelIds 拆出，行为不变）：
// 从进程入口（dsh 可执行文件）逐级向上找 node_modules/@earendil-works/pi-ai。
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

// 读取 github-copilot 的「可解析模型 id → 协议」映射。只读不改。
// 两个来源的并集：① 安装树内的目录数据文件；② 进程内目录注册表（ADR 0003——desktop
// 只读安装树下，刷新出来的增量条目只存在于注册表，目录文件里永远看不到）。两者都
// 拿不到才返回 null（调用方回退 listModels 交集）。
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
    // 注册表面只在**只读安装树**（desktop asar）上才有意义：可写安装树下目录文件就是
    // 运行时加载的副本，多读一次模块只是白白把 pi-ai 的模块图拉进本进程。
    const ids = install && install.writable !== true ? await registryModelIds(install, log) : null;
    if (ids) for (const id of ids) byId[id] ??= "registry";
  } catch { /* 注册表不可用不阻断同步 */ }
  return Object.keys(byId).length > 0 ? byId : null;
}

// 登录成功后，把账号可用模型写入用户 settings 的模型目录
// （turnkey，用户新增需求 2026-09-04；目录保护，用户反馈 2026-09-05）。
// 可写集合取交集：凭据 payload.availableModelIds（账号可用）∩ 内置目录已描述。
// 目录快照外的 id 必须排除——catalog 路由校验要求模型的 wire 协议可解析
// （api = 路由设置 ?? 目录条目 ?? 路由共享协议），目录外 id 三者皆空会被整体
// 拒绝；pi-ai 目录更新后它们会自然进入可写集合。
// 目录保护（2026-09-05）：该路由已配置模型目录（models 键存在，含空列表）或
// modelOverrides 时视作用户所有，同步直接让路——用户在 Models 页精简过的目录
// 不会被重置。只有目录尚不存在时才填充一次；想重置全量，删掉 settings.yaml
// 里该路由的 models 列表后重新登录即可。

// 读取解析后的 github-copilot 路由配置（base 层 + 用户层的最终值）。
// 0.1.7 起 settings.get(ns) 被移除（settings API 重塑，见 know-how 013 §3），
// 改经 describe()：value 层（base+user 合成）语义等价旧 get；旧版 DSH 的
// describe 行无 value 时回退 user 层（用户定制目录恰在 user 层）。
// settings 未注入 / 未注册 / 读取失败一律按空处理——回退到可写入分支，
// 保持既有 turnkey 行为不变。
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
    // 回退：listModels 反映当前已配置列表，存在「已配置→只见已配置」自锁，
    // 仅作目录定位失败时的降级。
    const served = new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
    ids = available.filter((id) => served.has(id));
  }
  if (ids.length === 0) return;
  // T4 首次填充保护：提交前重核 handoff 仍完好（同 attempt、originIntentVersion 仍当前、
  // 无撤回/超时标记）——取数 await 期间意图已变（撤回 V2/超时）则只记录事实，不写配置。
  if (opts.handoff) {
    const intact = typeof opts.handoffIntact === "function" ? opts.handoffIntact(opts.handoff) : false;
    if (!intact) return;
  }
  // 真 CAS（与 boot 2a 同款，2026-09-28 审计补充）：携带 expectedRevision 提交，
  // 与用户在 Models 页的并发编辑互斥——冲突时 settings 抛 SETTINGS_CONFLICT，
  // 由 sync() 的 catch 记入 syncError（失败不静默），不再有静默覆盖窗口。
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

// ==================== 模型目录手动刷新（数据级目录补丁，ADR 0001） ====================

class InvalidModeError extends Error {}

const defaultStateFile = () => join(homedir(), ".dsh", "copilot-auth-state.json");
const defaultOverlayFile = () => fileURLToPath(new URL("./catalog-overlay.json", import.meta.url));

// 字面量 body 直接用（测试）；否则按流读并 JSON.parse
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

// 版本与 catalog 同根解析（R3-8）：注入 catalogFile 时 version 取其所在根的
// package.json（opts.piAiVersion 为测试钩子）；生产走 findPiAiInstallation()。
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
  // 可写性门禁（ADR 0002）：desktop asar 打包形态下 catalogFile 在只读归档内——读一切
  // 正常、写必被拒。这里统一分类，apply/boot 据此结构化快速失败而非抛天书 ENOENT。
  // opts.writableProbe 为测试注入钩子（生产恒用默认探测实现）。
  return { ...install, ...classifyCatalogTarget(install.catalogFile, opts.writableProbe) };
}

// 定位失败不抛（boot/同步/settings 都必须能在安装树异常时降级）。
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

// 账号可用模型：现场拉取（显式耦合 0.84.4）→ 任何失败回退凭证缓存 availableModelIds
async function resolveAvailable(ctx, fetchImpl) {
  const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
  const payload = record?.payload ?? {};
  if (payload.access) {
    try {
      return { ids: await fetchLiveAvailableModelIds({ credential: payload, fetchImpl }), source: "live" };
    } catch { /* 回退 cache */ }
  }
  return { ids: Array.isArray(payload.availableModelIds) ? payload.availableModelIds : [], source: "cache" };
}

// R3-3 严格分支：仅 mode==="overlay" 读内置覆盖层；normal npm 失败只回
// catalogSource:"local"（绝不隐式读 overlay）；未知 mode → 400。
async function resolveCatalogSource(opts, mode, fetchImpl, allowedKeys) {
  if (mode === "overlay") {
    const raw = readJson(opts.overlayFile ?? defaultOverlayFile());
    if (raw === undefined) throw new Error("bundled overlay file missing");
    // 形状规范化（ADR 0003）：pi-ai ≥0.99.0 的目录用 `chat:<id>` 键，必须规范化回
    // 裸 id + 本机字段集合，合并/校验/digest 才与 0.87.x 世代同语义。
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

// settings raw user 层完整配置视图（R3-2）：digest/baseline/CAS 的唯一取数面。
// 缺席一律 null 占位（非 undefined），保证 journal JSON 持久化无损、boot 重载后
// 与现算视图可逐字节比较；「未配置 vs 显式空」由 *Present 标志区分。
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

function rawSettingsView(ctx) {
  try {
    const d = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
    return viewFromUserLayer(d?.user);
  } catch { /* settings 未注入/未注册/读取失败一律按空视图 */ }
  return viewFromUserLayer(undefined);
}

// 幂等判定：当前视图是否已等于 target 形状——models 恰好为 targetIds 的纯 {id}
// 条目（无任何字段定制），且无有效 modelOverrides。
function viewEqualsTarget(view, targetIds) {
  if (!view.modelsPresent || !Array.isArray(view.models)) return false;
  if (view.models.some((m) => !m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).some((k) => k !== "id"))) {
    return false;
  }
  const ids = view.models.map((m) => m.id);
  if ([...ids].sort().join("\0") !== [...targetIds].sort().join("\0")) return false;
  if (view.modelOverridesPresent && view.modelOverrides && Object.keys(view.modelOverrides).length > 0) return false;
  return true;
}

function overlayEntryIds(overlay) {
  return Object.values(overlay ?? {}).flatMap((s) => Object.keys(s ?? {}));
}

// ==================== 注入后的"路由是否真的端出来"复核（ADR 0003 增补） ====================
// 为什么需要这一层：llm-pi-ai 在**挂载时**就构建快照，并把目录解析结果按 settings 配置
// 对象的身份 memoize（其 profiles() 只在 config.providers.get() 变身份时重建）。插件挂载
// 晚于它，动态 import pi-ai 模块图又要几秒——boot 期注入因此常常落在快照之后：注册表里
// 有条目，路由仍按旧快照把它判为"目录不描述"并丢弃。注入成功后必须用**宿主自己的**
// listModels 复核（不能用我们自己的模块实例自证，那是自指的），缺失就做一次
// **净零切换**触发快照重建——两次真内容变化的写，最终内容与用户原配置完全一致。

// 路由当前端出的模型 id 集合；宿主 API 不可用时返回 null（无从判断，不误报）。
async function servedModelIds(ctx) {
  try {
    return new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
  } catch {
    return null;
  }
}

// 用户 settings 里当前引用的模型 id（只有它们才需要"端得出来"）。
function configuredModelIds(ctx) {
  const models = readConfiguredRoute(ctx).models;
  return new Set((Array.isArray(models) ? models : []).map((m) => m?.id).filter(Boolean));
}

// 诊断口径：已注入条目中，被 settings 引用却没能从路由端出来的 id。
// 返回 { referenced, missing }；宿主 API 不可用时 missing 为 null。
async function registryServedDiagnostics(ctx, overlayIds) {
  const referenced = [...new Set(overlayIds)].filter((id) => configuredModelIds(ctx).has(id));
  if (referenced.length === 0) return { referenced, missing: [] };
  const served = await servedModelIds(ctx);
  if (served === null) return { referenced, missing: null };
  return { referenced, missing: referenced.filter((id) => !served.has(id)) };
}

// 净零切换后的短重试复核（快照重建是异步的）。
async function registryMissingWithRetry(ctx, ids, { attempts = 5, delayMs = 150 } = {}) {
  let missing = ids;
  for (let i = 0; i < attempts; i++) {
    const diag = await registryServedDiagnostics(ctx, ids);
    missing = diag.missing ?? missing;
    if (missing.length === 0) return [];
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return missing;
}

// 净零切换（ADR 0003 增补 v1.2.7）：**同值写不会改变配置对象身份**——宿主快照因此不重建
// （2026-10-03 实测：boot 期同值触碰写了文件、宿主仍按旧快照丢弃注入条目；apply 写的也是
// 同值，同样 500 registry-not-effective）。所以这里做两次**真内容变化**的写把身份推两次：
// 先把该路由 `displayName` 改成当前值 + 一个尾随空格，再改回原状（该键非用户所有时 unset）。
// 净效果 = 用户配置一字不改，但宿主必然重建快照；displayName 不参与模型列表语义。
async function touchRouteIdentity(ctx, log) {
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

// boot 期注入后的自愈复核：缺失即净零切换触发重建，再复核。返回 { ok, touched, referenced, missing }。
async function ensureRegistryServed(ctx, overlayIds, log) {
  const before = await registryServedDiagnostics(ctx, overlayIds);
  if (before.referenced.length === 0) return { ok: true, touched: false, ...before };
  if (before.missing !== null && before.missing.length === 0) return { ok: true, touched: false, ...before };
  let touched = false;
  try {
    touched = await touchRouteIdentity(ctx, log);
  } catch (err) {
    log?.(`copilot-auth: registry snapshot touch failed — ${String(err?.message ?? err)}`);
  }
  const missing = touched ? await registryMissingWithRetry(ctx, before.referenced) : before.missing;
  const ok = missing !== null && missing.length === 0;
  if (!ok) {
    log?.(
      `copilot-auth: registry-not-served — ${(missing ?? before.referenced).join(",")}`
        + (touched ? "" : " (净零切换未执行：settings 未注入或该路由配置缺失)"),
    );
  }
  return { ok, touched, referenced: before.referenced, missing };
}

// 启动序列（严格按序 boot 0→1→2；整体 try/catch，失败只记 lastError +
// logger.warn，绝不阻断挂载；所有写入幂等，崩溃现场下个 boot 安全重试）。
async function bootRefresh(ctx, opts) {
  const stateFile = opts.stateFile ?? defaultStateFile();
  let state = loadState(stateFile);
  try {
    if (state.lastError === "state-corrupt") {
      // 损坏已隔离：持久化安全态（/status 稳定可见、激活丢失→自愈停用，🟡-4）
      saveState(stateFile, state);
    }
    if (!state.journal && !state.activated && !state.restartState) return; // R9：未激活不触碰
    let install = null;
    try {
      install = resolveInstall(opts);
    } catch {
      install = null;
    }
    let bootPatched = false;
    const readDiskCatalog = () => JSON.parse(readFileSync(install.catalogFile, "utf8"));
    const diskIds = (disk) => new Set(Object.values(disk).flatMap((s) => Object.keys(s ?? {})));
    const log = (m) => ctx.logger?.info?.(m);
    // 测试注入钩子：opts.injectRegistry / opts.registryIds（生产恒用真实实现）。
    const injectRegistry = opts.injectRegistry ?? injectCatalogEntries;
    const readRegistryIds = opts.registryIds ?? registryModelIds;
    // 落地一次目录增量：可写安装树走原子写盘（ADR 0001）；只读安装树（desktop asar）
    // 走进程内目录注册表注入（ADR 0003）。返回 { ok, wrote, mode, reason }，绝不抛。
    const landIncrement = async (overlay, merged) => {
      if (install.writable) {
        writeJsonAtomic(install.catalogFile, merged.merged);
        return { ok: true, wrote: true, mode: "file", reason: null };
      }
      const r = await injectRegistry(install, overlay, {
        log,
        allowedKeys: catalogShapeKeys(readDiskCatalog()),
      });
      return { ok: r.ok, wrote: false, mode: "registry", reason: r.reason, detail: r };
    };
    // 运行时实际可解析的模型 id：目录文件 ∪ 进程内注册表（ADR 0003——注入的条目
    // 不在文件里，任何"目录可解析"判定都必须走这一面）。
    const servedIds = async () => {
      const ids = diskIds(readDiskCatalog());
      // 同 readCatalogModelIds：只有只读安装树才需要并注册表面（可写树下两者同源）。
      const reg = install.writable === true ? null : await readRegistryIds(install, log);
      if (reg) for (const id of reg) ids.add(id);
      return ids;
    };

    // boot 0：journal=prepared 崩溃恢复（先于激活门，但先过兼容 gate，R3-1）
    if (state.journal?.phase === "prepared") {
      if (!install || install.version !== state.journal.appliedAgainstPiAiVersion) {
        state = setLastError(state, `prepared-incompatible: journal against ${state.journal.appliedAgainstPiAiVersion}, current ${install?.version ?? "none"} — re-run refresh preview`);
        saveState(stateFile, state); // 目录零写入、journal 保留
        return;
      }
      const replay = mergeCatalog(readDiskCatalog(), state.journal.pendingOverlay);
      if (replay.added.length > 0) {
        const landed = await landIncrement(state.journal.pendingOverlay, replay);
        if (!landed.ok) {
          // 落地失败（不可写且注册表注入失败）：journal 原样保留、零写入、可 grep 的
          // lastError，下次 boot 重试；安装树将来变可写后本恢复自动完成。
          const why = landed.mode === "file" ? `catalog-not-writable (${install.unwritableReason})` : `registry-inject-failed (${landed.reason})`;
          state = setLastError(state, `${why}: pi-ai catalog is not landable; prepared journal kept`);
          saveState(stateFile, state);
          return;
        }
        bootPatched = landed.wrote;
        // 注册表通道：注入只是把条目放进进程内注册表，宿主快照可能已在挂载时按旧目录
        // 定稿——用宿主 API 复核，缺失即净零切换触发重建（ADR 0003 增补）。
        if (landed.mode === "registry") {
          await ensureRegistryServed(ctx, overlayEntryIds(state.journal.pendingOverlay), log);
        }
      }
      state.appliedOverlay = mergeCatalog(state.appliedOverlay, state.journal.pendingOverlay).merged;
      state.appliedProvenance = {
        sourcePiAiVersion: state.journal.source?.piAiVersion ?? null,
        integrity: state.journal.source?.integrity ?? null,
        appliedAgainstPiAiVersion: state.journal.appliedAgainstPiAiVersion,
        catalogSchemaVersion: 1,
      };
      state.activated = true;
      // file 通道才需要重启标记（下个 boot 由 2a 把 settings 镜像到 target）；
      // 注册表注入当次生效，boot2a 在本 boot 就会同步 settings（ADR 0003）。
      if (install.writable) state.restartState = restartMarker("refresh", digest(state.appliedOverlay));
      state.journal = advanceJournal(state.journal);
      state = clearLastError(state);
      saveState(stateFile, state);
    }

    // boot 1：自愈（仅 activated，且当前 pi-ai 版本==基线才重放；跨版本见 gate）
    if (state.activated) {
      const baseline = state.appliedProvenance?.appliedAgainstPiAiVersion;
      const overlayIds = overlayEntryIds(state.appliedOverlay);
      if (overlayIds.length > 0 && baseline) {
        if (!install) {
          state = setLastError(state, "self-heal-incompatible: pi-ai installation not found");
          saveState(stateFile, state);
        } else if (install.version === baseline) {
          const replay = mergeCatalog(readDiskCatalog(), state.appliedOverlay);
          if (replay.added.length > 0) {
            const landed = await landIncrement(state.appliedOverlay, replay);
            if (!landed.ok) {
              // 自愈失败不抛错、不阻断启动序列：appliedOverlay 保留，下次 boot 重放。
              const why = landed.mode === "file" ? `catalog-not-writable (${install.unwritableReason})` : `registry-inject-failed (${landed.reason})`;
              state = setLastError(state, `${why}: self-heal deferred, overlay entries stay pending`);
              saveState(stateFile, state);
            } else {
              bootPatched = landed.wrote;
              // 注册表注入是进程内的、当次 boot 即生效，不需要重启标记（ADR 0003）。
              if (landed.wrote) state.restartState = restartMarker("self-heal", digest(state.appliedOverlay));
              state = clearLastError(state);
              saveState(stateFile, state);
              // 注入通常落在宿主快照之后（宿主在挂载时即定稿目录解析结果）——用宿主
              // 自己的 listModels 复核，缺失即净零切换触发重建；仍缺失则记可 grep 的
              // lastError（不写盘、不阻断挂载）。
              if (landed.mode === "registry") {
                const served = await ensureRegistryServed(ctx, overlayEntryIds(state.appliedOverlay), log);
                if (!served.ok) {
                  state = setLastError(state, `registry-not-served: ${(served.missing ?? served.referenced).join(",")} — injected entries are in the registry but the route still does not serve them`);
                  saveState(stateFile, state);
                }
              }
            }
          }
        } else {
          const served = await servedIds();
          const missing = overlayIds.filter((id) => !served.has(id));
          if (missing.length > 0) {
            // 跨版本有缺失：上报 self-heal-incompatible，不改安装树
            state = setLastError(state, `self-heal-incompatible: pi-ai ${install.version} != baseline ${baseline}, missing ${missing.join(",")}`);
            saveState(stateFile, state);
          }
          // 条目已原生存在 → 空操作
        }
      }
    }

    // boot 2：本 boot 未写目录时，两个独立出口（R3-5 职责分离）
    if (!bootPatched) {
      // 2a. journal=committed → settings 真 CAS（settings 同步的唯一触发源）
      if (state.journal?.phase === "catalog-committed-needs-restart") {
        const j = state.journal;
        let consumed = false;
        let failed = null;
        try {
          if (!install) throw new Error("pi-ai installation not found");
          // 语义前置（Y2-3）：targetIds 全部可由当前目录解析；whole-file digest 仅诊断
          const ids = await servedIds();
          const unresolvable = j.targetIds.filter((id) => !ids.has(id));
          if (unresolvable.length > 0) throw new Error(`target-unresolvable: ${unresolvable.join(",")}`);
          const desc = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
          if (!desc) throw new Error("settings namespace llm-pi-ai unavailable");
          const view = viewFromUserLayer(desc.user);
          if (digest(view) === digest(j.settingsBaseline)) {
            await ctx.settings.mutate("llm-pi-ai", [
              { op: "set", path: ["providers", "github-copilot", "models"], value: j.targetIds.map((id) => ({ id })) },
              { op: "unset", path: ["providers", "github-copilot", "modelOverrides"] },
            ], desc.revision); // 真 CAS：revision 不符由 settings 抛 SETTINGS_CONFLICT
            consumed = true;
          } else if (viewEqualsTarget(view, j.targetIds)) {
            consumed = true; // 已等于 target → 幂等消费，不再 mutate
          } else {
            failed = "settings-conflict: configuration changed since preview; re-run refresh";
          }
        } catch (err) {
          failed = err?.code === "SETTINGS_CONFLICT" || /conflict/i.test(String(err?.message ?? ""))
            ? `settings-conflict: ${err.message}`
            : String(err?.message ?? err);
        }
        if (consumed) {
          state.journal = null;
          state = clearLastError(state);
          saveState(stateFile, state);
        } else if (failed) {
          state = setLastError(state, failed); // 不覆盖、记 conflict、/status 上报
          saveState(stateFile, state);
        }
      }
      // 2b. restartState 非空且 expected entries 已在目录 → 仅清 restartState
      // （不携带 settings 意图：单独存在时不得触碰 describe/mutate）
      if (state.restartState && install) {
        const ids = await servedIds();
        if (overlayEntryIds(state.appliedOverlay).every((id) => ids.has(id))) {
          state.restartState = null;
          state = clearLastError(state);
          saveState(stateFile, state);
        }
      }
    }
  } catch (err) {
    try {
      saveState(stateFile, setLastError(state, err));
    } catch { /* 记录失败不掩盖 */ }
    ctx.logger?.warn?.("copilot-auth: refresh boot failed: %s", String(err?.message ?? err));
  }
}

// /status 专用只读读取：不隔离、不写盘（隔离只在 boot 发生一次）
function peekState(path) {
  const corrupt = () => ({ ...freshState(), lastError: "state-corrupt" });
  let raw;
  try {
    raw = readJson(path);
  } catch {
    return corrupt();
  }
  if (raw === undefined) return freshState();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return corrupt();
  return { ...freshState(), ...raw };
}

// preview 与 apply 共享的输入计算——digest 绑定的正确性依赖两侧走同一代码路径。
async function computeRefreshInputs(ctx, opts, mode) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const { ids, source } = await resolveAvailable(ctx, fetchImpl);
  const local = readLocalCatalog(opts);
  const resolved = await resolveCatalogSource(opts, mode, fetchImpl, catalogShapeKeys(local.catalog));
  const merged = mergeCatalog(local.catalog, resolved.catalog);
  const catalogIds = new Set(Object.values(merged.merged).flatMap((s) => Object.keys(s ?? {})));
  const view = rawSettingsView(ctx);
  const currentIds = Array.isArray(view.models)
    ? view.models.map((m) => m?.id).filter((x) => typeof x === "string")
    : [];
  const diff = diffModels(currentIds, ids, catalogIds);
  const customizationReset = {
    modelEntryIds: (Array.isArray(view.models) ? view.models : [])
      .filter((m) => m && typeof m === "object" && Object.keys(m).some((k) => k !== "id"))
      .map((m) => m.id),
    modelOverrideIds:
      view.modelOverrides && typeof view.modelOverrides === "object" && !Array.isArray(view.modelOverrides)
        ? Object.keys(view.modelOverrides)
        : [],
  };
  const digests = {
    settings: digest(view), // raw 完整视图：字段级变化必漂移（R3-2）
    available: digest([...ids].sort()),
    catalog: digest(local.bytes), // 本地目录文件字节
    remote: digest(resolved.catalog), // 实际使用的目录来源对象（与 mode 严格对应）
  };
  return { view, ids, source, local, resolved, merged, diff, customizationReset, digests };
}

// 端到端自证（ADR 0003）：注入 + settings 写入后，路由必须真的把 target 端出来。
// settings→快照重建是异步的，故带短重试。返回 { ok, missing, served }。
async function waitForServedModels(ctx, targetIds, { attempts = 6, delayMs = 150 } = {}) {
  const want = [...new Set(targetIds)];
  let served = new Set();
  for (let i = 0; i < attempts; i++) {
    try {
      served = new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
    } catch (err) {
      if (i === attempts - 1) return { ok: false, missing: want, served: [...served], error: String(err?.message ?? err) };
    }
    const missing = want.filter((id) => !served.has(id));
    if (missing.length === 0) return { ok: true, missing: [], served: [...served] };
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: false, missing: want.filter((id) => !served.has(id)), served: [...served] };
}

// 自证失败时的 best-effort 回滚：把用户 settings 的 models 恢复成刷新前的视图。
// 回滚本身失败不掩盖原错误——调用方以结构化错误（rolledBack:false）上报。
async function rollbackSettings(ctx, previous) {
  try {
    const desc = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
    if (!desc) return false;
    const ops = previous?.modelsPresent
      ? [{ op: "set", path: ["providers", "github-copilot", "models"], value: previous.models }]
      : [{ op: "unset", path: ["providers", "github-copilot", "models"] }];
    await ctx.settings.mutate("llm-pi-ai", ops, desc.revision);
    return true;
  } catch {
    return false;
  }
}

// intentVersion 持久层（T3 契约）：`<dataDir>/auth-intent.json` 原子写；
// scope 未知（缺 profileContext）时读写一律抛错 → 写路由 503，不伪成功。
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

export function apply(ctx, opts = {}) {
  const r = routes();
  const scope = resolveRuntimeScope(ctx);
  const intentIO = createIntentIO(scope);
  let lastSyncError;
  const refreshMutex = createMutex(); // 宿主单进程内互斥（不支持多实例，见 README）

  // 模型目录同步只在登录成功（且 handoff 完好）后执行；失败不静默，经 /status 暴露。
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

  // 启动序列：prepared 恢复（先过兼容 gate）→ 激活门 → 自愈 → settings 真 CAS。
  // 绝不阻断挂载；失败仅 lastError + warn。opts.onBootDone 为测试钩子（boot  settle 回调）。
  void bootRefresh(ctx, opts)
    .catch((err) => {
      ctx.logger?.warn?.("copilot-auth: refresh boot failed: %s", String(err?.message ?? err));
    })
    .finally(() => opts.onBootDone?.());

  // 模型目录同步已由 controller.onAuthorized → runSync 触发（T3/T4）。

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

  // 请求撤回（T3/D-01 软撤回）：先持久失效本地意图，再尝试宿主撤销；
  // 任何 delivery 都不承诺晚写停止，风险锁存保持待核实。
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
      // refresh 状态块：lastError 直读状态文件顶层（R3-6）；pendingRestart 派生自
      // 状态文件（journal 相位或 restartState），不用模块布尔；piAiVersion /
      // catalogDigest / catalogFile 来自同根解析，digest 为当前文件字节 sha256
      // （E2E 据此把被检查文件绑定到实际加载副本，R3-8/R4-5）。
      let install = null;
      try {
        install = resolveInstall(opts);
      } catch {
        install = null;
      }
      let catalogDigest = null;
      if (install) {
        try {
          catalogDigest = digest(readFileSync(install.catalogFile));
        } catch {
          catalogDigest = null;
        }
      }
      const state = peekState(opts.stateFile ?? defaultStateFile());
      const refresh = {
        scopeAvailable: scope.known,
        activated: state.activated === true,
        pendingRestart: state.restartState != null || state.journal?.phase === "catalog-committed-needs-restart",
        phase: state.journal?.phase ?? null,
        lastError: state.lastError ?? null,
        piAiVersion: install?.version ?? null,
        catalogDigest,
        catalogFile: install?.catalogFile ?? null,
        catalogWritable: install ? install.writable === true : null,
        // 落地通道（ADR 0003）：file = 可写安装树走目录补丁；registry = 只读安装树
        // （desktop asar）走进程内目录注册表注入。registryInjected = 已注入条目数。
        catalogMode: install ? (install.writable === true ? "file" : "registry") : null,
        registryInjected: overlayEntryIds(state.appliedOverlay).length,
      };
      // 诊断口径（ADR 0003 增补）：已注入、被 settings 引用、却没能从路由端出来的 id。
      // "注册表里有了但 picker 里看不到"这类问题的唯一直接证据；宿主 API 不可用时为 null。
      refresh.settingsNotServed = (await registryServedDiagnostics(ctx, overlayEntryIds(state.appliedOverlay))).missing;
      // 注入取路面：bare（宿主解析拦截给出的同一实例，首选）/ file（asar 绝对路径）。
      // instanceMismatch=true 说明进程里存在两份模块实例——(b) 类故障的直接证据。
      refresh.registryVia = registryVia();
      refresh.registryInstanceMismatch = registryInstanceMismatch();
      json(res, 200, {
        configured: credential === "present",
        syncError: lastSyncError,
        // 授权独立维度（T3）：凭据事实、尝试快照、风险锁存与能力门。
        authorization: {
          credential,
          attempt: authSnapshot,
          riskLatch: authSnapshot.riskLatch,
          capabilities: { logout: false, reauthorize: false }, // 当前宿主无法证明安全，默认禁用
        },
        refresh,
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

  // 手动刷新可用模型目录 · preview：只读，返回 diff + customizationReset + digest 组。
  // body 可带 { "mode": "overlay" } 用内置覆盖层出 diff（离线 bootstrap）。
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
      const mode = body?.mode;
      if (mode !== undefined && mode !== "latest" && mode !== "overlay") {
        json(res, 400, { ok: false, error: "invalid-mode" });
        return;
      }
      try {
        const inputs = await computeRefreshInputs(ctx, opts, mode);
        json(res, 200, {
          ok: true,
          source: inputs.source,
          catalogSource: inputs.resolved.catalogSource,
          catalogError: inputs.resolved.catalogError,
          catalogWritable: inputs.local.writable,
          catalogMode: inputs.local.writable ? "file" : "registry",
          catalogNormalized: inputs.resolved.normalized,
          skipped: inputs.merged.skipped,
          added: inputs.diff.added,
          removed: inputs.diff.removed,
          kept: inputs.diff.kept,
          target: inputs.diff.target,
          customizationReset: inputs.customizationReset,
          digests: inputs.digests,
        });
      } catch (err) {
        if (err instanceof InvalidModeError) {
          json(res, 400, { ok: false, error: "invalid-mode" });
          return;
        }
        json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  });

  // 手动刷新 · apply：mutex 内重算全部输入 digest 与回传比对（漂移 → 409
  // preview-stale，client 重新 preview）；一致则 write-ahead：journal(prepared)
  // → 原子提交目录 → 合入 appliedOverlay + activated → journal 推进 committed。
  // 重启 dsh web 后由启动序列把 settings 目录镜像重建为 target（见 boot 序列）。
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
      const mode = body?.mode;
      if (mode !== undefined && mode !== "latest" && mode !== "overlay") {
        json(res, 400, { ok: false, error: "invalid-mode" });
        return;
      }
      try {
        const out = await refreshMutex(async () => {
          const inputs = await computeRefreshInputs(ctx, opts, mode);
          const got = body?.digests ?? {};
          for (const k of ["settings", "available", "catalog", "remote"]) {
            if (got[k] !== inputs.digests[k]) {
              return { code: 409, payload: { ok: false, error: "preview-stale" } };
            }
          }
          // digest 全部一致后才解析版本（写入失败点上移，500 不留 journal）
          const install = resolveInstall(opts);
          const stateFile = opts.stateFile ?? defaultStateFile();
          if (!install.writable) {
            // 只读安装树（desktop asar）：ADR 0002 的写盘门禁之外再开一条**不写盘**的
            // 落地通道——进程内目录注册表注入（ADR 0003）。注入成功才写 settings，
            // 再以 listModels 端到端自证；自证失败回滚 settings，绝不产出
            // "能选中但发不出去"的假模型。
            const injectRegistry = opts.injectRegistry ?? injectCatalogEntries;
            const injected = await injectRegistry(install, inputs.merged.addedOverlay, {
              log: (m) => ctx.logger?.info?.(m),
              allowedKeys: catalogShapeKeys(inputs.local.catalog),
            });
            if (!injected.ok) {
              return {
                code: 400,
                payload: {
                  ok: false,
                  error: "registry-inject-failed",
                  reason: injected.reason,
                  missing: injected.missing,
                  rejected: injected.rejected,
                  catalogFile: install.catalogFile,
                },
              };
            }
            const desc = ctx.settings?.describe?.()?.find?.((x) => x?.ns === "llm-pi-ai");
            if (!desc) {
              return { code: 500, payload: { ok: false, error: "settings namespace llm-pi-ai unavailable" } };
            }
            await ctx.settings.mutate("llm-pi-ai", [
              { op: "set", path: ["providers", "github-copilot", "models"], value: inputs.diff.target.map((id) => ({ id })) },
            ], desc.revision);
            const served = await waitForServedModels(ctx, inputs.diff.target);
            if (!served.ok) {
              const rolledBack = await rollbackSettings(ctx, inputs.view);
              return {
                code: 500,
                payload: { ok: false, error: "registry-not-effective", missing: served.missing, rolledBack },
              };
            }
            let state = loadState(stateFile);
            state.appliedOverlay = mergeCatalog(state.appliedOverlay, inputs.merged.addedOverlay).merged;
            state.appliedProvenance = {
              sourcePiAiVersion: inputs.resolved.provenance.piAiVersion ?? null,
              integrity: inputs.resolved.provenance.integrity ?? null,
              appliedAgainstPiAiVersion: install.version,
              catalogSchemaVersion: 1,
            };
            state.activated = true;
            state.journal = null; // 注册表注入当次生效，无写盘、无重启相位
            state = clearLastError(state);
            saveState(stateFile, state);
            return {
              code: 200,
              payload: {
                ok: true,
                restartRequired: false,
                mode: "registry",
                registryVia: injected.via,
                injected: [...injected.injected, ...injected.present],
                target: inputs.diff.target.length,
              },
            };
          }
          const patchedBytes = Buffer.from(JSON.stringify(inputs.merged.merged, null, 2) + "\n", "utf8");
          let state = loadState(stateFile);
          state.journal = createJournal({
            settingsBaseline: inputs.view,
            targetIds: inputs.diff.target,
            pendingOverlay: inputs.merged.addedOverlay, // catalog-shaped 增量（R3-4）
            appliedAgainstPiAiVersion: install.version,
            catalogBaselineDigest: inputs.digests.catalog,
            patchedCatalogDigest: digest(patchedBytes),
            source: inputs.resolved.provenance,
          });
          saveState(stateFile, state); // ① write-ahead：prepared
          writeJsonAtomic(install.catalogFile, inputs.merged.merged); // ② 目录原子提交
          state = loadState(stateFile);
          state.appliedOverlay = mergeCatalog(state.appliedOverlay, inputs.merged.addedOverlay).merged;
          state.appliedProvenance = {
            sourcePiAiVersion: inputs.resolved.provenance.piAiVersion ?? null,
            integrity: inputs.resolved.provenance.integrity ?? null,
            appliedAgainstPiAiVersion: install.version,
            catalogSchemaVersion: 1,
          };
          state.activated = true;
          state.restartState = restartMarker("refresh", digest(state.appliedOverlay));
          saveState(stateFile, state); // ③ appliedOverlay/activated 落盘
          state = loadState(stateFile);
          state.journal = advanceJournal(state.journal);
          saveState(stateFile, state); // ④ 相位推进 catalog-committed-needs-restart
          return { code: 200, payload: { ok: true, restartRequired: true } };
        });
        json(res, out.code, out.payload);
      } catch (err) {
        if (err instanceof InvalidModeError) {
          json(res, 400, { ok: false, error: "invalid-mode" });
          return;
        }
        json(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    },
  });
}

export default { name, inject, apply };
