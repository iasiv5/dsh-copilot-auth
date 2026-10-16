import { test } from "node:test";
import assert from "node:assert/strict";
import { copilotBaseUrl, fetchLiveAvailableModelIds, parseAccessExpiryMs, refreshEphemeralAccess } from "../src/copilot-models.mjs";

const INDIVIDUAL_TOKEN = "tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;";
const PLAIN_TOKEN = "tid=1;exp=2;"; // 无 proxy-ep

function modelsResponse(data) {
  return { data };
}

function mockFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    for (const [prefix, responder] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return responder(url);
    }
    throw new Error("unexpected fetch: " + url);
  };
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "STATUS",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("baseUrl：individual token proxy-ep → api.individual.githubcopilot.com", () => {
  assert.equal(copilotBaseUrl(INDIVIDUAL_TOKEN), "https://api.individual.githubcopilot.com");
});

test("baseUrl：enterprise normalizeDomain 语义（裸域 / URL 形态 / 空白）", () => {
  assert.equal(copilotBaseUrl(PLAIN_TOKEN, "acme.ghe.com"), "https://copilot-api.acme.ghe.com");
  assert.equal(copilotBaseUrl(PLAIN_TOKEN, "https://acme.ghe.com/path"), "https://copilot-api.acme.ghe.com");
  assert.equal(copilotBaseUrl(PLAIN_TOKEN, "  acme.ghe.com  "), "https://copilot-api.acme.ghe.com");
});

test("baseUrl：非法值 / 空字符串视作无 enterpriseUrl；无 proxy-ep 无 enterprise → individual 缺省", () => {
  assert.equal(copilotBaseUrl(PLAIN_TOKEN, "not a domain"), "https://api.individual.githubcopilot.com");
  assert.equal(copilotBaseUrl(PLAIN_TOKEN, ""), "https://api.individual.githubcopilot.com");
  assert.equal(copilotBaseUrl(PLAIN_TOKEN, "   "), "https://api.individual.githubcopilot.com");
  assert.equal(copilotBaseUrl(PLAIN_TOKEN), "https://api.individual.githubcopilot.com");
});

test("严格 picker：picker 缺失/false 不入选（即使 policy enabled）——enterprise 端点无回退", async () => {
  const calls = [];
  const fetchImpl = mockFetch({
    "https://copilot-api.acme.ghe.com": () =>
      jsonRes(modelsResponse([
        { id: "gpt-a", model_picker_enabled: false, policy: { state: "enabled" } },
        { id: "gpt-b", policy: { state: "enabled" } }, // picker 缺失
      ])),
  }, calls);
  const ids = await fetchLiveAvailableModelIds({
    credential: { access: PLAIN_TOKEN, enterpriseUrl: "acme.ghe.com" },
    fetchImpl,
  });
  assert.deepEqual(ids, [], "enterprise 端点不做 policy 回退");
  assert.equal(calls[0].url, "https://copilot-api.acme.ghe.com/models");
  assert.equal(calls[0].init.headers["Editor-Version"], "vscode/1.107.0");
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], "2026-06-01");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${PLAIN_TOKEN}`);
  assert.ok(calls[0].init.signal, "5s 超时 signal 必须存在");
});

test("严格 picker：individual 主集非空时不回退；policy enabled 但 picker false 的条目仍排除", async () => {
  const fetchImpl = mockFetch({
    "https://api.individual.githubcopilot.com": () =>
      jsonRes(modelsResponse([
        { id: "gpt-a", model_picker_enabled: true },
        { id: "gpt-b", model_picker_enabled: false, policy: { state: "enabled" } },
      ])),
  });
  const ids = await fetchLiveAvailableModelIds({ credential: { access: INDIVIDUAL_TOKEN }, fetchImpl });
  assert.deepEqual(ids, ["gpt-a"]);
});

test("policy 回退仅 individual 且主集为空：picker 全 false + policy enabled → 回退集", async () => {
  const fetchImpl = mockFetch({
    "https://api.individual.githubcopilot.com": () =>
      jsonRes(modelsResponse([
        { id: "gpt-a", model_picker_enabled: false, policy: { state: "enabled" } },
        { id: "gpt-b", model_picker_enabled: false, policy: { state: "disabled" } },
        { id: "gpt-c", model_picker_enabled: false }, // 无 policy
      ])),
  });
  const ids = await fetchLiveAvailableModelIds({ credential: { access: INDIVIDUAL_TOKEN }, fetchImpl });
  assert.deepEqual(ids, ["gpt-a"]);
});

test("排除规则：tool_calls === false 排除；policy.state === disabled 排除（picker true 也救不回）", async () => {
  const fetchImpl = mockFetch({
    "https://api.individual.githubcopilot.com": () =>
      jsonRes(modelsResponse([
        { id: "ok", model_picker_enabled: true },
        { id: "no-tools", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
        { id: "banned", model_picker_enabled: true, policy: { state: "disabled" } },
      ])),
  });
  const ids = await fetchLiveAvailableModelIds({ credential: { access: INDIVIDUAL_TOKEN }, fetchImpl });
  assert.deepEqual(ids, ["ok"]);
});

test("非 200 → 抛错（调用方回退 cache）；响应非 data 数组 → 抛错", async () => {
  const unauthorized = mockFetch({ "https://api.individual.githubcopilot.com": () => jsonRes({}, 401) });
  await assert.rejects(
    fetchLiveAvailableModelIds({ credential: { access: INDIVIDUAL_TOKEN }, fetchImpl: unauthorized }),
    /401/,
  );
  const garbage = mockFetch({ "https://api.individual.githubcopilot.com": () => jsonRes({ nope: true }) });
  await assert.rejects(
    fetchLiveAvailableModelIds({ credential: { access: INDIVIDUAL_TOKEN }, fetchImpl: garbage }),
    /Invalid Copilot models response/,
  );
});

test("无 access → 抛错（调用方回退 cache）", async () => {
  await assert.rejects(fetchLiveAvailableModelIds({ credential: {}, fetchImpl: async () => jsonRes({}) }));
});

// ---- v1.2.21：exp 解析与 ephemeral 续期（计划 Task 1）----

test("parseAccessExpiryMs：exp 秒 → 毫秒；缺失/非数字/undefined → null", () => {
  assert.equal(parseAccessExpiryMs("tid=1;exp=2000;proxy-ep=proxy.individual.githubcopilot.com;"), 2000000);
  assert.equal(parseAccessExpiryMs("tid=1;"), null, "无 exp 字段 → null");
  assert.equal(parseAccessExpiryMs(undefined), null);
  assert.equal(parseAccessExpiryMs("tid=1;exp=NaN;"), null, "非数字 exp → null");
});

test("refreshEphemeralAccess 成功：v2/token URL＋Bearer refresh＋COPILOT_HEADERS（无 api-version）＋5min 提前量", async () => {
  const calls = [];
  const fetchImpl = mockFetch({
    "https://api.github.com/copilot_internal/v2/token": () => jsonRes({ token: "tid=2;exp=999999;", expires_at: 1000000 }),
  }, calls);
  const out = await refreshEphemeralAccess({ refreshToken: "ghu-x", fetchImpl });
  assert.equal(out.access, "tid=2;exp=999999;");
  assert.equal(out.expiresAtMs, 999700000, "expires_at×1000 − 5×60×1000 提前量");
  assert.equal(calls[0].url, "https://api.github.com/copilot_internal/v2/token");
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghu-x");
  assert.equal(calls[0].init.headers["User-Agent"], "GitHubCopilotChat/0.35.0");
  assert.equal(calls[0].init.headers["X-GitHub-Api-Version"], undefined, "续期调用不带 api-version（对齐 pi-ai refresh 路径）");
  assert.ok(calls[0].init.signal, "5s 超时 signal 必须存在");
});

test("refreshEphemeralAccess：enterpriseUrl 归一 → api.<domain>/copilot_internal/v2/token", async () => {
  const calls = [];
  const fetchImpl = mockFetch({
    "https://api.ghe.com/copilot_internal/v2/token": () => jsonRes({ token: "tid=e;", expires_at: 5 }),
  }, calls);
  const out = await refreshEphemeralAccess({ refreshToken: "ghu-e", enterpriseUrl: "ghe.com", fetchImpl });
  assert.equal(out.access, "tid=e;");
  assert.equal(calls[0].url, "https://api.ghe.com/copilot_internal/v2/token");
});

test("refreshEphemeralAccess 失败分型：401 带 status；非对象/缺字段两条消息保真；网络错误原样上抛", async () => {
  const unauthorized = mockFetch({ "https://api.github.com/copilot_internal/v2/token": () => jsonRes({}, 401) });
  await assert.rejects(
    refreshEphemeralAccess({ refreshToken: "ghu-x", fetchImpl: unauthorized }),
    (err) => err.status === 401 && /401/.test(err.message),
    "HTTP 失败须携带 status 供调用方分型",
  );
  const nonObject = mockFetch({ "https://api.github.com/copilot_internal/v2/token": () => jsonRes("nope") });
  await assert.rejects(
    refreshEphemeralAccess({ refreshToken: "ghu-x", fetchImpl: nonObject }),
    /Invalid Copilot token response$/,
    "非对象响应消息对齐 pi-ai 0.87.1 L261",
  );
  const missingFields = mockFetch({ "https://api.github.com/copilot_internal/v2/token": () => jsonRes({ token: 1, expires_at: "x" }) });
  await assert.rejects(
    refreshEphemeralAccess({ refreshToken: "ghu-x", fetchImpl: missingFields }),
    /Invalid Copilot token response fields/,
    "字段缺失消息对齐 pi-ai 0.87.1 L264",
  );
  const netfail = mockFetch({});
  await assert.rejects(
    refreshEphemeralAccess({ refreshToken: "ghu-x", fetchImpl: netfail }),
    /unexpected fetch/,
    "网络错误原样上抛（调用方分类为 network）",
  );
});
