// T7：profile 隔离的 schema 2 刷新状态——两 scope 互不影响、legacy 只读、损坏留存、未知版本拒写。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRefreshState, saveRefreshState, freshRefreshState, refreshStateFile,
} from "../src/state.mjs";

const scope = (id) => ({ known: true, profileId: id, dataDir: join(mkdtempSync(join(tmpdir(), "v2state-")), id) });

test("两个 scope 写各自 dataDir，互不影响（配置意图绝不跨 profile 消费）", () => {
  const a = scope("aa");
  const b = scope("bb");
  const sa = freshRefreshState(a.profileId);
  sa.activated = true;
  sa.activeOperation = { operationId: "op-a", strategy: "rebuild", selectedIds: ["x"] };
  saveRefreshState(a, sa);
  const rb = loadRefreshState(b).state;
  assert.equal(rb.activated, false, "b 不看到 a 的激活");
  assert.equal(rb.activeOperation, null);
  const ra = loadRefreshState(a).state;
  assert.equal(ra.activated, true, "同 profile 重载保留 activated/appliedOverlay");
  assert.equal(ra.activeOperation.operationId, "op-a");
  assert.notEqual(refreshStateFile(a), refreshStateFile(b));
});

test("v1 全局旧文件存在且无 v2 状态 → 全新状态 + legacyStateDetected，不消费旧 journal/overlay", () => {
  const s = scope("cc");
  const legacyDir = mkdtempSync(join(tmpdir(), "v1legacy-"));
  const legacyPath = join(legacyDir, "copilot-auth-state.json");
  writeFileSync(legacyPath, JSON.stringify({
    version: 1, activated: true, journal: { phase: "prepared" },
    appliedOverlay: { "openai-completions": { "gpt-x": { id: "gpt-x" } } },
  }));
  const { state, flags } = loadRefreshState(s, { legacyPath });
  assert.equal(flags.legacyStateDetected, true);
  assert.equal(state.activated, false, "不从 legacy 继承激活");
  assert.equal(state.activeOperation, null, "不消费旧 journal");
  assert.deepEqual(state.appliedOverlay, {}, "不搬运旧 overlay");
  const { flags: noFlag } = loadRefreshState(scope("dd"), { legacyPath: join(legacyDir, "missing.json") });
  assert.equal(noFlag.legacyStateDetected, undefined);
});

test("损坏 v2 文件：改名留存 .corrupt-<ts>，返回 state-corrupt 安全态", () => {
  const s = scope("ee");
  saveRefreshState(s, freshRefreshState(s.profileId));
  writeFileSync(refreshStateFile(s), "{ broken json");
  const { state } = loadRefreshState(s);
  assert.equal(state.lastError, "state-corrupt");
  const preserved = readdirSync(s.dataDir).filter((f) => f.includes(".corrupt-"));
  assert.equal(preserved.length, 1, "原件改名留存不覆盖");
});

test("未知 version：返回 unknownVersion 且原件保留、save 拒绝", () => {
  const s = scope("ff");
  const file = refreshStateFile(s);
  saveRefreshState(s, freshRefreshState(s.profileId));
  writeFileSync(file, JSON.stringify({ version: 99, profileId: "ff", evil: true }));
  const { state, flags } = loadRefreshState(s);
  assert.equal(state, null, "不解析未知 schema");
  assert.equal(flags.unknownVersion, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 99, "原件未被改写");
  assert.throws(() => saveRefreshState(s, { version: 99 }), /refuse-save-unknown-version/);
});

test("scope unknown：读返回安全态并标记，写抛错", () => {
  const { state, flags } = loadRefreshState({ known: false, profileId: null, dataDir: null });
  assert.equal(flags.scopeUnavailable, true);
  assert.equal(state.version, 2);
  assert.throws(() => saveRefreshState({ known: false }, freshRefreshState(null)), /scope-unavailable/);
});
