// client 半区：浏览器侧 cordis 插件。通过 settings.section 插槽注册
// 「GHC设置」页（order 11，紧挨 Models 的 order 10），fetch host 半区的
// 4 条自有路由，轮询渲染设备码（user code + 验证链接）。
// 文案走 locale 服务（en/zh 词典，随系统语言切换）；
// 侧栏图标：壳的 navIcon(id) 对未知 id 回落齿轮且不开放注册，故用
// MutationObserver 把本节导航行的齿轮替换为单色 Copilot 图标
// （octicons copilot-16，fill=currentColor，浅/深主题自动一致）。
import { useEffect, useRef, useState } from "react";
import { initial as refreshInitial, advance } from "./refresh-flow.mjs";

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
    refreshing: "Fetching preview…",
    applying: "Applying…",
    restartNeeded: "Catalog patched. Restart dsh web to finish syncing the model list.",
    stalePreview: "Inputs changed — review the new diff",
    overlayBtn: "Preview with bundled overlay",
    stateCorrupt: "State file was corrupted and quarantined; auto self-heal is disabled — run a refresh to re-activate.",
    srcLive: "Account models: live fetch",
    srcCache: "Account models: credential cache (live fetch failed)",
    srcLatest: "Catalog source: latest pi-ai from npm",
    srcLocal: "Catalog source: local only (npm fetch failed)",
    srcOverlay: "Catalog source: bundled overlay (offline bootstrap)",
    none: "(none)",
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
    refreshNow: "刷新可用模型目录",
    refreshTitle: "刷新可用模型目录",
    refreshDesc: "将现场拉取账号可用模型与最新 pi-ai 目录数据，对本机目录做数据级只增补丁（pi-ai 版本不变）。确认前请核对下方差异。",
    riskRemoved: "失效模型（账号已不再可用的模型）重启后将从模型列表消失。",
    riskReset: "你的定制（精简裁剪、条目字段微调、modelOverrides）将被重置为镜像集合。",
    riskRestart: "需重启 dsh web 后生效（两阶段：现在写目录补丁，下个 boot 同步 settings）。",
    addedModels: "新增模型",
    removedModels: "移除（已失效）",
    keptModels: "保留",
    skippedModels: "被校验跳过的上游条目",
    customReset: "以下定制将被重置：",
    customEntries: "字段微调",
    customOverrides: "modelOverrides",
    confirmRefresh: "确认刷新",
    cancel: "取消",
    refreshing: "拉取预览中…",
    applying: "应用中…",
    restartNeeded: "目录补丁已写入。重启 dsh web 后完成模型列表同步。",
    stalePreview: "数据已变化，请重新确认差异",
    overlayBtn: "改用内置覆盖层预览",
    stateCorrupt: "状态文件已损坏并被隔离；自动自愈已停用，请重新执行一次刷新以激活。",
    srcLive: "账号模型：现场拉取",
    srcCache: "账号模型：凭证缓存（现场拉取失败）",
    srcLatest: "目录来源：npm 最新 pi-ai",
    srcLocal: "目录来源：仅本地目录（npm 拉取失败）",
    srcOverlay: "目录来源：内置覆盖层（离线 bootstrap）",
    none: "（无）",
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
  banner: { margin: 0, fontSize: 13, lineHeight: "20px", color: "#f59f00" },
  modalMask: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  // 背景/文字与壳 body 用同一对 dsw 令牌（--dsw-alias-bg-base / label-primary），
  // 深/浅主题自动一致——勿用不存在的变量名 fallback（曾致深色主题白底白字）
  modal: { background: "var(--dsw-alias-bg-base, #fff)", color: "var(--dsw-alias-label-primary, inherit)",
    border: "1px solid rgba(128,128,128,0.35)", borderRadius: 12, maxWidth: 560, width: "100%",
    maxHeight: "80vh", overflowY: "auto", padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10,
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)" },
  modalTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  modalText: { margin: 0, fontSize: 13, lineHeight: "20px", opacity: 0.85 },
  diffList: { margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "20px" },
  added: { color: "#37b24d" },
  removed: { color: "#e03131" },
  skipped: { color: "#f59f00" },
  risk: { margin: 0, fontSize: 12, lineHeight: "18px", color: "#e8590c" },
  modalActions: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 },
  mono: { fontFamily: "ui-monospace, monospace" },
};

const badgeColor = { idle: "#adb5bd", running: "#f59f00", authorized: "#37b24d", failed: "#e03131", loading: "#adb5bd" };

// 刷新弹窗：消费 refresh-flow 状态机的 confirming 态（preview 数据）。
// 渲染 added（绿）/removed（红）/kept 计数/skipped（黄，如有）/customizationReset
// 名单/source 提示/三条风险文案；catalogSource==="local" 时展示 overlayBtn
//（点击 = 发 mode:"overlay" 的新 preview，不直接 apply，R2-5）。
function RefreshModal({ t, flow, onConfirm, onCancel, onOverlay }) {
  const p = flow.preview;
  const sourceKeys = [
    p.source === "live" ? "srcLive" : "srcCache",
    p.catalogSource === "latest" ? "srcLatest" : p.catalogSource === "overlay" ? "srcOverlay" : "srcLocal",
  ];
  const list = (ids, style) =>
    ids.length === 0 ? <span style={{ opacity: 0.6 }}>{t("none")}</span> : (
      <ul style={styles.diffList}>
        {ids.map((id) => <li key={id} style={{ ...style, ...styles.mono }}>{id}</li>)}
      </ul>
    );
  const resets = [
    ...p.customizationReset.modelEntryIds.map((id) => `${id} (${t("customEntries")})`),
    ...p.customizationReset.modelOverrideIds.map((id) => `${id} (${t("customOverrides")})`),
  ];
  return (
    <div style={styles.modalMask} role="dialog" aria-modal="true">
      <div style={styles.modal}>
        <h4 style={styles.modalTitle}>{t("refreshTitle")}</h4>
        <p style={styles.modalText}>{t("refreshDesc")}</p>
        {flow.staleNotice && <p style={styles.banner}>⚠ {t("stalePreview")}</p>}
        <p style={styles.modalText}>{sourceKeys.map((k) => t(k)).join(" · ")}</p>
        <p style={styles.modalText}><strong>{t("addedModels")}</strong>（{p.added.length}）</p>
        {list(p.added, styles.added)}
        <p style={styles.modalText}><strong>{t("removedModels")}</strong>（{p.removed.length}）</p>
        {list(p.removed, styles.removed)}
        <p style={styles.modalText}><strong>{t("keptModels")}</strong>（{p.kept.length}）</p>
        {p.skipped.length > 0 && (
          <>
            <p style={styles.modalText}><strong>{t("skippedModels")}</strong>（{p.skipped.length}）</p>
            <ul style={styles.diffList}>
              {p.skipped.map((s) => <li key={s.id} style={styles.skipped}>{s.id} — {s.reason}</li>)}
            </ul>
          </>
        )}
        {resets.length > 0 && (
          <>
            <p style={styles.modalText}><strong>{t("customReset")}</strong></p>
            <ul style={styles.diffList}>
              {resets.map((x) => <li key={x} style={styles.skipped}>{x}</li>)}
            </ul>
          </>
        )}
        <p style={styles.risk}>⚠ {t("riskRemoved")}</p>
        <p style={styles.risk}>⚠ {t("riskReset")}</p>
        <p style={styles.risk}>⚠ {t("riskRestart")}</p>
        <div style={styles.modalActions}>
          {p.catalogSource === "local" && (
            <button type="button" style={{ ...styles.button, ...styles.secondary, marginRight: "auto" }} onClick={onOverlay}>
              {t("overlayBtn")}
            </button>
          )}
          <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={onCancel}>{t("cancel")}</button>
          <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={onConfirm}>{t("confirmRefresh")}</button>
        </div>
      </div>
    </div>
  );
}

function CopilotSection({ t = (key) => DICTS.en[key] ?? key }) {
  const [page, setPage] = useState("loading"); // loading | idle | running | authorized | failed
  const [notices, setNotices] = useState([]);
  const [error, setError] = useState(undefined);
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const [flow, setFlow] = useState(refreshInitial);
  const flowRef = useRef(flow);

  // 刷新状态机的唯一驱动入口：client 只经 advance（不直接调 reduce/runEffect）。
  // onState 同步落中间态，applying 期间重复 confirm 被 reducer 忽略（双击安全）。
  const drive = (event) =>
    advance(flowRef.current, event, fetch, (next) => {
      flowRef.current = next;
      setFlow(next);
    }).catch(() => {});

  useEffect(() => {
    drive({ type: "init" }); // 页面刷新后由 /status 水合 restartNeeded / state-corrupt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={logout}>{t("logout")}</button>
          <button
            type="button"
            style={{ ...styles.button, ...styles.primary }}
            disabled={flow.name === "previewing" || flow.name === "applying"}
            onClick={() => drive({ type: "start" })}
          >
            {flow.name === "previewing" ? t("refreshing") : flow.name === "applying" ? t("applying") : t("refreshNow")}
          </button>
        </div>
      )}
      {page === "authorized" && flow.name === "restartNeeded" && (
        <p style={styles.banner}>⚠ {t("restartNeeded")}</p>
      )}
      {page === "authorized" && flow.name === "failed" && (
        <p style={styles.error}>{flow.error === "state-corrupt" ? t("stateCorrupt") : flow.error}</p>
      )}
      {flow.name === "confirming" && (
        <RefreshModal
          t={t}
          flow={flow}
          onConfirm={() => drive({ type: "confirm" })}
          onCancel={() => drive({ type: "cancel" })}
          onOverlay={() => drive({ type: "start", mode: "overlay" })}
        />
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
