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
    unknown: "Unknown error"
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
    unknown: "\u672A\u77E5\u9519\u8BEF"
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
  error: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#e03131" }
};
var badgeColor = { idle: "#adb5bd", running: "#f59f00", authorized: "#37b24d", failed: "#e03131", loading: "#adb5bd" };
function CopilotSection({ t = (key) => DICTS.en[key] ?? key }) {
  const [page, setPage] = (0, import_react.useState)("loading");
  const [notices, setNotices] = (0, import_react.useState)([]);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [copied, setCopied] = (0, import_react.useState)(false);
  const timer = (0, import_react.useRef)(null);
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
    page === "authorized" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: logout, children: t("logout") }) }),
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
