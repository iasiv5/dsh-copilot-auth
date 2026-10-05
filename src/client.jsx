// client 半区：浏览器侧 cordis 插件。通过 settings.section 插槽注册
// 「GHC设置」页（order 11，紧挨 Models 的 order 10），fetch host 半区的
// 8 条自有路由（授权 5 条＋模型 preview/apply/retire），轮询渲染设备码。
// 文案走 locale 服务（en/zh 词典，随系统语言切换）；
// 侧栏图标：壳的 navIcon(id) 对未知 id 回落齿轮且不开放注册，故用
// MutationObserver 把本节导航行的齿轮替换为单色 Copilot 图标
// （octicons copilot-16，fill=currentColor，浅/深主题自动一致）。
import { useEffect, useRef, useState } from "react";
import { initial as refreshInitial, advance, refreshBlocked } from "./refresh-flow.mjs";
import { createAuthFlow } from "./auth-flow.mjs";

export const name = "copilot-auth-ui";
export const inject = ["slots", "locale"];

const DICTS = {
  en: {
    nav: "GHC Settings",
    title: "GitHub Copilot",
    intro: "Authorize with a personal or organization account on github.com that has Copilot access. No API token is required.",
    idle: "Not signed in",
    waiting: "Waiting for you to authorize on GitHub",
    authorized: "Signed in",
    failed: "Failed",
    loading: "…",
    login: "Sign in",
    logout: "Sign out",
    authUnsafe: "Safe completion of the authorization flow is unconfirmed. Sign-out and a new authorization attempt are unavailable.",
    attemptTimeout: "Authorization wait timed out; the outcome remains unverified. A new authorization attempt is unavailable. Check the status or verify it manually.",
    attemptShared: "An authorization attempt is already running in this instance.",
    unavailable: "This runtime lacks the capabilities needed to apply changes safely.",
    connection: "Connection lost. The last confirmed status is shown.",
    retryNow: "Check status",
    copyFailed: "Copy failed. Select and copy the device code manually.",
    riskBadge: "Outcome unverified",
    codeHint: "Open the link below and enter this code to finish signing in:",
    copy: "Copy",
    copied: "Copied ✓",
    unknown: "Unknown error",
    netConnect: "Cannot reach GitHub. Check this machine's network or proxy settings.",
    netDns: "Cannot resolve github.com. Check DNS or network settings.",
    netCert: "GitHub certificate verification failed. A corporate proxy or TLS inspection may be intercepting the connection.",
    netGeneric: "The authorization request failed over the network.",
    statusUnknown: "Status unknown",
    errNetwork: "Network error: cannot reach the authorization service. Retrying automatically.",
    errGateway: "Gateway error: the DSH service may be restarting. Retrying automatically.",
    errBadResponse: "Unexpected response from the authorization service.",
    errHttp: "The authorization request failed. Check status and retry.",
    logoutScope: "This removes Copilot authorization from this credential store and affects other instances using it. It does not delete your GitHub account.",
    logoutFailed: "Sign-out did not complete; authorization credentials may remain. Please retry.",
    // ---- Model management (protocol v3, design §5 / ADR 0005) ----
    manageModels: "Manage model list",
    selectAll: "Select all",
    selectNone: "Deselect all",
    alignAction: "Align with account & catalog",
    groupAddable: "Available to add",
    groupListed: "In list",
    groupRemoval: "Proposed for removal",
    retain: "Keep: re-check to retain",
    customizedBadge: "Customized",
    clearOverrides: "Also clear all model customizations.",
    inheritedOverrides: "Inherited model customizations cannot be cleared here.",
    clearRisk: "Clearing hides nothing — all available models stay listed; to trim, keep only the ones you check.",
    applyChanges: "Apply changes",
    removalRisk: "{count} listed model(s) will be removed; their customizations are removed with them.",
    summaryLine: "After applying: {total} model(s) — {kept} kept · {added} added · {removed} removed",
    catalogNotice: "{count} catalog entries will be added",
    noChanges: "No changes and no new catalog entries.",
    removalNeedsLive: "Removals require live account evidence",
    removedAccount: "Not reported by this account",
    removedUnresolvable: "Not resolvable by the current catalog",
    skippedModels: "Upstream entries skipped by validation",
    srcLive: "Account models: live",
    srcCache: "Account models: cached at {time}; removals require upgrading to live evidence",
    srcStale: "The cache has no trusted timestamp, is expired, or belongs to changed authorization; reference only.",
    srcLatest: "Catalog source: latest pi-ai from npm",
    srcLocal: "Catalog source: local (npm fetch failed)",
    srcOverlay: "Catalog source: bundled overlay (offline bootstrap)",
    overlayBtn: "Preview with bundled overlay",
    previewStale: "Configuration or data changed. Preview and confirm again.",
    none: "(none)",
    applying: "Applying…",
    refreshing: "Fetching preview…",
    cancel: "Cancel",
    applied: "Changes are active. No restart is needed.",
    pendingRestart: "Changes are saved and require restarting this instance's service or application. Refreshing the page alone is not enough.",
    conflict: "Configuration changed. To protect your edits, preview and confirm again.",
    partial: "Changes were only partially applied. Review the current status and recovery guidance.",
    rolledBack: "This operation's model configuration changes were rolled back. Catalog data may still have been added.",
    rollbackConflict: "Newer configuration was detected and preserved. Automatic rollback did not complete.",
    busy: "Another operation is using this resource. Please retry shortly.",
    unknownResult: "Completion has not been confirmed. Check the current status before submitting again.",
    recoveryNeeded: "A previous configuration intent is stale or conflicted. End it before applying new changes.",
    retireBtn: "End previous configuration intent",
    retireTitle: "End previous configuration intent",
    retireConfirmText: "End the intent only; existing changes are not rolled back or undone.",
    legacy: "Legacy shared recovery state was found. It will not be applied automatically; preview and confirm in this profile.",
    techDetails: "Technical details",
    stateCorrupt: "State file was corrupted and quarantined. Preview and confirm again.",
    blockedReasons: {
      "inject-unavailable": "The in-process catalog registry is unavailable in this installation.",
      "install-unresolved": "The pi-ai installation could not be located.",
    },
  },
  zh: {
    nav: "GHC设置",
    title: "GitHub Copilot",
    intro: "使用具有 Copilot 权限的 github.com 个人或组织账号授权，无需填写 API Token。",
    idle: "未登录",
    waiting: "等待你在 GitHub 完成授权",
    authorized: "已登录",
    failed: "失败",
    loading: "…",
    login: "授权登录",
    logout: "退出登录",
    authUnsafe: "尚不能确认授权流程已安全结束，暂不能退出或发起新的授权尝试。",
    attemptTimeout: "等待授权超时，结果仍待核实。当前不能发起新的授权尝试，请查询状态或人工核实。",
    attemptShared: "此实例已有授权正在进行。",
    connection: "连接异常，显示的是最后确认的状态。",
    retryNow: "查询状态",
    copyFailed: "复制失败，请手动选中设备码复制。",
    riskBadge: "结果待核实",
    codeHint: "在浏览器打开下面的链接，输入这串代码完成授权：",
    copy: "复制",
    copied: "已复制 ✓",
    unknown: "未知错误",
    netConnect: "无法连接 GitHub：请检查本机网络或代理设置。",
    netDns: "无法解析 GitHub 域名：请检查 DNS 或网络设置。",
    netCert: "GitHub 证书校验失败：可能存在企业代理或 TLS 检查拦截。",
    netGeneric: "授权请求网络失败。",
    statusUnknown: "状态未知",
    errNetwork: "网络异常：无法连接授权服务，正在自动重试。",
    errGateway: "网关错误：DSH 服务可能正在重启，正在自动重试。",
    errBadResponse: "授权服务返回异常响应。",
    errHttp: "授权请求失败。请查询状态后重试。",
    logoutScope: "将清除此凭据库中的 Copilot 授权，使用同一凭据库的其他实例也会受到影响。此操作不注销 GitHub 账号。",
    logoutFailed: "退出登录未完成，授权凭据仍可能存在。请重试。",
    // ---- 模型管理（协议 v3，设计§5 / ADR 0005） ----
    manageModels: "管理模型列表",
    selectAll: "全选",
    selectNone: "取消全选",
    alignAction: "对齐账号与目录",
    groupAddable: "可新增",
    groupListed: "在列",
    groupRemoval: "待删除候选",
    retain: "挽留：重新勾选以保留",
    customizedBadge: "有定制",
    clearOverrides: "同时清除全部模型定制。",
    inheritedOverrides: "存在继承的模型定制，无法在此清除。",
    clearRisk: "清空不会隐藏模型——会话内将显示全部可用模型；要精简，只需勾选保留项。",
    applyChanges: "应用更改",
    removalRisk: "将移除 {count} 个在列模型，其定制随之清除。",
    summaryLine: "应用后共 {total} 个：保留 {kept} · 新增 {added} · 移除 {removed}",
    catalogNotice: "目录将新增 {count} 条描述",
    noChanges: "无需更改，目录也无新数据。",
    removalNeedsLive: "移除类更改需要实时账号证据",
    removedAccount: "账号未报告",
    removedUnresolvable: "目录无法解析",
    skippedModels: "被校验跳过的上游条目",
    srcLive: "账号模型：实时获取",
    srcCache: "账号模型：缓存，获取于 {time}；移除类更改需升级为实时证据",
    srcStale: "缓存缺少可信时间、已过期或授权已变化，仅供参考。",
    srcLatest: "目录来源：npm 最新 pi-ai",
    srcLocal: "目录来源：本地目录（npm 拉取失败）",
    srcOverlay: "目录来源：内置覆盖层（离线 bootstrap）",
    overlayBtn: "改用内置目录数据预览",
    previewStale: "配置或数据已变化，请重新预览并确认。",
    none: "（无）",
    applying: "应用中…",
    refreshing: "拉取预览中…",
    cancel: "取消",
    applied: "更改已生效，无需重启。",
    pendingRestart: "更改已保存，待重启生效。请重启运行此实例的服务或应用；仅刷新页面不会生效。",
    conflict: "配置已变化。为保护你的修改，请重新预览并确认。",
    partial: "更改未完全应用，请查看当前状态和恢复建议。",
    rolledBack: "本次模型配置更改已回滚。目录数据可能仍已补充。",
    rollbackConflict: "检测到更新的配置，已保留你的修改；自动回滚未完成。",
    busy: "另一个操作正在处理此资源，请稍后重试。",
    unknownResult: "尚未确认操作完成。请核实当前状态，勿重复提交。",
    recoveryNeeded: "存在已失效或冲突的旧配置意图，请先结束旧意图再应用新更改。",
    retireBtn: "结束旧配置意图",
    retireTitle: "结束旧配置意图",
    retireConfirmText: "只结束旧意图，不回滚或撤销已发生的更改。",
    legacy: "检测到旧的共享恢复状态。不会自动应用，请在当前 profile 重新预览确认。",
    techDetails: "技术详情",
    stateCorrupt: "恢复状态无法读取，原件已保留。请重新预览确认。",
    unavailable: "当前运行时缺少安全应用所需的能力，暂不能应用更改。",
    blockedReasons: {
      "inject-unavailable": "当前安装的进程内目录注册表不可用。",
      "install-unresolved": "无法定位 pi-ai 安装。",
    },
  },
};

const NAV_TEXTS = Object.keys(DICTS).map((locale) => DICTS[locale].nav);

// blockedReason 按具体原因给文案（refreshBlocked 已由 refresh-flow.mjs 导出，测试覆盖）。
function blockedReasonText(t, flags) {
  const reason = flags?.blockedReason;
  if (reason && t("blockedReasons")?.[reason]) return t("blockedReasons")[reason];
  return t("unavailable");
}

// HTTP 层错误（requestJson messageKey）→ 面向用户的原因文案。
// 历史缺陷：start/status 请求在创建 attempt 之前失败时，页面只显示裸「失败」，
// 真实原因（网络/网关/响应异常）被吞掉——现在如实分层展示。
function httpErrorText(t, key) {
  return {
    "network-error": t("errNetwork"),
    "bad-gateway": t("errGateway"),
    "bad-response": t("errBadResponse"),
    "http-error": t("errHttp"),
  }[key];
}

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
  // 弹窗背景/文字由 sampleThemeSurface() 在渲染时采样覆盖（皮肤可能把 bg-base
  // 做成半透明磨砂，弹窗必须不透明）；此处仅为兜底
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
  muted: { opacity: 0.6 },
  risk: { margin: 0, fontSize: 12, lineHeight: "18px", color: "#e8590c" },
  modalActions: { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 },
  mono: { fontFamily: "ui-monospace, monospace" },
};

const badgeColor = { idle: "#adb5bd", waiting: "#f59f00", authorized: "#37b24d", failed: "#e03131", loading: "#adb5bd", risk: "#f59f00", unavailable: "#adb5bd" };

// 主题表面色采样：取 body 计算背景并剥掉 alpha——皮肤可能把 bg-base 做成半透明
// 磨砂（凡人修仙传 BEAUTY 即 rgba(18,18,26,0.35)），弹窗叠在遮罩上必须不透明；
// 文字色直接用 body 计算色。一次性采样，主题切换后重挂载即刷新。
function sampleThemeSurface() {
  if (typeof document === "undefined") return { bg: "#fff", fg: "inherit" };
  const cs = getComputedStyle(document.body);
  const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
  const bg = m ? `rgb(${m[1].split(",").slice(0, 3).join(",")})` : "#fff";
  return { bg, fg: cs.color || "inherit" };
}

// 模型操作弹窗（协议 v3，ADR 0005）：管理模型列表＝目标状态编辑。单张分组全表
// （可新增/在列/待删除候选），勾选集合即期望终态；选择/清除定制经 onSelect → 服务端
// 从原快照 materialize（不重新取数）；缓存证据＋删除提案由状态机自动升级 live；
// 删除类变更二次确认、空目标单独确认、降级来源锁定待删除候选（Q33/Q35/Q36）；
// 危险确认初始焦点在取消、Esc 等价取消（设计§5）；技术详情默认折叠（G04）。
function RefreshModal({ t, flow, onSelect, onConfirm, onCancel, onOverlay }) {
  const p = flow.preview;
  const isStale = p.evidence?.stale === true;
  const degradedCatalog = p.catalogSource === "local" || p.catalogSource === "overlay";
  const locked = isStale || degradedCatalog; // 降级来源：待删除候选锁定保留（Q33）
  const rows = p.rows ?? [];
  const addableIds = rows.filter((r) => r.status === "addable").map((r) => r.id);
  const rawAllIds = rows.filter((r) => r.status !== "addable").map((r) => r.id);
  const removalRows = rows.filter((r) => r.status === "removal-proposal");
  // 乐观勾选：点击即更新本地视图，服务端 materialize 回显到达后清空覆盖。
  // 锁定降级下待删除候选＝强制保留（Q33）：勾选集合并入锁定行，计数/摘要/上报与勾选框同口径
  const [localSel, setLocalSel] = useState(null); // Set | null
  const [coChecked, setCoChecked] = useState(false);
  useEffect(() => { setLocalSel(null); setCoChecked(p.clearOverrides === true); }, [p.diff]);
  const lockedIds = rows.filter((r) => r.status === "removal-proposal" && locked).map((r) => r.id);
  const selected = (() => {
    const s = new Set(localSel ?? (p.diff?.selectedIds ?? []));
    for (const id of lockedIds) s.add(id);
    return s;
  })();
  const confirmEmptyOf = (set) => set.size === 0 && p.hadModels === true;
  const emitSel = (nextSet) => {
    setLocalSel(nextSet);
    const ce = confirmEmptyOf(nextSet);
    // 非空选择不携带 confirmEmpty（计划 T4 用例 6 字面；服务端 === true 归一，语义一致）
    onSelect({ selectedIds: [...nextSet], clearOverrides: coChecked, ...(ce ? { confirmEmpty: true } : {}) });
  };
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    emitSel(next);
  };
  const toggleClearOverrides = (v) => {
    setCoChecked(v);
    const ce = confirmEmptyOf(selected);
    onSelect({ selectedIds: [...selected], clearOverrides: v, ...(ce ? { confirmEmpty: true } : {}) });
  };
  // 摘要/风险计数与勾选态同源（勾选即终态，无需等服务端回显）
  const keptCount = rawAllIds.filter((id) => selected.has(id)).length;
  const addedCount = addableIds.filter((id) => selected.has(id)).length;
  const removedCount = rawAllIds.length - keptCount;
  const total = keptCount + addedCount;
  const emptyTarget = confirmEmptyOf(selected);
  const applyBlocked = isStale || (removedCount > 0 && (p.evidence?.source !== "live" || degradedCatalog));
  const cancelRef = useRef(null);
  const surface = useRef(null);
  if (!surface.current) surface.current = sampleThemeSurface();
  const escCancel = (e) => { if (e.key === "Escape") onCancel(); };
  // 单次确认（Q37）：破坏性意图由底栏常驻风险线前置告知，点击即应用
  const confirmClick = () => {
    if (isStale || applyBlocked) return; // reducer 双保险
    onConfirm({});
  };
  const sourceLine = [
    p.evidence?.source === "live" ? t("srcLive")
      : p.evidence?.source === "cache" ? t("srcCache").replace("{time}", String(p.evidence?.fetchedAt ?? "")) : null,
    p.catalogSource === "latest" ? t("srcLatest") : p.catalogSource === "overlay" ? t("srcOverlay") : t("srcLocal"),
  ].filter(Boolean).join(" · ");
  const groupDefs = [
    { key: "groupAddable", items: rows.filter((r) => r.status === "addable") },
    { key: "groupListed", items: rows.filter((r) => r.status === "listed") },
    { key: "groupRemoval", items: removalRows, retain: true },
  ];
  return (
    <div style={styles.modalMask} role="dialog" aria-modal="true" onKeyDown={escCancel}>
      {/* 固定高度＋三段式（头部/可滚动内容/常驻操作栏）：勾选与物化往返不改变卡片尺寸 */}
      <div style={{ ...styles.modal, background: surface.current.bg, color: surface.current.fg, height: "min(80vh, 680px)", padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "18px 20px 6px" }}>
          <h4 style={styles.modalTitle}>{t("manageModels")}</h4>
          {/* staleNotice 双语义分流（R1-4/R2-1）：「可应用的缓存态」（有效缓存＋latest 目录）
              下一律不显示 previewStale——纯新增可正常应用（删除类的知情由 removalNeedsLive
              横幅承担）；其余（apply-stale 重预览、stale 证据等）维持「请重新预览并确认」 */}
          {flow.staleNotice && !(!isStale && p.evidence?.source !== "live" && p.catalogSource === "latest") && <p style={styles.banner}>⚠ {t("previewStale")}</p>}
          <p style={styles.modalText}>{sourceLine}</p>
          {isStale && <p style={styles.banner}>⚠ {t("srcStale")}</p>}
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, scrollbarGutter: "stable", padding: "0 20px" }}>
          {/* 工具行：全选/取消全选作用于全表（含待删除候选＝全部挽留）；对齐仅在漂移时出现（Q36） */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 0" }}>
            <button type="button" style={{ ...styles.button, ...styles.secondary, height: 24, fontSize: 12 }}
              onClick={() => emitSel(new Set([...addableIds, ...rawAllIds]))}>{t("selectAll")}</button>
            <button type="button" style={{ ...styles.button, ...styles.secondary, height: 24, fontSize: 12 }}
              onClick={() => emitSel(new Set(lockedIds))}>{t("selectNone")}</button>
            {removalRows.length > 0 && (
              <button type="button" style={{ ...styles.button, ...styles.secondary, height: 24, fontSize: 12, ...(locked ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
                disabled={locked} title={locked ? t("removalNeedsLive") : undefined}
                onClick={() => emitSel(new Set([...addableIds, ...rows.filter((r) => r.status === "listed").map((r) => r.id)]))}
              >{t("alignAction")}</button>
            )}
          </div>
          {groupDefs.map(({ key, items, retain }) => items.length === 0 ? null : (
            <div key={key} style={{ marginBottom: 8 }}>
              <p style={{ ...styles.modalText, fontWeight: 600, margin: "6px 0 2px" }} title={retain ? t("retain") : undefined}>
                {t(key)}（{items.length}）
              </p>
              {items.map((r) => {
                const forceKept = r.status === "removal-proposal" && locked;
                const checked = forceKept || selected.has(r.id);
                return (
                  <label key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0" }}>
                    <input type="checkbox" checked={checked} disabled={forceKept} onChange={() => toggle(r.id)} />
                    <span style={styles.mono}>{r.id}</span>
                    {r.status === "removal-proposal" && (
                      <span style={{ ...styles.removed, fontSize: 12 }}>{t(r.reason === "unresolvable" ? "removedUnresolvable" : "removedAccount")}</span>
                    )}
                    {r.customized === true && <span style={{ ...styles.muted, fontSize: 12 }}>{t("customizedBadge")}</span>}
                  </label>
                );
              })}
            </div>
          ))}
          {(p.overridesMeta?.clearable || p.overridesMeta?.inheritedOnly) && (
            <div style={{ padding: "4px 0" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={coChecked} disabled={!p.overridesMeta?.clearable} onChange={(e) => toggleClearOverrides(e.target.checked)} />
                <span style={p.overridesMeta?.clearable ? undefined : { ...styles.muted, fontSize: 13 }}>
                  {t(p.overridesMeta?.clearable ? "clearOverrides" : "inheritedOverrides")}
                </span>
              </label>
            </div>
          )}
          {(p.skipped ?? []).length > 0 && (
            <details style={styles.modalText}>
              <summary>{t("skippedModels")}（{p.skipped.length}）</summary>
              <ul style={styles.diffList}>
                {p.skipped.map((s) => <li key={s.id} style={styles.skipped}>{s.id} — {s.reason}</li>)}
              </ul>
            </details>
          )}
          {((p.diff?.warnings ?? []).length > 0 || p.catalogError) && (
            <details style={styles.modalText}>
              <summary>{t("techDetails")}</summary>
              {(p.diff?.warnings ?? []).length > 0 && (
                <ul style={styles.diffList}>
                  {(p.diff?.warnings ?? []).map((w, i) => <li key={w.id ?? i} style={styles.skipped}>{w.id} — {w.reason}</li>)}
                </ul>
              )}
              {p.catalogError && <span style={{ ...styles.mono, fontSize: 12 }}>{p.catalogError}</span>}
            </details>
          )}
        </div>
        <div style={{ padding: "8px 20px 16px" }}>
          {/* 风险线常驻固定底栏（用户实测反馈：埋在滚动区底部看不到告警、误以为按钮失灵）——
              移除/清除定制/清空意图自勾选一刻即显示（单次确认 Q37：告知前置，非点击计数），
              无论滚动位置何在都必然可见 */}
          {(removedCount > 0 || coChecked || emptyTarget) && (
            <div style={{ marginBottom: 4 }}>
              {removedCount > 0 && <p style={styles.risk}>⚠ {t("removalRisk").replace("{count}", String(removedCount))}</p>}
              {coChecked && <p style={styles.risk}>⚠ {t("clearOverrides")}</p>}
              {emptyTarget && <p style={styles.risk}>⚠ {t("clearRisk")}</p>}
            </div>
          )}
          {/* 摘要行常驻：知情（Q36）；与风险线同源计数 */}
          <p style={{ ...styles.modalText, margin: 0 }}>
            {total === 0 && removedCount === 0 && (p.catalogNewEntries ?? 0) === 0
              ? t("noChanges")
              : <>
                  {t("summaryLine")
                    .replace("{total}", String(total))
                    .replace("{kept}", String(keptCount))
                    .replace("{added}", String(addedCount))
                    .replace("{removed}", String(removedCount))}
                  {(p.catalogNewEntries ?? 0) > 0 && <> · {t("catalogNotice").replace("{count}", String(p.catalogNewEntries))}</>}
                </>}
          </p>
          {removedCount > 0 && applyBlocked && <p style={styles.banner}>⚠ {t("removalNeedsLive")}</p>}
          <div style={styles.modalActions}>
            {p.catalogSource === "local" && (
              <button type="button" style={{ ...styles.button, ...styles.secondary, marginRight: "auto" }} onClick={onOverlay}>
                {t("overlayBtn")}
              </button>
            )}
            <button ref={cancelRef} type="button" style={{ ...styles.button, ...styles.secondary }} onClick={onCancel}>{t("cancel")}</button>
            <button
              type="button"
              style={{ ...styles.button, ...styles.primary, ...(applyBlocked ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
              disabled={applyBlocked}
              onClick={confirmClick}
            >
              {t("applyChanges")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 「结束旧配置意图」确认弹窗（T11/B17b 简化版）：默认焦点在取消；Esc 取消；
// 只结束旧意图，不回滚或撤销已发生的更改。
function RetireDialog({ t, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  const surface = useRef(null);
  if (!surface.current) surface.current = sampleThemeSurface();
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div style={styles.modalMask} role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div style={{ ...styles.modal, background: surface.current.bg, color: surface.current.fg, maxWidth: 420 }}>
        <h4 style={styles.modalTitle}>{t("retireTitle")}</h4>
        <p style={styles.modalText}>{t("retireConfirmText")}</p>
        <div style={styles.modalActions}>
          <button ref={cancelRef} type="button" style={{ ...styles.button, ...styles.secondary }} onClick={onCancel}>{t("cancel")}</button>
          <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={onConfirm}>{t("retireBtn")}</button>
        </div>
      </div>
    </div>
  );
}

// 通用确认弹窗（退出登录等危险确认）：默认焦点在取消；Esc 等价取消（设计§5）。
function ConfirmDialog({ title, body, confirmText, cancelText, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  const surface = useRef(null);
  if (!surface.current) surface.current = sampleThemeSurface();
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div style={styles.modalMask} role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div style={{ ...styles.modal, background: surface.current.bg, color: surface.current.fg, maxWidth: 460 }}>
        <h4 style={styles.modalTitle}>{title}</h4>
        <p style={styles.modalText}>{body}</p>
        <div style={styles.modalActions}>
          <button ref={cancelRef} type="button" style={{ ...styles.button, ...styles.secondary }} onClick={onCancel}>{cancelText}</button>
          <button type="button" style={{ ...styles.button, ...styles.primary }} onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

function CopilotSection({ t = (key) => DICTS.en[key] ?? key }) {
  // 授权区：唯一驱动入口是 authFlow（串行控制器，T5）；刷新区沿用 refresh-flow（T11 改造）。
  const [auth, setAuth] = useState({ phase: "loading", connectivity: "online", shared: false });
  const [copied, setCopied] = useState(false);
  const [copyFail, setCopyFail] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [flow, setFlow] = useState(refreshInitial);
  const flowRef = useRef(flow);
  const authFlowRef = useRef(null);
  if (!authFlowRef.current && typeof fetch === "function") {
    // fetchImpl 必须显式注入（回归修复：v1.2.8 漏传导致授权状态机每次请求
    // 都在 requestJson 里变成 network-error——页面恒显「未登录」，点「授权登录」
    // 恒显「失败」且 POST 根本不发出；单测显式注入 fetchImpl 故未拦截）
    authFlowRef.current = createAuthFlow({ fetchImpl: fetch, onState: (s) => setAuth(s) });
  }

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
    void authFlowRef.current?.init();
    return () => authFlowRef.current?.dispose(); // 仅停止本页请求，不清宿主风险状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = () => {
    setCopied(false);
    setCopyFail(false);
    void authFlowRef.current?.start();
  };
  const checkStatus = () => {
    void authFlowRef.current?.refresh();
  };
  const doLogout = () => {
    setLogoutConfirm(false);
    void authFlowRef.current?.logout(); // 退出登录：单次调用，删后由 init 复核真实状态
  };

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyFail(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFail(true); // 设备码文本始终可手动选中复制
    }
  };

  const phase = auth.phase;
  const attempt = auth.attempt;
  const notices = [...(attempt?.notices ?? [])].reverse();
  const codeNotice = typeof attempt?.code === "string" && attempt.code !== ""
    ? { code: attempt.code, url: attempt.url }
    : (() => {
      const n = notices.find((x) => x && typeof x.code === "string" && x.code !== "");
      return n ? { code: n.code, url: n.url } : null;
    })();
  const badgeText = phase === "risk" ? t("riskBadge")
    : phase === "loading" ? t("loading")
    : phase === "idle" && auth.error ? t("statusUnknown") // 加载失败≠未登录，如实显示状态未知
    : t(phase);

  return (
    <div style={styles.section}>
      <h3 style={styles.title}>{t("title")}</h3>
      <p style={styles.intro}>{t("intro")}</p>
      <div style={styles.badgeRow}>
        <span style={{ ...styles.dot, background: badgeColor[phase] ?? "#adb5bd" }} />
        <span style={styles.badge}>{badgeText}</span>
      </div>
      {auth.connectivity !== "online" && phase !== "loading" && (
        <p style={styles.banner}>⚠ {t("connection")}</p>
      )}
      {auth.connectivity === "manual" && (
        <div>
          <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={checkStatus}>{t("retryNow")}</button>
        </div>
      )}
      {phase === "waiting" && (
        <>
          {auth.shared && <p style={styles.banner}>ⓘ {t("attemptShared")}</p>}
          {codeNotice && (
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
              {copyFail && <p style={styles.error}>{t("copyFailed")}</p>}
            </div>
          )}
        </>
      )}
      {phase === "risk" && (
        <div style={styles.card}>
          <p style={styles.banner}>⚠ {t("authUnsafe")}</p>
          {auth.riskKind === "timed-out-unverified" && <p style={styles.modalText}>{t("attemptTimeout")}</p>}
          <div>
            <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={checkStatus}>{t("retryNow")}</button>
          </div>
        </div>
      )}
      {phase === "unavailable" && (
        <p style={styles.banner}>⚠ {t("unavailable")}</p>
      )}
      {phase === "failed" && attempt?.error && (() => {
        // 网络层失败（undici 原话 "fetch failed (CODE)"，v1.2.18 起服务端附码）
        // → 人性化提示 + 弱化的原始失败码；其余错误维持原样展示
        const m = /^fetch failed \(([A-Za-z0-9_]+)\)$/.exec(attempt.error);
        if (!m) return <p style={styles.error}>{attempt.error}</p>;
        const code = m[1];
        const human = code === "ENOTFOUND" ? t("netDns")
          : code.startsWith("CERT") || code.includes("SIGNATURE") ? t("netCert")
          : t("netConnect");
        return (
          <>
            <p style={styles.error}>{human}</p>
            <p style={{ ...styles.modalText, opacity: 0.6 }}>{attempt.error}</p>
          </>
        );
      })()}
      {phase === "failed" && !attempt?.error && (
        <>
          <p style={styles.banner}>⚠ {httpErrorText(t, auth.error) ?? t("unknown")}</p>
          <div>
            <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={checkStatus}>{t("retryNow")}</button>
          </div>
        </>
      )}
      {phase === "idle" && auth.error && (
        <p style={styles.banner}>⚠ {httpErrorText(t, auth.error) ?? t("unknown")}</p>
      )}
      {phase === "authorized" && (
        <div style={styles.card}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {/* 退出登录（v1.2.10）：服务端确认无进行中尝试且无风险锁存时才可用，
                点击后经确认弹窗（logoutScope）执行凭据删除＋删后核实。
                「重新授权」按钮已移除（v1.2.11）：已登录只需退出登录，未登录
                入口本就是「授权登录」——独立的重新授权属逻辑冗余。 */}
            {(() => {
              const logoutAvailable = auth.status?.authorization?.capabilities?.logout === true;
              return (
                <button
                  type="button"
                  style={{ ...styles.button, ...styles.secondary, ...(logoutAvailable ? null : { opacity: 0.5, cursor: "not-allowed" }) }}
                  disabled={!logoutAvailable}
                  title={logoutAvailable ? t("logoutScope") : t("authUnsafe")}
                  onClick={() => setLogoutConfirm(true)}
                >{t("logout")}</button>
              );
            })()}
            {(["previewing", "applying", "checking", "retiring"].includes(flow.name)) ? (
              <button type="button" style={{ ...styles.button, ...styles.primary, opacity: 0.5 }} disabled>
                {flow.name === "applying" ? t("applying") : t("refreshing")}
              </button>
            ) : (
              <button
                type="button"
                style={{ ...styles.button, ...styles.primary, ...(refreshBlocked(flow.flags) ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
                disabled={refreshBlocked(flow.flags)}
                onClick={() => drive({ type: "start", operation: "manage" })}
              >
                {t("manageModels")}
              </button>
            )}
          </div>
          {auth.logoutError && (
            <p style={styles.error}>⚠ {auth.logoutError === "logout-unsafe" ? t("authUnsafe") : t("logoutFailed")}</p>
          )}
          {refreshBlocked(flow.flags) && (
            <p style={styles.banner}>⚠ {blockedReasonText(t, flow.flags)}</p>
          )}
          {flow.flags?.legacyStateDetected && (
            <p style={styles.banner}>ⓘ {t("legacy")}</p>
          )}
          {flow.name === "pendingRestart" && (
            <p style={styles.banner}>⚠ {t("pendingRestart")}</p>
          )}
          {flow.name === "busy" && (
            <p style={styles.banner}>ⓘ {t("busy")}</p>
          )}
          {flow.name === "resultUnknown" && (
            <>
              <p style={styles.error}>⚠ {t("unknownResult")}</p>
              <div>
                <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={() => drive({ type: "check" })}>{t("retryNow")}</button>
              </div>
            </>
          )}
          {flow.name === "result" && (
            <div>
              {(() => {
                const st = flow.result?.status;
                const key = {
                  applied: "applied",
                  conflict: "conflict",
                  partial: "partial",
                  "rolled-back": "rolledBack",
                  "rollback-conflict": "rollbackConflict",
                  "recovery-needed": "recoveryNeeded",
                  "intent-retired": "recoveryNeeded",
                }[st];
                return key
                  ? <p style={st === "applied" ? styles.banner : styles.error}>{st === "applied" ? "✓" : "⚠"} {t(key)}</p>
                  : null;
              })()}
              {["recovery-needed", "rollback-conflict", "intent-retired"].includes(flow.result?.status) && (
                <div>
                  <button type="button" style={{ ...styles.button, ...styles.secondary }} onClick={() => drive({ type: "retire-request" })}>
                    {t("retireBtn")}
                  </button>
                </div>
              )}
              {/* 技术详情只在真实失败时展示（v1.2.12）：成功路径的 changes 计数
                  与弹窗中的增删列表重复，属噪音——全局移除 */}
              {flow.result?.error && (
                <details style={styles.modalText}>
                  <summary>{t("techDetails")}</summary>
                  <span style={{ ...styles.mono, fontSize: 12 }}>{flow.result.error}</span>
                </details>
              )}
            </div>
          )}
          {flow.name === "failed" && (
            <p style={styles.error}>{flow.error === "state-corrupt" ? t("stateCorrupt") : flow.error}</p>
          )}
        </div>
      )}
      {flow.name === "confirming" && (
        <RefreshModal
          t={t}
          flow={flow}
          onSelect={({ selectedIds, clearOverrides, confirmEmpty }) => drive({ type: "select", selectedIds, clearOverrides, confirmEmpty })}
          onConfirm={(opts) => drive({ type: "confirm", ...opts })}
          onCancel={() => drive({ type: "cancel" })}
          onOverlay={() => drive({ type: "start", catalogSource: "overlay" })}
        />
      )}
      {flow.name === "retireConfirm" && (
        <RetireDialog
          t={t}
          onConfirm={() => drive({ type: "retire-confirm" })}
          onCancel={() => drive({ type: "cancel" })}
        />
      )}
      {logoutConfirm && (
        <ConfirmDialog
          title={t("logout")}
          body={t("logoutScope")}
          confirmText={t("logout")}
          cancelText={t("cancel")}
          onCancel={() => setLogoutConfirm(false)}
          onConfirm={doLogout}
        />
      )}
      {(phase === "idle" || phase === "failed") && (
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
