// catalog.mjs — 数据核心：tgz 严格解析、条目校验、只增不更新合并、diff、digest、
// pi-ai 安装定位。合并语义「只增不更新」（ADR 0001）：已有 id 的元数据永不覆盖。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

// github-copilot 目录的三种 wire 协议（白名单，目录外协议拒绝）。
export const SUPPORTED_APIS = ["anthropic-messages", "openai-completions", "openai-responses"];

const TGZ_ENTRY_PATH = "package/dist/providers/data/github-copilot.json";

// 严格 ustar 解析：checksum 逐块校验、尺寸越界即截断、目录/pax 条目跳过内容、
// 其余类型拒绝。返回 [{ name, type, content }]。
function parseTar(tar) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // 结束零块
    const magic = header.subarray(257, 262).toString("latin1");
    if (magic !== "ustar") throw new Error(`not a ustar archive (magic=${JSON.stringify(magic)})`);
    const stored = Number.parseInt(header.subarray(148, 156).toString("latin1").trim() || "0", 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== stored) throw new Error("tar checksum mismatch");
    const name = header.subarray(0, 100).toString("latin1").replace(/\0.*$/s, "");
    const sizeField = header.subarray(124, 136).toString("latin1").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeField || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bad tar size field for ${name}`);
    const type = String.fromCharCode(header[156]);
    offset += 512;
    if (offset + size > tar.length) throw new Error(`truncated tar (entry ${name})`);
    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === "0" || type === "\0") entries.push({ name, type, content });
    else if (type === "5" || type === "x" || type === "g") continue; // 目录 / pax：跳过
    else throw new Error(`unsupported tar entry type ${JSON.stringify(type)} for ${name}`);
  }
  return entries;
}

// 从 pi-ai tgz 中精确提取 github-copilot.json。路径精确匹配（前缀不误判）、
// 重复条目抛错；maxBytes 经 gunzipSync maxOutputLength 落地（防 gzip bomb）。
export function extractTgzEntry(buf, { maxBytes } = {}) {
  let tar;
  try {
    tar = gunzipSync(buf, maxBytes ? { maxOutputLength: maxBytes } : {});
  } catch (err) {
    if (err instanceof RangeError || /maxOutputLength|too large/i.test(String(err?.message))) {
      throw new Error(`catalog archive too large (decompressed cap ${maxBytes} bytes)`);
    }
    throw err;
  }
  const matches = parseTar(tar).filter((e) => e.name === TGZ_ENTRY_PATH);
  if (matches.length === 0) throw new Error(`entry not found: ${TGZ_ENTRY_PATH}`);
  if (matches.length > 1) throw new Error(`duplicate entry: ${TGZ_ENTRY_PATH}`);
  return matches[0].content;
}

// 单条目校验：true 合法；否则返回原因字符串。唯一调用点是 mergeCatalog（Y2-7）。
export function validateCatalog(api, id, entry) {
  if (!SUPPORTED_APIS.includes(api)) return `unsupported api: ${api}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "entry is not an object";
  if (entry.id !== id) return `id mismatch: key=${id} entry.id=${entry.id}`;
  if (entry.api !== api) return `api mismatch: section=${api} entry.api=${entry.api}`;
  if (entry.provider !== "github-copilot") return `unexpected provider: ${entry.provider}`;
  for (const field of ["contextWindow", "maxTokens"]) {
    if (typeof entry[field] !== "number" || !Number.isFinite(entry[field]) || entry[field] <= 0) {
      return `${field} must be a positive number`;
    }
  }
  return true;
}

// 只增不更新合并。added = 展示数组 [{id, api}]；addedOverlay = catalog-shaped
// 增量（供 journal/自愈，仅含本次合法新增）；skipped = 非法条目 [{api, id, reason}]；
// 已有 id（任一层）静默跳过——不覆盖、不进 added/skipped。
export function mergeCatalog(local, remote) {
  const merged = {};
  for (const [api, section] of Object.entries(local ?? {})) merged[api] = { ...(section ?? {}) };
  const have = new Set(Object.values(merged).flatMap((s) => Object.keys(s)));
  const added = [];
  const skipped = [];
  const addedOverlay = {};
  for (const [api, section] of Object.entries(remote ?? {})) {
    for (const [id, entry] of Object.entries(section ?? {})) {
      if (have.has(id)) continue; // 只增不更新
      const why = validateCatalog(api, id, entry);
      if (why !== true) {
        skipped.push({ api, id, reason: why });
        continue;
      }
      (merged[api] ??= {})[id] = entry;
      (addedOverlay[api] ??= {})[id] = entry;
      added.push({ id, api });
      have.add(id);
    }
  }
  return { merged, added, addedOverlay, skipped };
}

// R3：removed 以 target 为准，不以 available 为准——available 但目录不可解析的
// 当前模型必须进 removed（settings 校验拒绝目录外 id，保留必报错）。
export function diffModels(currentIds, availableIds, catalogIds) {
  const target = [...new Set(availableIds)].filter((id) => catalogIds.has(id));
  const targetSet = new Set(target);
  const current = [...new Set(currentIds)];
  return {
    target,
    added: target.filter((id) => !current.includes(id)),
    removed: current.filter((id) => !targetSet.has(id)),
    kept: current.filter((id) => targetSet.has(id)),
  };
}

// canonical JSON：递归键排序；保留 undefined 与缺失键、空数组与空对象的区别
// （字段级定制变化必须使 settings digest 漂移，R3-2）。
function canonicalize(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`)
    .join(",")}}`;
}

export function digest(x) {
  const h = createHash("sha256");
  if (Buffer.isBuffer(x)) h.update(x);
  else if (typeof x === "string") h.update(x);
  else h.update(canonicalize(x), "utf8");
  return h.digest("hex");
}

// 从进程入口（或注入的 startPath）逐级向上定位 pi-ai 安装根；catalog 文件与
// version 取自同一解析根的 package.json（防版本与被写文件不属同一副本，R3-8）。
export function findPiAiInstallation({ startPath } = {}) {
  try {
    let dir = startPath ?? dirname(realpathSync(process.argv?.[1] ?? ""));
    for (let depth = 0; depth < 8; depth++) {
      const root = join(dir, "node_modules", "@earendil-works", "pi-ai");
      const catalogFile = join(root, "dist", "providers", "data", "github-copilot.json");
      const packageJsonFile = join(root, "package.json");
      if (existsSync(catalogFile) && existsSync(packageJsonFile)) {
        const pkg = JSON.parse(readFileSync(packageJsonFile, "utf8"));
        return { catalogFile, packageJsonFile, version: pkg.version };
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* 安装树结构变化 → null（调用方降级） */ }
  return null;
}
