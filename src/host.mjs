// host 半区：cordis 插件。注册 6 条 exact 路由，把内置 github-copilot 的
// OAuth 设备码流（ctx.authorization）暴露给 Web client，并提供「手动刷新可用
// 模型目录」（数据级目录补丁，pi-ai 代码版本不动；只读 GET /models 适配显式
// 耦合 pi-ai 0.84.4，详见 CONTEXT.md 与 ADR 0001）。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CREDENTIAL_KEY, emptyState, routes } from "./shared.mjs";
import { readJson, writeJsonAtomic, createMutex } from "./atomic-json.mjs";
import { mergeCatalog, diffModels, digest, findPiAiInstallation } from "./catalog.mjs";
import { fetchLatestCatalog } from "./catalog-fetch.mjs";
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

// 读取 pi-ai 内置目录的 github-copilot 模型 id → 协议映射。只读不改。
// 定位/解析失败返回 null（调用方回退 listModels 交集，见下）。
function readCatalogModelIds() {
  try {
    const dataFile = findCatalogFile();
    if (!dataFile) return null;
    const data = JSON.parse(readFileSync(dataFile, "utf8"));
    const byId = {};
    for (const [api, section] of Object.entries(data)) {
      for (const id of Object.keys(section ?? {})) byId[id] ??= api;
    }
    return byId;
  } catch { /* 安装树结构变化时回退 */ }
  return null;
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
// settings 未注入 / 未注册 / 读取失败一律按空处理——回退到可写入分支，
// 保持既有 turnkey 行为不变。
function readConfiguredRoute(ctx) {
  try {
    const section = ctx.settings?.get?.("llm-pi-ai");
    return section?.providers?.["github-copilot"] ?? {};
  } catch {
    return {};
  }
}

async function syncAvailableModels(ctx) {
  const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
  const available = record?.payload?.availableModelIds;
  if (!Array.isArray(available) || available.length === 0) return;
  const route = readConfiguredRoute(ctx);
  const modelsConfigured = route.models !== undefined && route.models !== null;
  const overridesConfigured = !!route.modelOverrides
    && typeof route.modelOverrides === "object"
    && Object.keys(route.modelOverrides).length > 0;
  if (modelsConfigured || overridesConfigured) return;
  const catalog = readCatalogModelIds();
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
  await ctx.settings.mutate("llm-pi-ai", [
    { op: "set", path: ["providers", "github-copilot", "models"], value: ids.map((id) => ({ id })) },
  ]);
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
  if (opts.catalogFile) {
    if (opts.piAiVersion) return { catalogFile: opts.catalogFile, version: opts.piAiVersion };
    const root = dirname(dirname(dirname(dirname(opts.catalogFile))));
    const packageJsonFile = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonFile, "utf8"));
    return { catalogFile: opts.catalogFile, packageJsonFile, version: pkg.version };
  }
  const found = findPiAiInstallation();
  if (!found) throw new Error("pi-ai installation not found");
  return found;
}

function readLocalCatalog(opts) {
  const file = resolveInstall(opts).catalogFile;
  const bytes = readFileSync(file);
  return { file, bytes, catalog: JSON.parse(bytes.toString("utf8")) };
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
async function resolveCatalogSource(opts, mode, fetchImpl) {
  if (mode === "overlay") {
    const catalog = readJson(opts.overlayFile ?? defaultOverlayFile());
    if (catalog === undefined) throw new Error("bundled overlay file missing");
    return {
      catalog,
      catalogSource: "overlay",
      catalogError: null,
      provenance: { kind: "overlay", piAiVersion: OVERLAY_SOURCE_VERSION, integrity: null },
    };
  }
  if (mode !== undefined && mode !== "latest") throw new InvalidModeError(String(mode));
  try {
    const r = await fetchLatestCatalog({ fetchImpl });
    return {
      catalog: r.catalog,
      catalogSource: "latest",
      catalogError: null,
      provenance: { kind: "latest", piAiVersion: r.piAiVersion, integrity: r.integrity },
    };
  } catch (error) {
    return {
      catalog: readLocalCatalog(opts).catalog,
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

    // boot 0：journal=prepared 崩溃恢复（先于激活门，但先过兼容 gate，R3-1）
    if (state.journal?.phase === "prepared") {
      if (!install || install.version !== state.journal.appliedAgainstPiAiVersion) {
        state = setLastError(state, `prepared-incompatible: journal against ${state.journal.appliedAgainstPiAiVersion}, current ${install?.version ?? "none"} — re-run refresh preview`);
        saveState(stateFile, state); // 目录零写入、journal 保留
        return;
      }
      const replay = mergeCatalog(readDiskCatalog(), state.journal.pendingOverlay);
      if (replay.added.length > 0) {
        writeJsonAtomic(install.catalogFile, replay.merged);
        bootPatched = true;
      }
      state.appliedOverlay = mergeCatalog(state.appliedOverlay, state.journal.pendingOverlay).merged;
      state.appliedProvenance = {
        sourcePiAiVersion: state.journal.source?.piAiVersion ?? null,
        integrity: state.journal.source?.integrity ?? null,
        appliedAgainstPiAiVersion: state.journal.appliedAgainstPiAiVersion,
        catalogSchemaVersion: 1,
      };
      state.activated = true;
      state.restartState = restartMarker("refresh", digest(state.appliedOverlay));
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
            writeJsonAtomic(install.catalogFile, replay.merged); // 原子重放
            bootPatched = true;
            state.restartState = restartMarker("self-heal", digest(state.appliedOverlay));
            state = clearLastError(state);
            saveState(stateFile, state);
          }
        } else {
          const missing = overlayIds.filter((id) => !diskIds(readDiskCatalog()).has(id));
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
          const ids = diskIds(readDiskCatalog());
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
        const ids = diskIds(readDiskCatalog());
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
  const resolved = await resolveCatalogSource(opts, mode, fetchImpl);
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

export function apply(ctx, opts = {}) {
  const r = routes();
  let attempt = emptyState();
  let lastSyncError;
  const refreshMutex = createMutex(); // 宿主单进程内互斥（不支持多实例，见 README）

  // 启动序列：prepared 恢复（先过兼容 gate）→ 激活门 → 自愈 → settings 真 CAS。
  // 绝不阻断挂载；失败仅 lastError + warn。opts.onBootDone 为测试钩子（boot  settle 回调）。
  void bootRefresh(ctx, opts)
    .catch((err) => {
      ctx.logger?.warn?.("copilot-auth: refresh boot failed: %s", String(err?.message ?? err));
    })
    .finally(() => opts.onBootDone?.());

  // 模型目录同步只在登录成功后执行（2026-09-05 对齐结论：挂载不再同步）。
  // 插件启动/重启绝不触碰用户 settings，用户精简过的目录不会被动重置。
  // 失败不静默：错误经 /status 的 syncError 字段暴露，便于诊断。
  const sync = () => syncAvailableModels(ctx).then(() => { lastSyncError = undefined; }).catch((err) => {
    lastSyncError = String(err?.message ?? err);
    ctx.logger?.warn?.("copilot-auth: model sync failed: %s", lastSyncError);
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.start,
    handler: (req, res) => {
      if (!guard(req, res, "POST")) return;
      if (attempt.status === "running") {
        json(res, 409, { ok: false, error: "already running" });
        return;
      }
      attempt = emptyState();
      attempt.status = "running";
      const interaction = {
        notify: (notice) => {
          attempt.notices.push(notice);
        },
        prompt: (p) => {
          // 企业域名提问答空串（公司是普通 github.com 组织账号）；
          // 其余任何 prompt 都是未预期的，拒绝并使 attempt 失败。
          if (p && typeof p.message === "string" && p.message.includes("Enterprise")) {
            return Promise.resolve("");
          }
          return Promise.reject(new Error("unexpected prompt: " + (p?.message ?? String(p))));
        },
      };
      // 响应先行：begin 以后台任务执行，handler 返回路径不得 await begin。
      void ctx.authorization
        .begin({ key: CREDENTIAL_KEY, method: "oauth", interaction })
        .then((outcome) => {
          // AuthorizationOutcome.status: 'authorized' | 'cancelled'（types.d.ts L68-71）
          if (outcome && outcome.status === "authorized") {
            attempt.status = "authorized";
            void sync();
          } else {
            attempt.status = "failed";
            attempt.error = "登录已取消";
          }
        })
        .catch((err) => {
          attempt.status = "failed";
          attempt.error = String(err?.message ?? err);
        });
      json(res, 202, { ok: true });
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.state,
    handler: (req, res) => {
      if (!guard(req, res, "GET")) return;
      json(res, 200, attempt);
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.status,
    handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      // describeRecord 只回传 presence，不把含 token 的 GrantRecord 拉进内存。
      let configured = false;
      try {
        const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY);
        configured = info?.configured === true;
      } catch {
        configured = false;
      }
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
        activated: state.activated === true,
        pendingRestart: state.restartState != null || state.journal?.phase === "catalog-committed-needs-restart",
        phase: state.journal?.phase ?? null,
        lastError: state.lastError ?? null,
        piAiVersion: install?.version ?? null,
        catalogDigest,
        catalogFile: install?.catalogFile ?? null,
      };
      json(res, 200, { configured, syncError: lastSyncError, refresh });
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.logout,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      // 幂等契约：deleteRecord 对不存在记录是 no-op 且正常 resolve，
      // 真实删除与否由随后的 /status 反映。
      await ctx.credentials.deleteRecord(CREDENTIAL_KEY);
      json(res, 200, { ok: true });
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
