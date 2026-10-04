# Copilot 授权与模型管理统一实施计划（简化合并版）

状态：2026-10-04 由[计划A：授权与状态](<2026-10-03-copilot-authorization-state-implementation-plan.md>)与[计划B：模型事务](<2026-10-03-copilot-model-transactions-implementation-plan.md>)合并简化而成，**取代二者作为唯一实施依据**。设计事实以[设计规格](<../design/2026-10-03-dual-profile-auth-and-models.md>)与[ADR 0004](<../adr/0004-safe-model-management-and-profile-isolation.md>)为准，本计划只保留其中用户可感知的正确性修复与功能拆分，防御性协议机器按「非目标」节明确裁掉。2026-10-04 第 1 轮独立评审提出 12 项问题（1 阻断／3 重要／8 建议），已全部修订并经第 2 轮复核确认；第 2 轮另提 6 项（1 重要／5 建议）、第 3 轮再提 2 项（1 重要／1 建议）均已修订入本版。

**执行记录（2026-10-04）**：T0–T12 已全部在 main 分支实施完成（checkpoint：`ffc26ed` 阶段一 T0–T5、`d778dd1` 阶段二/三 T6–T12）；`npm run build` 产物同步、`npm pack --dry-run` 22 文件含全部 7 个新模块且无测试/秘密文件。未发布（G09）；实机人工验收清单待用户另行授权后执行。全量测试经两轮执行评审后为 187 条全绿（初版 183 → 第 1 轮评审 +2 → 第 2 轮评审 +2）。**v1.2.8 发布清理**：删除 state.mjs v1 函数族及其 6 条历史回归（restartMarker 保留，事务内核仍在用），终版 **181 条全绿**；README 版本矩阵补 v1.2.8 行，版本号 bump 1.2.8 经 OIDC（GitHub Actions Trusted Publishing）发布。

**执行后评审修订（2026-10-04，第 1 轮执行评审，13 项：2 重要／11 建议）**：已修复 withdrawalDelivery 写入 attempt（快照如实反映）、补通道门控状态机测试、boot 终态按 baseline↔target 计数、T4 跳过原因入日志、词典去重/清死键、快照过期淘汰、405 方法守卫用例；并记录如下**有意偏离**：① T8「Modify src/copilot-models.mjs」未改该文件——fetchedAt/缓存逻辑落在 refresh-service.mjs 内（`fetchLiveAvailableModelIds` 原样复用），语义全部达成；② checkpoint 边界 T6–T12 合并为单提交（T11/T12 未单独切分）；③ blockedReason 实际仅产生 `inject-unavailable`/`install-unresolved`，实例分歧与只读安装经诊断字段表达（见契约表修订）。

**执行后评审修订（2026-10-04，第 2 轮执行评审，3 项建议）**：① changes 语义统一为「已发生的变更」——boot 终态仅 applied/partial（配置确已落地）填 models 计数，conflict/rollback-conflict 归零；② registry catalog-landed 崩溃窗口两义消除——boot 残留先按「当前配置==target→幂等核实／==baseline→按写前意图重提交／其余→conflict 保留用户值」收敛，再做 served 验证；③ service 暴露 snapshotCount() 诊断面，补快照淘汰与残留三分支测试。

## 目标

1. 授权真实化：消灭伪退出与伪取消——退出/重新授权在当前宿主下默认禁用并说明；取消改为「请求撤回＋结果待核实」风险锁存；单实例授权尝试（attemptId）；启动竞态、静默网络错误（HTML/502 直显 Unexpected token）修复。
2. 首次填充保护：已请求撤回后晚到的 authorized 只更新凭据事实，不再写模型配置。
3. 模型操作拆分：把单一破坏性「刷新」拆为默认非破坏的**补充模型**（候选默认不勾选）与显式确认的**重建模型列表**（清 Copilot 条目参数与 modelOverrides，空集合二次确认）。
4. 配置保护：提交前后以 settings revision 做 CAS，用户并发编辑优先；回滚只在归属可证明时执行。
5. profile 隔离：刷新状态文件随 profile 用户数据目录隔离（schema 2），旧全局状态只读提示，不再跨 profile 消费意图。
6. 可恢复事务：apply 前持久操作意图，启动时核实恢复；operationId 幂等；提供「放弃旧意图」显式确认路径。

## 非目标（相对原两份计划的裁剪）

| 原计划机制（出处） | 本计划处理 |
|---|---|
| credentialObservationId／HMAC 凭据观察、withAuthorizationFence 围栏、全库 ABA（A02/A02b） | 不做。授权变化保护由 intentVersion（本 profile 显式操作计数，记入预览快照/activeOperation/账号缓存，并在 apply、boot 恢复、缓存消费处复核，漂移走 409/recovery-needed）＋ settings revision CAS 承担。 |
| withResourceLock 跨进程锁＋子进程竞争矩阵（A01b/B21） | 不做。沿用现有 createMutex 进程内互斥＋原子写；README 声明单宿主进程假设，跨进程同目录并发不在保证范围。 |
| jsdom/react-dom DOM 测试、无障碍 Dialog 组件库、剪贴板测试（A11/A13/A14） | 不做，不新增任何依赖。沿用现有弹窗结构；UI 靠状态机测试＋人工验收。 |
| CI 六格矩阵与 ci-contract 测试（A17） | 不改 [ci.yml](<../../.github/workflows/ci.yml>)。 |
| 三版本 compatibility fixtures（A15）、package-files/bundle-load 新测试（A16/B22） | 不做；沿用现有 resolveInstall 降级模式，构件核对并入 T12 最终验证。 |
| settingsSessionId／configCommitReceipt／writeSet 分级恢复门禁（RV-03/04） | 简化：基线存 view＋revision；失败回滚仅在「当前配置仍等于本操作写入值」时执行，否则 rollback-conflict 保留用户值。 |
| recoveryRecordId／confirmedEffectsDigest resolve 协议（B17b） | 简化：retire ＝ 静止核实＋UI 确认弹窗后清 activeOperation。 |
| 账号证据的 AuthBinding 绑定（B02） | 简化：重建强制 live GET 成功；补充允许 ≤24 小时带 fetchedAt 的缓存。 |
| compatibilitySwitch 新机制（B11） | 复用 host.mjs 现有 probe 临时改名刷新路径。 |
| client-copy.mjs 独立词典模块（A10） | 就地扩展 [client.jsx](<../../src/client.jsx>) 现有 DICTS。 |

## 架构快照

[host.mjs](<../../src/host.mjs>) 保留 cordis 入口、同源守卫与路由接线；授权生命周期提取到 `src/auth-host.mjs`，刷新编排提取到 `src/refresh-service.mjs`，落地事务提取到 `src/refresh-transaction.mjs`。浏览器侧 HTTP 解析与授权状态机从 [client.jsx](<../../src/client.jsx>) 提取为 `src/client-http.mjs` 与 `src/auth-flow.mjs`，DOM 只负责展示；词典沿用 client.jsx 内 DICTS。目录落地（file 补丁／registry 注入）、原子写、供应链守卫全部复用现有 [catalog.mjs](<../../src/catalog.mjs>)、[catalog-registry.mjs](<../../src/catalog-registry.mjs>)、[catalog-fetch.mjs](<../../src/catalog-fetch.mjs>)、[atomic-json.mjs](<../../src/atomic-json.mjs>)。

## 全局约束（继承设计规格§1）

- G01：Node.js >=20；保持现有发布 peer `@deepseek-ai/cordis: ^4.0.2`，不升级 DSH 或 pi-ai 代码。
- G02：DSH 0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2 为兼容目标；缺能力时禁用相关修改并说明，不伪成功。
- G03：保留导航「GHC设置」／「GHC Settings」；正文标题使用 GitHub Copilot；操作名为「授权登录／请求撤回／重新授权／退出登录」「补充模型」「重建模型列表」「应用更改」；unsafe 退出／重新授权必须禁用并说明。
- G04：沿用 `/copilot-auth` 路由前缀和 `llm-pi-ai/github-copilot` 凭据键；en/zh 主信息等义；技术详情折叠并脱敏。
- G05：模型补充默认非破坏性；全量重建单独确认；底层目录只增不覆盖已有描述；不写官方归档、不通过路由级单协议绕过混合协议目录、不新增提供方路由。
- G06：共享宿主凭据库与公共安装目录数据，隔离 profile 配置、刷新事务、激活、缓存和诊断。
- G07：预览有效期 10 分钟；缓存可应用上限 24 小时；断网自动重试最多 60 秒；无上游有效期时本地授权等待上限 15 分钟——均为产品策略而非 GitHub 保证。
- G08：不自动重启、不增加长期备份或用户撤销、不自动发送推理请求；真实授权、重启和可能耗配额的验证另获用户授权。
- G09（改）：实施授权随用户批准本计划一并授予（工作区实现＋mock 测试）；npm 发版、推送、真实环境验证仍需另行授权。
- 追加：不新增任何运行时／开发依赖；`lib/client.js` 只由 `npm run build` 生成，禁止手写；不修改 [ci.yml](<../../.github/workflows/ci.yml>)。

## 文件结构与职责

| 动作 | 文件 | 职责 |
|---|---|---|
| Create | `src/client-http.mjs` | requestJson：HTTP/JSON 解析、状态码保留、错误脱敏（白名单 messageKey），双侧可用。 |
| Create | `src/runtime-scope.mjs` | 从宿主 profileContext 解析稳定 profileId 与私有 dataDir；未知时 known=false 禁写。 |
| Create | `src/auth-host.mjs` | 授权控制器：单实例尝试、软撤回＋风险锁存、禁用退出/重授权、intentVersion、首次填充 handoff。 |
| Create | `src/auth-flow.mjs` | 浏览器授权状态机：串行请求、代次保护、轮询退避、卸载停止。 |
| Create | `src/model-update.mjs` | 纯策略 buildModelChange：补充/重建目标视图、增删保留与原因、writeSet。 |
| Create | `src/refresh-service.mjs` | 预览快照（10 分钟、选择重算、operationId 签发）、账号证据门禁、操作排队与幂等查询。 |
| Create | `src/refresh-transaction.mjs` | apply 事务内核（prepared→catalog-landed→configuration-committed→verified）、条件回滚、boot 恢复、retire。 |
| Modify | [src/shared.mjs](<../../src/shared.mjs>) | PROTOCOL_VERSION=2、cancel/refreshRetire 路由、协议常量。 |
| Modify | [src/host.mjs](<../../src/host.mjs>) | 接线授权控制器与刷新服务；status 聚合 authorization 块与新 refresh 块；删除被替代内核。 |
| Modify | [src/state.mjs](<../../src/state.mjs>) | schema 2 profile 状态读写层（保留 v1 损坏留存语义）。 |
| Modify | [src/refresh-flow.mjs](<../../src/refresh-flow.mjs>) | 客户端模型流：选择、确认、结果、retire、幂等查询。 |
| Modify | [src/client.jsx](<../../src/client.jsx>) | 授权区接 auth-flow；模型区改补充/重建双入口＋勾选预览＋分层结果；扩展 DICTS。 |
| Modify | [src/copilot-models.mjs](<../../src/copilot-models.mjs>) | 账号模型 GET 结果带可信 fetchedAt；缓存文件落 dataDir。 |
| Modify | [package.json](<../../package.json>)、[README.md](<../../README.md>) | files 增新模块；README 按实际行为更新。 |
| Create | `test/client-http.test.mjs`、`test/runtime-scope.test.mjs`、`test/auth-host.test.mjs`、`test/auth-flow.test.mjs`、`test/model-update.test.mjs`、`test/profile-isolation.test.mjs`、`test/refresh-service.test.mjs`、`test/refresh-transaction.test.mjs` | 随对应任务创建。 |
| Modify | [test/host.test.mjs](<../../test/host.test.mjs>)、[test/state.test.mjs](<../../test/state.test.mjs>)、[test/refresh-flow.test.mjs](<../../test/refresh-flow.test.mjs>) | 保留有效旧回归，替换被新契约取代的用例。 |

## 接口契约

| 接口 | 契约 |
|---|---|
| `requestJson(fetchImpl, url, init)` | 返回 `{ok, httpStatus, body, error}`；HTML/非 JSON 保留 httpStatus，error=`{messageKey, details}` 白名单脱敏，不透传原始异常或整段代理页；写调用不自动重试。 |
| `resolveRuntimeScope(ctx)` | `{known, profileId, dataDir, reason?}`；dataDir＝`join(profileContext.dir, "copilot-auth")`（`dir`＝`$DSH_HOME/profiles/<name>`，profile 私有；不得使用跨 profile 共享的 `home`），profileId＝profileContext `name\0dir` 的 sha256 前 16 hex；缺 profileContext 或形状非法时 known=false＋reason，此时所有写路由（start/cancel/preview/apply/retire）返回 503 `scope-unavailable`，status 返回 200 且带 `scopeAvailable:false`，客户端禁用相关入口并显示 unavailable 文案（G02 不伪成功）。 |
| `createAuthorizationController(ctx, {scope, intentIO})` | `{start, cancel, logout, snapshot, onAuthorized}`。start：先经 intentIO 持久 intentVersion+1（失败不发 begin），再 `ctx.authorization.begin`，返回 202 `{attemptId}`；运行中再 start 返回 409 `{attemptId}`。cancel：先 intentVersion+1，再尝试调用宿主撤销接口（存在则传参调用→invoked；缺失→unavailable；抛错→failed），并设进程内 riskLatch。logout/reauthorize：一律拒绝 `logout-safety-unavailable`，绝不调用 deleteRecord。onAuthorized(handoff) 仅在 outcome=authorized 且该 attempt 的 originIntentVersion 仍为当前值且无撤回/超时标记时触发；handoff=`{attemptId, originIntentVersion, authorizedAt}`。snapshot() 返回 `{attemptId, status, startedAt, code?, url?, expiresAt?, waitDeadline, withdrawalDelivery?, riskLatch}`。intentIO＝读写 `auth-intent.json` 的小接口（见下），与 refresh-service 的 stateIO 是两个不同注入。 |
| `createAuthFlow({fetchImpl, clock, onState})` | `{init, start, cancel, refresh, dispose}`；单一 init 聚合 status；请求代次＋attemptId 双保护；start 收到 409 时按「共同尝试」处理——展示 attempt.shared 并转入对现有 attempt 的轮询，不当作失败；轮询 1 秒，读取失败退避 1/2/4/8/15 秒封顶，累计 60 秒转手动；dispose 仅停止本页请求。 |
| `buildModelChange({operation, rawView, effectiveView, accountIds, resolvableIds, selectedIds, confirmEmpty})` | operation∈supplement/rebuild；返回 `{allowed, reason?, targetView, added[], removed[{id,reason}], kept[], warnings[], writeSet}`；writeSet⊆`{catalogEntries, models, modelOverrides}`。补充保留全部现有对象/顺序/覆盖，仅追加勾选且可解析去重后的 ID；重建 targetView.models 为账号∩可解析的纯 ID 列表并清空本路由 modelOverrides，空交集需 confirmEmpty=true；不可解析现有项保留并出 warning。 |
| `createRefreshService(ctx, {scope, stateIO, readIntentVersion, clock})` | `{preview, apply, status, retire, bootReady, dispose}`；readIntentVersion 为只读注入（host.mjs 从 `auth-intent.json` 组装，与控制器 intentIO 同源），供快照冻结、apply 复核与缓存校验。preview：`{protocolVersion:2, operation, catalogSource?, basePreviewId?, selectedIds?}`→`{previewId, expiresAt, diff}`；内存快照冻结账号集合/目录内容/配置 view+revision/当时 intentVersion，10 分钟过期；选择变化从原快照重算并沿用原 expiresAt，签发绑定选择的 operationId。apply：`{protocolVersion:2, previewId, operationId}`→先复核 intentVersion 与配置 revision 仍与快照一致（任一漂移返回 409 preview-stale/authChanged，要求重新预览），再委托事务内核；同 operationId 幂等返回已知结果；activeOperation 未终结时新 apply 返回 423。status：`{operationId?}`→`{query: active|last|unknown, active?, lastResult?}`。retire：静止核实后清 activeOperation。boot/apply/retire 同一队列串行。 |
| `OperationResult` | `{operationId, status, changes:{catalogAdded, modelsAdded, modelsRemoved}, error?, phase}`；status∈`not-applied|no-change|pending-restart|applied|conflict|partial|rolled-back|rollback-conflict|recovery-needed|intent-retired`。 |
| schema 2 状态文件 | `<dataDir>/refresh-state.json`：`{version:2, profileId, activated, appliedOverlay, appliedProvenance, intentVersion, activeOperation|null, lastResult|null, restartState|null, lastError, lastErrorAt}`；`restartState` 沿用 v1 语义 `{reason: refresh|self-heal, expectedEntriesDigest, since}`——目录写盘后待重启加载的说明（file 通道 apply 与自愈重放共用，非错误），下个 boot 目录加载并核实后清除；activeOperation=`{operationId, strategy, selectedIds, intentVersion, settingsBaseline:{view,revision}, targetView, phase:prepared|catalog-landed|configuration-committed|verified, createdAt}`；boot 恢复与 retire 前复核 intentVersion，不一致则不消费旧 target（标记 recovery-needed，要求重新预览）。损坏改名留存 `.corrupt-<ts>` 不覆盖（沿用 v1 语义）。 |
| intentVersion 存储 | `<dataDir>/auth-intent.json`：`{version:1, intentVersion, updatedAt}`，原子写；known=false 时 bump 失败即拒绝动作。 |
| apply 提交时点（两通道） | registry 通道与纯配置变化（writeSet 无 catalogEntries 且目标当前运行时已可解析）：apply 当次完成配置提交与验证（Q29 即时生效）。file 通道且 writeSet 含 catalogEntries：apply 只落地目录并返回 pending-restart，**配置提交延迟到下个 boot**——目录已被加载、全部目标可解析、基线 view/revision 未被用户改变（否则 conflict 保留用户值）后才提交（设计§4.3，沿用 v1 两阶段语义，避免运行期路由整体拒绝窗口）。 |
| status refresh 块 | `{scopeAvailable, catalogWritable, catalogMode(file/registry/blocked/unknown), blockedReason?, registryInjected, registryVia, registryInstanceMismatch, catalogFile, settingsNotServed, activeOperation, lastResult, pendingRestart, legacyStateDetected, piAiVersion, catalogDigest}`；`pendingRestart` 派生自 restartState 或未终结的 catalog-landed 操作；`blockedReason` 为结构化原因码（`inject-unavailable`／`install-unresolved`；模块实例分歧与只读安装**经诊断字段表达**——`registryInstanceMismatch` 与 `catalogWritable:false`——不置 blocked：裸 specifier 绑宿主实例＋served 复核是 v1.2.7 已验证的可工作通道）；通道分类来自插件启动时初始化缓存的能力探测（复用 resolveInstall/classifyCatalogTarget），判定表：`file`＝安装解析成功且可写；`registry`＝安装解析成功且只读但注册表注入面可用；`blocked`＝安装解析成功但注入面不可用→禁用应用；`unknown`＝安装解析失败或 scope 未知→不承诺可应用，禁用入口；**GET status 不执行写探针**（Q23）；`legacyStateDetected`＝检测到旧 v1 全局状态文件且本 profile 尚无 v2 状态时的派生标志，客户端显示设计§5 `legacy` 文案提示重新预览确认。 |
| 账号缓存 | `<dataDir>/account-model-cache.json`：`{ids, fetchedAt, intentVersion}`；fetchedAt 只在 live GET 成功时写入；仅当 ≤24 小时且 intentVersion 与当前一致时可作为补充的应用依据，否则预览只展示 stale 参考、apply 被拒（Q7「无有效缓存阻止应用」/Q16）；重建永不使用缓存。 |
| 路由 | 保留现有 6 路径；新增 POST `/copilot-auth/cancel`、POST `/copilot-auth/refresh/retire`；模型 preview/apply 请求缺 `protocolVersion:2` 返回 400 upgrade-required，旧 digest 式请求不再接受。 |

## 任务清单

Run 命令均从仓库根执行，Node 20+、npm，bash/PowerShell 可单独执行。每个任务先写测试确认红灯，再实现到同命令全绿（T0/T12 除外）。时间与网络一律注入 fake clock/fetch，不用 sleep。

### 阶段一：授权真实化

#### T0：基线核对

1. 记录当前 HEAD（`git log -1 --oneline`）；确认工作区无未预期改动。
2. Run `npm ci`；`npm run build`；`npm test`——三者全绿才开工；任何红灯先停下向用户报告，不猜。

#### T1：HTTP 契约与错误脱敏

Files：Create `src/client-http.mjs`, `test/client-http.test.mjs`；Modify [src/shared.mjs](<../../src/shared.mjs>)。Produces：requestJson、PROTOCOL_VERSION=2、cancel/refreshRetire 路由常量。

1. 写测试：200 JSON、502 HTML 页、空响应、坏 JSON、网络 reject、含模拟 token 的错误详情脱敏；断言路由前缀与 CREDENTIAL_KEY 未变、新路由常量存在。
2. Run `node --test test/client-http.test.mjs`——模块缺失红灯。
3. 实现 requestJson（错误码白名单：`network-error`/`bad-gateway`/`bad-response`/`http-error`，details 只保留白名单字段）；shared.mjs 增 `PROTOCOL_VERSION=2` 与 `cancel`/`refreshRetire` 路由。
4. 同命令全绿；Run `node --test test/patch.test.mjs` 确认旧契约未破坏。

#### T2：profile 作用域

Files：Create `src/runtime-scope.mjs`, `test/runtime-scope.test.mjs`。Produces：resolveRuntimeScope。

1. 写测试：同 dir 不同 name 得不同 profileId；缺 profileContext 或形状非法返回 known=false＋reason；dataDir＝`join(profileContext.dir, "copilot-auth")`，不同 profile 的 dataDir 互不包含（防误用跨 profile 共享的 home）；相同 name+dir 跨调用稳定。
2. Run `node --test test/runtime-scope.test.mjs`——红灯。
3. 实现：优先读 `ctx.profileContext`（`{name, dir, ...}`，实施时以实际注入形状为准）；dataDir 不存在时由调用方按需创建，本模块不写盘。
4. 同命令全绿。

#### T3：授权控制器（软撤回＋风险锁存＋禁用退出）

Files：Create `src/auth-host.mjs`, `test/auth-host.test.mjs`；Modify [src/host.mjs](<../../src/host.mjs>) start/state/logout 接线。Consumes：T1/T2。Produces：createAuthorizationController（注入 intentIO）、`/cancel` 路由、status 的 authorization 块。

1. 写测试（用 `AUTH_` 前缀测试名）：deferred begin 下 start 返回 202＋attemptId；运行中再 start 409；cancel 先持久 intentVersion+1 再调用宿主撤销（`ctx.authorization.cancel(key)` 存在则调用→invoked，缺失→unavailable，抛错→failed），delivery 三态映射，且设 riskLatch；riskLatch 存在时新 start 被拒（authUnsafe）；logout 路由返回 `logout-safety-unavailable` 且 deleteRecord 调用数为 0；begin outcome=cancelled → attempt 状态 `withdrawal-pending-unverified` 且设锁存；outcome=authorized 且版本仍当前 → onAuthorized 收到 handoff，版本已变 → 不回调；unexpected prompt 仍拒绝；intentVersion 持久化失败时不调用 begin；fake clock 推进超过 waitDeadline → snapshot 状态 `timed-out-unverified`＋riskLatch 置位＋新 start 被拒（authUnsafe）；scope known=false → start/cancel 返回 503 `scope-unavailable`。
2. Run `node --test --test-name-pattern="AUTH_" test/auth-host.test.mjs`——红灯。
3. 实现：把 host.mjs 现有 attempt 逻辑（interaction/prompt 答空、Enterprise 处理、202 先行）迁入控制器；waitDeadline=startedAt+15 分钟（本地等待上限，不伪造设备码倒计时，仅上游真实提供 expiresAt 时展示；超时由 snapshot 以注入 clock 惰性判定为 `timed-out-unverified`＋riskLatch，无需后台定时器）；riskLatch 为进程内内存态，重挂不清、dispose 不清；intentIO 读写 `auth-intent.json`（原子写，known=false 时 bump 抛错），由 host.mjs 组装注入。host.mjs 的 logout 路由改为统一拒绝；status 路由增 `authorization:{credential, attempt, riskLatch, capabilities:{logout:false, reauthorize:false}}` 块，保留现有 configured/syncError/refresh 聚合。本任务不动旧刷新内核，其状态读写仍走 v1 路径，T7/T10 再切换。
4. 同命令全绿；Run `node --test test/host.test.mjs`，按新契约更新「cancelled 即 failed」与 logout 用例，保留同源守卫等有效回归。

#### T4：首次填充保护

Files：Modify [src/host.mjs](<../../src/host.mjs>) syncAvailableModels、`src/auth-host.mjs`；测试并入 `test/auth-host.test.mjs` 与 [test/host.test.mjs](<../../test/host.test.mjs>)。Consumes：T3 handoff。

1. 写测试（`HANDOFF_` 前缀）：start V1→cancel V2（delivery=failed/unavailable）→SDK 晚到 authorized：describeRecord 更新（事实可见）但 settings.mutate 调用数为 0、旧 cache/意图不复活；正常 authorized V1 → 填充一次；取数 await 期间 intentVersion 再变 → 不 mutate。保留现有空列表/合成层/override 不覆盖回归。
2. Run `node --test --test-name-pattern="HANDOFF_" test/auth-host.test.mjs test/host.test.mjs`——红灯。
3. 实现：syncAvailableModels 接受 handoff 参数；配置提交前重核 handoff.originIntentVersion 仍当前、该 attempt 无撤回/超时标记、且模型仍未配置，任一不满足则记录跳过原因并返回，不写配置。
4. 同命令全绿。

#### T5：客户端授权控制器与界面

Files：Create `src/auth-flow.mjs`, `test/auth-flow.test.mjs`；Modify [src/client.jsx](<../../src/client.jsx>)。Consumes：T1 requestJson、T3 status/attempt 契约。

1. 写测试（fake clock＋deferred fetch）：慢 init 不覆盖新操作；start→409→展示 attempt.shared 并转入对现有 attempt 的轮询（不当作失败）；轮询乱序被代次丢弃；HTML 响应映射为 messageKey 而非原始文本；连续失败按 1/2/4/8/15 秒退避、累计 60 秒转手动；dispose 后无悬挂定时器。
2. Run `node --test test/auth-flow.test.mjs`——红灯。
3. 实现 createAuthFlow；client.jsx：去掉重复 status 拉取与 setInterval，统一订阅控制器；退出/重新授权按钮 disabled＋authUnsafe 说明；新增「请求撤回」按钮（调 /cancel，展示 delivery 与待核实文案）；等待超时只显示「查询状态/人工核实」，不提供直接重试授权；status 返回 `scopeAvailable:false` 时禁用授权/模型入口并显示 unavailable 文案。DICTS 按[设计规格§5](<../design/2026-10-03-dual-profile-auth-and-models.md>)补充 withdrawal／withdrawalUnavailable／authUnsafe／attempt.timeout／attempt.shared／unavailable 等键（en/zh 等义）。
4. 同命令全绿；Run `npm run build` 确认 client 构建通过。

### 阶段二：模型管理拆分

#### T6：纯模型变更策略

Files：Create `src/model-update.mjs`, `test/model-update.test.mjs`。Produces：buildModelChange。

1. 写测试：补充默认空选择→列表零变化、完整保留对象/顺序/modelOverrides；勾选追加去重且只接受可解析 ID；重建产出纯 ID 列表＋清空本路由 modelOverrides；空交集未 confirmEmpty → allowed=false；不可解析现有项保留＋warning；writeSet 正确区分目录/列表/覆盖。
2. Run `node --test test/model-update.test.mjs`——红灯。
3. 实现纯函数，不改其他路由字段；基线继承值无法安全清除时（raw 缺失但 base 存在）rebuild 受限并在 reason 说明。
4. 同命令全绿。

#### T7：profile 状态 schema 2

Files：Modify [src/state.mjs](<../../src/state.mjs>)；Create `test/profile-isolation.test.mjs`；Modify [test/state.test.mjs](<../../test/state.test.mjs>)。Consumes：T2。

1. 写测试：两个 scope 写各自 dataDir 互不影响；v1 全局旧文件存在且本 profile 无 v2 状态时，loadRefreshState 返回全新状态并在返回值带 `legacyStateDetected:true`（宿主传入旧文件路径用于检测；不消费旧 journal/overlay）；损坏文件改名留存 `.corrupt-<ts>`；同 profile 重复加载保留 activated/appliedOverlay；未知 version 拒绝执行并保留原件。
2. Run `node --test test/state.test.mjs test/profile-isolation.test.mjs`——红灯。
3. 实现 loadRefreshState(scope)/saveRefreshState(scope,state)（按接口契约 schema 2）；沿用 atomic-json 原子写。本任务只交付新读写层，host.mjs 旧刷新内核的切换在 T10 一并完成。
4. 同命令全绿。

#### T8：预览服务与账号证据

Files：Create `src/refresh-service.mjs`, `test/refresh-service.test.mjs`；Modify [src/copilot-models.mjs](<../../src/copilot-models.mjs>)。Consumes：T2/T6/T7。

1. 写测试（intentVersion 经注入的 readIntentVersion fake 提供）：10 分钟过期边界；选择变化从原快照重算且沿用原 expiresAt、不重新下载；previewId/operationId 绑定选择；快照记录当时 intentVersion，变化后的 apply 返回 409 preview-stale；rebuild 在 live GET 失败时拒绝（不退化为缓存）；补充仅允许 ≤24h 带 fetchedAt 且同 intentVersion 的缓存作应用依据，live 失败且缓存无 fetchedAt/过期/跨 intentVersion 时预览只展示 stale 参考、apply 被拒（Q7 无有效缓存阻止应用）；缓存只在 live 成功时写 fetchedAt＋intentVersion；队列内 apply 串行、activeOperation 未终结时新 apply 423；scope known=false 时 preview/apply 返回 503 `scope-unavailable`。
2. Run `node --test test/refresh-service.test.mjs`——红灯。
3. 实现 createRefreshService（事务执行先注入 fake，T9 接真）；账号 GET 复用 copilot-models 现有只读接口，缓存文件 `<dataDir>/account-model-cache.json`。
4. 同命令全绿。

#### T9：事务内核与恢复

Files：Create `src/refresh-transaction.mjs`, `test/refresh-transaction.test.mjs`；Modify [src/host.mjs](<../../src/host.mjs>)（仅把现有 probe 临时改名刷新 `touchRouteIdentity` 等价抽取为可导出函数，不改语义）。Consumes：T7/T8；复用现有 catalog/catalog-registry/atomic-json。

1. 写测试（failpoint 注入各阶段边界）：prepared 持久失败→零副作用；**file 通道**（writeSet 含 catalogEntries）apply 当次只落地目录、settings.mutate 调用数为 0、返回 pending-restart，下个 boot 目录已加载且目标全部可解析→按基线 CAS 提交配置→verified，boot 提交前用户已改配置→conflict 保留用户值不覆盖；**registry 通道/纯配置**：apply 当次完成提交与验证（纯配置即时 applied，无需重启）；配置提交后中断→boot 核实为 applied；提交前 revision 变化→conflict 且旧 target 零写入；boot 恢复时 activeOperation.intentVersion 与当前不一致→不消费旧 target，标记 recovery-needed；零勾选＋目录增量→目录落地、models 零变化、结果为 pending-restart/applied 而非 no-change；后续步骤失败且当前配置仍等于本操作写入值→回滚成功，否则 rollback-conflict 保留用户值；registry 模式 listModels 验证缺失→partial/recovery-needed；retire 幂等且仅静止时放行，activeOperation.intentVersion 已漂移→retire 不消费旧 target（标记 recovery-needed）；**保守激活/自愈**：pi-ai 基线未变时重放幂等（appliedOverlay 保持）、pi-ai 升级/重装覆盖目录后按 appliedOverlay 只增重放恢复（file 通道需再重启加载时置 pending-restart 说明）、registry 通道重放后 served 缺失上报 lastError、跨 pi-ai 基线且条目缺失不自动应用（置错误并提示重新预览）；重复恢复幂等。
2. Run `node --test test/refresh-transaction.test.mjs`——红灯。
3. 实现 runApply/bootRecover/retire：profile 锁（createMutex）内按 prepared→catalog-landed→configuration-committed→verified 推进，每阶段先持久再行动；基线 view+revision 同次 describe 捕获；目录落地沿用只增合并与预检注入；快照刷新复用从 host.mjs 抽出的 probe 临时改名函数；**配置提交时点按接口契约「apply 提交时点」执行**——file 通道含目录写入时 apply 止步 catalog-landed 并返回 pending-restart，提交由 bootRecover 在目录加载、可解析前置与基线 CAS 核实后完成；终态原子写 lastResult 并清 activeOperation；bootRecover 同时承担 v1 boot 的保守激活/自愈职责（等价迁移 host.mjs 现有自愈重放逻辑：同 pi-ai 基线幂等保持、目录被覆盖后按 appliedOverlay 只增重放、跨基线不自动应用并提示重新预览，registry 通道重放后做 served 复核）。
4. 同命令全绿；Run `node --test test/atomic-json.test.mjs test/catalog-registry.test.mjs` 确认复用层未破坏。

#### T10：host 刷新接线与协议路由

Files：Modify [src/host.mjs](<../../src/host.mjs>)；Modify [test/host.test.mjs](<../../test/host.test.mjs>)。Consumes：T8/T9。

1. 写测试（`REFRESH_V2_` 前缀）：缺 protocolVersion 的旧请求 400 upgrade-required；正常 preview→apply→status 闭环；同 operationId 重复 apply 返回已知结果；忙 423；GET status 三态（active/last/unknown）；retire 路由闭环；启动时 bootReady 执行恢复；同源与方法守卫保留；status 的 refresh 块按接口契约字段齐备（含 catalogWritable/catalogMode/blockedReason/pendingRestart/legacyStateDetected/scopeAvailable）且 **GET status 不执行写探针**（以 tmp 安装目录断言 status 前后无新文件，Q23）；scope known=false 时写路由 503、status 带 `scopeAvailable:false`。
2. Run `node --test --test-name-pattern="REFRESH_V2_" test/host.test.mjs`——红灯。
3. 实现：host.mjs 删除被替代的旧 preview/apply 内核与旧 boot 自愈路径（职责等价迁入 T9 bootRecover），只接线 refresh-service，bootReady 同时覆盖 activeOperation 恢复与保守激活/自愈；状态读写整体切换到 loadRefreshState/saveRefreshState（旧 v1 全局文件从此只读）；路由断言更新 6→8。
4. 同命令全绿；Run `node --test test/host.test.mjs` 全量，替换旧 digest/镜像语义用例，保留首次填充与守卫回归。

#### T11：客户端模型流与界面

Files：Modify [src/refresh-flow.mjs](<../../src/refresh-flow.mjs>), [src/client.jsx](<../../src/client.jsx>)；Modify [test/refresh-flow.test.mjs](<../../test/refresh-flow.test.mjs>)。Consumes：T1/T8/T10 契约。

1. 写测试：预览→勾选（默认全不选）→materialize 重算→确认→apply 的状态序列；零勾选＋目录增量→确认后目录落地、列表零变化（结果非 no-change）；rebuild 未二次确认/空集合未单独确认不发包；423 转 status 查询；unknown 结果只查询不重发；recovery-needed→确认 retire→重新预览闭环；预览过期重置确认；本地来源失败→显式「使用内置目录数据」入口生成新预览（不隐式降级，Q7）；catalogMode 为 blocked/unknown 时模型入口禁用并显示 unavailable 文案，附 blockedReason 对应的具体原因说明（G02／设计§4.3「按实际原因解释」）；`pendingRestart` 为 true 时显示待重启说明；慢响应不覆盖新视图。
2. Run `node --test test/refresh-flow.test.mjs`——红灯。
3. 实现：RefreshModal 改为候选勾选列表＋全选、增/删（带原因：未包含在本次账号列表/当前目录无法解析）/保留/警告分区显示、来源与时间标注（live/缓存/本地/内置）与显式切源入口（沿用现有 overlayBtn 行为，生成新预览）；重建风险与清空风险文案、pendingRestart 说明；结果区按 OperationResult.status 分层，recovery-needed 提供「结束旧配置意图（不回滚已发生更改）」确认入口；`legacyStateDetected` 时显示设计§5 `legacy` 文案；`scopeAvailable:false` 时禁用模型入口并显示 unavailable 文案。危险确认弹窗（重建二次确认/清空确认/retire 确认）初始焦点在取消按钮、可取消阶段 Esc 等价取消；技术详情（冲突详情/诊断串）默认折叠，主信息区只显示面向结果的文案（G04）。DICTS 按[设计规格§5](<../design/2026-10-03-dual-profile-auth-and-models.md>)补齐 en/zh 键。
4. 同命令全绿；Run `npm run build`。

### 阶段三：收尾

#### T12：构件、最终验证与说明

Files：Modify [package.json](<../../package.json>) files、[README.md](<../../README.md>)。

1. package.json files 增加 7 个新 src 模块；README 更新为实际行为：软撤回语义、退出/重新授权禁用原因、补充/重建区别、profile 隔离与旧状态只读、单宿主进程假设、目录只增与供应链守卫不变、保守激活/自愈保留（pi-ai 升级后按已确认条目只增重放）；不 bump version、不发版。
2. Run `npm ci`；`npm run build`；`npm test`；`npm pack --dry-run --ignore-scripts --json`——全绿，且 pack 清单包含全部新 host 模块、不含测试与秘密文件。
3. 人工验收清单（用户另行授权后、测试账号上进行）：Linux web 实机核对授权/撤回/禁用说明、等待超时文案、补充保留定制、重建清覆盖、pendingRestart 文案、危险确认弹窗初始焦点与 Esc 取消、离开再回来风险不清；Windows desktop 无实机时如实保留缺口。

## 执行纪律

- 开始实现前先批判性复查整份计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划再动代码。
- 按任务顺序执行（T0→T12），不无声跳步、合并或改变目标；每任务运行其验证命令并确认预期结果。
- 阻塞、重复失败或仓库现实与计划不符（如 profileContext/撤销接口实际形状不同）立即停下说明，不猜、不硬编码私有路径。
- 当前在 main 分支：开工前用户已批准本计划即视为同意在其上实施；checkpoint commit 仅在阶段边界（T5、T11、T12 后）进行，不自动推送。
- 全部任务完成后运行最终验证并输出修改摘要。

## 最终验证

从仓库根逐条运行：`npm ci`；`npm run build`；`npm test`；`npm pack --dry-run --ignore-scripts --json`。预期全绿、构建产物与 src 同步、pack 清单完整。mock 测试不冒充实机验证；真实授权/重启/推理调用一律不在本轮自动执行（G08）。

## 与原两份计划的关系

本计划消费计划A的：软撤回与风险锁存语义（D-01）、禁用退出/重授权、attemptId 单实例、首次填充 handoff 核心思想、requestJson 错误脱敏、客户端串行控制器；消费计划B的：补充/重建拆分（Q1/Q5/Q6/Q8）、buildModelChange 纯策略、10 分钟预览与选择绑定、operationId 幂等、schema 2 profile 隔离、写前持久意图与条件回滚、启动恢复。两份原计划与设计规格、ADR 0004 保留为决策背景，不再作为实施依据；其三轮评审历史结论中与「非目标」节冲突的强保证（强取消、全库 ABA、跨进程锁）不在本计划承诺范围。
