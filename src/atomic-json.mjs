// atomic-json.mjs — 所有 JSON 写盘的唯一通道。
// writeJsonAtomic: 同目录 temp（wx 排他创建）→ writeAll → fsyncFile → 重读 parse 校验
// → rename → fsyncDirectory（win32 无目录 fsync 语义直接跳过，issue #1；其余失败仅此处降级 warn）。rename 前任何失败清理 temp 并抛错，
// 原文件不动。第三参为语义 adapter 的部分覆盖（未覆盖键回落默认实现），供故障注入测试。
import { randomUUID } from "node:crypto";
import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function readJson(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(raw);
}

// 短写循环补写；writeChunk 返回 <= 0 或非整数抛错防死循环（R4-2）。
export function writeAll(fd, buffer, writeChunk = writeSync) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeChunk(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("write made no progress");
    }
    offset += written;
  }
}

// 目录 fsync 是 POSIX 惯用法（open 目录句柄 + fsync，保目录项落盘）。
// Windows 无目录 fsync 语义：对目录句柄 fsyncSync 必然 EPERM（libuv FlushFileBuffers
// 对目录句柄拒绝，issue #1）——win32 直接跳过，NTFS 元数据日志已保证 rename 后
// 的目录项一致性；POSIX 平台行为不变。具名导出仅供测试观察平台分支。
export function fsyncDirectory(dir) {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const defaultFs = {
  openTemp: (path) => openSync(path, "wx"),
  writeAll: (fd, buf) => writeAll(fd, buf),
  fsyncFile: (fd) => fsyncSync(fd),
  closeFd: (fd) => closeSync(fd),
  rename: (from, to) => renameSync(from, to),
  fsyncDirectory,
  remove: (path) => unlinkSync(path),
};

export function writeJsonAtomic(path, obj, fs = {}) {
  const a = { ...defaultFs, ...fs };
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.tmp-${randomUUID()}`);
  const payload = Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf8");
  let fd;
  try {
    fd = a.openTemp(tempPath);
    a.writeAll(fd, payload);
    a.fsyncFile(fd);
    a.closeFd(fd);
    fd = undefined;
    JSON.parse(readFileSync(tempPath, "utf8")); // 提交前重读校验，坏内容不过 rename
    a.rename(tempPath, path);
  } catch (err) {
    if (fd !== undefined) {
      try { a.closeFd(fd); } catch { /* 清理失败不掩盖原始错误 */ }
    }
    try { a.remove(tempPath); } catch { /* temp 可能尚未创建 */ }
    throw err;
  }
  try {
    a.fsyncDirectory(dir);
  } catch (err) {
    // 目录项落盘失败仅降级告警：rename 已生效，语义如实成文（R3-7 ⑤）
    console.warn(`[copilot-auth] fsyncDirectory failed for ${dir}: ${err}`);
  }
}

// settled-tail mutex：回调拒绝后不中毒，后续任务仍串行执行（Y2-4）。
// 仅提供宿主单进程内互斥，不支持多实例/多进程并发（见 README 已知边界）。
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}
