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
var inject = ["slots"];
var T = {
  title: "GitHub Copilot \u767B\u5F55",
  intro: "\u4F7F\u7528\u516C\u53F8 GitHub \u8D26\u53F7\u901A\u8FC7\u8BBE\u5907\u7801\u6388\u6743\u767B\u5F55 Copilot\uFF0C\u65E0\u9700\u586B\u5199 API Token\u3002",
  login: "\u767B\u5F55",
  logout: "\u6CE8\u9500",
  idle: "\u672A\u767B\u5F55",
  running: "\u8FDB\u884C\u4E2D\u2026",
  authorized: "\u5DF2\u767B\u5F55",
  failed: "\u5931\u8D25",
  codeHint: "\u5728\u6D4F\u89C8\u5668\u6253\u5F00\u4E0B\u9762\u7684\u94FE\u63A5\uFF0C\u8F93\u5165\u8FD9\u4E32\u4EE3\u7801\u5B8C\u6210\u6388\u6743\uFF1A",
  copy: "\u590D\u5236",
  copied: "\u5DF2\u590D\u5236 \u2713"
};
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
var badgeText = { idle: T.idle, running: T.running, authorized: T.authorized, failed: T.failed, loading: "\u2026" };
function CopilotSection() {
  const [page, setPage] = (0, import_react.useState)("loading");
  const [notices, setNotices] = (0, import_react.useState)([]);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [copied, setCopied] = (0, import_react.useState)(false);
  const timer = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    let alive = true;
    fetch("/copilot-auth/status").then((r) => r.json()).then((d) => {
      if (alive) setPage(d.configured ? "authorized" : "idle");
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
            setError(s.error ?? "\u672A\u77E5\u9519\u8BEF");
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.section, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: styles.title, children: T.title }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.intro, children: T.intro }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.badgeRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...styles.dot, background: badgeColor[page] ?? "#adb5bd" } }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.badge, children: badgeText[page] ?? page })
    ] }),
    page === "running" && codeNotice && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.card, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.codeHint, children: codeNotice.message || T.codeHint }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.codeRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: styles.code, children: codeNotice.code }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: () => copyCode(codeNotice.code), children: copied ? T.copied : T.copy })
      ] }),
      codeNotice.url && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { style: styles.link, href: codeNotice.url, target: "_blank", rel: "noreferrer", children: codeNotice.url })
    ] }),
    page === "failed" && error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.error, children: error }),
    page === "authorized" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.secondary }, onClick: logout, children: T.logout }) }),
    (page === "idle" || page === "failed") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...styles.button, ...styles.primary }, onClick: login, children: T.login }) })
  ] });
}
function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "copilot", order: 11, label: () => T.title, inject: () => ({}) },
    CopilotSection
  ));
}

		return module.exports;
	}
});
