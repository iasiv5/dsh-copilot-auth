import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const doc = YAML.parse(readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8"));

test("insert 不再挂载 dsh-authorization（0.1.7 起 runtime 内置，重复 provide 即冲突）", () => {
  const insert = doc.find((row) => Array.isArray(row.insert))?.insert ?? [];
  assert.equal(insert.find((e) => e.id === "copilot-authorization"), undefined);
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
