// client-http.mjs — 浏览器/host 双侧可用的 HTTP/JSON 解析层（T1）。
// 契约：requestJson(fetchImpl, url, init) -> {ok, httpStatus, body, error}
//  - 网络拒绝 → network-error（httpStatus=null）
//  - 非 JSON（HTML 代理页/空体/坏 JSON）→ 保留 httpStatus，bad-gateway（5xx 或 HTML）/ bad-response
//  - JSON 但失败 → http-error，errorCode 仅保留安全形状（字母开头，字母/数字/空格/连字符）
//  - details 白名单：{httpStatus?, contentType?, errorCode?}；绝不透传原始响应体或异常文本
//  - 写调用不自动重试
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9 -]{0,79}$/;
const SAFE_CONTENT_TYPE = /^[\w./+-]{0,100}$/;

export function sanitizeErrorCode(value) {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : "http-error";
}

// 错误响应的 body 深度脱敏：仅保留安全形状的字符串（字母/数字/空格/连字符，
// 覆盖 already running、logout-safety-unavailable、uuid 等），其余字符串丢弃，
// 防止上游异常文本或疑似 token 随 body 泄漏；ok:true 的 body 为域数据，原样返回。
const SAFE_STRING = /^[A-Za-z0-9][A-Za-z0-9 -]{0,127}$/;

function deepSanitize(value) {
  if (typeof value === "string") return SAFE_STRING.test(value) ? value : undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const s = deepSanitize(v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

function sanitizeContentType(value) {
  if (typeof value !== "string" || !SAFE_CONTENT_TYPE.test(value)) return undefined;
  return value;
}

export async function requestJson(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return { ok: false, httpStatus: null, body: undefined, error: { messageKey: "network-error", details: {} } };
  }
  const httpStatus = res.status;
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  if (typeof text !== "string" || text.trim() === "") {
    return {
      ok: false,
      httpStatus,
      body: undefined,
      error: { messageKey: httpStatus >= 500 ? "bad-gateway" : "bad-response", details: { httpStatus } },
    };
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const contentType = sanitizeContentType(res.headers?.get?.("content-type"));
    const looksHtml = contentType?.includes("html") || /^\s*<(?:!doctype|html)/i.test(text);
    const messageKey = httpStatus >= 500 || looksHtml ? "bad-gateway" : "bad-response";
    const details = { httpStatus };
    if (contentType !== undefined) details.contentType = contentType;
    return { ok: false, httpStatus, body: undefined, error: { messageKey, details } };
  }
  const ok = res.ok && body?.ok !== false;
  if (ok) return { ok: true, httpStatus, body, error: undefined };
  const details = {};
  if (!res.ok) details.httpStatus = httpStatus;
  const errorCode = sanitizeErrorCode(body?.error);
  if (errorCode !== undefined) details.errorCode = errorCode;
  return { ok: false, httpStatus, body: deepSanitize(body), error: { messageKey: "http-error", details } };
}
