// client 半区：浏览器侧 cordis 插件。通过 settings.section 插槽注册
// 「GitHub Copilot 登录」设置页（order 11，紧挨 Models 的 order 10），
// fetch host 半区的 4 条自有路由，轮询渲染设备码（user code + 验证链接）。
import { useEffect, useRef, useState } from "react";

export const name = "copilot-auth-ui";
export const inject = ["slots"];

const T = {
  title: "GitHub Copilot 登录",
  intro: "使用公司 GitHub 账号通过设备码授权登录 Copilot，无需填写 API Token。",
  login: "登录",
  logout: "注销",
  idle: "未登录",
  running: "进行中…",
  authorized: "已登录",
  failed: "失败",
  codeHint: "在浏览器打开下面的链接，输入这串代码完成授权：",
  copy: "复制",
  copied: "已复制 ✓",
};

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
const badgeText = { idle: T.idle, running: T.running, authorized: T.authorized, failed: T.failed, loading: "…" };

function CopilotSection() {
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
              setError(s.error ?? "未知错误");
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
              setError(s.error ?? "未知错误");
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
    try { await fetch("/copilot-auth/logout", { method: "POST" }); } catch { /* 已吞掉，状态以下一步查询为准 */ }
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

  return (
    <div style={styles.section}>
      <h3 style={styles.title}>{T.title}</h3>
      <p style={styles.intro}>{T.intro}</p>
      <div style={styles.badgeRow}>
        <span style={{ ...styles.dot, background: badgeColor[page] ?? "#adb5bd" }} />
        <span style={styles.badge}>{badgeText[page] ?? page}</span>
      </div>
      {page === "running" && codeNotice && (
        <div style={styles.card}>
          <p style={styles.codeHint}>{codeNotice.message || T.codeHint}</p>
          <div style={styles.codeRow}>
            <span style={styles.code}>{codeNotice.code}</span>
            <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={() => copyCode(codeNotice.code)}>
              {copied ? T.copied : T.copy}
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
          <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={logout}>{T.logout}</button>
        </div>
      )}
      {(page === "idle" || page === "failed") && (
        <div>
          <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={login}>{T.login}</button>
        </div>
      )}
    </div>
  );
}

export function apply(ctx) {
  ctx.slots.inject("settings.section", () => ctx.slots.register(
    { name: "settings.section", id: "copilot", order: 11, label: () => T.title, inject: () => ({}) },
    CopilotSection,
  ));
}
