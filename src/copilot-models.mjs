// copilot-models.mjs — GitHub Copilot 可用性适配（只读 GET /models）。
// ⚠️ 显式耦合 pi-ai 0.84.4：COPILOT_HEADERS / COPILOT_API_VERSION / normalizeDomain /
// getGitHubCopilotBaseUrl / parseGitHubCopilotModelCatalog 的语义逐行抄录自
// @earendil-works/pi-ai@0.84.4 dist/auth/oauth/github-copilot.js。
// 不实现 token 获取/刷新/policy 修改；语义漂移或任何失败一律由调用方回退凭证缓存
// （payload.availableModelIds）。pi-ai 升级后本文件必须对照新版源码复核。

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
    throw new Error(`${response.status} ${response.statusText}: GET ${baseUrl}/models`);
  }
  return parseAvailableModelIds(await response.json(), allowPolicyFallback);
}
