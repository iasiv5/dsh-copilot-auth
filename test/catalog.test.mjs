import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { tgz, tar } from "./helpers.mjs";
import {
  SUPPORTED_APIS, extractTgzEntry, validateCatalog, mergeCatalog,
  diffModels, digest, findPiAiInstallation, isAsarPath, probeWritable, classifyCatalogTarget,
} from "../src/catalog.mjs";

const ENTRY_PATH = "package/dist/providers/data/github-copilot.json";

function entry(id, api = "openai-completions", extra = {}) {
  return { id, api, provider: "github-copilot", contextWindow: 100000, maxTokens: 4096, ...extra };
}

test("SUPPORTED_APIS：三种 wire 协议", () => {
  assert.deepEqual([...SUPPORTED_APIS].sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
});

test("extractTgzEntry：正常提取目标条目", () => {
  const payload = JSON.stringify({ "openai-completions": { "gpt-a": entry("gpt-a") } });
  const buf = tgz([
    { name: "package/package.json", content: "{}" },
    { name: ENTRY_PATH, content: payload },
  ]);
  assert.equal(extractTgzEntry(buf).toString("utf8"), payload);
});

test("extractTgzEntry：路径精确匹配，xpackage/ 前缀不误判", () => {
  const buf = tgz([{ name: "x" + ENTRY_PATH, content: "{}" }]);
  assert.throws(() => extractTgzEntry(buf), /not found/);
});

test("extractTgzEntry：同一目标出现两次 → 抛错", () => {
  const buf = tgz([
    { name: ENTRY_PATH, content: "{}" },
    { name: ENTRY_PATH, content: "{}" },
  ]);
  assert.throws(() => extractTgzEntry(buf), /duplicate/);
});

test("extractTgzEntry：截断 tar → 抛错", () => {
  // 内容 1000 字节：header(512) + content(1000→1024) + 零块(1024) = 2560；
  // 截进 content 区（1500 < 512+1000），声明尺寸越界即抛错
  const full = tar([{ name: ENTRY_PATH, content: Buffer.alloc(1000, 65) }]);
  const truncated = gzipSync(full.subarray(0, 1500));
  assert.throws(() => extractTgzEntry(truncated), /truncated/);
});

test("extractTgzEntry：maxBytes 超限 → 语义词错误（gunzip maxOutputLength 落地）", () => {
  const buf = tgz([{ name: ENTRY_PATH, content: "{}" }]); // 解压后 tar 至少 2048 字节
  assert.throws(() => extractTgzEntry(buf, { maxBytes: 600 }), /too large/);
});

test("validateCatalog：五类违法各返回原因字符串；合法条目 → true", () => {
  const good = entry("m");
  assert.equal(validateCatalog("openai-completions", "m", good), true);
  // ① api 非白名单
  assert.equal(typeof validateCatalog("mystery-api", "m", entry("m", "mystery-api")), "string");
  // ② key ≠ entry.id
  assert.equal(typeof validateCatalog("openai-completions", "a", entry("b")), "string");
  // ③ entry.api ≠ section
  assert.equal(typeof validateCatalog("openai-completions", "m", entry("m", "anthropic-messages")), "string");
  // ④ provider ≠ github-copilot
  assert.equal(typeof validateCatalog("openai-completions", "m", entry("m", "openai-completions", { provider: "openai" })), "string");
  // ⑤ 数值字段非正数
  assert.equal(typeof validateCatalog("openai-completions", "m", entry("m", "openai-completions", { contextWindow: 0 })), "string");
  assert.equal(typeof validateCatalog("openai-completions", "m", entry("m", "openai-completions", { maxTokens: -1 })), "string");
});

test("mergeCatalog：只增不更新（已有 id 元数据变化不覆盖）+ 幂等", () => {
  const local = { "openai-completions": { "gpt-a": entry("gpt-a", "openai-completions", { contextWindow: 111 }) } };
  const remote = {
    "openai-completions": {
      "gpt-a": entry("gpt-a", "openai-completions", { contextWindow: 999 }), // 已有 id：不更新
      "gpt-b": entry("gpt-b"),
    },
  };
  const first = mergeCatalog(local, remote);
  assert.equal(first.merged["openai-completions"]["gpt-a"].contextWindow, 111, "已有 id 不被覆盖");
  assert.deepEqual(first.added, [{ id: "gpt-b", api: "openai-completions" }]);
  const second = mergeCatalog(first.merged, remote);
  assert.deepEqual(second.added, [], "二次合并 added 为空");
  assert.deepEqual(second.addedOverlay, {}, "二次合并 addedOverlay 为空对象");
});

test("mergeCatalog：白名单过滤，非法条目进 skipped 且带原因", () => {
  const remote = { "mystery-api": { m1: entry("m1", "mystery-api") } };
  const r = mergeCatalog({}, remote);
  assert.deepEqual(r.merged, {});
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].id, "m1");
  assert.equal(typeof r.skipped[0].reason, "string");
});

test("mergeCatalog：addedOverlay 契约（R4-1）——catalog-shaped 且仅含本次合法新增", () => {
  const flash = entry("gemini-3.8-flash", "openai-completions", { contextWindow: 1000000 });
  const local = { "openai-completions": { "gpt-a": entry("gpt-a") } };
  const remote = {
    "openai-completions": {
      "gemini-3.8-flash": flash,
      "gpt-a": entry("gpt-a", "openai-completions", { contextWindow: 222 }), // 已有 id 不入
      bad: entry("bad", "openai-completions", { provider: "openai" }), // 非法不入
    },
  };
  const result = mergeCatalog(local, remote);
  assert.deepEqual(result.addedOverlay, { "openai-completions": { "gemini-3.8-flash": flash } });
  assert.deepEqual(result.skipped.map((s) => s.id), ["bad"]);
});

test("diffModels：available 但目录不可解析的当前模型必须进 removed（R3）", () => {
  const d = diffModels(["gpt-a", "ghost"], ["gpt-a", "ghost"], new Set(["gpt-a"]));
  assert.deepEqual(d.target, ["gpt-a"]);
  assert.deepEqual(d.removed.sort(), ["ghost"]);
  // 不变量：kept∪removed=current、kept∪added=target、三者两两互斥
  const u = (a, b) => [...new Set([...a, ...b])].sort();
  assert.deepEqual(u(d.kept, d.removed), ["ghost", "gpt-a"].sort());
  assert.deepEqual(u(d.kept, d.added), d.target.slice().sort());
});

test("diffModels：empty target 是合法结果（Y1）", () => {
  const d = diffModels(["gpt-dead"], [], new Set());
  assert.deepEqual(d, { target: [], added: [], removed: ["gpt-dead"], kept: [] });
});

test("digest：键序无关；undefined 与缺失键有别；空数组与空对象有别", () => {
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }), "canonical 递归键排序");
  assert.notEqual(digest({ a: undefined }), digest({}), "undefined 与键缺失必须产生不同 digest");
  assert.notEqual(digest([]), digest({}), "空数组与空对象必须产生不同 digest");
  assert.equal(digest(Buffer.from("ab")), digest("ab"), "字节与等价字符串一致");
});

test("findPiAiInstallation：catalogFile/packageJsonFile/version 同根解析", () => {
  const dir = mkdtempSync(join(tmpdir(), "piai-"));
  const root = join(dir, "node_modules", "@earendil-works", "pi-ai");
  mkdirSync(join(root, "dist", "providers", "data"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version: "0.84.4" }));
  writeFileSync(join(root, "dist", "providers", "data", "github-copilot.json"), "{}");
  const nested = join(dir, "some", "deep", "dir");
  mkdirSync(nested, { recursive: true });
  const found = findPiAiInstallation({ startPath: nested });
  assert.equal(found.version, "0.84.4");
  assert.equal(found.catalogFile, join(root, "dist", "providers", "data", "github-copilot.json"));
  assert.equal(found.packageJsonFile, join(root, "package.json"));
  // 不存在 → null
  const empty = mkdtempSync(join(tmpdir(), "piai-empty-"));
  assert.equal(findPiAiInstallation({ startPath: empty }), null);
});

// ==================== 安装目标可写性分类（ADR 0002：desktop asar 只读目标） ====================

test("isAsarPath：段尾 .asar 判定（大小写不敏感，/ 与 \\ 都认），.asar.unpacked 不误判", () => {
  assert.equal(isAsarPath(String.raw`C:\Users\x\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@earendil-works\pi-ai\dist\providers\data\github-copilot.json`), true, "win 路径（实机报错形态）");
  assert.equal(isAsarPath("/opt/dsh/resources/app.asar/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/github-copilot.json"), true, "posix 路径");
  assert.equal(isAsarPath("/opt/resources/APP.ASAR/x.json"), true, "大小写不敏感");
  assert.equal(isAsarPath("/opt/resources/app.asar"), true, "整段即归档");
  assert.equal(isAsarPath(String.raw`D:\data\app.asar.unpacked\dsh\x.json`), false, ".asar.unpacked 以 unpacked 结尾，不匹配");
  assert.equal(isAsarPath("/opt/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/github-copilot.json"), false, "普通磁盘路径");
  assert.equal(isAsarPath(""), false);
  assert.equal(isAsarPath(undefined), false);
});

test("probeWritable：真实目录 true，不存在目录 false", () => {
  assert.equal(probeWritable(mkdtempSync(join(tmpdir(), "probe-"))), true);
  assert.equal(probeWritable(join(tmpdir(), "probe-not-exist")), false);
});

test("classifyCatalogTarget：asar 短路不触盘；普通目录经探测；probe 注入钩子生效", () => {
  const asar = classifyCatalogTarget(String.raw`C:\x\app.asar\dsh\node_modules\@earendil-works\pi-ai\dist\providers\data\github-copilot.json`);
  assert.deepEqual(asar, { writable: false, unwritableReason: "asar" });
  const real = join(mkdtempSync(join(tmpdir(), "cls-")), "github-copilot.json");
  assert.deepEqual(classifyCatalogTarget(real), { writable: true, unwritableReason: null });
  assert.deepEqual(classifyCatalogTarget(real, () => false), { writable: false, unwritableReason: "probe-failed" }, "probe 注入（只读卷/ACL 形态）");
});
