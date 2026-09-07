window.__ModuleLoader__.load({
	id: "@inventec/dsh-copilot-auth",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");

// src/shared.mjs
var ROUTE_PREFIX = "/copilot-auth";
var routes = () => ({
  start: `${ROUTE_PREFIX}/start`,
  state: `${ROUTE_PREFIX}/state`,
  status: `${ROUTE_PREFIX}/status`,
  logout: `${ROUTE_PREFIX}/logout`,
  refreshPreview: `${ROUTE_PREFIX}/refresh/preview`,
  refreshApply: `${ROUTE_PREFIX}/refresh/apply`
});

// src/refresh-flow.mjs
var initial = Object.freeze({ name: "idle" });
function reduce(state, event) {
  switch (state.name) {
    case "idle":
    case "failed":
    case "restartNeeded": {
      if (event.type === "start") {
        return [{ name: "previewing", mode: event.mode, stale: false }, { type: "preview", mode: event.mode }];
      }
      if (state.name === "failed" && event.type === "dismiss") return [initial, null];
      if (state.name === "idle" && event.type === "init") return [state, { type: "status" }];
      if (event.type === "hydrate") {
        const refresh = event.status?.refresh;
        if (!event.status) return [state, null];
        if (refresh?.lastError === "state-corrupt") return [{ name: "failed", error: "state-corrupt" }, null];
        if (refresh?.pendingRestart === true) return [{ name: "restartNeeded" }, null];
        return state.name === "idle" ? [state, null] : [state, null];
      }
      return [state, null];
    }
    case "previewing": {
      if (event.type === "preview-ok") {
        return [{ name: "confirming", preview: event.preview, mode: state.mode, staleNotice: state.stale === true }, null];
      }
      if (event.type === "preview-fail") return [{ name: "failed", error: event.error }, null];
      return [state, null];
    }
    case "confirming": {
      if (event.type === "start") {
        return [{ name: "previewing", mode: event.mode, stale: false }, { type: "preview", mode: event.mode }];
      }
      if (event.type === "confirm") {
        return [
          { name: "applying", mode: state.mode, digests: state.preview.digests },
          { type: "apply", mode: state.mode, digests: state.preview.digests }
        ];
      }
      if (event.type === "cancel") return [initial, null];
      return [state, null];
    }
    case "applying": {
      if (event.type === "apply-ok") return [{ name: "restartNeeded" }, null];
      if (event.type === "apply-stale") {
        return [{ name: "previewing", mode: state.mode, stale: true }, { type: "preview", mode: state.mode }];
      }
      if (event.type === "apply-fail") return [{ name: "failed", error: event.error }, null];
      return [state, null];
    }
    default:
      return [state, null];
  }
}
async function runEffect(effect, fetchImpl) {
  const r = routes();
  const post = (url, body) => fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (effect.type === "preview") {
    try {
      const res = await post(r.refreshPreview, effect.mode ? { mode: effect.mode } : {});
      const body = await res.json();
      return res.status === 200 && body?.ok ? { type: "preview-ok", preview: body } : { type: "preview-fail", error: body?.error ?? `HTTP ${res.status}` };
    } catch (err) {
      return { type: "preview-fail", error: String(err?.message ?? err) };
    }
  }
  if (effect.type === "apply") {
    try {
      const res = await post(r.refreshApply, {
        digests: effect.digests,
        ...effect.mode ? { mode: effect.mode } : {}
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409) return { type: "apply-stale" };
      return res.status === 200 && body?.ok ? { type: "apply-ok" } : { type: "apply-fail", error: body?.error ?? `HTTP ${res.status}` };
    } catch (err) {
      return { type: "apply-fail", error: String(err?.message ?? err) };
    }
  }
  if (effect.type === "status") {
    try {
      const res = await fetchImpl(r.status);
      return { type: "hydrate", status: await res.json() };
    } catch {
      return { type: "hydrate", status: null };
    }
  }
  throw new Error(`unknown effect: ${effect.type}`);
}
async function advance(state, event, fetchImpl, onState) {
  let [s, fx] = reduce(state, event);
  onState?.(s);
  while (fx) {
    const resultEvent = await runEffect(fx, fetchImpl);
    [s, fx] = reduce(s, resultEvent);
    onState?.(s);
  }
  return s;
}

// src/client.jsx
var import_jsx_runtime = require("react/jsx-runtime");
var name = "copilot-auth-ui";
var inject = ["slots", "locale"];
var DICTS = {
  en: {
    nav: "GHC Settings",
    title: "GitHub Copilot Sign-in",
    intro: "Sign in to Copilot with your company GitHub account using the device code \u2014 no API token required.",
    idle: "Not signed in",
    running: "Signing in\u2026",
    authorized: "Signed in",
    failed: "Failed",
    loading: "\u2026",
    login: "Sign in",
    logout: "Sign out",
    codeHint: "Open the link below and enter this code to finish signing in:",
    copy: "Copy",
    copied: "Copied \u2713",
    unknown: "Unknown error",
    refreshNow: "Refresh model catalog",
    refreshTitle: "Refresh available model catalog",
    refreshDesc: "This pulls your account's available models and the latest pi-ai catalog data, then applies a data-level, add-only patch to the local catalog (pi-ai version stays unchanged). Review the diff before confirming.",
    riskRemoved: "Models no longer available to your account will DISAPPEAR from the model list after restart.",
    riskReset: "Your customizations (trimmed model list, per-model field tweaks, modelOverrides) will be RESET to the mirrored set.",
    riskRestart: "Takes effect only after a dsh web restart (two-phase: catalog patch now, settings sync on next boot).",
    addedModels: "New models",
    removedModels: "Removed (no longer available)",
    keptModels: "Kept",
    skippedModels: "Upstream entries skipped by validation",
    customReset: "These customizations will be reset:",
    customEntries: "field tweaks",
    customOverrides: "modelOverrides",
    confirmRefresh: "Confirm refresh",
    cancel: "Cancel",
    refreshing: "Fetching preview\u2026",
    applying: "Applying\u2026",
    restartNeeded: "Catalog patched. Restart dsh web to finish syncing the model list.",
    stalePreview: "Inputs changed \u2014 review the new diff",
    overlayBtn: "Preview with bundled overlay",
    stateCorrupt: "State file was corrupted and quarantined; auto self-heal is disabled \u2014 run a refresh to re-activate.",
    srcLive: "Account models: live fetch",
    srcCache: "Account models: credential cache (live fetch failed)",
    srcLatest: "Catalog source: latest pi-ai from npm",
    srcLocal: "Catalog source: local only (npm fetch failed)",
    srcOverlay: "Catalog source: bundled overlay (offline bootstrap)",
    none: "(none)"
  },
  zh: {
    nav: "GHC\u8BBE\u7F6E",
    title: "GitHub Copilot \u767B\u5F55",
    intro: "\u4F7F\u7528\u516C\u53F8 GitHub \u8D26\u53F7\u901A\u8FC7\u8BBE\u5907\u7801\u6388\u6743\u767B\u5F55 Copilot\uFF0C\u65E0\u9700\u586B\u5199 API Token\u3002",
    idle: "\u672A\u767B\u5F55",
    running: "\u8FDB\u884C\u4E2D\u2026",
    authorized: "\u5DF2\u767B\u5F55",
    failed: "\u5931\u8D25",
    loading: "\u2026",
    login: "\u767B\u5F55",
    logout: "\u6CE8\u9500",
    codeHint: "\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u4E0B\u9762\u7684\u94FE\u63A5\uFF0C\u8F93\u5165\u8FD9\u4E32\u4EE3\u7801\u5B8C\u6210\u6388\u6743\uFF1A",
    copy: "\u590D\u5236",
    copied: "\u5DF2\u590D\u5236 \u2713",
    unknown: "\u672A\u77E5\u9519\u8BEF",
    refreshNow: "\u5237\u65B0\u53EF\u7528\u6A21\u578B\u76EE\u5F55",
    refreshTitle: "\u5237\u65B0\u53EF\u7528\u6A21\u578B\u76EE\u5F55",
    refreshDesc: "\u5C06\u73B0\u573A\u62C9\u53D6\u8D26\u53F7\u53EF\u7528\u6A21\u578B\u4E0E\u6700\u65B0 pi-ai \u76EE\u5F55\u6570\u636E\uFF0C\u5BF9\u672C\u673A\u76EE\u5F55\u505A\u6570\u636E\u7EA7\u53EA\u589E\u8865\u4E01\uFF08pi-ai \u7248\u672C\u4E0D\u53D8\uFF09\u3002\u786E\u8BA4\u524D\u8BF7\u6838\u5BF9\u4E0B\u65B9\u5DEE\u5F02\u3002",
    riskRemoved: "\u5931\u6548\u6A21\u578B\uFF08\u8D26\u53F7\u5DF2\u4E0D\u518D\u53EF\u7528\u7684\u6A21\u578B\uFF09\u91CD\u542F\u540E\u5C06\u4ECE\u6A21\u578B\u5217\u8868\u6D88\u5931\u3002",
    riskReset: "\u4F60\u7684\u5B9A\u5236\uFF08\u7CBE\u7B80\u88C1\u526A\u3001\u6761\u76EE\u5B57\u6BB5\u5FAE\u8C03\u3001modelOverrides\uFF09\u5C06\u88AB\u91CD\u7F6E\u4E3A\u955C\u50CF\u96C6\u5408\u3002",
    riskRestart: "\u9700\u91CD\u542F dsh web \u540E\u751F\u6548\uFF08\u4E24\u9636\u6BB5\uFF1A\u73B0\u5728\u5199\u76EE\u5F55\u8865\u4E01\uFF0C\u4E0B\u4E2A boot \u540C\u6B65 settings\uFF09\u3002",
    addedModels: "\u65B0\u589E\u6A21\u578B",
    removedModels: "\u79FB\u9664\uFF08\u5DF2\u5931\u6548\uFF09",
    keptModels: "\u4FDD\u7559",
    skippedModels: "\u88AB\u6821\u9A8C\u8DF3\u8FC7\u7684\u4E0A\u6E38\u6761\u76EE",
    customReset: "\u4EE5\u4E0B\u5B9A\u5236\u5C06\u88AB\u91CD\u7F6E\uFF1A",
    customEntries: "\u5B57\u6BB5\u5FAE\u8C03",
    customOverrides: "modelOverrides",
    confirmRefresh: "\u786E\u8BA4\u5237\u65B0",
    cancel: "\u53D6\u6D88",
    refreshing: "\u62C9\u53D6\u9884\u89C8\u4E2D\u2026",
    applying: "\u5E94\u7528\u4E2D\u2026",
    restartNeeded: "\u76EE\u5F55\u8865\u4E01\u5DF2\u5199\u5165\u3002\u91CD\u542F dsh web \u540E\u5B8C\u6210\u6A21\u578B\u5217\u8868\u540C\u6B65\u3002",
    stalePreview: "\u6570\u636E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u786E\u8BA4\u5DEE\u5F02",
    overlayBtn: "\u6539\u7528\u5185\u7F6E\u8986\u76D6\u5C42\u9884\u89C8",
    stateCorrupt: "\u72B6\u6001\u6587\u4EF6\u5DF2\u635F\u574F\u5E76\u88AB\u9694\u79BB\uFF1B\u81EA\u52A8\u81EA\u6108\u5DF2\u505C\u7528\uFF0C\u8BF7\u91CD\u65B0\u6267\u884C\u4E00\u6B21\u5237\u65B0\u4EE5\u6FC0\u6D3B\u3002",
    srcLive: "\u8D26\u53F7\u6A21\u578B\uFF1A\u73B0\u573A\u62C9\u53D6",
    srcCache: "\u8D26\u53F7\u6A21\u578B\uFF1A\u51ED\u8BC1\u7F13\u5B58\uFF08\u73B0\u573A\u62C9\u53D6\u5931\u8D25\uFF09",
    srcLatest: "\u76EE\u5F55\u6765\u6E90\uFF1Anpm \u6700\u65B0 pi-ai",
    srcLocal: "\u76EE\u5F55\u6765\u6E90\uFF1A\u4EC5\u672C\u5730\u76EE\u5F55\uFF08npm \u62C9\u53D6\u5931\u8D25\uFF09",
    srcOverlay: "\u76EE\u5F55\u6765\u6E90\uFF1A\u5185\u7F6E\u8986\u76D6\u5C42\uFF08\u79BB\u7EBF bootstrap\uFF09",
    none: "\uFF08\u65E0\uFF09"
  }
};
var NAV_TEXTS = Object.keys(DICTS).map((locale) => DICTS[locale].nav);
var COPILOT_ICON_SVG = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="flex:none"><path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"/><path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/></svg>';
function enforceNavIcon(labelText) {
  if (!labelText) return;
  for (const cell of document.querySelectorAll("button")) {
    const spans = cell.querySelectorAll("span");
    const labelSpan = spans[spans.length - 1];
    if (!labelSpan || labelSpan.textContent !== labelText) continue;
    if (cell.dataset.copilotIcon === "1") continue;
    const gear = cell.querySelector("svg");
    if (!gear) continue;
    gear.style.display = "none";
    const holder = document.createElement("span");
    holder.innerHTML = COPILOT_ICON_SVG;
    const svg = holder.firstElementChild;
    const cls = gear.className && typeof gear.className === "object" ? gear.className.baseVal : gear.className;
    if (cls) svg.setAttribute("class", cls);
    cell.dataset.copilotIcon = "1";
    gear.after(svg);
  }
}
function startNavIconEnforcer(getLabelText) {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  let queued = false;
  const run = () => {
    queued = false;
    try {
      enforceNavIcon(getLabelText());
    } catch {
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}
var styles = {
  section: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 12, fontFamily: "inherit" },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" },
  intro: { margin: 0, fontSize: 14, lineHeight: "22px", opacity: 0.75 },
  badgeRow: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  badge: { fontSize: 12, lineHeight: "18px" },
  button: {
    height: 32,
    padding: "0 14px",
    fontSize: 14,
    borderRadius: 16,
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit"
  },
  primary: { background: "#4c6ef5", color: "#fff" },
  secondary: { background: "transparent", color: "inherit", border: "1px solid currentColor", opacity: 0.8 },
  card: {
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: 12,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10
  },
  codeHint: { margin: 0, fontSize: 13, lineHeight: "20px", opacity: 0.85 },
  codeRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  code: { fontSize: 24, fontWeight: 700, letterSpacing: 2, fontVariantNumeric: "tabular-nums" },
  link: { fontSize: 13, color: "#4c6ef5" },
  error: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#e03131" },
  banner: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#f59f00" },
  modalMask: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    zIndex: 1e3,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24
  },
  modal: {
    background: "var(--dsh-bg, #fff)",
    color: "inherit",
    borderRadius: 12,
    maxWidth: 560,
    width: "100%",
    maxHeight: "80vh",
    overflowY: "auto",
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)"
  },
  modalTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  modalText: { margin: 0, fontSize: 13, lineHeight: "20px", opacity: 0.85 },
  diffList: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "20px" },
  added: { color: "#37b24d" },
  removed: { color: "#e03131" },
  skipped: { color: "#f59f00" },
  risk: { margin: 0, fontSize: 12, lineHeight: "18px", color: "#e8590c" },
  modalActions: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 },
  mono: { fontFamily: "ui-monospace, monospace" }
};
var badgeColor = { idle: "#adb5bd", running: "#f59f00", authorized: "#37b24d", failed: "#e03131", loading: "#adb5bd" };
function RefreshModal({ t, flow, onConfirm, onCancel, onOverlay }) {
  const p = flow.preview;
  const sourceKeys = [
    p.source === "live" ? "srcLive" : "srcCache",
    p.catalogSource === "latest" ? "srcLatest" : p.catalogSource === "overlay" ? "srcOverlay" : "srcLocal"
  ];
  const list = (ids, style) => ids.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.6 }, children: t("none") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: styles.diffList, children: ids.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { style: { ...style, ...styles.mono }, children: id }, id)) });
  const resets = [
    ...p.customizationReset.modelEntryIds.map((id) => `${id} (${t("customEntries")})`),
    ...p.customizationReset.modelOverrideIds.map((id) => `${id} (${t("customOverrides")})`)
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.modalMask, role: "dialog", "aria-modal": "true", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.modal, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h4", { style: styles.modalTitle, children: t("refreshTitle") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: t("refreshDesc") }),
    flow.staleNotice && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
      "\u26A0 ",
      t("stalePreview")
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: sourceKeys.map((k) => t(k)).join(" \xB7 ") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.modalText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("addedModels") }),
      "\uFF08",
      p.added.length,
      "\uFF09"
    ] }),
    list(p.added, styles.added),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.modalText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("removedModels") }),
      "\uFF08",
      p.removed.length,
      "\uFF09"
    ] }),
    list(p.removed, styles.removed),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.modalText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("keptModels") }),
      "\uFF08",
      p.kept.length,
      "\uFF09"
    ] }),
    p.skipped.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.modalText, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("skippedModels") }),
        "\uFF08",
        p.skipped.length,
        "\uFF09"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: styles.diffList, children: p.skipped.map((s) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { style: styles.skipped, children: [
        s.id,
        " \u2014 ",
        s.reason
      ] }, s.id)) })
    ] }),
    resets.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.modalText, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("customReset") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { style: styles.diffList, children: resets.map((x) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { style: styles.skipped, children: x }, x)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
      "\u26A0 ",
      t("riskRemoved")
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
      "\u26A0 ",
      t("riskReset")
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.risk, children: [
      "\u26A0 ",
      t("riskRestart")
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.modalActions, children: [
      p.catalogSource === "local" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary, marginRight: "auto" }, onClick: onOverlay, children: t("overlayBtn") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: onCancel, children: t("cancel") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary }, onClick: onConfirm, children: t("confirmRefresh") })
    ] })
  ] }) });
}
function CopilotSection({ t = (key) => DICTS.en[key] ?? key }) {
  const [page, setPage] = (0, import_react.useState)("loading");
  const [notices, setNotices] = (0, import_react.useState)([]);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [copied, setCopied] = (0, import_react.useState)(false);
  const timer = (0, import_react.useRef)(null);
  const [flow, setFlow] = (0, import_react.useState)(initial);
  const flowRef = (0, import_react.useRef)(flow);
  const drive = (event) => advance(flowRef.current, event, fetch, (next) => {
    flowRef.current = next;
    setFlow(next);
  }).catch(() => {
  });
  (0, import_react.useEffect)(() => {
    drive({ type: "init" });
  }, []);
  (0, import_react.useEffect)(() => {
    let alive = true;
    fetch("/copilot-auth/status").then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (d.configured) {
        setPage("authorized");
        return;
      }
      fetch("/copilot-auth/state").then((r) => r.json()).then((s) => {
        if (!alive) return;
        setNotices(s.notices ?? []);
        if (s.status === "failed") {
          setPage("failed");
          setError(s.error ?? t("unknown"));
        } else if (s.status === "running") {
          setPage("running");
          poll();
        } else {
          setPage("idle");
        }
      }).catch(() => {
        if (alive) setPage("idle");
      });
    }).catch(() => {
      if (alive) setPage("idle");
    });
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);
  const poll = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      fetch("/copilot-auth/state").then((r) => r.json()).then((s) => {
        setNotices(s.notices ?? []);
        if (s.status !== "running") {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
          if (s.status === "authorized") {
            setPage("authorized");
          } else {
            setPage("failed");
            setError(s.error ?? t("unknown"));
          }
        }
      }).catch(() => {
      });
    }, 1e3);
  };
  const login = () => {
    setCopied(false);
    setError(void 0);
    setNotices([]);
    fetch("/copilot-auth/start", { method: "POST" }).catch(() => {
    });
    setPage("running");
    poll();
  };
  const logout = async () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    try {
      await fetch("/copilot-auth/logout", { method: "POST" });
    } catch {
    }
    setNotices([]);
    setError(void 0);
    setPage("idle");
  };
  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2e3);
    } catch {
    }
  };
  const codeNotice = [...notices].reverse().find((n) => n && typeof n.code === "string" && n.code !== "");
  const badgeText = page === "loading" ? t("loading") : t(page);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: styles.title, children: t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: t("intro") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.badgeRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.dot, background: badgeColor[page] ?? "#adb5bd" } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.badge, children: badgeText })
    ] }),
    page === "running" && codeNotice && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.codeHint, children: t("codeHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.codeRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.code, children: codeNotice.code }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: () => copyCode(codeNotice.code), children: copied ? t("copied") : t("copy") })
      ] }),
      codeNotice.url && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { style: styles.link, href: codeNotice.url, target: "_blank", rel: "noreferrer", children: codeNotice.url })
    ] }),
    page === "failed" && error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: error }),
    page === "authorized" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: logout, children: t("logout") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: { ...styles.button, ...styles.primary },
          disabled: flow.name === "previewing" || flow.name === "applying",
          onClick: () => drive({ type: "start" }),
          children: flow.name === "previewing" ? t("refreshing") : flow.name === "applying" ? t("applying") : t("refreshNow")
        }
      )
    ] }),
    page === "authorized" && flow.name === "restartNeeded" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.banner, children: [
      "\u26A0 ",
      t("restartNeeded")
    ] }),
    page === "authorized" && flow.name === "failed" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: flow.error === "state-corrupt" ? t("stateCorrupt") : flow.error }),
    flow.name === "confirming" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      RefreshModal,
      {
        t,
        flow,
        onConfirm: () => drive({ type: "confirm" }),
        onCancel: () => drive({ type: "cancel" }),
        onOverlay: () => drive({ type: "start", mode: "overlay" })
      }
    ),
    (page === "idle" || page === "failed") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary }, onClick: login, children: t("login") }) })
  ] });
}
function apply(ctx) {
  ctx.locale.register("copilot-auth", DICTS);
  const t = ctx.locale.bind("copilot-auth");
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "copilot", order: 11, label: () => t("nav"), inject: () => ({ t }) },
    CopilotSection
  ));
  startNavIconEnforcer(() => t("nav"));
}

		return module.exports;
	}
});
