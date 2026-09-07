import { test } from "node:test";
import assert from "node:assert/strict";
import { copilotBaseUrl, fetchLiveAvailableModelIds } from "../src/copilot-models.mjs";

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
