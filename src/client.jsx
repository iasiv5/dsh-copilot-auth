// client 半区：浏览器侧 cordis 插件。通过 settings.section 插槽注册
// 「GHC设置」页（order 11，紧挨 Models 的 order 10），fetch host 半区的
// 4 条自有路由，轮询渲染设备码（user code + 验证链接）。
// 文案走 locale 服务（en/zh 词典，随系统语言切换）；
// 侧栏图标：壳的 navIcon(id) 对未知 id 回落齿轮且不开放注册，故用
// MutationObserver 把本节导航行的齿轮替换为单色 Copilot 图标
// （octicons copilot-16，fill=currentColor，浅/深主题自动一致）。
import { useEffect, useRef, useState } from "react";

export const name = "copilot-auth-ui";
export const inject = ["slots", "locale"];

const DICTS = {
  en: {
    nav: "GHC Settings",
    title: "GitHub Copilot Sign-in",
    intro: "Sign in to Copilot with your company GitHub account using the device code — no API token required.",
    idle: "Not signed in",
    running: "Signing in…",
    authorized: "Signed in",
    failed: "Failed",
    loading: "…",
    login: "Sign in",
    logout: "Sign out",
    codeHint: "Open the link below and enter this code to finish signing in:",
    copy: "Copy",
    copied: "Copied ✓",
    unknown: "Unknown error",
  },
  zh: {
    nav: "GHC设置",
    title: "GitHub Copilot 登录",
    intro: "使用公司 GitHub 账号通过设备码授权登录 Copilot，无需填写 API Token。",
    idle: "未登录",
    running: "进行中…",
    authorized: "已登录",
    failed: "失败",
    loading: "…",
    login: "登录",
    logout: "注销",
    codeHint: "在浏览器打开下面的链接，输入这串代码完成授权：",
    copy: "复制",
    copied: "已复制 ✓",
    unknown: "未知错误",
  },
};

const NAV_TEXTS = Object.keys(DICTS).map((locale) => DICTS[locale].nav);

// octicons copilot-16（MIT，github/primer）——单色 currentColor，随主题变色
const COPILOT_ICON_SVG =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="flex:none">' +
  '<path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"/>' +
  '<path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z"/></svg>';

// 壳的导航行 button 结构固定为 [<svg class=navIcon*>, <span class=navLabel*>]，
// 按 label 文本找到本节那一行：隐藏齿轮 svg、紧随其后插入 Copilot svg
//（继承原 svg 的 class 以复用尺寸/主题样式；不删除 React 管理的节点）。
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
    } catch { /* DOM 未就绪时等下一次 mutation 再试 */ }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}

const styles = {
  section: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 12, fontFamily: "inherit" },
  title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: "24px" },
  intro: { margin: 0, fontSize: 14, lineHeight: "22px", opacity: 0.75 },
  badgeRow: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  badge: { fontSize: 12, lineHeight: "18px" },
  button: { height: 32, padding: "0 14px", fontSize: 14, borderRadius: 16, border: "none",
    cursor: "pointer", fontFamily: "inherit" },
  primary: { background: "#4c6ef5", color: "#fff" },
  secondary: { background: "transparent", color: "inherit", border: "1px solid currentColor", opacity: 0.8 },
  card: { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 12, padding: "12px 14px",
    display: "flex", flexDirection: "column", gap: 10 },
  codeHint: { margin: 0, fontSize: 13, lineHeight: "20px", opacity: 0.85 },
  codeRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  code: { fontSize: 24, fontWeight: 700, letterSpacing: 2, fontVariantNumeric: "tabular-nums" },
  link: { fontSize: 13, color: "#4c6ef5" },
  error: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#e03131" },
};

const badgeColor = { idle: "#adb5bd", running: "#f59f00", authorized: "#37b24d", failed: "#e03131", loading: "#adb5bd" };

function CopilotSection({ t = (key) => DICTS.en[key] ?? key }) {
  const [page, setPage] = useState("loading"); // loading | idle | running | authorized | failed
  const [notices, setNotices] = useState([]);
  const [error, setError] = useState(undefined);
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch("/copilot-auth/status")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.configured) { setPage("authorized"); return; }
        // 未配置时回查最近一次 attempt：失败要显式呈现（不能吞成「未登录」），
        // 进行中则恢复轮询（设置面板往返导致的重挂载不丢登录进度）。
        fetch("/copilot-auth/state")
          .then((r) => r.json())
          .then((s) => {
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
          })
          .catch(() => { if (alive) setPage("idle"); });
      })
      .catch(() => { if (alive) setPage("idle"); });
    return () => {
      alive = false;
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  const poll = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      fetch("/copilot-auth/state")
        .then((r) => r.json())
        .then((s) => {
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
        })
        .catch(() => { /* 网络抖动时继续下一轮轮询 */ });
    }, 1000);
  };

  const login = () => {
    setCopied(false);
    setError(undefined);
    setNotices([]);
    fetch("/copilot-auth/start", { method: "POST" }).catch(() => {});
    setPage("running");
    poll();
  };

  const logout = async () => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    try { await fetch("/copilot-auth/logout", { method: "POST" }); } catch { /* 状态以下一步查询为准 */ }
    setNotices([]);
    setError(undefined);
    setPage("idle");
  };

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* 剪贴板不可用时静默 */ }
  };

  const codeNotice = [...notices].reverse().find((n) => n && typeof n.code === "string" && n.code !== "");
  const badgeText = page === "loading" ? t("loading") : t(page);

  return (
    <div style={styles.section}>
      <h3 style={styles.title}>{t("title")}</h3>
      <p style={styles.intro}>{t("intro")}</p>
      <div style={styles.badgeRow}>
        <span style={{ ...styles.dot, background: badgeColor[page] ?? "#adb5bd" }} />
        <span style={styles.badge}>{badgeText}</span>
      </div>
      {page === "running" && codeNotice && (
        <div style={styles.card}>
          <p style={styles.codeHint}>{t("codeHint")}</p>
          <div style={styles.codeRow}>
            <span style={styles.code}>{codeNotice.code}</span>
            <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={() => copyCode(codeNotice.code)}>
              {copied ? t("copied") : t("copy")}
            </button>
          </div>
          {codeNotice.url && (
            <a style={styles.link} href={codeNotice.url} target="_blank" rel="noreferrer">{codeNotice.url}</a>
          )}
        </div>
      )}
      {page === "failed" && error && <p style={styles.error}>{error}</p>}
      {page === "authorized" && (
        <div>
          <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={logout}>{t("logout")}</button>
        </div>
      )}
      {(page === "idle" || page === "failed") && (
        <div>
          <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={login}>{t("login")}</button>
        </div>
      )}
    </div>
  );
}

export function apply(ctx) {
  ctx.locale.register("copilot-auth", DICTS);
  const t = ctx.locale.bind("copilot-auth");
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "copilot", order: 11, label: () => t("nav"), inject: () => ({ t }) },
    CopilotSection,
  ));
  startNavIconEnforcer(() => t("nav"));
}
