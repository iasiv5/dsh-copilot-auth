import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, writeAll, createMutex } from "../src/atomic-json.mjs";

test("readJson：缺失→undefined；坏 JSON→抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "aj-"));
  assert.equal(readJson(join(dir, "x.json")), undefined);
  writeFileSync(join(dir, "bad.json"), "{");
  assert.throws(() => readJson(join(dir, "bad.json")));
});

test("writeJsonAtomic：写入完整可读，临时文件不残留", () => {
  const dir = mkdtempSync(join(tmpdir(), "aj-"));
  const f = join(dir, "a.json");
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(readJson(f), { a: 1 });
  assert.deepEqual(readdirSync(dir).filter((n) => n !== "a.json"), []);
});

test("writeJsonAtomic：语义 fs adapter 五故障点（R3-7）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aj-"));
  const f = join(dir, "a.json");
  writeJsonAtomic(f, { old: true });
  // adapter 形状：{ openTemp(path), writeAll(fd,buf), fsyncFile(fd), closeFd(fd), rename(a,b), fsyncDirectory(dir), remove(path) }
  // ① writeAll 抛错 → 抛错，原文件不变，无 temp 残留
  assert.throws(() => writeJsonAtomic(f, { new: 1 }, { writeAll: () => { throw new Error("disk full"); } }));
  assert.deepEqual(readJson(f), { old: true });
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
  // ③ fsyncFile 抛错 → 抛错，原文件不变
  assert.throws(() => writeJsonAtomic(f, { new: 1 }, { fsyncFile: () => { throw new Error("fsync"); } }));
  assert.deepEqual(readJson(f), { old: true });
  // ④ rename 抛错 → 抛错，原文件不变
  assert.throws(() => writeJsonAtomic(f, { new: 1 }, { rename: () => { throw new Error("rename"); } }));
  assert.deepEqual(readJson(f), { old: true });
  // ⑤ fsyncDirectory 抛错 → 不抛（降级 warn），新值已提交——语义如实成文
  writeJsonAtomic(f, { new: 2 }, { fsyncDirectory: () => { throw new Error("dirfsync"); } });
  assert.deepEqual(readJson(f), { new: 2 });
});

test("writeAll：短写循环补写 + 零进度防死循环（R4-2，方案 A：writeAll 导出、writeChunk 可注入）", () => {
  // writeAll(fd, buffer, writeChunk = fs.writeSync)
  const buf = Buffer.from("0123456789");
  let calls = 0;
  writeAll(1, buf, (fd, b, off, len) => { calls++; return Math.ceil(len / 2); }); // 每次只写一半
  assert.ok(calls >= 2, "短写被循环补写");
  assert.throws(() => writeAll(1, buf, () => 0), /no progress/, "writeChunk 返回 0 必须抛错防死循环");
});

test("mutex：并发串行，且回调拒绝后不中毒（Y2-4）", async () => {
  const mutex = createMutex();
  const order = [];
  await assert.rejects(mutex(async () => { order.push(1); throw new Error("boom"); }));
  await mutex(async () => { order.push(2); });
  assert.deepEqual(order, [1, 2], "reject 后后续任务仍执行");
});
