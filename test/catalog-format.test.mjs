// 远端目录形状规范化（ADR 0003 / Q21）：pi-ai ≥0.99.0 用 `chat:<id>` 键，
// 0.87.x 用裸 id 键；本文件锁定「两个世代归一到同一语义」这一契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRemoteCatalog, catalogShapeKeys, trimEntryToShape, mergeCatalog, CHAT_KEY_PREFIX } from "../src/catalog.mjs";

const ENTRY = (id, api, extra = {}) => ({
  id, api, provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com",
  contextWindow: 128000, maxTokens: 8192, input: ["text"], ...extra,
});

test("0.87.x 裸键目录：原样通过，renamed=0", () => {
  const raw = { "openai-responses": { "gpt-a": ENTRY("gpt-a", "openai-responses") } };
  const { catalog, renamed, skipped } = normalizeRemoteCatalog(raw);
  assert.equal(renamed, 0);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.keys(catalog["openai-responses"]), ["gpt-a"]);
});

test("≥0.99.0 的 chat:<id> 键：剥离前缀、按内层 id 编键，renamed 计数", () => {
  const raw = {
    "openai-responses": {
      [`${CHAT_KEY_PREFIX}gpt-6.1-sol`]: ENTRY("gpt-6.1-sol", "openai-responses", { type: "chat" }),
      [`${CHAT_KEY_PREFIX}gpt-5-mini`]: ENTRY("gpt-5-mini", "openai-responses", { type: "chat" }),
    },
  };
  const { catalog, renamed, skipped } = normalizeRemoteCatalog(raw);
  assert.equal(renamed, 2, "两个条目被改名");
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.keys(catalog["openai-responses"]).sort(), ["gpt-5-mini", "gpt-6.1-sol"]);
});

test("键与内层 id 冲突的条目一律跳过（宁可少一个模型，不可写坏目录）", () => {
  const raw = { "openai-responses": { [`${CHAT_KEY_PREFIX}gpt-a`]: ENTRY("gpt-b", "openai-responses") } };
  const { catalog, renamed, skipped } = normalizeRemoteCatalog(raw);
  assert.equal(renamed, 0, "冲突条目不计数、不落库");
  assert.deepEqual(catalog, {});
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /id mismatch/);
});

test("非对象 section / 非对象条目跳过并记录，不抛错", () => {
  const raw = { "openai-responses": { "gpt-a": "nope" }, "anthropic-messages": null };
  const { catalog, skipped } = normalizeRemoteCatalog(raw);
  assert.deepEqual(catalog, {});
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].reason, "entry is not an object");
  assert.equal(skipped[1].reason, "section is not an object");
});

test("allowedKeys：裁剪到本机运行时已见过的字段集合（type:chat 这类新字段不进旧运行时）", () => {
  const raw = { "openai-responses": { [`${CHAT_KEY_PREFIX}gpt-6.1-sol`]: ENTRY("gpt-6.1-sol", "openai-responses", { type: "chat" }) } };
  const allowed = new Set(["id", "api", "provider", "baseUrl", "contextWindow", "maxTokens", "input"]);
  const { catalog } = normalizeRemoteCatalog(raw, { allowedKeys: allowed });
  assert.deepEqual(Object.keys(catalog["openai-responses"]["gpt-6.1-sol"]).sort(),
    ["api", "baseUrl", "contextWindow", "id", "input", "maxTokens", "provider"]);
  assert.equal("type" in catalog["openai-responses"]["gpt-6.1-sol"], false);
});

test("allowedKeys 为空集时不裁剪（拿不到参考形状宁可不裁剪，也不误删必需字段）", () => {
  const entry = ENTRY("gpt-a", "openai-responses", { type: "chat" });
  assert.deepEqual(trimEntryToShape(entry, new Set()), entry);
  assert.deepEqual(trimEntryToShape(entry, undefined), entry);
});

test("catalogShapeKeys：条目字段并集", () => {
  const keys = catalogShapeKeys({
    "openai-responses": { "gpt-a": { id: "gpt-a", baseUrl: "x" } },
    "openai-completions": { "gpt-b": { id: "gpt-b", maxTokens: 1 } },
  });
  assert.deepEqual([...keys].sort(), ["baseUrl", "id", "maxTokens"]);
});

test("端到端契约：规范化后的 ≥0.99.0 目录喂给 mergeCatalog 能正确新增裸 id（Q21 的回归面）", () => {
  const local = { "openai-completions": { "gpt-a": ENTRY("gpt-a", "openai-completions") } };
  const remote = {
    "openai-completions": { [`${CHAT_KEY_PREFIX}gpt-a`]: ENTRY("gpt-a", "openai-completions") },
    "openai-responses": { [`${CHAT_KEY_PREFIX}gpt-6.1-sol`]: ENTRY("gpt-6.1-sol", "openai-responses", { type: "chat" }) },
  };
  // 不加规范化：键带前缀 → 内层 id 与键冲突 → 全部 skipped，新增为空（这正是升级到
  // ≥0.99.0 后"刷新拿到新目录却什么都加不进来"的形态）
  const naive = mergeCatalog(local, remote);
  assert.deepEqual(naive.added, []);
  assert.equal(naive.skipped.length, 2);
  // 加规范化：新增 = 裸 id 的 gpt-6.1-sol；已存在的 gpt-a 静默跳过（只增不更新）
  const { catalog } = normalizeRemoteCatalog(remote, { allowedKeys: catalogShapeKeys(local) });
  const fixed = mergeCatalog(local, catalog);
  assert.deepEqual(fixed.added, [{ id: "gpt-6.1-sol", api: "openai-responses" }]);
  assert.equal(fixed.skipped.length, 0, "已存在 id 不进 skipped（只增不更新语义不变）");
  assert.deepEqual(Object.keys(fixed.addedOverlay["openai-responses"]), ["gpt-6.1-sol"]);
});
