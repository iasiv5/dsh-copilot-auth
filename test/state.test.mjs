// state.mjs 测试——v1.2.8 起 v1 函数族已删除，本文件只保留
// 仍在生产的 restartMarker（v2 事务内核 restartState 构造器）。
// schema 2 读写层（损坏留存/隔离/未知版本拒绝）由 profile-isolation.test.mjs 覆盖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartMarker, RESTART_REASONS } from "../src/state.mjs";

test("restartMarker 形状：reason/expectedEntriesDigest/since", () => {
  const m = restartMarker("refresh", "deadbeef");
  assert.equal(m.reason, "refresh");
  assert.equal(m.expectedEntriesDigest, "deadbeef");
  assert.equal(typeof m.since, "string");
  assert.throws(() => restartMarker("bogus", "x"), /reason/);
  assert.deepEqual(RESTART_REASONS, ["refresh", "self-heal"]);
});
