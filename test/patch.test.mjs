import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const doc = YAML.parse(readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8"));

test("insert 挂载 dsh-authorization 服务（内置 bundle 未挂载的前置）", () => {
  const insert = doc.find((row) => Array.isArray(row.insert))?.insert ?? [];
  const auth = insert.find((e) => e.id === "copilot-authorization");
  assert.equal(auth?.name, "@deepseek-ai/dsh-authorization");
});

test("insert 本插件 host entry，name 与 package.json 一致", () => {
  const insert = doc.find((row) => Array.isArray(row.insert))?.insert ?? [];
  const self = insert.find((e) => e.id === "copilot-auth");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(self?.name, pkg.name);
});

test("patch llm-pi-ai 行预置 github-copilot 路由（base 层，无 apiKeyEnv）", () => {
  const row = doc.find((e) => e.id === "llm-pi-ai" && !Array.isArray(e.insert));
  assert.equal(row?.name, "@deepseek-ai/dsh-llm-pi-ai"); // 评审 Agent 注 2026-09-03：补 v1-B5 的测试子项——yaml 的 name 防御此前未被测试锁定
  assert.equal(row?.config?.providers?.["github-copilot"]?.displayName, "GitHub Copilot");
  assert.equal(row?.config?.providers?.["github-copilot"]?.apiKeyEnv, undefined);
});
