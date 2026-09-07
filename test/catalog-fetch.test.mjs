import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tgz } from "./helpers.mjs";
import { fetchLatestCatalog } from "../src/catalog-fetch.mjs";

const REGISTRY = "https://registry.npmjs.org";
const PKG_PATH = "/@earendil-works/pi-ai";
const TARBALL_URL = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz";
const ENTRY_PATH = "package/dist/providers/data/github-copilot.json";
const CATALOG = { "openai-completions": { "gpt-x": { id: "gpt-x", api: "openai-completions" } } };

function sha512integrity(buf) {
  return "sha512-" + createHash("sha512").update(buf).digest("base64");
}

// mock Response：body 为异步可迭代 + cancel 间谍；headers.get 可用
function mockRes({ status = 200, chunks = [], headers = {} }) {
  const state = { cancelled: false, yielded: 0 };
  const body = {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        state.yielded++;
        yield Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8");
      }
    },
    cancel: async () => {
      state.cancelled = true;
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body,
    state,
  };
}

function metadataBody(tarballUrl = TARBALL_URL, integrity = null, version = "0.85.1") {
  return JSON.stringify({
    "dist-tags": { latest: version },
    versions: { [version]: { dist: { tarball: tarballUrl, integrity } } },
  });
}

function goodTgz() {
  return tgz([{ name: ENTRY_PATH, content: JSON.stringify(CATALOG) }]);
}

// 标准双段 mock：metadata → tarball
function mockFetchStandard(tgzBuf) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === REGISTRY + PKG_PATH) {
      return mockRes({ chunks: [metadataBody(TARBALL_URL, sha512integrity(tgzBuf))] });
    }
    if (url === TARBALL_URL) return mockRes({ chunks: [tgzBuf] });
    throw new Error("unexpected fetch: " + url);
  };
  return { fetchImpl, calls };
}

test("正常路径：metadata → integrity 匹配 → 返回 { catalog, piAiVersion, integrity }，且每次调用 redirect:manual + signal", async () => {
  const buf = goodTgz();
  const { fetchImpl, calls } = mockFetchStandard(buf);
  const r = await fetchLatestCatalog({ registry: REGISTRY, fetchImpl });
  assert.deepEqual(r.catalog, CATALOG);
  assert.equal(r.piAiVersion, "0.85.1");
  assert.equal(r.integrity, sha512integrity(buf));
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.init.redirect, "manual", "每次 fetchImpl 调用都必须 redirect:manual");
    assert.ok(c.init.signal, "每次调用必须带 AbortSignal");
  }
});

test("metadata 非 200 / 非 JSON / 缺 dist-tags → 抛错", async () => {
  for (const meta of [
    mockRes({ status: 500 }),
    mockRes({ chunks: ["not json{{{"] }),
    mockRes({ chunks: [JSON.stringify({ versions: {} })] }),
  ]) {
    const fetchImpl = async () => meta;
    await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }));
  }
});

test("integrity 不匹配 → 抛错且不返回 catalog", async () => {
  const buf = goodTgz();
  const fetchImpl = async (url) => {
    if (url === REGISTRY + PKG_PATH) return mockRes({ chunks: [metadataBody(TARBALL_URL, "sha512-AAAAdeadbeef")] });
    return mockRes({ chunks: [buf] });
  };
  await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }), /integrity/);
});

test("tarball URL 信任：http 且 host≠registry → 抛错；http 同 host（企业镜像）→ 放行", async () => {
  const buf = goodTgz();
  // 跨主机 http → 拒绝
  const evil = "http://evil.example.com/x.tgz";
  let fetchImpl = async (url) =>
    url === REGISTRY + PKG_PATH
      ? mockRes({ chunks: [metadataBody(evil, sha512integrity(buf))] })
      : mockRes({ chunks: [buf] });
  await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }), /disallowed/);
  // 企业镜像：registry 为 http，tarball 同 host http → 放行
  const mirror = "http://npm.corp.local";
  const mirrorTarball = "http://npm.corp.local/pi-ai-0.85.1.tgz";
  fetchImpl = async (url) => {
    if (url === mirror + PKG_PATH) return mockRes({ chunks: [metadataBody(mirrorTarball, sha512integrity(buf))] });
    if (url === mirrorTarball) return mockRes({ chunks: [buf] });
    throw new Error("unexpected: " + url);
  };
  const r = await fetchLatestCatalog({ registry: mirror, fetchImpl });
  assert.deepEqual(r.catalog, CATALOG);
});

test("redirect：允许 URL → 非允许 host 的 30x → 抛错", async () => {
  const buf = goodTgz();
  const cdn = "https://cdn.npmjs.org/ok.tgz";
  const fetchImpl = async (url) => {
    if (url === REGISTRY + PKG_PATH) return mockRes({ chunks: [metadataBody(cdn, sha512integrity(buf))] });
    if (url === cdn) return mockRes({ status: 302, headers: { location: "http://evil.example.com/x" } });
    throw new Error("unexpected: " + url);
  };
  await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }), /disallowed/);
});

test("redirect：第 4 跳（超过上限 3）→ 抛错", async () => {
  const buf = goodTgz();
  // 5 个 URL = 4 次 302：第 4 次 redirect 响应即超限抛错（文件永远到不了 e）
  const chain = ["https://a.npmjs.org/1", "https://b.npmjs.org/2", "https://c.npmjs.org/3", "https://d.npmjs.org/4", "https://e.npmjs.org/5"];
  const fetchImpl = async (url) => {
    if (url === REGISTRY + PKG_PATH) return mockRes({ chunks: [metadataBody(chain[0], sha512integrity(buf))] });
    const i = chain.indexOf(url);
    if (i >= 0 && i < chain.length - 1) return mockRes({ status: 302, headers: { location: chain[i + 1] } });
    if (url === chain.at(-1)) return mockRes({ chunks: [buf] });
    throw new Error("unexpected: " + url);
  };
  await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }), /too many redirects/);
});

test("redirect：相对 Location 以当前 URL 解析，3 跳内可达", async () => {
  const buf = goodTgz();
  const start = "https://cdn.npmjs.org/a/b/c.tgz";
  const final = "https://cdn.npmjs.org/a/final.tgz";
  const fetchImpl = async (url) => {
    if (url === REGISTRY + PKG_PATH) return mockRes({ chunks: [metadataBody(start, sha512integrity(buf))] });
    if (url === start) return mockRes({ status: 302, headers: { location: "../final.tgz" } });
    if (url === final) return mockRes({ chunks: [buf] });
    throw new Error("unexpected: " + url);
  };
  const r = await fetchLatestCatalog({ registry: REGISTRY, fetchImpl });
  assert.deepEqual(r.catalog, CATALOG);
});

test("redirect：A→B→A 回环 → 抛错", async () => {
  const buf = goodTgz();
  const A = "https://a.npmjs.org/x";
  const B = "https://b.npmjs.org/y";
  const fetchImpl = async (url) => {
    if (url === REGISTRY + PKG_PATH) return mockRes({ chunks: [metadataBody(A, sha512integrity(buf))] });
    if (url === A) return mockRes({ status: 302, headers: { location: B } });
    if (url === B) return mockRes({ status: 302, headers: { location: A } });
    throw new Error("unexpected: " + url);
  };
  await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }), /loop/);
});

test("流式限额：metadata 超限即 cancel 且中途停读（Y3-1）", async () => {
  // 无 Content-Length 的分块响应，总 10 × 512B，cap 1024B → 读 3 块内必须抛错
  const chunk = Buffer.alloc(512, 65);
  let res;
  const fetchImpl = async () => {
    res = mockRes({ chunks: Array(10).fill(chunk) });
    return res;
  };
  await assert.rejects(
    fetchLatestCatalog({ registry: REGISTRY, fetchImpl, caps: { metadata: 1024 } }),
    /too large/,
  );
  assert.equal(res.state.cancelled, true, "超限必须 cancel body");
  assert.ok(res.state.yielded < 10, `必须中途停读（实际读了 ${res.state.yielded} 块）`);
});

test("流式限额：tgz 超限即 cancel 且中途停读（Y3-1）", async () => {
  const chunk = Buffer.alloc(512, 65);
  const meta = metadataBody(TARBALL_URL, "sha512-x");
  let res;
  const fetchImpl = async (url) => {
    if (url === REGISTRY + PKG_PATH) return mockRes({ chunks: [meta] });
    res = mockRes({ chunks: Array(10).fill(chunk) });
    return res;
  };
  await assert.rejects(
    fetchLatestCatalog({ registry: REGISTRY, fetchImpl, caps: { tarball: 1024 } }),
    /too large/,
  );
  assert.equal(res.state.cancelled, true);
  assert.ok(res.state.yielded < 10);
});

test("包膜结构校验：catalog 非对象 / section 非对象 → 抛错（逐条目校验不在本层）", async () => {
  for (const bad of [JSON.stringify(["array"]), JSON.stringify({ sec: "not-object" })]) {
    const buf = tgz([{ name: ENTRY_PATH, content: bad }]);
    const { fetchImpl } = mockFetchStandard(buf);
    await assert.rejects(fetchLatestCatalog({ registry: REGISTRY, fetchImpl }), /envelope/);
  }
  // 逐条目合法性不拦（唯一归 mergeCatalog）：条目明显缺字段也照常返回
  const buf = tgz([{ name: ENTRY_PATH, content: JSON.stringify({ "openai-completions": { x: { bogus: true } } }) }]);
  const { fetchImpl } = mockFetchStandard(buf);
  const r = await fetchLatestCatalog({ registry: REGISTRY, fetchImpl });
  assert.equal(r.catalog["openai-completions"].x.bogus, true);
});
