# 管理模型列表实时证据自动续期＋缓存原因分型文案＋busy 卡死出口（实施计划）

## 目标

移除类更改要求 live 账号证据（`removals-need-live` 门），但 live 拉取依赖凭据记录里的短命 tid（`access`，24h 窗口、由 pi-ai 在模型调用时懒刷新）。tid 过期时 live 拉取 401、静默回退缓存，用户在弹窗里只看到"需要实时账号证据"，无出路（2026-10-16 实录：缓存时间戳冻结在 10-15 12:23Z、tid exp=10-16 01:39Z，用户手工"发一条模型消息"后才恢复）。

本计划三件事：

1. **preview 通道静默自愈（N1）**：`resolveAccountEvidence` 发现 `access` 过期且记录带 `refresh`（ghu）时，用一次 `copilot_internal/v2/token` 调用铸一枚**仅存内存**的新 tid，用它完成 live 拉取。成功→证据直接 live，移除可应用；失败→行为与今天逐字节一致（静默回退有效缓存）。不新增任何 UI 控件。
2. **缓存原因分型文案（N3）**：preview 投影新增 `evidence.reason`，弹窗来源行按原因给出精确解释与出路（先用一次模型 / 重新授权 / 稍后重试）。不新增任何 UI 控件。
3. **busy 卡死出口（know-how 032 并入，2026-10-16 主人拍板"两个都并入"）**：apply 撞 423 后若卡死操作 `phaseResult.status === "recovery-needed"`——(a) 页面刷新水合不再被旧 `lastResult`（如旧 "applied"）遮蔽，直接落入 busy；(b) busy 态复用**既有**「结束旧配置意图」按钮（retireBtn 文案、retireConfirm 弹窗、retire 事件链全部现成），不新增控件种类与文案键。032 §4-3（auth start 的 bump 挪到 409 门禁后）属授权子系统，**不并入**本计划，留作独立后续。

## 设计依据

- 会话共识（2026-10-16 脑暴＋钢人）：N1+N3 组合；N2（apply 通道自愈）、N4（上游 ensure-fresh 路由）、N5（放宽 Q35）均否决/搁置。
- pi-ai 续期语义对照：`@earendil-works/pi-ai` `dist/auth/oauth/github-copilot.js` 的 `refreshGitHubCopilotAccessToken`（0.87.1 L244-270；017 §8 已证 0.85.1↔0.87.1 该文件 diff 为空）。
- busy 死锁定谳与产品缺口：`01_docs/dsh-intall-know-how/032-copilot-auth-refresh-busy-intent-drift.md`（§2 时序链、§4 缺口清单；本计划 Task 4 落地 §4-1/§4-2）。

## 全局约束（逐字继承，违反即停）

1. **证据自愈（N1/N3）不新增任何 UI 控件**（按钮/输入框/开关），只改文案与既有渲染分支；032 并入部分不新增控件**种类**——仅扩展既有 retireBtn 的可见条件至 busy 态。
2. **不写凭据库**：续期所得 access 只存进程内存（闭包变量），绝不触任何凭据写路径；`llm-pi-ai/github-copilot` 记录内容不得被本插件修改。
3. **不削弱门禁**：`removals-need-live` 判定、Q36 自动升级闩锁、软降级语义（一切失败仍回退有效缓存）零改动。
4. **pi-ai 抄录留痕**：v2/token 语义抄进 `copilot-models.mjs` 时必须在文件头注释延续"显式耦合 pi-ai …勿改值"惯例；错误消息保真抄录、不合并。
5. **协议只增不改**：preview 投影新增 `evidence.reason`，不改既有字段；`PROTOCOL_VERSION` 不变（同包发布 client+server）。
6. **失败不重试**：v2/token 与 /models 均单次尝试；负缓存 5 分钟由注入时钟驱动，不用真实 setTimeout；ephemeral tid 按 exp 在内存复用，不过期不重铸。
7. **水合判序钉死判据**：activeOperation 仅在 `phaseResult.status === "recovery-needed"` 时优先于旧 `lastResult`；正常 pending-restart 流程的水合行为不得改变（用例 B 守卫）。
8. **测试桩与生产键名一致**：header 断言一律用生产实际键名（`Authorization`/`User-Agent`，大小写敏感）；禁止为迁就测试把生产 header 改成小写（会打翻既有 copilot-models 用例）。

## 架构快照

```
preview(body)                                  refresh-service.mjs
  └─ resolveAccountEvidence                    （移入 createRefreshService 闭包）
       ├─ payload = credentials.readRecord(CREDENTIAL_KEY).payload
       ├─ expMs = parseAccessExpiryMs(payload.access)        ← copilot-models.mjs（新）
       ├─ access 过期且有 refresh：
       │    ├─ ephemeral 新鲜（未过 exp）→ 直接复用，不打续期
       │    ├─ 负缓存期内 → 沿用上次失败原因，跳过 live GET
       │    └─ 否则 refreshEphemeralAccess({refresh,…})       ← copilot-models.mjs（新）
       │         ├─ 成功 → ephemeral（闭包内存），access=新 tid
       │         └─ 失败 → healBlockedUntil=now+5min，reason=token-rejected|network
       ├─ GET /models（access = ephemeral ?? payload.access）
       │    ├─ 成功 → source:"live", reason:null（写缓存，原样）
       │    └─ 401/403 → reason:"token-rejected"；其他 → reason:"network"（回退缓存，原样）
       └─ 回退缓存/stale 时 evidence 带 reason
preview 投影 projectPreview
  └─ evidence: { source, fetchedAt, stale, reason }           ← 只增一个字段
client sourceLine（client.jsx L373-377 cache 分支）
  └─ 按 reason 选 srcCache{Expired|Rejected|Network|NoSession}，无 reason 用 srcCache
```

```
hydrate（refresh-flow.mjs idle 分支 L114-128，032 并入）
  ├─ 现：lastResult.status ∈ 已知集（含旧 "applied"）先命中（L122-124）→ 卡死的 activeOperation 被遮蔽
  └─ 改：`activeOperation.phaseResult.status === "recovery-needed"` → 直接落 busy（携 active），置于 L119/L122 两判之前
busy 出口（client.jsx L747＋refresh-flow.mjs L108/L272-282）
  ├─ busy 渲染横幅保留；`flow.active?.phaseResult?.status === "recovery-needed"` 时渲染既有 retireBtn
  ├─ reducer：busy 态新增 retire-request 分支 → retireConfirm（携 active）；confirm 取 operationId = result?.operationId ?? active?.operationId
  ├─ retire-fail：retiring 态携有 active 时回 busy（携 retireError），无 active 维持现行 result 落点
  └─ retireConfirm cancel：有 active 时回 busy（回 result 仅限 result 入口）；retire-ok → checking + status（既有）
```

reason 枚举（全计划唯一写法定义）：`"access-expired" | "token-rejected" | "network" | "no-session"`，成功为 `null`。

## 文件结构与职责

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/copilot-models.mjs` | 修改 | 新增 `parseAccessExpiryMs`、`refreshEphemeralAccess`；文件头抄录留痕 |
| `src/refresh-service.mjs` | 修改 | `resolveAccountEvidence` 移入闭包并接自愈＋reason 分类；`projectPreview` 增 reason；`dispose` 清自愈态 |
| `src/client.jsx` | 修改 | zh/en 文案表各增 4 键；`sourceLine` cache 分支按 reason 分流；busy 态按条件渲染既有 retireBtn 与 retireError |
| `src/refresh-flow.mjs` | 修改 | hydrate 判序（recovery-needed 的 activeOperation 优先）；busy 态 retire-request／retireConfirm 双入口／cancel 与 retire-fail 回 busy；文件头注释同步 |
| `test/refresh-flow.test.mjs` | 修改 | 水合遮蔽回归、pending-restart 守卫、busy retire 闭环（含 retire-fail 回 busy）、判据外不出口 4 个用例 |
| `test/copilot-models.test.mjs` | 修改 | 两个新导出的用例 |
| `test/refresh-service.test.mjs` | 修改 | harness 支持过期 token＋v2/token 桩＋models 500；6 个新用例；修默认 token 为远未来 exp |
| `README.md` | 修改 | 测试计数（全部出现处）、管理模型列表节补自动续期与 busy 出口说明 |
| `package.json` | 修改 | version 1.2.21；description 追加版本句 |

不改动：`refresh-transaction.mjs`、`host.mjs`、`model-update.mjs`、`auth-host.mjs`、`auth-flow.mjs`、`cordis.patch.yml`、`PROTOCOL_VERSION`。

## 任务清单

执行环境：bash、node ≥20；以下命令一律在仓库根 `~/workspace/dsh-copilot-auth` 执行。

### Task 1：copilot-models.mjs——exp 解析与 ephemeral 续期

- [ ] Step 1.1 失败测试先行：`test/copilot-models.test.mjs` 增用例（沿既有 fetch 桩风格，header 断言键名与生产一致、大小写敏感——约束 8）：
  - `parseAccessExpiryMs`：`"tid=1;exp=2000;proxy-ep=proxy.individual.githubcopilot.com;"` → `2000000`；无 exp → `null`；`undefined` → `null`；非数字 exp → `null`。
  - `refreshEphemeralAccess` 成功：fetch 桩断言 URL 为 `https://api.github.com/copilot_internal/v2/token`、`Authorization` 为 `Bearer ghu-x`、headers 含 `User-Agent: GitHubCopilotChat/0.35.0` 且**不含** `X-GitHub-Api-Version`；响应 `{ token: "tid=2;exp=999999;", expires_at: 1000000 }` → 返回 `{ access: "tid=2;exp=999999;", expiresAtMs: 999700000000 }`（= 1000000×1000 − 300000，5 分钟提前量断言）。
  - `refreshEphemeralAccess` 带 `enterpriseUrl: "ghe.com"` → URL 为 `https://api.ghe.com/copilot_internal/v2/token`。
  - 失败分型（错误消息保真抄录，约束 4）：桩返回 401 → throw 且 `err.status === 401`；响应非对象 → throw `Invalid Copilot token response`；响应缺 `token`/`expires_at` → throw `Invalid Copilot token response fields`；桩网络 throw → 原样上抛。
- [ ] Step 1.2 确认失败：`node --test test/copilot-models.test.mjs` → 新用例全红（导出不存在）。
- [ ] Step 1.3 最小实现：`src/copilot-models.mjs`
  - 文件头注释（L2-6 区域）追加一行：`// v1.2.21 增抄：copilot_internal/v2/token 续期语义抄录自 pi-ai dist/auth/oauth/github-copilot.js refreshGitHubCopilotAccessToken（0.84.4 与 0.87.1 该函数 diff 为空）；ephemeral 使用、绝不落库。`
  - `export function parseAccessExpiryMs(access)`：`/exp=(\d+)/` 匹配 `String(access ?? "")`，命中返回 `Number(m[1]) * 1000`，否则 `null`。
  - `export async function refreshEphemeralAccess({ refreshToken, enterpriseUrl, fetchImpl } = {})`：`refreshToken` 非串或 `fetchImpl` 非函数 → throw `Error("refreshToken and fetchImpl required")`；`const domain = normalizeDomain(enterpriseUrl) ?? "github.com"`；`const url = \`https://api.${domain}/copilot_internal/v2/token\``（`api.` 前缀与 pi-ai getUrls 一致）；GET 该 url，headers `{ Accept: "application/json", Authorization: Bearer ${refreshToken}, ...COPILOT_HEADERS }`，`signal: AbortSignal.timeout(5000)`；`!response.ok` → throw `Object.assign(new Error(\`${status} ${statusText}: GET ${url}\`), { status })`；`raw` 非对象 → throw `Error("Invalid Copilot token response")`（对齐 0.87.1 L261）；`raw.token` 非串或 `raw.expires_at` 非数 → throw `Error("Invalid Copilot token response fields")`（对齐 0.87.1 L264，两条消息不合并）；返回 `{ access: raw.token, expiresAtMs: raw.expires_at * 1000 - 5 * 60 * 1000 }`。
- [ ] Step 1.4 验证：`node --test test/copilot-models.test.mjs` 全绿；`node --test test/refresh-service.test.mjs` 仍全绿（本任务不改调用方）。

### Task 2：refresh-service.mjs——闭包自愈＋reason 分类＋投影

Consumes：Task 1 的 `parseAccessExpiryMs(access)`、`refreshEphemeralAccess({ refreshToken, enterpriseUrl, fetchImpl })`（签名见 Task 1 Step 1.3）。
Produces：preview 投影 `evidence.reason`（枚举见架构快照）。

- [ ] Step 2.1 失败测试先行：`test/refresh-service.test.mjs`
  - 修常量：文件顶部 `INDIVIDUAL_TOKEN` 改为 `"tid=1;exp=100000000;proxy-ep=proxy.individual.githubcopilot.com;"`（远未来，保证既有"无 refresh 也 live"用例不因新过期分支而翻车）；新增局部常量 `const EXPIRED_TOKEN = "tid=1;exp=1;proxy-ep=proxy.individual.githubcopilot.com;"`。
  - harness 增强：`makeHarness` 参数增 `heal = "ok" | "reject" | "netfail"`（"off" 不设——未过期路径天然零调用，无需桩缺席模式）；`live` 模式扩展为 `"ok" | "fail"(401) | "500"`（`"500"` → `streamRes({}, 500)`）；`fetchImpl` 签名改 `(url, init)` 并把每次调用记入 `calls.push({ url, auth: init?.headers?.Authorization })`（键名大小写与生产一致——约束 8；既有用例不受影响）；新增分支 `url.includes("/copilot_internal/v2/token")` → `heal==="ok"` 返回 `streamRes({ token: "tid=9;exp=999999;", expires_at: Math.floor(t.now/1000)+3600 }, 200)`、`"reject"` 返回 401、`"netfail"` throw `Error("connect ECONNREFUSED")`；计数器 `counters.token += 1`；`record` 参数已支持透传 payload，无需再改。
  - 6 个新用例（断言均走 `p.evidence` 与 `calls`）：
    1. 过期＋refresh＋heal ok → `source:"live"`、`reason:null`；`calls` 中 /models 请求的 `auth` 为桩签发的新 tid；`counters.token === 1`；第二次 preview 仍 `counters.token === 1`（ephemeral 复用，不再打 v2/token）。
    2. 过期＋无 refresh → 沿本文件既有 cache 用例的夹具写法（向 `scope.dataDir` 写有效 `account-model-cache.json`）→ `source:"cache"`、`reason:"access-expired"`，`counters.token === 0`。
    3. 过期＋refresh＋heal reject → `reason:"token-rejected"`、回退缓存；同分钟内第二次 preview `counters.token === 1`（负缓存）；`t.now += 6*60*1000` 后第三次 preview `counters.token === 2`（负缓存解封）。
    4. 过期＋refresh＋heal netfail → `reason:"network"`。
    5. 未过期 access → `counters.token === 0`（不打续期）。
    6. 未过期 access＋models 401（`live:"fail"`）→ `reason:"token-rejected"`；models 500（`live:"500"`）→ `reason:"network"`。
  - 结构守卫：用例 1 末尾断言 `h.ctx.credentials.writeRecord === undefined`——本插件对凭据库无写原语；若未来有人给 harness 加写方法，此断言即提醒必须补"零写调用"断言。
- [ ] Step 2.2 确认失败：`node --test test/refresh-service.test.mjs` → 新用例红（reason 字段缺失/行为不符）。
- [ ] Step 2.3 最小实现：`src/refresh-service.mjs`
  - 常量区（L16-17 旁）增 `const HEAL_RETRY_MS = 5 * 60 * 1000;`；import 行（L14）增 `parseAccessExpiryMs, refreshEphemeralAccess`。
  - 把模块级 `resolveAccountEvidence`（L32-61）整体移入 `createRefreshService` 闭包（`requireScope` 之前），签名改 `async function resolveAccountEvidence({ clock, fetchImpl })`，内部直接用闭包 `ctx/scope/readIntentVersion`；原调用点（preview 内）同步改参。
  - 闭包新增状态：`let ephemeral = null; let healBlockedUntil = 0; let healBlockedReason = null;`
  - 证据逻辑（替换原 L42-52 段）：
    1. `payload` 读取不变；`reason = null`；`access = payload?.access`。
    2. `access` 缺失 → `reason = "no-session"`，跳到缓存回退（不发请求）。
    3. `expMs = parseAccessExpiryMs(access)`；`accessExpired = expMs !== null && expMs <= clock.now()`。
    4. `accessExpired` 且 `payload.refresh` 为非空串，按序三分支：
       a. **复用**：`ephemeral && clock.now() < ephemeral.expiresAtMs` → `access = ephemeral.access`（不打续期），径入第 6 条 live GET；
       b. **负缓存**：否则若 `clock.now() < healBlockedUntil` → `reason = healBlockedReason ?? "access-expired"`，跳过 live GET；
       c. **续期**：否则 try `refreshEphemeralAccess({ refreshToken: payload.refresh, enterpriseUrl: payload.enterpriseUrl, fetchImpl })` → 成功：`ephemeral = 结果`、`healBlockedUntil = 0`、`healBlockedReason = null`、且 `clock.now() < ephemeral.expiresAtMs` 时 `access = ephemeral.access`；失败 e：`healBlockedUntil = clock.now() + HEAL_RETRY_MS`、`healBlockedReason = (e?.status === 401 || e?.status === 403) ? "token-rejected" : "network"`、`reason = healBlockedReason`，跳过 live GET。
    5. `accessExpired` 且无 refresh → `reason = "access-expired"`，跳过 live GET。
    6. live GET（`fetchLiveAvailableModelIds({ credential: { ...payload, access }, fetchImpl })`）成功 → 写缓存原样，返回 `{ source: "live", ids, fetchedAt, stale: false, reason: null }`；失败 e → `(e?.status === 401 || e?.status === 403) ? reason = "token-rejected" : reason = "network"`，落缓存回退。
    7. 缓存/stale 两个返回值各带 `reason`。
  - `projectPreview`（L177）evidence 投影增 `reason: snap.evidence.reason ?? null`。
  - `dispose()`（L281-283）清 `ephemeral/healBlockedUntil/healBlockedReason`；文件头注释（L3）补"过期 tid 时经 v2/token 铸 ephemeral tid（内存、不落库、单次尝试、负缓存 5min、按 exp 复用）"。
- [ ] Step 2.4 验证：`node --test test/refresh-service.test.mjs` 全绿；`npm test` 全绿（全仓回归，含 apply 门与 Q36 用例不受影响）。

### Task 3：client.jsx——reason 分型文案与来源行分流

Consumes：Task 2 的 `evidence.reason` 枚举 `"access-expired" | "token-rejected" | "network" | "no-session"`。

- [ ] Step 3.1 zh 文案（`src/client.jsx` L160 `srcCache` 之后插入，键名照抄）：
  - `srcCacheExpired: "账号模型：缓存，获取于 {time}。会话令牌已过期，未能自动续期——先用任一 Copilot 模型对话一次；若仍失败，请退出登录并重新授权。"`
  - `srcCacheRejected: "账号模型：缓存，获取于 {time}。本地令牌被 GitHub 拒绝（可能已在另一台设备重新授权）——请退出登录并重新授权。"`
  - `srcCacheNetwork: "账号模型：缓存，获取于 {time}。暂时无法获取实时证据——稍后重开此窗口重试。"`
  - `srcCacheNoSession: "账号模型：缓存，获取于 {time}。本地无会话令牌——请先完成授权。"`
- [ ] Step 3.2 en 文案（en 表 `srcCache` 之后插入，与 zh 一一对应）：
  - `srcCacheExpired: "Account models: cached at {time}. The session token is expired and could not be auto-renewed — chat with any Copilot model once; if it still fails, sign out and authorize again."`
  - `srcCacheRejected: "Account models: cached at {time}. The local token was rejected by GitHub (possibly re-authorized on another device) — sign out and authorize again."`
  - `srcCacheNetwork: "Account models: cached at {time}. Live evidence is temporarily unreachable — reopen this dialog later to retry."`
  - `srcCacheNoSession: "Account models: cached at {time}. No local session token — authorize first."`
- [ ] Step 3.3 渲染分流：`sourceLine`（L373-377）cache 分支改为按 `p.evidence?.reason` 取键——组件外新增纯函数 `cacheCopyKey(reason)`：`"access-expired"→"srcCacheExpired"`、`"token-rejected"→"srcCacheRejected"`、`"network"→"srcCacheNetwork"`、`"no-session"→"srcCacheNoSession"`、其余→`null`；cache 分支写为 `(cacheCopyKey(p.evidence?.reason) ? t(cacheCopyKey(p.evidence?.reason)) : t("srcCache")).replace("{time}", String(p.evidence?.fetchedAt ?? ""))`。`srcCache` 原文保留作 null-reason 兜底；`removalNeedsLive` 横幅、`applyBlocked`、staleNotice 均不动。
- [ ] Step 3.4 验证（本仓库无 client 渲染测试夹具，用可观察产物断言）：
  - `npm run build` 成功；
  - `grep -c "srcCacheExpired" lib/client.js` ≥ 2（zh+en 双份）；同法查 `srcCacheRejected/srcCacheNetwork/srcCacheNoSession`；
  - `npm test` 全绿（client-http 等既有用例零回归）。

### Task 4：refresh-flow 水合判序＋busy 态 retire 出口（032 并入）

Consumes：既有服务端能力（`POST /refresh/retire` host.mjs:727、`/status.refresh.activeOperation` host.mjs:589，均在位，零服务端改动）。独立于 Task 1-3，无接口依赖。
Produces：水合与 busy 态行为变更；retireConfirm 双入口（result 入口携 `result`／busy 入口携 `active`）；retire-fail 回 busy。

- [ ] Step 4.1 失败测试先行：`test/refresh-flow.test.mjs`（沿既有 hydrate／retire 闭环用例的桩写法）：
  - 用例 A（水合遮蔽回归，复刻 032 §2）：idle 态派发 hydrate，`/status` 返回 `refresh.activeOperation = { operationId: "op-stuck", phaseResult: { status: "recovery-needed", error: "intent-version-drift" } }` 且 `refresh.lastResult = { status: "applied", … }` → 断言落 `busy`（`state.active.operationId === "op-stuck"`），不再落 `result`。
  - 用例 B（pending-restart 守卫）：`lastResult.status` ∈ restartStates 且 `activeOperation.phaseResult.status` 非 recovery-needed（如 `"pending-restart"`）→ 水合仍落 `pendingRestart`（本用例当前应已绿，作判据钉死守卫）。
  - 用例 C（busy retire 闭环，含失败回路）：busy（active 为 recovery-needed）→ 派发 `retire-request` → 落 `retireConfirm`（携 active）→ 派发 `retire-confirm` → 落 `retiring`（携 active）且 retire effect 的 operationId 为 `active.operationId` → 派发 `retire-ok` → 落 `checking` 并发 status effect；**另构造一遍同链路改派 `retire-fail`** → 回 `busy`（携 active 与 retireError），不落空 `result`。
  - 用例 D（判据外不出口＋cancel 回 busy）：busy 且 `phaseResult.status` 非 recovery-needed → `retire-request` 不响应（保持 busy）；retireConfirm（busy 入口）派发 `cancel` → 回 `busy`（携 active），不落 `result`。
- [ ] Step 4.2 确认失败：`node --test test/refresh-flow.test.mjs` → A/C/D 红，B 绿（守卫）。
- [ ] Step 4.3 最小实现：
  - `src/refresh-flow.mjs` idle 分支 hydrate：在 L118 `const base = …` 之后、L119 restartStates 判定之前插入 `if (refresh?.activeOperation?.phaseResult?.status === "recovery-needed") return [{ ...base, name: "busy", active: refresh.activeOperation }, null];`
  - reducer 顶层（L108 result 态 retire-request 旁）增 busy 分支：`if (event.type === "retire-request" && state.name === "busy" && state.active?.phaseResult?.status === "recovery-needed") return [{ name: "retireConfirm", active: state.active }, null];`
  - `retireConfirm` case（L272-277）：`retire-confirm` 的落点改 `{ name: "retiring", operationId: state.result?.operationId ?? state.active?.operationId, result: state.result, active: state.active }`；`cancel` 改 `state.active ? [{ name: "busy", active: state.active }, null] : [{ name: "result", result: state.result }, null]`。
  - `retiring` case（L279-282）：`retire-fail` 改 `state.active ? [{ name: "busy", active: state.active, retireError: event.error }, null] : [{ name: "result", result: state.result, retireError: event.error }, null]`（result 入口行为不变；busy 入口不再落空 result 死端）。
  - `src/client.jsx` busy 渲染（L747-748）：横幅保留；`flow.active?.phaseResult?.status === "recovery-needed"` 时在横幅下渲染既有 retire 按钮（复制 L775-779 的按钮 JSX，`onClick` 同 `drive({ type: "retire-request" })`，文案同 `t("retireBtn")`）；`flow.retireError` 存在时在横幅文本后以括号附加原文（不加文案键）。
  - `src/refresh-flow.mjs` 文件头注释（L3-6）同步补一行：hydrate 新判序（recovery-needed 的 activeOperation 优先）与 busy 态 retire 入口/失败回路。
- [ ] Step 4.4 验证：`node --test test/refresh-flow.test.mjs` 全绿；`npm test` 全绿；`npm run build` 成功。

### Task 5：README 与版本元数据

- [ ] Step 5.1 `README.md`：`grep -n "210" README.md` 找出测试计数的**全部**出现处（当前为 L56 特性表与 L133 命令注释两处，以 grep 实际输出为准），逐处更新为新总数；"管理模型列表"节补两句：①移除前的实时证据会在本地会话令牌过期时自动续期（仅内存、不落库），续期失败时来源行会给出原因与出路；②apply 撞 423 且旧操作已 recovery-needed 时，弹窗与刷新后的页面均提供「结束旧配置意图」出口（know-how 032 缺口闭环）。
- [ ] Step 5.2 `package.json`：`"version": "1.2.21"`；description 句尾追加"v1.2.21：移除前实时证据自动续期（ephemeral 不落库＋负缓存 5min）＋缓存证据原因分型文案＋busy 卡死 retire 出口与水合判序修正（032）。"（沿用既有"v1.2.x：…"句式）。
- [ ] Step 5.3 验证：`grep '"version"' package.json` 为 1.2.21；`grep -c "v1.2.21" package.json` ≥ 1；`grep -n "210 条" README.md` 零命中（新计数 ≠ 210 时）且新计数与 `npm test` 输出一致。

## 接口契约（跨任务复述）

- `parseAccessExpiryMs(access: string|undefined) → number|null`（Task 1 产，Task 2 消）。
- `refreshEphemeralAccess({ refreshToken, enterpriseUrl, fetchImpl }) → Promise<{ access: string, expiresAtMs: number }>`；失败 throw，`e.status` 仅在 HTTP 非 2xx 时存在（Task 1 产，Task 2 消）。
- `evidence.reason ∈ { null, "access-expired", "token-rejected", "network", "no-session" }`（Task 2 产，Task 3 消；键映射见 Task 3 Step 3.3）。
- `activeOperation.phaseResult.status === "recovery-needed"`：busy 出口的唯一判据（/status 原样透传，host.mjs:589；语义见 032 §2）——Task 4 消费，零服务端改动。
- retireConfirm 双入口：result 入口携 `result`（既有，L109），busy 入口携 `active`（Task 4 新增）；confirm 的 operationId 取 `result?.operationId ?? active?.operationId`；`retire-fail` 有 active 回 busy（携 retireError）、无 active 维持现行 result 落点。

## 风险与回退

1. **自愈失败 = 现状逐字节**：v2/token 或 /models 任何失败都走既有"静默回退有效缓存"软降级，唯一新增是 `evidence.reason` 字段（只增、旧消费方忽略），N1 失败不会比今天更坏。
2. **水合判序回归面**：判据钉死 `recovery-needed`，正常 pending-restart 流程不受影响（用例 B 为常绿守卫）；非法/缺失 `phaseResult` 时条件为假、走原顺序，天然降级。
3. **`resolveAccountEvidence` 移入闭包**属等价重构（无外部导出消费者），全量 `npm test` 兜底；自愈三态（ephemeral/负缓存/原因）均为进程内存，`dispose()`/服务重启即清，无持久化格式变更。
4. **回退 = 单 commit revert**：无数据迁移、无持久格式变更；`evidence.reason` 字段层面向前兼容（旧 client 忽略未知字段）。上线后若复发 032 类死锁，仍可按 032 §3 的 retire API 手工处置兜底。

## 执行纪律

- 开始实现前先批判性复查本计划；发现缺项/矛盾/与仓库现实不符，先修计划再动手。
- 按任务顺序执行；每完成一步跑该步验证；禁止无声跳步或合并任务。
- 遇到与计划冲突的仓库现实（如 `resolveAccountEvidence` 已被移出/重命名、`refresh-flow.mjs` 分支行段漂移、测试骨架失配），立即停下说明，不要猜。
- 当前分支若为 main/master，先经主人确认再开始。
- tag/发版不在本计划内，全部任务完成后由主人另行拍板。

## 最终验证

1. `npm test` 全绿（记录用例总数）。
2. `npm run build` 成功且 `lib/client.js` 含 4 个新文案键（各 ≥2 次）。
3. `node --test test/refresh-flow.test.mjs` 用例 A–D 全绿（032 回归守卫）。
4. 手工冒烟（可选，主人配合）：①tid 过期态下打开管理模型列表 → 来源行显示"实时获取"，取消勾选一个在列模型 → 应用更改成功；②若现场存在 032 卡死操作（`/status.refresh.activeOperation` 非空且 recovery-needed），刷新页面 → busy＋「结束旧配置意图」按钮可见，点击确认后可重新 apply。journal 无新报错。

## 勘误注（执行期发现，2026-10-16 归档补记，评审 R1-1/R1-2）

1. Step 1.1「expiresAtMs: 999700000000」为字面值笔误：按其公式（1000000×1000 − 300000）正确值为 **999700000**。实现与测试均按公式执行，正确。
2. Step 2.1「INDIVIDUAL_TOKEN 改为 exp=100000000（远未来）」单位有误：exp 为**秒**制，10^8 s ≈ 1973 年（过去）。真实时钟语境（host.test.mjs 走 Date.now）已改用 exp=4000000000（2096 年）；refresh-service 假时钟（t.now=1_000_000ms）两值皆可，已统一为 4000000000。执行提交 9326fa7 以"exp 秒制陷阱修正"留痕。
3. 实现对 `refreshEphemeralAccess` 的 `refreshToken` 增加空串拒绝（计划原文只写"非串"）——防御性加强，行为正确，留档防未来"实现与计划不一致"误判。
4. 申报偏离两处（执行审核第 1 轮核验通过）：`fetchLiveAvailableModelIds` 抛错补携 `.status`（Step 2.3 第 6 条 401/403 分型的实现前提，与 refreshEphemeralAccess 同款）；host.test.mjs 夹具 token 远未来化（同第 2 条）。
