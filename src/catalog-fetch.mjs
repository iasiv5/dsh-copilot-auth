// catalog-fetch.mjs — 最新 pi-ai 目录的受信获取通道。
// 分层校验契约（Y2-7）：本层只管传输可信——integrity / 超时 / 流式大小上限 /
// 包膜结构；逐条目合法性唯一归 mergeCatalog 的 validateCatalog，本层不拦。
import { createHash } from "node:crypto";
import { extractTgzEntry } from "./catalog.mjs";

const PKG = "@earendil-works/pi-ai";
const DEFAULT_CAPS = { metadata: 20_000_000, tarball: 30_000_000, decompressed: 100_000_000 };
const MAX_REDIRECTS = 3;

// 流式限额读取（Y3-1）：逐 chunk 累计，超限立即 cancel 并抛错——不得先无限缓冲再检查。
async function readCapped(res, cap) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > cap) {
      try {
        await res.body.cancel();
      } catch { /* cancel 失败不掩盖超限错误 */ }
      throw new Error(`response too large (cap ${cap} bytes)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// URL 信任：仅 HTTPS，或与所配置 registry 同主机的 http（企业镜像例外）。
function assertUrlAllowed(rawUrl, registryHost) {
  const u = new URL(rawUrl);
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && u.host === registryHost) return u;
  throw new Error(`disallowed url: ${rawUrl}`);
}

// 一律 redirect:"manual"（Y3-2）：30x 逐跳校验 Location 的协议/host（同 tarball
// 规则），相对 Location 以当前 URL 解析，最多 3 跳，回环（重复 URL）即抛错。
async function fetchValidated(fetchImpl, url, registryHost) {
  let current = url;
  const seen = new Set([current]);
  for (let redirects = 0; ; ) {
    assertUrlAllowed(current, registryHost);
    const res = await fetchImpl(current, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
    const location = res.headers?.get?.("location");
    if (res.status >= 300 && res.status < 400 && location) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS}) from ${url}`);
      const next = new URL(location, current).href;
      if (seen.has(next)) throw new Error(`redirect loop detected: ${next}`);
      seen.add(next);
      try {
        await res.body?.cancel?.();
      } catch { /* redirect 响应体丢弃失败可忽略 */ }
      current = next;
      continue;
    }
    return res;
  }
}

// fetchLatestCatalog({ registry, fetchImpl, caps? }) → { catalog, piAiVersion, integrity }
// caps 为测试注入钩子（默认 20MB metadata / 30MB tgz 压缩 / 100MB 解压）。
export async function fetchLatestCatalog({ registry, fetchImpl, caps = {} } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl required");
  const limit = { ...DEFAULT_CAPS, ...caps };
  const reg = (registry ?? process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const registryHost = new URL(reg).host;

  const metaRes = await fetchValidated(fetchImpl, `${reg}/${PKG}`, registryHost);
  if (!metaRes.ok) throw new Error(`npm metadata -> ${metaRes.status}`);
  const metadata = JSON.parse((await readCapped(metaRes, limit.metadata)).toString("utf8"));
  const version = metadata?.["dist-tags"]?.latest;
  const dist = version ? metadata?.versions?.[version]?.dist : undefined;
  if (!version || !dist?.tarball || !dist?.integrity) {
    throw new Error("npm metadata missing dist-tags.latest/versions[latest].dist");
  }

  const tgzRes = await fetchValidated(fetchImpl, dist.tarball, registryHost);
  if (!tgzRes.ok) throw new Error(`npm tarball -> ${tgzRes.status}`);
  const tgz = await readCapped(tgzRes, limit.tarball);

  const actual = "sha512-" + createHash("sha512").update(tgz).digest("base64");
  if (actual !== dist.integrity) {
    throw new Error(`integrity mismatch for ${PKG}@${version}`);
  }

  const catalog = JSON.parse(extractTgzEntry(tgz, { maxBytes: limit.decompressed }).toString("utf8"));
  // 包膜结构校验（本层职责）：catalog 为对象且每个 section 为对象。
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("catalog envelope invalid: root is not an object");
  }
  for (const [api, section] of Object.entries(catalog)) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new Error(`catalog envelope invalid: section ${api} is not an object`);
    }
  }
  return { catalog, piAiVersion: version, integrity: dist.integrity };
}
