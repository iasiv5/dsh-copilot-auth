// 两半区共享的 HTTP API 契约。路由前缀固定、不做配置项：
// client 侧 fetch 硬编码同一路径，配置一旦漂移 client 即 404（见计划附录 B）。
export const CREDENTIAL_KEY = "llm-pi-ai/github-copilot";
export const ROUTE_PREFIX = "/copilot-auth";
export const routes = () => ({
  start: `${ROUTE_PREFIX}/start`,
  state: `${ROUTE_PREFIX}/state`,
  status: `${ROUTE_PREFIX}/status`,
  logout: `${ROUTE_PREFIX}/logout`,
  refreshPreview: `${ROUTE_PREFIX}/refresh/preview`,
  refreshApply: `${ROUTE_PREFIX}/refresh/apply`,
});
export const emptyState = () => ({ status: "idle", notices: [], error: undefined });
