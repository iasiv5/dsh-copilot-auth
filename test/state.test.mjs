import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadState, saveState, freshState, createJournal, advanceJournal,
  setLastError, clearLastError, restartMarker,
} from "../src/state.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "state-"));

test("freshState 形状：version 1 全字段就位", () => {
  assert.deepEqual(freshState(), {
    version: 1,
    activated: false,
    restartState: null,
    appliedOverlay: {},
    appliedProvenance: null,
    journal: null,
    lastError: null,
    lastErrorAt: null,
  });
});

test("round-trip：save → load 一致；缺失文件 → fresh", () => {
  const dir = tmp();
  const f = join(dir, "s.json");
  assert.deepEqual(loadState(f), freshState());
  const s = { ...freshState(), activated: true, restartState: restartMarker("self-heal", "abc") };
  saveState(f, s);
  assert.deepEqual(loadState(f), s);
});

test("坏文件：改名留存 .corrupt-<ts> 不覆盖，返回 state-corrupt 安全态；后续正常保存不抹掉留存文件", () => {
  const dir = tmp();
  const f = join(dir, "s.json");
  writeFileSync(f, "{not json");
  const s = loadState(f);
  assert.equal(s.lastError, "state-corrupt");
  assert.ok(s.lastErrorAt, "lastErrorAt 置位");
  assert.equal(s.activated, false);
  assert.equal(existsSync(f), false, "原路径已改名");
  const quarantined = readdirSync(dir).filter((n) => n.includes(".corrupt-"));
  assert.equal(quarantined.length, 1);
  // 下一次普通保存写原路径，留存文件不被抹掉
  saveState(f, freshState());
  assert.deepEqual(loadState(f), freshState());
  assert.equal(readFileSync(join(dir, quarantined[0]), "utf8"), "{not json");
});

test("非对象状态文件同样按损坏隔离", () => {
  const dir = tmp();
  const f = join(dir, "s.json");
  writeFileSync(f, JSON.stringify(["array"]));
  const s = loadState(f);
  assert.equal(s.lastError, "state-corrupt");
  assert.equal(readdirSync(dir).filter((n) => n.includes(".corrupt-")).length, 1);
});

test("journal 各相位 round-trip：prepared → catalog-committed-needs-restart", () => {
  const dir = tmp();
  const f = join(dir, "s.json");
  // raw 视图契约：缺席用 null 占位（非 undefined），保证 journal JSON 持久化无损、
  // boot 重载后与现算视图可逐字节比较；「未配置 vs 显式空」由 *Present 标志区分
  const j = createJournal({
    settingsBaseline: { modelsPresent: true, models: [{ id: "gpt-a" }], modelOverridesPresent: false, modelOverrides: null },
    targetIds: ["gpt-a"],
    pendingOverlay: { "openai-completions": { "gpt-a": { id: "gpt-a", api: "openai-completions", provider: "github-copilot", contextWindow: 1, maxTokens: 1 } } },
    appliedAgainstPiAiVersion: "0.84.4",
    catalogBaselineDigest: "a".repeat(64),
    patchedCatalogDigest: "b".repeat(64),
    source: { kind: "latest", piAiVersion: "0.85.1", integrity: "sha512-x" },
  });
  assert.equal(j.phase, "prepared");
  assert.deepEqual(j.catalogIdentity, { packageName: "@earendil-works/pi-ai", catalogSchemaVersion: 1 });
  let s = { ...freshState(), journal: j };
  saveState(f, s);
  assert.deepEqual(loadState(f).journal, j);
  const advanced = advanceJournal(loadState(f).journal);
  assert.equal(advanced.phase, "catalog-committed-needs-restart");
  s = { ...s, journal: advanced };
  saveState(f, s);
  assert.deepEqual(loadState(f).journal, advanced);
  assert.throws(() => advanceJournal(advanced), /cannot advance/);
});

test("lastError 规则：置位/清除投影顶层（R3-6）", () => {
  let s = freshState();
  s = setLastError(s, new Error("boom"));
  assert.equal(s.lastError, "boom");
  assert.ok(s.lastErrorAt);
  s = clearLastError(s);
  assert.equal(s.lastError, null);
  assert.equal(s.lastErrorAt, null);
});

test("restartMarker 形状：reason/expectedEntriesDigest/since", () => {
  const m = restartMarker("refresh", "deadbeef");
  assert.equal(m.reason, "refresh");
  assert.equal(m.expectedEntriesDigest, "deadbeef");
  assert.ok(m.since);
  assert.throws(() => restartMarker("bogus", "x"), /reason/);
});
