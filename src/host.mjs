// host 半区：cordis 插件。注册 4 条 exact 路由，把内置 github-copilot 的
// OAuth 设备码流（ctx.authorization）暴露给 Web client。零 GitHub 协议代码。
import { CREDENTIAL_KEY, emptyState, routes } from "./shared.mjs";

export const name = "copilot-auth";
export const inject = ["webServer", "authorization", "credentials", "settings", "llm"];

// 登录成功（或挂载时已登录）后，把账号可用模型写入用户 settings 的模型目录
// （turnkey，用户新增需求 2026-09-04）。
// 数据源取交集：凭据 payload.availableModelIds（账号可用）∩ ctx.llm.listModels
// （运行时目录已描述）。目录快照外的 id 必须排除——catalog 路由校验要求模型
// 的 wire 协议可解析（api = 路由设置 ?? 目录条目 ?? 路由共享协议），目录外 id
// 三者皆空会被整体拒绝；pi-ai 目录更新后它们会自然进入 listModels 集合。
// 注意：每次登录/挂载会用最新列表覆盖该目录，手工定制会被重置。
async function syncAvailableModels(ctx) {
  const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
  const available = record?.payload?.availableModelIds;
  if (!Array.isArray(available) || available.length === 0) return;
  const served = new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
  const ids = available.filter((id) => served.has(id));
  if (ids.length === 0) return;
  await ctx.settings.mutate("llm-pi-ai", [
    { op: "set", path: ["providers", "github-copilot", "models"], value: ids.map((id) => ({ id })) },
  ]);
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === null || origin === "") return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function json(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function guard(req, res, method) {
  if (!sameOrigin(req)) {
    json(res, 403, { ok: false, error: "forbidden origin" });
    return false;
  }
  if (req.method !== method) {
    json(res, 405, { ok: false, error: "method not allowed" });
    return false;
  }
  return true;
}

export function apply(ctx) {
  const r = routes();
  let attempt = emptyState();
  let lastSyncError;

  // 挂载时若已登录，同步一次模型目录（凭据持久化在本地，模型列表随账号刷新）。
  // 失败不静默：错误经 /status 的 syncError 字段暴露，便于诊断。
  const sync = () => syncAvailableModels(ctx).then(() => { lastSyncError = undefined; }).catch((err) => {
    lastSyncError = String(err?.message ?? err);
    ctx.logger?.warn?.("copilot-auth: model sync failed: %s", lastSyncError);
  });
  void sync();

  ctx.webServer.register({
    kind: "exact",
    path: r.start,
    handler: (req, res) => {
      if (!guard(req, res, "POST")) return;
      if (attempt.status === "running") {
        json(res, 409, { ok: false, error: "already running" });
        return;
      }
      attempt = emptyState();
      attempt.status = "running";
      const interaction = {
        notify: (notice) => {
          attempt.notices.push(notice);
        },
        prompt: (p) => {
          // 企业域名提问答空串（公司是普通 github.com 组织账号）；
          // 其余任何 prompt 都是未预期的，拒绝并使 attempt 失败。
          if (p && typeof p.message === "string" && p.message.includes("Enterprise")) {
            return Promise.resolve("");
          }
          return Promise.reject(new Error("unexpected prompt: " + (p?.message ?? String(p))));
        },
      };
      // 响应先行：begin 以后台任务执行，handler 返回路径不得 await begin。
      void ctx.authorization
        .begin({ key: CREDENTIAL_KEY, method: "oauth", interaction })
        .then((outcome) => {
          // AuthorizationOutcome.status: 'authorized' | 'cancelled'（types.d.ts L68-71）
          if (outcome && outcome.status === "authorized") {
            attempt.status = "authorized";
            void sync();
          } else {
            attempt.status = "failed";
            attempt.error = "登录已取消";
          }
        })
        .catch((err) => {
          attempt.status = "failed";
          attempt.error = String(err?.message ?? err);
        });
      json(res, 202, { ok: true });
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.state,
    handler: (req, res) => {
      if (!guard(req, res, "GET")) return;
      json(res, 200, attempt);
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.status,
    handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      // describeRecord 只回传 presence，不把含 token 的 GrantRecord 拉进内存。
      let configured = false;
      try {
        const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY);
        configured = info?.configured === true;
      } catch {
        configured = false;
      }
      json(res, 200, { configured, syncError: lastSyncError });
    },
  });

  ctx.webServer.register({
    kind: "exact",
    path: r.logout,
    handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      // 幂等契约：deleteRecord 对不存在记录是 no-op 且正常 resolve，
      // 真实删除与否由随后的 /status 反映。
      await ctx.credentials.deleteRecord(CREDENTIAL_KEY);
      json(res, 200, { ok: true });
    },
  });
}

export default { name, inject, apply };
