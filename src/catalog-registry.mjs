// catalog-registry.mjs — desktop/asar「只读安装树」的不写盘通道（ADR 0003）。
//
// 背景：dsh-desktop（Electron）把整个运行时打进只读 app.asar，数据级目录补丁
// （ADR 0001）无法写 `.../pi-ai/dist/providers/data/github-copilot.json`。但 pi-ai
// 的目录在进程内还有第二个可用面：`MODELS["github-copilot"]`（即
// `GITHUB_COPILOT_MODELS`，一个未冻结的普通对象，键 = 模型 id），而 DSH 的
// `catalogModels()` 每次构建快照都现读它（`Object.values(MODELS[provider])`）。
//
// 把增量条目注入这个对象，内置 github-copilot 路由就会把新模型端出来：鉴权
// （OAuth 凭据记录）、DSH↔pi-ai 消息翻译、三协议分派、picker/设置页全部复用宿主
// 既有链路——不新增路由、不写任何文件、不改任何官方产物。
//
// 三条硬约束（ADR 0003）：
//   1. 注入后必须能被 getBuiltinModels() 看见，否则报告失败；调用方**不得**把该
//      id 写进 settings——绝不产出"能选中但发不出去"的假模型；
//   2. 条目按本机目录已见过的字段集合裁剪（pi-ai ≥0.99.0 新增 `type: "chat"` 之类
//      的字段不进旧运行时的模型对象）；
//   3. 全程 try/catch，任何失败只返回报告，绝不抛出、绝不阻断插件挂载。
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCatalog, findPiAiInstallation, trimEntryToShape } from "./catalog.mjs";

// 注入面只服务内置 github-copilot 路由（其他 provider 无既有凭据/翻译链路复用）。
export const REGISTRY_ROUTE = "github-copilot";

// 裸 specifier：由宿主 dsh-app-boot 的解析拦截路由到安装树内的同一份包，模块实例
// 与宿主完全同一（首选）；asar 绝对路径 file URL 为退路（A2/A3 探针已验证可加载，
// 但模块实例是否与宿主同一需要 getBuiltinModels 回读确认）。
const MODELS_SPECIFIER = "@earendil-works/pi-ai/providers/github-copilot.models";
const ALL_SPECIFIER = "@earendil-works/pi-ai/providers/all";

const MODELS_ENTRY = join("providers", "github-copilot.models.js");
const ALL_ENTRY = join("providers", "all.js");

// catalogFile = <root>/dist/providers/data/github-copilot.json → <root>/dist
export function registryDistDir(install) {
  return dirname(dirname(dirname(install.catalogFile)));
}

// 依次尝试「裸 specifier → 绝对路径 file URL」加载目录注册表模块。
// 两条路的返回都做形状校验：注册表必须是可写对象、getBuiltinModels 必须是函数。
export async function loadRegistryModules(install, log) {
  const dist = registryDistDir(install);
  const attempts = [
    { via: "bare", models: MODELS_SPECIFIER, all: ALL_SPECIFIER },
    {
      via: "file",
      models: pathToFileURL(join(dist, MODELS_ENTRY)).href,
      all: pathToFileURL(join(dist, ALL_ENTRY)).href,
    },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const models = await import(attempt.models);
      const all = await import(attempt.all);
      const registry = models?.GITHUB_COPILOT_MODELS;
      if (!registry || typeof registry !== "object" || Object.isFrozen(registry)) {
        throw new TypeError(`registry object unusable (frozen=${Object.isFrozen(registry)})`);
      }
      if (typeof all?.getBuiltinModels !== "function") {
        throw new TypeError("getBuiltinModels unavailable");
      }
      return { via: attempt.via, registry, all, errors };
    } catch (err) {
      errors.push(`${attempt.via}: ${err?.code ?? ""} ${err?.message ?? err}`.trim());
    }
  }
  log?.(`copilot-auth: registry modules unavailable — ${errors.join(" | ")}`);
  return { via: null, registry: null, all: null, errors };
}

// 注入 catalog-shaped 增量（{ api: { id: entry } }），返回报告对象（绝不抛）。
// 已存在的 id（原生条目或本进程早前注入）视为成功，不覆盖——与目录补丁的
// 「只增不更新」语义一致（ADR 0001）。
export async function injectCatalogEntries(install, overlay, { log, allowedKeys } = {}) {
  const wanted = [];
  for (const [api, section] of Object.entries(overlay ?? {})) {
    for (const [id, entry] of Object.entries(section ?? {})) wanted.push({ api, id, entry });
  }
  if (wanted.length === 0) {
    return { ok: true, via: null, injected: [], present: [], rejected: [], missing: [], reason: null, errors: [] };
  }
  const modules = await loadRegistryModules(install, log);
  if (!modules.via) {
    return { ok: false, via: null, injected: [], present: [], rejected: [], missing: [], reason: "registry-modules-unavailable", errors: modules.errors };
  }
  const injected = [];
  const present = [];
  const rejected = [];
  for (const { api, id, entry } of wanted) {
    if (modules.registry[id] !== undefined) {
      present.push(id);
      continue;
    }
    const trimmed = trimEntryToShape(entry, allowedKeys);
    const why = validateCatalog(api, id, trimmed);
    if (why !== true) {
      rejected.push({ api, id, reason: why });
      continue;
    }
    modules.registry[id] = trimmed;
    injected.push(id);
  }
  const visible = new Set(modules.all.getBuiltinModels(REGISTRY_ROUTE).map((m) => m?.id).filter(Boolean));
  const missing = [...injected, ...present].filter((id) => !visible.has(id));
  const ok = missing.length === 0 && rejected.length === 0;
  if (!ok) {
    log?.(
      `copilot-auth: registry inject incomplete (via=${modules.via}) injected=${injected.length} missing=${missing.join(",") || "-"} rejected=${rejected.map((r) => `${r.id}:${r.reason}`).join(",") || "-"}`,
    );
  }
  return {
    ok,
    via: modules.via,
    injected,
    present,
    rejected,
    missing,
    reason: ok ? null : missing.length > 0 ? "not-visible-after-inject" : "invalid-entries",
    errors: modules.errors,
  };
}

// 当前注册表里 github-copilot 的模型 id 集合（注入面的事实来源；不可用时 null）。
export async function registryModelIds(install, log) {
  const modules = await loadRegistryModules(install, log);
  if (!modules.via) return null;
  try {
    return new Set(modules.all.getBuiltinModels(REGISTRY_ROUTE).map((m) => m?.id).filter(Boolean));
  } catch (err) {
    log?.(`copilot-auth: registry read failed — ${String(err?.message ?? err)}`);
    return null;
  }
}

// 便捷入口：从进程入口定位安装树后注入。
export async function injectIntoInstallation(overlay, { startPath, log, allowedKeys } = {}) {
  const install = findPiAiInstallation({ startPath });
  if (!install) {
    return { ok: false, via: null, injected: [], present: [], rejected: [], missing: [], reason: "pi-ai-installation-not-found", errors: [] };
  }
  return injectCatalogEntries(install, overlay, { log, allowedKeys });
}
