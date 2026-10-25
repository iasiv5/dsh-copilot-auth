// know-how 031：package-lock 根版本字段必须与 package.json 同步（不同步不 tag）。
// 挂在 npm test 链上自动生效：ci.yml 三平台矩阵 + release.yml 发布链 + 本地发版预演，
// 漂移在任何 tag 推送之前就红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

test("lock 根版本同步：lock.version 与 lock.packages[''].version 均等于 package.json（know-how 031）", () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
});
