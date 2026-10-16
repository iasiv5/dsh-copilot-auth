// copilot-models.mjs — GitHub Copilot 可用性适配（只读 GET /models）。
// ⚠️ 显式耦合 pi-ai 0.84.4：COPILOT_HEADERS / COPILOT_API_VERSION / normalizeDomain /
// getGitHubCopilotBaseUrl / parseGitHubCopilotModelCatalog 的语义逐行抄录自
// @earendil-works/pi-ai@0.84.4 dist/auth/oauth/github-copilot.js。
// 不实现 token 获取/policy 修改；token 刷新仅限 v1.2.21 起的 ephemeral 续期（见文末，
// 只存内存、绝不落库）；其余语义漂移或任何失败一律由调用方回退凭证缓存
// （payload.availableModelIds）。pi-ai 升级后本文件必须对照新版源码复核。
// v1.2.21 增抄：copilot_internal/v2/token 续期语义抄录自 pi-ai dist/auth/oauth/github-copilot.js
// refreshGitHubCopilotAccessToken（0.84.4 与 0.87.1 该函数 diff 为空）；ephemeral 使用、绝不落库。

// ↓↓↓ 以下常量抄录自 pi-ai 0.84.4 dist/auth/oauth/github-copilot.js（勿改值）
const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const COPILOT_API_VERSION = "2026-06-01";
// ↑↑↑ 抄录结束

const INDIVIDUAL_DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

// 抄录语义：trim → 空 → null；含 :// 直接 new URL，否则补 https://；取 hostname；异常 → null
function normalizeDomain(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

// 抄录语义：token 形如 tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
// proxy.xxx → api.xxx
function getBaseUrlFromToken(token) {
  const match = String(token ?? "").match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const proxyHost = match[1];
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

// 抄录语义：token proxy-ep 优先 → enterprise copilot-api.<domain> → individual 缺省
export function copilotBaseUrl(access, enterpriseUrl) {
  const enterpriseDomain = normalizeDomain(enterpriseUrl);
  if (access) {
    const urlFromToken = getBaseUrlFromToken(access);
    if (urlFromToken) return urlFromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return INDIVIDUAL_DEFAULT_BASE_URL;
}

function asRecord(value) {
  return value && typeof value === "object" ? value : undefined;
}

// 抄录语义（仅 availableModelIds 部分；policyModelIds 涉及 policy 修改，本适配不实现）：
// tool_calls === false 前置排除；pickerEnabled === true && policyState !== "disabled"
// 为主集；仅当 individual 端点且主集为空时回退 policyState === "enabled"。
function parseAvailableModelIds(raw, allowPolicyFallback) {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Invalid Copilot models response");
  }
  const accountModels = data.flatMap((rawItem) => {
    const item = asRecord(rawItem);
    const id = item?.id;
    if (!item || typeof id !== "string") return [];
    const capabilities = asRecord(item.capabilities);
    const supports = asRecord(capabilities?.supports);
    if (supports?.tool_calls === false) return [];
    return [
      {
        id,
        pickerEnabled: item.model_picker_enabled === true,
        policyState: asRecord(item.policy)?.state,
      },
    ];
  });
  const pickerModelIds = accountModels
    .filter((model) => model.pickerEnabled && model.policyState !== "disabled")
    .map((model) => model.id);
  return pickerModelIds.length > 0 || !allowPolicyFallback
    ? pickerModelIds
    : accountModels.filter((model) => model.policyState === "enabled").map((model) => model.id);
}

// 现场拉取账号可用模型。credential 为 GrantRecord payload：
// { access, enterpriseUrl?, availableModelIds? }。5s 超时、不重试（对齐 0.84.4
// token 刷新路径 maxRetries: 0 的行为）；任何失败抛错，由调用方回退凭证缓存。
export async function fetchLiveAvailableModelIds({ credential, fetchImpl } = {}) {
  const access = credential?.access;
  if (!access || typeof fetchImpl !== "function") {
    throw new Error("credential.access and fetchImpl required");
  }
  const baseUrl = copilotBaseUrl(access, credential.enterpriseUrl);
  // 0.84.4 注释：部分 Individual 账号 picker 标志全 false 但 policy 显式 enabled，
  // 回退严格限定在 individual 端点。
  const allowPolicyFallback = baseUrl === INDIVIDUAL_DEFAULT_BASE_URL;
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${access}`,
      ...COPILOT_HEADERS,
      "X-GitHub-Api-Version": COPILOT_API_VERSION,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    // 携 status 供调用方证据分型（401/403 → token-rejected；其余 → network），与 refreshEphemeralAccess 同款
    throw Object.assign(new Error(`${response.status} ${response.statusText}: GET ${baseUrl}/models`), { status: response.status });
  }
  return parseAvailableModelIds(await response.json(), allowPolicyFallback);
}

// 本地解析 access（tid 会话令牌）内的 exp=（秒 → 毫秒）；缺失/不可解析 → null。
// 零网络：调用方据此在发请求前判断"是否需要续期"。
export function parseAccessExpiryMs(access) {
  const match = String(access ?? "").match(/exp=(\d+)/);
  return match ? Number(match[1]) * 1000 : null;
}

// 铸一枚新的短命 tid：GET copilot_internal/v2/token（Bearer = 长期 ghu）。
// 语义抄录自 pi-ai refreshGitHubCopilotAccessToken（见文件头）；单次尝试、5s 超时、
// 不重试、结果仅存内存（调用方绝不写回凭据库）。HTTP 失败抛错并携 status 供分型
// （401/403 → 长期令牌被拒；其余/网络 → network）。错误消息保真对齐 0.87.1 L261/L264。
export async function refreshEphemeralAccess({ refreshToken, enterpriseUrl, fetchImpl } = {}) {
  if (typeof refreshToken !== "string" || refreshToken === "" || typeof fetchImpl !== "function") {
    throw new Error("refreshToken and fetchImpl required");
  }
  const domain = normalizeDomain(enterpriseUrl) ?? "github.com";
  const url = `https://api.${domain}/copilot_internal/v2/token`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`${response.status} ${response.statusText}: GET ${url}`), { status: response.status });
  }
  const raw = await response.json();
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Copilot token response");
  }
  const token = raw.token;
  const expiresAt = raw.expires_at;
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error("Invalid Copilot token response fields");
  }
  return { access: token, expiresAtMs: expiresAt * 1000 - 5 * 60 * 1000 };
}
