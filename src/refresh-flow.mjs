// refresh-flow.mjs — 「刷新可用模型目录」client 侧状态机。
// reduce 为纯函数（不执行 I/O）；runEffect/advance 只使用注入的 fetchImpl——
// 本模块不直接引用全局 fetch，所有网络能力经注入获得（node:test 可测）。
// 状态：idle → previewing → confirming → applying → restartNeeded / failed；
// apply 409 → previewing 自动重拉（Y2-1：409 响应不携带新 preview，client 重新
// POST preview）→ 成功进 confirming(staleNotice)；restartNeeded 可由 /status 水合。
import { routes } from "./shared.mjs";

export const initial = Object.freeze({ name: "idle" });

// reduce(state, event) → [nextState, effect | null]
// effect 为数据化指令：{type:"preview",mode} | {type:"apply",mode,digests} | {type:"status"}
export function reduce(state, event) {
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
        if (!event.status) return [state, null]; // status 拉取失败不硬失败
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
      return [state, null]; // previewing 期间忽略 start 等重复事件
    }
    case "confirming": {
      if (event.type === "start") {
        // catalogSource==="local" 时弹窗提供「改用内置覆盖层预览」：
        // 发 mode:"overlay" 的新 preview（不直接 apply，R2-5），新 diff 需再次确认
        return [{ name: "previewing", mode: event.mode, stale: false }, { type: "preview", mode: event.mode }];
      }
      if (event.type === "confirm") {
        return [
          { name: "applying", mode: state.mode, digests: state.preview.digests },
          { type: "apply", mode: state.mode, digests: state.preview.digests },
        ];
      }
      if (event.type === "cancel") return [initial, null];
      return [state, null];
    }
    case "applying": {
      if (event.type === "apply-ok") return [{ name: "restartNeeded" }, null];
      if (event.type === "apply-stale") {
        // 409 preview-stale：以原 mode 重新 preview（保持 overlay 来源，R2-5）
        return [{ name: "previewing", mode: state.mode, stale: true }, { type: "preview", mode: state.mode }];
      }
      if (event.type === "apply-fail") return [{ name: "failed", error: event.error }, null];
      return [state, null]; // applying 态忽略 confirm/start（双击只发一次）
    }
    default:
      return [state, null];
  }
}

// 副作用执行器：effect → 结果事件。只经注入的 fetchImpl 发请求。
export async function runEffect(effect, fetchImpl) {
  const r = routes();
  const post = (url, body) =>
    fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  if (effect.type === "preview") {
    try {
      const res = await post(r.refreshPreview, effect.mode ? { mode: effect.mode } : {});
      const body = await res.json();
      return res.status === 200 && body?.ok
        ? { type: "preview-ok", preview: body }
        : { type: "preview-fail", error: body?.error ?? `HTTP ${res.status}` };
    } catch (err) {
      return { type: "preview-fail", error: String(err?.message ?? err) };
    }
  }
  if (effect.type === "apply") {
    try {
      const res = await post(r.refreshApply, {
        digests: effect.digests,
        ...(effect.mode ? { mode: effect.mode } : {}),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409) return { type: "apply-stale" };
      return res.status === 200 && body?.ok
        ? { type: "apply-ok" }
        : { type: "apply-fail", error: body?.error ?? `HTTP ${res.status}` };
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

// controller：reduce → 执行 effect → 结果事件回送 reduce → 循环至无 effect。
// client.jsx 必须只经 advance 驱动状态机，不直接调 reduce/runEffect。
// onState 在每个 reduce 步同步回调（含 effect 执行前）——UI 借此即时落中间态
// （applying 期间重复 confirm 被 reducer 忽略，双击只发一次）。
export async function advance(state, event, fetchImpl, onState) {
  let [s, fx] = reduce(state, event);
  onState?.(s);
  while (fx) {
    const resultEvent = await runEffect(fx, fetchImpl);
    [s, fx] = reduce(s, resultEvent);
    onState?.(s);
  }
  return s;
}
