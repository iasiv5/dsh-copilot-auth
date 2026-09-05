// host 半区：cordis 插件。注册 4 条 exact 路由，把内置 github-copilot 的
// OAuth 设备码流（ctx.authorization）暴露给 Web client。零 GitHub 协议代码。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { CREDENTIAL_KEY, emptyState, routes } from "./shared.mjs";

export const name = "copilot-auth";
export const inject = ["webServer", "authorization", "credentials", "settings", "llm"];

// 读取 pi-ai 内置目录的 github-copilot 模型 id → 协议映射。数据文件位于 dsh
// 安装树内的 @earendil-works/pi-ai；从进程入口（dsh 可执行文件）逐级向上定位，
// 只读不改。定位/解析失败返回 null（调用方回退 listModels 交集，见下）。
function readCatalogModelIds() {
  try {
    let dir = dirname(realpathSync(process.argv?.[1] ?? ""));
    for (let depth = 0; depth < 8; depth++) {
      const dataFile = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "github-copilot.json");
      if (existsSync(dataFile)) {
        const data = JSON.parse(readFileSync(dataFile, "utf8"));
        const byId = {};
        for (const [api, section] of Object.entries(data)) {
          for (const id of Object.keys(section ?? {})) byId[id] ??= api;
        }
        return byId;
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch { /* 安装树结构变化时回退 */ }
  return null;
}

// 登录成功后，把账号可用模型写入用户 settings 的模型目录
// （turnkey，用户新增需求 2026-09-04；目录保护，用户反馈 2026-09-05）。
// 可写集合取交集：凭据 payload.availableModelIds（账号可用）∩ 内置目录已描述。
// 目录快照外的 id 必须排除——catalog 路由校验要求模型的 wire 协议可解析
// （api = 路由设置 ?? 目录条目 ?? 路由共享协议），目录外 id 三者皆空会被整体
// 拒绝；pi-ai 目录更新后它们会自然进入可写集合。
// 目录保护（2026-09-05）：该路由已配置模型目录（models 键存在，含空列表）或
// modelOverrides 时视作用户所有，同步直接让路——用户在 Models 页精简过的目录
// 不会被重置。只有目录尚不存在时才填充一次；想重置全量，删掉 settings.yaml
// 里该路由的 models 列表后重新登录即可。

// 读取解析后的 github-copilot 路由配置（base 层 + 用户层的最终值）。
// settings 未注入 / 未注册 / 读取失败一律按空处理——回退到可写入分支，
// 保持既有 turnkey 行为不变。
function readConfiguredRoute(ctx) {
  try {
    const section = ctx.settings?.get?.("llm-pi-ai");
    return section?.providers?.["github-copilot"] ?? {};
  } catch {
    return {};
  }
}

async function syncAvailableModels(ctx) {
  const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
  const available = record?.payload?.availableModelIds;
  if (!Array.isArray(available) || available.length === 0) return;
  const route = readConfiguredRoute(ctx);
  const modelsConfigured = route.models !== undefined && route.models !== null;
  const overridesConfigured = !!route.modelOverrides
    && typeof route.modelOverrides === "object"
    && Object.keys(route.modelOverrides).length > 0;
  if (modelsConfigured || overridesConfigured) return;
  const catalog = readCatalogModelIds();
  let ids;
  if (catalog) {
    ids = available.filter((id) => catalog[id] !== undefined);
  } else {
    // 回退：listModels 反映当前已配置列表，存在「已配置→只见已配置」自锁，
    // 仅作目录定位失败时的降级。
    const served = new Set((await ctx.llm.listModels("github-copilot")).map((m) => m?.id).filter(Boolean));
    ids = available.filter((id) => served.has(id));
  }
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

  // 模型目录同步只在登录成功后执行（2026-09-05 对齐结论：挂载不再同步）。
  // 插件启动/重启绝不触碰用户 settings，用户精简过的目录不会被动重置。
  // 失败不静默：错误经 /status 的 syncError 字段暴露，便于诊断。
  const sync = () => syncAvailableModels(ctx).then(() => { lastSyncError = undefined; }).catch((err) => {
    lastSyncError = String(err?.message ?? err);
    ctx.logger?.warn?.("copilot-auth: model sync failed: %s", lastSyncError);
  });

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
