// T2：resolveRuntimeScope 稳定 profile 身份与私有 dataDir。
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveRuntimeScope } from "../src/runtime-scope.mjs";

test("已知 profileContext → known=true，profileId 为 16 位 hex，dataDir 位于 profile 私有目录", () => {
  const ctx = { profileContext: { name: "web", dir: "/dsh/profiles/web", home: "/dsh" } };
  const s = resolveRuntimeScope(ctx);
  assert.equal(s.known, true);
  assert.match(s.profileId, /^[0-9a-f]{16}$/);
  // 期望值用 join 生成（Windows 下分隔符为反斜杠，硬编码 POSIX 斜杠会误报）
  assert.equal(s.dataDir, join("/dsh/profiles/web", "copilot-auth"));
  // 前缀断言同样须经 join 规范化（输入正斜杠在 win32 会被 join 改写为反斜杠）
  assert.ok(s.dataDir.startsWith(join(ctx.profileContext.dir)), "dataDir 必须落在 profile 私有目录内");
});

test("同 dir 不同 name → 不同 profileId", () => {
  const a = resolveRuntimeScope({ profileContext: { name: "a", dir: "/dsh/profiles/a", home: "/dsh" } });
  const b = resolveRuntimeScope({ profileContext: { name: "b", dir: "/dsh/profiles/a", home: "/dsh" } });
  assert.notEqual(a.profileId, b.profileId);
});

test("缺 profileContext / 形状非法 → known=false + reason，禁写", () => {
  assert.equal(resolveRuntimeScope({}).known, false);
  assert.equal(resolveRuntimeScope(undefined).known, false);
  const bad = resolveRuntimeScope({ profileContext: { name: 1, dir: "/x" } });
  assert.equal(bad.known, false);
  assert.equal(typeof bad.reason, "string");
  assert.equal(resolveRuntimeScope({ profileContext: { name: "a", dir: "" } }).known, false);
});

test("不同 profile 的 dataDir 互不包含（禁用共享 home）", () => {
  const a = resolveRuntimeScope({ profileContext: { name: "a", dir: "/dsh/profiles/a", home: "/dsh" } });
  const b = resolveRuntimeScope({ profileContext: { name: "b", dir: "/dsh/profiles/b", home: "/dsh" } });
  assert.ok(!a.dataDir.includes(b.dataDir));
  assert.ok(!b.dataDir.includes(a.dataDir));
});

test("相同 name+dir 跨调用稳定；不写盘", () => {
  const ctx = { profileContext: { name: "web", dir: "/dsh/profiles/web" } };
  assert.deepEqual(resolveRuntimeScope(ctx), resolveRuntimeScope(ctx));
});
