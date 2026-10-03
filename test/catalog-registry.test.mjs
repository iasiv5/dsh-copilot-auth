// 目录注册表注入面（ADR 0003）：只读安装树下的不写盘落地通道。
// 用与真实 pi-ai 同构的假模块树（未冻结的 GITHUB_COPILOT_MODELS + 现读它的
// getBuiltinModels）覆盖：注入成功 / 已存在不覆盖 / 非法条目拒绝 / 形状裁剪 /
// 注册表面不可用 / 冻结守卫生效。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { injectCatalogEntries, registryModelIds, registryDistDir, REGISTRY_ROUTE } from "../src/catalog-registry.mjs";

const ENTRY = (id, api = "openai-responses", extra = {}) => ({
  id, api, provider: "github-copilot", baseUrl: "https://api.individual.githubcopilot.com",
  contextWindow: 128000, maxTokens: 8192, input: ["text"], ...extra,
});

// 假 pi-ai 安装树：<dir>/app.asar/dsh/node_modules/@earendil-works/pi-ai/dist/providers/*
function makeTree({ models = {}, frozen = false, withModules = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const root = join(dir, "app.asar", "dsh", "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(join(root, "dist", "providers", "data"), { recursive: true });
  const catalogFile = join(root, "dist", "providers", "data", "github-copilot.json");
  writeFileSync(catalogFile, JSON.stringify({ "openai-completions": {} }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.87.1", type: "module" }));
  if (withModules) {
    const literal = JSON.stringify(models);
    writeFileSync(
      join(root, "dist", "providers", "github-copilot.models.js"),
      `export const GITHUB_COPILOT_MODELS = ${frozen ? `Object.freeze(${literal})` : literal};\n`,
    );
    writeFileSync(
      join(root, "dist", "providers", "all.js"),
      'import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.js";\n'
        + 'export function getBuiltinModels(provider) { return provider === "github-copilot" ? Object.values(GITHUB_COPILOT_MODELS) : []; }\n',
    );
  }
  const install = { catalogFile, version: "0.87.1", writable: false, unwritableReason: "asar" };
  return { dir, root, catalogFile, install, modelsUrl: pathToFileURL(join(root, "dist", "providers", "github-copilot.models.js")).href };
}

const reread = async (url) => (await import(url)).GITHUB_COPILOT_MODELS;

test("registryDistDir：从 catalogFile 回溯到 <root>/dist", () => {
  const tree = makeTree();
  assert.equal(registryDistDir(tree.install).endsWith(join("pi-ai", "dist")), true);
});

test("注入新条目：ok、via=file（裸 specifier 在测试进程不可解析）、getBuiltinModels 立即可见", async () => {
  const tree = makeTree({ models: { "gpt-a": ENTRY("gpt-a") } });
  const r = await injectCatalogEntries(tree.install, { "openai-responses": { "gpt-6.1-sol": ENTRY("gpt-6.1-sol") } });
  assert.equal(r.ok, true);
  assert.equal(r.via, "file");
  assert.deepEqual(r.injected, ["gpt-6.1-sol"]);
  assert.deepEqual(r.missing, []);
  const registry = await reread(tree.modelsUrl);
  assert.equal(registry["gpt-6.1-sol"].id, "gpt-6.1-sol");
  assert.equal(registry["gpt-6.1-sol"].api, "openai-responses");
});

test("已存在的 id 不覆盖（只增不更新）：进 present、registry 值保持原样", async () => {
  const tree = makeTree({ models: { "gpt-a": ENTRY("gpt-a", "openai-completions", { name: "原始" }) } });
  const r = await injectCatalogEntries(tree.install, { "openai-responses": { "gpt-a": ENTRY("gpt-a", "openai-responses", { name: "篡改" }) } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.present, ["gpt-a"]);
  assert.deepEqual(r.injected, []);
  const registry = await reread(tree.modelsUrl);
  assert.equal(registry["gpt-a"].name, "原始");
  assert.equal(registry["gpt-a"].api, "openai-completions");
});

test("非法条目拒绝并整体失败（reason=invalid-entries）——绝不写入半个条目", async () => {
  const tree = makeTree();
  const r = await injectCatalogEntries(tree.install, { "openai-responses": { "gpt-bad": { id: "gpt-bad", api: "openai-responses", provider: "github-copilot" } } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-entries");
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].reason, /contextWindow/);
  const registry = await reread(tree.modelsUrl);
  assert.equal("gpt-bad" in registry, false);
});

test("allowedKeys 裁剪：上游新增字段（type:chat）不进旧运行时", async () => {
  const tree = makeTree();
  const allowed = new Set(["id", "api", "provider", "baseUrl", "contextWindow", "maxTokens", "input"]);
  const r = await injectCatalogEntries(tree.install, { "openai-responses": { "gpt-6.1-sol": ENTRY("gpt-6.1-sol", "openai-responses", { type: "chat" }) } }, { allowedKeys: allowed });
  assert.equal(r.ok, true);
  const registry = await reread(tree.modelsUrl);
  assert.equal("type" in registry["gpt-6.1-sol"], false);
});

test("注册表面不可用（无模块树）→ ok:false / registry-modules-unavailable，绝不抛", async () => {
  const tree = makeTree({ withModules: false });
  const r = await injectCatalogEntries(tree.install, { "openai-responses": { "gpt-a": ENTRY("gpt-a") } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "registry-modules-unavailable");
  assert.equal(r.errors.length, 2, "裸 specifier 与 file URL 两条路都记了失败原因");
});

test("冻结注册表被守卫拦下（as 只读面不可写时不硬闯）", async () => {
  const tree = makeTree({ models: { "gpt-a": ENTRY("gpt-a") }, frozen: true });
  const r = await injectCatalogEntries(tree.install, { "openai-responses": { "gpt-b": ENTRY("gpt-b") } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "registry-modules-unavailable");
});

test("空增量不触盘、不加载模块：ok 且各列表为空", async () => {
  const tree = makeTree({ withModules: false });
  const r = await injectCatalogEntries(tree.install, {});
  assert.equal(r.ok, true);
  assert.equal(r.via, null);
  assert.deepEqual(r.injected, []);
});

test("registryModelIds：返回注册表当前 id 集合；不可用时 null", async () => {
  const tree = makeTree({ models: { "gpt-a": ENTRY("gpt-a"), "gpt-reg": ENTRY("gpt-reg") } });
  const ids = await registryModelIds(tree.install);
  assert.deepEqual([...ids].sort(), ["gpt-a", "gpt-reg"]);
  assert.equal(REGISTRY_ROUTE, "github-copilot");
  const missing = makeTree({ withModules: false });
  assert.equal(await registryModelIds(missing.install), null);
});
