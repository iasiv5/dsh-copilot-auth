import { test } from "node:test";
import assert from "node:assert/strict";
import { initial, reduce, runEffect, advance } from "../src/refresh-flow.mjs";

// ---------- 夹具 ----------
const PREVIEW = {
  ok: true, source: "cache", catalogSource: "latest", catalogError: null,
  skipped: [], added: ["gpt-b"], removed: ["gpt-dead"], kept: ["gpt-a"], target: ["gpt-a", "gpt-b"],
  customizationReset: { modelEntryIds: [], modelOverrideIds: [] },
  digests: { settings: "s", available: "a", catalog: "c", remote: "r" },
};
const OVERLAY_PREVIEW = { ...PREVIEW, catalogSource: "overlay" };

function mockFetch(script) {
  // script: { [urlSuffix]: response | response[] }，response = { status, body }
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(script).find((k) => url.endsWith(k));
    if (!key) throw new Error("unexpected fetch: " + url);
    const entry = script[key];
    const res = Array.isArray(entry) ? entry[Math.min(calls.filter((c) => c.url.endsWith(key)).length - 1, entry.length - 1)] : entry;
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.body };
  };
  return { fetchImpl, calls };
}

const okJson = (body) => ({ status: 200, body });

// ---------- reducer 纯函数 ----------
test("reducer 正常流转：idle → previewing → confirming → applying → restartNeeded", () => {
  let [s, fx] = reduce(initial, { type: "start" });
  assert.equal(s.name, "previewing");
  assert.equal(s.mode, undefined);
  assert.deepEqual(fx, { type: "preview", mode: undefined });
  [s, fx] = reduce(s, { type: "preview-ok", preview: PREVIEW });
  assert.equal(s.name, "confirming");
  assert.equal(s.staleNotice, false);
  assert.equal(s.preview, PREVIEW);
  assert.equal(fx, null);
  [s, fx] = reduce(s, { type: "confirm" });
  assert.equal(s.name, "applying");
  assert.deepEqual(fx, { type: "apply", mode: undefined, digests: PREVIEW.digests });
  [s, fx] = reduce(s, { type: "apply-ok" });
  assert.equal(s.name, "restartNeeded");
  assert.equal(fx, null);
});

test("reducer：preview 失败 → failed；failed 可 dismiss 回 idle 或直接重来", () => {
  let [s] = reduce(initial, { type: "start" });
  [s] = reduce(s, { type: "preview-fail", error: "boom" });
  assert.deepEqual(s, { name: "failed", error: "boom" });
  let [s2, fx2] = reduce(s, { type: "dismiss" });
  assert.deepEqual(s2, initial);
  assert.equal(fx2, null);
  [s2, fx2] = reduce(s, { type: "start" });
  assert.equal(s2.name, "previewing");
  assert.ok(fx2);
});

test("reducer：apply 409 → previewing(stale, 原 mode) → confirming(staleNotice:true)", () => {
  let [s, fx] = reduce({ name: "applying", mode: "overlay", digests: PREVIEW.digests }, { type: "apply-stale" });
  assert.equal(s.name, "previewing");
  assert.equal(s.mode, "overlay", "409 后保持原 mode（R2-5）");
  assert.equal(s.stale, true);
  assert.deepEqual(fx, { type: "preview", mode: "overlay" });
  [s, fx] = reduce(s, { type: "preview-ok", preview: PREVIEW });
  assert.equal(s.name, "confirming");
  assert.equal(s.staleNotice, true, "UI 提示「数据已变化，请重新确认」");
  assert.equal(fx, null);
});

test("reducer：409 后重新 preview 也失败 → failed", () => {
  let [s, fx] = reduce({ name: "applying", mode: undefined, digests: {} }, { type: "apply-stale" });
  [s] = reduce(s, { type: "preview-fail", error: "still down" });
  assert.deepEqual(s, { name: "failed", error: "still down" });
});

test("reducer：apply 500 → failed；confirming 取消 → idle", () => {
  let [s] = reduce({ name: "applying", mode: undefined, digests: {} }, { type: "apply-fail", error: "server 500" });
  assert.deepEqual(s, { name: "failed", error: "server 500" });
  [s] = reduce({ name: "confirming", preview: PREVIEW, mode: undefined, staleNotice: false }, { type: "cancel" });
  assert.deepEqual(s, initial);
});

test("reducer：applying 态忽略重复 confirm/start（双击只发一次）", () => {
  const applying = { name: "applying", mode: undefined, digests: PREVIEW.digests };
  for (const ev of [{ type: "confirm" }, { type: "start" }]) {
    const [s, fx] = reduce(applying, ev);
    assert.equal(s, applying, "applying 态重复事件被忽略");
    assert.equal(fx, null);
  }
  const previewing = { name: "previewing", mode: undefined, stale: false };
  const [s2, fx2] = reduce(previewing, { type: "start" });
  assert.equal(s2, previewing);
  assert.equal(fx2, null);
});

test("reducer：confirming 态可改用 overlay 重 preview（R2-5 的 UI 入口）", () => {
  const confirming = { name: "confirming", preview: PREVIEW, mode: undefined, staleNotice: false };
  const [s, fx] = reduce(confirming, { type: "start", mode: "overlay" });
  assert.equal(s.name, "previewing");
  assert.equal(s.mode, "overlay");
  assert.deepEqual(fx, { type: "preview", mode: "overlay" });
});

test("reducer：confirming 保留 overlay 来源标记（preview.catalogSource）", () => {
  const [s] = reduce({ name: "previewing", mode: "overlay", stale: false }, { type: "preview-ok", preview: OVERLAY_PREVIEW });
  assert.equal(s.name, "confirming");
  assert.equal(s.preview.catalogSource, "overlay");
  assert.equal(s.mode, "overlay");
});

test("reducer：/status 水合——pendingRestart → restartNeeded；state-corrupt → failed；干净 → idle", () => {
  let [s, fx] = reduce(initial, { type: "init" });
  assert.equal(s.name, "idle");
  assert.deepEqual(fx, { type: "status" });
  [s] = reduce(initial, { type: "hydrate", status: { refresh: { pendingRestart: true } } });
  assert.equal(s.name, "restartNeeded");
  [s] = reduce(initial, { type: "hydrate", status: { refresh: { pendingRestart: false, lastError: "state-corrupt" } } });
  assert.deepEqual(s, { name: "failed", error: "state-corrupt" }, "state-corrupt 走专用文案（🟡-4）");
  [s] = reduce(initial, { type: "hydrate", status: { refresh: { pendingRestart: false, lastError: null } } });
  assert.equal(s.name, "idle");
  [s] = reduce(initial, { type: "hydrate", status: null }); // status 拉取失败不硬失败
  assert.equal(s.name, "idle");
});

// ---------- effect runner 接线（Y3-3） ----------
test("runner：latest 409 后以原 mode 重 preview 恰好一次，不重发 apply", async () => {
  const { fetchImpl, calls } = mockFetch({
    "/refresh/apply": { status: 409, body: { ok: false, error: "preview-stale" } },
    "/refresh/preview": okJson(PREVIEW),
  });
  // apply effect → apply-stale
  let ev = await runEffect({ type: "apply", mode: undefined, digests: PREVIEW.digests }, fetchImpl);
  assert.equal(ev.type, "apply-stale");
  // reducer 转 previewing + preview effect；runner 执行
  const [s, fx] = reduce({ name: "applying", mode: undefined, digests: PREVIEW.digests }, ev);
  ev = await runEffect(fx, fetchImpl);
  assert.equal(ev.type, "preview-ok");
  const applyCalls = calls.filter((c) => c.url.endsWith("/refresh/apply"));
  const previewCalls = calls.filter((c) => c.url.endsWith("/refresh/preview"));
  assert.equal(applyCalls.length, 1, "不重发 apply");
  assert.equal(previewCalls.length, 1, "恰好一次重 preview");
  assert.equal(JSON.parse(previewCalls[0].init.body).mode, undefined, "latest 模式 body 不带 mode");
});

test("runner：overlay 409 后仍以 overlay 重 preview", async () => {
  const { fetchImpl, calls } = mockFetch({
    "/refresh/apply": { status: 409, body: { ok: false, error: "preview-stale" } },
    "/refresh/preview": okJson(OVERLAY_PREVIEW),
  });
  const ev = await runEffect({ type: "apply", mode: "overlay", digests: PREVIEW.digests }, fetchImpl);
  const [, fx] = reduce({ name: "applying", mode: "overlay", digests: PREVIEW.digests }, ev);
  await runEffect(fx, fetchImpl);
  const previewCalls = calls.filter((c) => c.url.endsWith("/refresh/preview"));
  assert.equal(JSON.parse(previewCalls[0].init.body).mode, "overlay");
});

test("runner：重 preview 失败 → preview-fail（reducer → failed）", async () => {
  const { fetchImpl } = mockFetch({ "/refresh/preview": { status: 500, body: { ok: false, error: "npm down" } } });
  const ev = await runEffect({ type: "preview", mode: undefined }, fetchImpl);
  assert.deepEqual(ev, { type: "preview-fail", error: "npm down" });
  const [s] = reduce({ name: "previewing", mode: undefined, stale: true }, ev);
  assert.equal(s.name, "failed");
});

// ---------- controller advance 闭环（🟡-1） ----------
test("controller：overlay apply 409 → 保持 overlay → 只重 preview 一次 → confirming(staleNotice)", async () => {
  const { fetchImpl, calls } = mockFetch({
    "/refresh/preview": [okJson(OVERLAY_PREVIEW), okJson({ ...OVERLAY_PREVIEW, digests: { settings: "s2", available: "a", catalog: "c", remote: "r2" } })],
    "/refresh/apply": { status: 409, body: { ok: false, error: "preview-stale" } },
  });
  // 用户点刷新（overlay 来源由上一次 local preview 的按钮触发）
  let s = await advance(initial, { type: "start", mode: "overlay" }, fetchImpl);
  assert.equal(s.name, "confirming");
  assert.equal(s.staleNotice, false);
  // 用户确认 → apply 409 → 自动重 preview → confirming(staleNotice)
  s = await advance(s, { type: "confirm" }, fetchImpl);
  assert.equal(s.name, "confirming");
  assert.equal(s.staleNotice, true);
  assert.equal(s.preview.digests.settings, "s2", "新 diff 的 digest 组已更新");
  const seq = calls.map((c) => c.url.split("/copilot-auth/")[1]);
  assert.deepEqual(seq, ["refresh/preview", "refresh/apply", "refresh/preview"], "调用序列：preview → apply(409) → 一次重 preview");
  assert.equal(JSON.parse(calls[2].init.body).mode, "overlay");
});

test("controller：init 水合 /status pendingRestart → restartNeeded", async () => {
  const { fetchImpl } = mockFetch({ "/status": okJson({ configured: true, refresh: { pendingRestart: true } }) });
  const s = await advance(initial, { type: "init" }, fetchImpl);
  assert.equal(s.name, "restartNeeded");
});

test("controller：完整成功链路 advance 直通 restartNeeded", async () => {
  const { fetchImpl, calls } = mockFetch({
    "/refresh/preview": okJson(PREVIEW),
    "/refresh/apply": okJson({ ok: true, restartRequired: true }),
  });
  let s = await advance(initial, { type: "start" }, fetchImpl);
  s = await advance(s, { type: "confirm" }, fetchImpl);
  assert.equal(s.name, "restartNeeded");
  assert.equal(calls.length, 2);
});
