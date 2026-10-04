# Copilot 授权、状态与共用接口实施计划

状态：2026-10-03第5轮独立只读复核通过，**计划ready，待用户批准实施；任务均未执行**。按已确认D-01软撤回与最终范围A，RV-01至RV-07全部计划层闭环，无待用户裁决分歧。原强取消／全库ABA未被实现或证明，而是被用户明确收窄目标替代；前三轮表仅保留历史。

## 目标

修正伪退出、启动竞态、静默网络错误与授权状态混淆；建立profile身份、本地授权绑定、准确的撤回请求／风险限制与可靠客户端控制器，为[模型事务计划B](<2026-10-03-copilot-model-transactions-implementation-plan.md>)提供明确接口。A完成不代表新的模型管理已实现。

## 架构快照

[host.mjs](<../../src/host.mjs>)保留cordis入口、现有刷新路由和统一status聚合，把授权生命周期提取到`src/auth-host.mjs`。新增scope与授权观察模块，不自行实现GitHub OAuth。浏览器把HTTP解析、串行请求、状态机与词典从[client.jsx](<../../src/client.jsx>)提取，DOM只负责展示。共享凭据键保持不变；profile局部观察记录不复制原始token。

## 全局约束（逐字继承设计）

- G01：Node.js >=20；保持现有发布 peer `@deepseek-ai/cordis: ^4.0.2`，不升级 DSH 或 pi-ai 代码。
- G02：DSH 0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2 为兼容目标；能力门禁与验证结果分别记录，不把版本范围当成无条件能力保证。
- G03：保留导航“GHC设置”／“GHC Settings”；正文标题使用 GitHub Copilot，操作为“授权登录／请求撤回／重新授权／退出登录”“补充模型”“重建模型列表”“应用更改”；unsafe退出／重新授权必须禁用并说明。
- G04：沿用 `/copilot-auth` 路由前缀和 `llm-pi-ai/github-copilot` 凭据键；en/zh 主信息等义；技术详情折叠并脱敏。
- G05：模型补充默认非破坏性；全量重建单独确认；底层目录只增不覆盖已有描述；不写官方归档、不通过路由级单协议绕过混合协议目录、不新增提供方路由。
- G06：共享宿主凭据库与公共安装目录数据，隔离 profile 配置、刷新事务、激活、缓存和诊断；遵循宿主 DSH_HOME 与稳定 profile 身份。
- G07：预览有效期 10 分钟；缓存可应用上限 24 小时且绑定同一本地授权绑定；断网状态自动重试最多 60 秒；无上游有效期时本地授权等待上限 15 分钟，以上均是产品策略而非 GitHub 保证。
- G08：不自动重启、不增加长期备份或用户撤销、不自动发送推理请求；真实授权、重启和可能耗配额的验证另获授权。
- G09：当前交付只含文档与计划；实现、安装、构建、提交、推送和发布均未获授权。

未来批准本计划只授权工作区实现与mock验证；真实环境与发版仍需另行授权。当前正式Node脚本见[package.json](<../../package.json>)，CI习惯见[ci.yml](<../../.github/workflows/ci.yml>)。新增开发测试依赖是计划中的评审提案，不是已获安装授权。

## 输入工件

- [设计规格](<../design/2026-10-03-dual-profile-auth-and-models.md>)§1–3、§5–6；Q1–Q31皆已确认。
- [领域词汇表](<../../GLOSSARY.md>)、[ADR 0004](<../adr/0004-safe-model-management-and-profile-isolation.md>)。
- [host授权测试](<../../test/host.test.mjs>)、[patch测试](<../../test/patch.test.mjs>)、[客户端构建脚本](<../../scripts/build-client.mjs>)。
- 现行v1.2.7代码基线；实施前重新核对HEAD，保留其他人新增的历史验证记录。

## 文件结构与职责（先定结构）

| 动作 | 文件 | 职责 |
|---|---|---|
| Create | `src/runtime-scope.mjs` | 从宿主profileContext解析稳定身份与用户数据路径；未知身份受限。 |
| Create | `src/resource-lock.mjs` | 适配已核实的宿主withFileLock，统一profile／授权观察／共享目录锁；不是自造租约锁。 |
| Create | `src/authorization-identity.mjs` | 本profile显式意图版本与私有材料观察；AuthBinding及现有凭据排他读围栏，不提供全库epoch。 |
| Create | `src/auth-host.mjs` | 单实例尝试、软撤回、不可证明安全的退出／切换禁用及风险锁存。 |
| Create | `src/api-errors.mjs` | 脱敏、结构化错误与HTTP响应投影，host专用。 |
| Create | `src/client-http.mjs` | 浏览器HTTP／JSON解析，返回完整脱敏结果，不接触host模块。 |
| Create | `src/auth-flow.mjs` | 纯授权状态归并和可注入时钟的串行追踪控制器。 |
| Create | `src/client-copy.mjs` | en/zh词典单一来源，B增加模型键。 |
| Create | `src/client-dialog.jsx` | 可访问Dialog，B复用。 |
| Modify | [src/host.mjs](<../../src/host.mjs>) | 接入授权模块、保留刷新模块，status统一聚合；首次填充CAS。 |
| Modify | [src/client.jsx](<../../src/client.jsx>) | 使用授权控制器、词典和Dialog，不保留并行status初始化。 |
| Modify | [src/shared.mjs](<../../src/shared.mjs>) | 增cancel路由、协议版本、结果字段与常量；保持原前缀／键。 |
| Modify | [package.json](<../../package.json>)、[package-lock.json](<../../package-lock.json>) | 发布包含新host模块；仅开发依赖增DOM测试，版本不在本轮发布。 |
| Reference | [scripts/build-client.mjs](<../../scripts/build-client.mjs>) | 保留生产信封；测试helper使用esbuild内存编译，不无故修改此脚本。 |
| Modify | [ci.yml](<../../.github/workflows/ci.yml>) | A17明确覆盖Node20.0.0／22与三OS、测试／构建／pack门禁。 |
| Modify | [test/host.test.mjs](<../../test/host.test.mjs>) | 更新新路由契约及保留首次填充旧回归。 |
| Create | `test/auth-boundary-contract.test.mjs`, `test/fixtures/copilot-auth-bridge.mjs`, `test/runtime-scope.test.mjs`, `test/resource-lock.test.mjs`, `test/authorization-identity.test.mjs`, `test/auth-host.test.mjs`, `test/client-http.test.mjs`, `test/auth-flow.test.mjs`, `test/client-copy.test.mjs`, `test/client-dom.test.mjs`, `test/compatibility.test.mjs`, `test/test-ui-loader.mjs`, `test/package-files.test.mjs`, `test/bundle-load.test.mjs`, `test/ci-contract.test.mjs` | Node内建测试；新文件按任务逐个创建，不能假称现在存在。 |
| Modify | [lib/client.js](<../../lib/client.js>) | 仅实施完成时由npm run build生成，禁止手写。 |

A与B都涉及host、client、shared、package与测试，**顺序执行，不并行覆盖**。A导出接口稳定后B才能消费。

## 跨计划接口契约

新增公开HTTP `protocolVersion:2`；现有6个路径保留，新增POST `/copilot-auth/cancel`。旧模型apply请求到B切换后不应被悄悄解释为新策略；B处理协议拒绝。A/B源码与bundle必须同步构建。

| 模块／接口 | 精确契约 |
|---|---|
| `resolveRuntimeScope(ctx,{fs,config})` | 返回 `{known,profileId,profileDir,dshHome,dataDir,reason}`；规范化宿主profile目录为稳定身份，数据归其profile；不从process.argv或homedir猜profile。`config`仅测试注入，不新增UI配置。 |
| `withResourceLock(filename,fn,{waitMs})` | 动态适配宿主已存在的 `@deepseek-ai/dsh-atomic-write` 公共withFileLock，跨同机／同PID命名空间进程互斥；缺能力返回LOCK_UNAVAILABLE，争用映射RESOURCE_BUSY。profile操作锁用dataDir内固定anchor，目录写锁用规范化真实catalogFile的同目录锁，不受不同DSH_HOME绕开。 |
| `observeAuthorization(ctx,{scope,reason,clock,store,recordProvided,recordSnapshot})` | 返回局部AuthorizationEvidence；外部调用用真实modifyRecord排他当前记录＋metadata锁观察，回调undefined不改凭据；recordProvided=true只使用已持有回调的记录，禁止重新入队。状态读取不写观察。 |
| `advanceIntentVersion({scope,reason,actionId,store})` | 调用方先持有profile操作锁；先持久失效再SDK请求，返回本动作的{intentVersion,actionId}，供accepted attempt私下固定originIntentVersion/originActionId。重复actionId幂等；安全门拒绝动作不发请求、不创建假新版本。不在metadata锁内访问凭据库。 |
| `withAuthorizationFence(ctx,{scope,expectedBinding,identity},fn)` | 通过现有credentials.modifyRecord排他读→recordProvided观察→比较完整AuthBinding→fn；callback返回undefined，返回fn结果非record。fn不递归改凭据、不做token刷新；profile操作→凭据记录→本地观察→安装目录锁序。 |
| `AuthBinding / AuthorizationEvidence` | AuthBinding={profileId,intentVersion,credentialObservationId}，后两项profile内持久opaque ID；Evidence={credentialState,authBinding,observationReadable,observedAt,capabilities,guarantee:"local-observed"}。不输出HMAC／私钥／grant，不含storeId或sharedBoundaryTrusted承诺。 |
| `createAuthorizationController(ctx,{scope,identity,onAuthorized,clock})` | {start,state,cancel,logout,readEvidence,dispose}；start接受时从advanceIntentVersion固定originIntentVersion/originActionId并在SDK回调闭包捕获attemptId，不读可变全局attempt替换来源。成功观察可更新事实，但当前版本仍匹配且该attempt无已接受撤回／超时风险才调用onAuthorized(AuthorizedHandoff)；释放handoff创建锁后回调，不能改绑旧事件。退出／切换安全门不变。 |
| `AuthorizedHandoff` | {attemptId,originActionId,originIntentVersion,authorizedAt,expectedBinding}；expectedBinding来自成功时grant观察，intentVersion必须等于origin，credentialObservationId允许与启动前absent不同。A09提交前再次校验来源／撤回标记／完整binding；不接收一份仅由当前V2重生成的成功事件。 |
| `AttemptSnapshot` | {attemptId,status,startedAt,code?,url?,expiresAt?,waitDeadline,withdrawalDelivery?,riskLatch,error?}；withdrawalDelivery=recorded|invoked|failed|unavailable，不是终止ACK。riskLatch在当前真实进程内跨组件重挂保持，不因begin已settle／presence或绑定变化解除。 |
| `ApiFailure` | `{ok:false,errorCode,messageKey,details,retryable,httpStatus,operationId?}`；details经白名单脱敏；不泄漏raw record／token／派生fingerprint。 |
| `requestJson(fetchImpl,url,init)` | 返回 `{ok,httpStatus,body,error}`；HTML／非JSON时保留HTTP状态，界面不直接输出整段代理页面。写调用不自动重发。 |
| `createAuthFlow({fetchImpl,clock,onState})` | `{init,start,cancel,logout,refresh,dispose}`；请求代次保护、无重叠轮询、60秒退避上限，卸载仅停本页请求。 |
| `/status` | 保留兼容presence字段，新增`authorization`证据、`attempt`概况、`capabilities`和结构化诊断；模型`refresh`由host原模块聚合，A不修改现行模型语义。 |

## 已裁决的授权范围与能力门

最新“确定A”取代旧D-02库级保证：依赖宿主现有readRecord／modifyRecord，不新增宿主接口。原desktop方案复用内置OAuth／凭据链；本地AuthBinding只保护本profile接受的明确操作与实际观察到的材料变化。其他客户端／profile在停机期间发生又恢复同材料的历史不在保证范围，不能用“检测不到”重新变成整体执行阻断。

D-01：仅请求撤回／结果待核实。已读Copilot桥接绕session.commit且忽略SDK store signal；cancel存在、begin／settled结束、一次presence、noop barrier都不证明底层晚写停止。这些事实仍是危险操作禁用的依据，不再要求插件补出强drain。

| 能力 | 当前目标版本行为 |
|---|---|
| 初始授权 | 本插件本实例无已知未核实风险、宿主无可见inFlight且无需替换已有记录时可启动；不承诺管理未知外部历史。 |
| 请求撤回 | 支持时调用现有cancel／signal；只显示送达调用或失败事实，风险锁存仍待核实。 |
| 退出／重新授权切换 | 当前缺安全保证默认disabled，前后端一致；不调用deleteRecord或替换begin。未来可信安全路径需要单独证据，不在本轮修宿主。 |
| 局部身份观察与提交读围栏 | 可复用真实modifyRecord＋profile私有观察；形状／文件／排他能力不可靠时只禁依赖它的写操作。 |
| 全库epoch／停机ABA | 非目标，不提供／不检测／不新增host或sidecar协议，也不假称已解决。 |

观察私有记录只保存HMAC、随机比较key与opaque绑定ID，不保存原始token。稳定refresh／enterprise变化更换观察ID，access／expires／modelIDs自然更新不更换；scope或观察文件不可信则不能消费旧绑定。状态查询只读；records更新事件异步调度排他观察，避免宿主锁内等待重入。原始记录与派生marker不进入普通恢复状态／HTTP／日志。

撤回风险是一条独立状态轴：整个真实当前进程中的控制器重挂必须复用风险锁存，不以重新创建controller／组件、AuthBinding变化或UI关页复位。当前没有可信drain则保持限制。新实际进程边界只在原写者确已退出、没有未跟踪子写者且实例生命周期可核实时重新初始化；PID复用／自建随机ID不作单独证明。这不是模型事务quiescent或本地意图版本。

## 任务清单

所有Run命令从仓库根执行，Node20+、npm。命令均可用于bash或PowerShell；每条单独运行，不依赖bash的`&&`。测试中的时间与网络全部注入，不用sleep猜竞态。每个测试文件在对应任务Step1创建后才运行。

### A00：验证现有宿主事实与受限行为

Files：Create `test/auth-boundary-contract.test.mjs`, `test/fixtures/copilot-auth-bridge.mjs`。Consumes：真实桥接、最终范围A、D-01。Produces：normalStart／requestWithdrawal／logout／reauthorize能力矩阵，局部保证边界。

1. 用真实同构fixture保留丢signal／绕session.commit／排队晚写，断言弱撤回结果和unsafe操作必须拒绝；加入本profile明确动作失效、正常access轮换、观察到的材料变化对照。停机同材料ABA只标不在范围，不把它伪测成检测成功。
2. Run `node --test test/auth-boundary-contract.test.mjs`；旧UI伪取消／伪退出或全库信任断言应失败。
3. 记录版本与已核对事实；强取消能力false不再阻止整个计划，受限行为本身是目标。仍禁止私有flow覆盖、影子key或全局改凭据方法。
4. 同命令全绿且准确表达范围；不因没有宿主新增epoch而停工，不因测试受限分支通过宣称真实取消保证。

### A01：解析稳定profile作用域

Files：Create `src/runtime-scope.mjs`, `test/runtime-scope.test.mjs`。Consumes：宿主profileContext `{name,dir,home,installAnchor}`。Produces：`resolveRuntimeScope`。

1. 写测试：不同profile同home不同ID；非默认home；路径规范化；运行时版本换路径不改变profileID；缺context返回known=false；越界／符号链异常受限。
2. Run `node --test test/runtime-scope.test.mjs`；红灯应是模块缺失或上述身份断言失败，不接受误访问真实home。
3. 实现宿主权威路径解析；dataDir位于profile私有用户数据子目录，返回值不创建安装探针；mock与真实fs适配分离。
4. 同命令全绿；完成标准：所有状态文件归属可解释，未知身份无共享fallback。

### A01b：适配同机跨进程资源锁

Files：Create `src/resource-lock.mjs`, `test/resource-lock.test.mjs`；Modify [package.json](<../../package.json>)、[package-lock.json](<../../package-lock.json>)开发依赖。Consumes：A01规范化scope；宿主公共 `withFileLock(filename,fn,{waitMs})`，已在三目标版本类型声明中发现。Produces：`withResourceLock`和统一锁顺序。

1. 当前lock的cordis为4.0.2，而atomic-write测试依赖peer为~4.0.4；未来获准实施先Run `npm install --save-dev --save-exact @deepseek-ai/cordis@4.0.4 @deepseek-ai/dsh-atomic-write@0.2.0-rc.2`，仅更新开发依赖与合法lock解析，不修改发布peer ^4.0.2、不加精确DSH发布peer。核对lock根版本与当前manifest一致、peer解析无冲突，禁止legacy-peer-deps／force隐藏问题。CI不能假设有本机安装树；测试真实公开导出通过注入loader加载这个开发依赖，另测生产动态解析缺失的受限路径。用tmp目录及Node child_process写竞争测试：两进程同anchor排他；不同home同真实catalog路径仍排他；持有进程退出可恢复；记录不完整／存活或复用PID不偷锁；异常释放及超时返回busy。
2. Run `node --test test/resource-lock.test.mjs`；当前仅createMutex无法满足跨进程测试，应红灯；测试依赖已存在不等于插件适配已实现。
3. 动态加载公共withFileLock，不增加精确版本发布peer；运行前能力检查，测试注入锁实现。profile anchor父目录按私有权限初始化，安装锁父目录仅限已证明可写的目录；保留宿主PID命名空间限制。锁等待预算明确传入，网络取数不持有写锁；未知锁归属不自动按年龄删除。目录内容仍用现有带fsync的原子写，不能误用宿主writeFileAtomic替换崩溃持久性。
4. 同命令全绿；锁争用不改文件内容，跨主机／PID命名空间共享存储明确不支持。若目标宿主不能解析公共导出，禁用相关修改并修兼容说明，不猜私有路径。

### A02：建立本profile授权绑定

Files：Create `src/authorization-identity.mjs`, `test/authorization-identity.test.mjs`。Consumes：A01 scope、A01b锁、现有credentials.readRecord／modifyRecord、设计§3.3。Produces：observeAuthorization、advanceIntentVersion、AuthBinding。

1. 写正常access／expires／modelIDs变动保持观察ID；真实稳定材料变化／缺失再出现更换ID；明确接受操作先更新intentVersion，重复actionId不重复更新；两profile互不共享版本；重启保留；未知形状、HMACkey／观察记录损坏不生成假绑定。旧材料ABA未被观察时不声称可识别。
2. Run `node --test test/authorization-identity.test.mjs`；旧无局部版本／观察无绑定方案应失败。
3. 私有HMAC仅用于稳定材料比较，意图版本和观察ID均为持久随机opaque标识；全部metadata写锁保护。不在锁外旧record读取后覆盖新观察：非recordProvided路径先由真实modifyRecord取得排他当前记录，provided路径不重新入队。显式版本更新在profile操作锁内、SDK副作用前完成；持久失败不发SDK动作。status只读，更新事件异步排队，原件损坏保留并使旧缓存／意图不可消费。
4. 同命令全绿；不输出或复制原始token，不新增全库协议。安全存储按平台真实权限／ACL核实，不把Windows chmod伪称等价。

### A02b：围栏内核实本地绑定

Files：Modify `src/authorization-identity.mjs`, `test/authorization-identity.test.mjs`。Consumes：observeAuthorization、现有modifyRecord与完整expectedBinding。Produces：withAuthorizationFence。

1. 写提交前材料变化／本profile意图版本变化拒绝fn；自然access轮换允许；回调期间同服务凭据写排队；callback undefined不改记录；未知形状／不支持排他读受限；provided路径不重入。观察事件与显式版本更新竞态不得丢更新。
2. Run `node --test --test-name-pattern="AUTH_FENCE" test/authorization-identity.test.mjs`；无完整绑定比较的版本应失败。
3. profile操作→真实凭据callback→本地metadata观察→完整binding核实→fn，返回undefined保留凭据。fn不递归modify／刷新token；网络取数在围栏外，提交前重核。不能证明效果验证不会重入时保持待核实，先修计划。
4. 同命令全绿；只协调合作的现有凭据服务，不承诺外部直接改文件或未观察同材料ABA。

### A03：统一HTTP与错误契约

Files：Create `src/api-errors.mjs`, `src/client-http.mjs`, `test/client-http.test.mjs`；Modify [shared.mjs](<../../src/shared.mjs>)。Consumes：既有routes／credential key。Produces：`ApiFailure`、`requestJson`、protocolVersion=2、cancel路径。

1. 写202／409／403／500／HTML502／空响应／JSON坏形状／网络断开及含模拟秘密的详情脱敏测试；检查路由前缀与key未变。
2. Run `node --test test/client-http.test.mjs test/patch.test.mjs`；预期原raw异常和无cancel契约断言红灯。
3. 白名单错误code及详情，分HTTP与业务结果；写请求不在helper中自动重试；更新routes，保留旧路径，未实现路由不得伪成功。
4. 同命令全绿；HTTP502不能仅显示Unexpected token，秘密断言全部通过。

### A04：建立单实例授权尝试

Files：Create `src/auth-host.mjs`, `test/auth-host.test.mjs`；Modify [host.mjs](<../../src/host.mjs>)授权start/state接线。Consumes：scope、identity、ApiFailure、宿主authorization.begin。Produces：`createAuthorizationController.start/state`、`AttemptSnapshot`。

1. 写deferred begin测试：请求先202、单attempt、二次409携当前attemptId、notice及未知prompt、SDK拒绝错误；github.com与既有自定义enterprise凭据受限；旧回调不覆盖新attempt。
2. Run `node --test --test-name-pattern="AUTH_START|AUTH_STATE" test/auth-host.test.mjs`；测试名使用这些前缀，旧实现应在attemptId／响应处理缺失上失败。
3. 抽离授权控制器；接受初始start时先在profile锁内advanceIntentVersion，把返回版本／actionId固定到该accepted attempt并由SDK回调闭包捕获attemptId；持久失败不调用begin。成功仅更新当前事实，创建AuthorizedHandoff须原版本仍当前且无本attempt撤回／超时标记，释放资格检查锁后才调用onAuthorized。controller复用真实进程风险锁存；传signal；只为已识别的github.com Enterprise选择prompt答空，未知提示结构化失败；验证设备URL为受信HTTPS GitHub验证页。记录真实notice字段与本地waitDeadline，不伪造expiresAt。
4. 同命令全绿；[旧host测试](<../../test/host.test.mjs>)的“cancelled即failed”规格由A05显式替换，其余固定key／同源守卫保留。

### A05：请求撤回与等待超时

Files：Modify `src/auth-host.mjs`, `test/auth-host.test.mjs`及[host.mjs](<../../src/host.mjs>)兼容cancel路由。Consumes：attemptId、现有cancel／signal、advanceIntentVersion。Produces：withdrawalDelivery、withdrawal-pending-unverified／timed-out-unverified与riskLatch。

1. 写请求在排队／已开始写／先settle后晚写时始终待核实；调用缺失／抛错不称发送成功；15分钟本地上限不伪造设备码过期。begin cancelled／presence／token轮换／绑定变化／组件重挂都不清锁存。
2. Run `node --test --test-name-pattern="AUTH_CANCEL|AUTH_TIMEOUT" test/auth-host.test.mjs`；强取消映射或风险被重挂清空应失败。
3. 已接受撤回先持久失效本地旧意图，再发一次SDK撤回调用；同attempt动作幂等。只记录invoked或failed，不转“已彻底取消”。风险状态在真实进程级保持，dispose只停止本页追踪，不销毁底层风险证据。无可信结束依据不释放新尝试／退出。
4. 同命令全绿；晚到凭据只更新所见事实，不反转为撤回成功，明确本地等待超时与上游失效不同。

### A06：拒绝不安全退出

Files：Modify `src/auth-host.mjs`, `test/auth-host.test.mjs`及[host.mjs](<../../src/host.mjs>)logout接线。Consumes：A00能力矩阵、riskLatch与宿主presence。Produces：明确disabled／logout-safety-unavailable，无伪退出。

1. 写当前桥接、撤回未核实、未知底层写者时logout拒绝，deleteRecord调用数为0；UI仍展示最后凭据事实。仅对已验证安全契约的对照fixture测真实删除失败／核实未知／重复退出。
2. Run `node --test --test-name-pattern="AUTH_LOGOUT" test/auth-host.test.mjs`；无条件delete／idle应失败。
3. 当前不安全目标版本默认禁用退出；服务端不因客户端强发而旁路。安全门不以一次absence或无inFlight作为充分证明。未来安全fixture路径才可失效本地版本、删除、核实；不能擅自全局改SDK来启用。
4. 同命令全绿；禁用不删除或回写任何凭据，不将能力缺失当整个模型管理需等宿主改造。

### A07：限制重新授权与新尝试切换

Files：Modify `src/auth-host.mjs`, `test/auth-host.test.mjs`。Consumes：A00矩阵／riskLatch／初始授权条件与advanceIntentVersion。Produces：不安全切换拒绝、初始授权可用及准确状态。

1. 写已有授权需要替换／已知未核实尝试时新的start/reauthorize拒绝，不调用begin／delete；组件重挂、晚到authorized、binding变化不绕过限制。初始无记录且无本插件已知风险与可见inFlight时单一正常尝试仍可开始。
2. Run `node --test --test-name-pattern="AUTH_REAUTHORIZE|AUTH_START" test/auth-host.test.mjs`；旧立即开始覆盖性尝试应失败。
3. 当前版本reauthorize默认disabled，正常初始启动先检查并持久本地意图版本；拒绝的请求不执行副作用。可信安全路径将来需要另证据才启用；插件不先清／复制／回写旧grant。源SDK已返回cancelled但无法排除晚写时仍保留风险锁存。
4. 同命令全绿；不承诺原始SDK绝不晚改凭据，说明的是插件不主动破坏和本实例已知风险限制。

### A08：建立串行浏览器授权控制器

Files：Create `src/auth-flow.mjs`, `test/auth-flow.test.mjs`。Consumes：requestJson、AttemptSnapshot、AuthorizationEvidence。Produces：`createAuthFlow`与分层视图。

1. 用fake clock和deferred fetch写慢init＋start、POST慢于旧state、轮询乱序、HTML响应、重挂载、dispose、60秒退避上限以及写超时先status核实测试。
2. Run `node --test test/auth-flow.test.mjs`；旧并行初始化／setInterval语义不得通过目标断言。
3. 单一init聚合status，请求序号与attemptId双保护；正常轮询1秒，连续读取失败按1/2/4/8/15秒封顶退避，累计60秒转手动重试。写操作不重发；取消页面fetch不取消宿主授权。
4. 同命令全绿；测试结束无悬挂定时器或未收集promise。

### A09：保护首次自动填充

Files：Modify [host.mjs](<../../src/host.mjs>) `syncAvailableModels`及[test/host.test.mjs](<../../test/host.test.mjs>)、`test/auth-host.test.mjs`。Consumes：A04的AuthorizedHandoff（attemptId／originActionId／originIntentVersion／成功时expectedBinding）、profile锁、A02b围栏及配置view＋revision。Produces：只属于原有效尝试的一次首次填充，不从晚到事实另造意图。

1. 保留空列表／合成层／override不覆盖回归。新增HANDOFF用例：start V1→withdraw V2调用失败或不可用→旧SDK正常authorized，presence可更新但配置mutate=0、旧cache/preview/intent不复活；正常未撤回V1成功产生新观察ID仍填充一次；handoff取数／提交期间再次版本变化或用户编辑拒绝；安全门拒绝动作不产生假版本。
2. Run `node --test --test-name-pattern="HANDOFF|登录|模型同步|挂载" test/auth-host.test.mjs test/host.test.mjs`；当前无来源handoff与仅取新binding的实现应在晚到成功断言失败。
3. 控制器先观察成功后的当前凭据事实，再在profile锁内核originIntentVersion仍当前、attempt归属及其无撤回／超时风险，生成immutable handoff；释放该锁再调用A09，不递归取profile锁。expectedBinding用成功时观察ID，不拿启动前absent的完整binding作成功比较。A09现场取数在写锁外，提交重新取得profile锁＋credential围栏，核完整expectedBinding、原版本／撤回标记及同次配置revision；任何变化只记录未填充，不重新以当前V2创建成功handoff。无配置才写，读取错误不当空配置，不增加新目录或伪造旧缓存时间。
4. 同命令全绿；正常首次成功不被新观察ID误阻止，晚到旧尝试不填充。撤回与填充按profile锁线性化：已先提交的配置不自动回滚，撤回先接受则mutate为0；状态依旧区分授权事实与配置结果。

### A10：抽出等义双语词典

Files：Create `src/client-copy.mjs`, `test/client-copy.test.mjs`；Modify [client.jsx](<../../src/client.jsx>)词典引用。Consumes：设计§5准确文案。Produces：`DICTS`与`messageKey`映射。

1. 写en/zh键集合一致、参数一致、nav精确GHC值、请求撤回与已终止分开；超时仅建议查询／人工核实，不显示可直接重试授权；unverified不是普通失败，技术错误不直显、presence不承诺推理。
2. Run `node --test test/client-copy.test.mjs`；现有硬编码取消和混用模型词条应红灯。
3. 将词典提取成浏览器纯模块；A添加授权／连接／通用词条，旧模型词条暂保留，B按设计替换。导航图标匹配继续基于相同nav文本。
4. 同命令全绿；所有新增主信息都有等义英文，不修改GHC入口名。

### A11：建立真实DOM测试基建

Files：Modify [package.json](<../../package.json>)、[package-lock.json](<../../package-lock.json>)；Create `test/test-ui-loader.mjs`, `test/client-dom.test.mjs`。
Consumes：现有React18.3.1 lock、esbuild构建习惯。Produces：Node:test可运行的组件DOM验证。

1. 写冒烟测试：内存编译JSX、jsdom挂载React组件、act刷新与卸载，禁止写lib／外网请求。
2. 在未来已授权工作区实施中运行 `npm install --save-dev --save-exact react-dom@18.3.1 jsdom@26.1.0`；再Run `node --test --test-name-pattern="DOM_HARNESS" test/client-dom.test.mjs`。依赖版本安装前复核当前React lock及Node20 engines，不匹配先修计划；这些包不是当前已存在的测试框架。
3. test-ui-loader使用已存在esbuild `write:false`内存编译、受控require与jsdom；React DOM仅开发依赖，host发布运行时不引用。清理window、document、定时器与React root。
4. 同命令全绿，再Run `npm ci`与同命令以验证lock重现；本任务不是浏览器实机验收。

### A12：接入授权分层界面

Files：Modify [client.jsx](<../../src/client.jsx>) `CopilotSection`；Modify `test/client-dom.test.mjs`。Consumes：createAuthFlow、DICTS、聚合status。Produces：UI授权进度、重新授权、请求撤回／退出禁用说明、连接与模型错误分层。

1. 写DOM测试：present与syncError同时显示；拒绝／未知退出不变absent；202后waiting；请求撤回及unsafe退出／重新授权前后端拒绝；超时只显示查询／人工核实，不显示新授权重试；离开再回来风险不清，原始异常不展示。
2. Run `node --test --test-name-pattern="DOM_AUTH" test/client-dom.test.mjs`；旧组件伪退出／双初始化应红灯。
3. 去掉重复status和setInterval；统一controller订阅，dispose不清进程风险。展示请求撤回／待核实；当前unsafe退出／reauthorize按钮disabled且解释原因，HTTP强发仍被拒绝。presence变化不解除限制，初始正常授权与连接失败保持事实分层。
4. 同命令全绿；旧刷新视图仍保留，A不提前展示尚未实现的补充／重建入口。

### A13：呈现复制结果

Files：Modify [client.jsx](<../../src/client.jsx>)复制动作；Modify `test/client-dom.test.mjs`。Consumes：词典及安全设备码展示。Produces：可选择复制的代码、success／failure live region。

1. 写clipboard resolve／reject／缺接口的DOM测试，确保失败仍可手动选择代码。
2. Run `node --test --test-name-pattern="DOM_COPY" test/client-dom.test.mjs`；旧静默catch应红灯。
3. 显示本地化失败提示；成功状态有明确短时恢复，不把代码或token写日志。
4. 同命令全绿；测试覆盖非安全上下文替代路径，不声称jsdom已验证桌面剪贴板。

### A14：提供可访问Dialog

Files：Create `src/client-dialog.jsx`；Modify [client.jsx](<../../src/client.jsx>)退出确认；Modify `test/client-dom.test.mjs`。Consumes：en/zh标题与可取消阶段。Produces：`Dialog({titleId,canCancel,onCancel,initialFocusRef,children})`。

1. 写可访问名称、Tab／ShiftTab圈定、Esc、背景inert、关闭焦点恢复、pending时不能取消、默认取消焦点的DOM测试。
2. Run `node --test --test-name-pattern="DOM_DIALOG" test/client-dom.test.mjs`；旧role-only弹窗不满足。
3. 实现受控焦点与背景保存／恢复（不覆盖原inert属性），提交期只读进度；B复用此组件替换刷新弹窗。
4. 同命令全绿；真实键盘／读屏列为后续人工门禁，不能用属性断言替代全部体验。

### A15：聚合状态与能力门禁

Files：Modify [host.mjs](<../../src/host.mjs>)status／插件清理；Create `test/compatibility.test.mjs`；Modify `test/auth-host.test.mjs`及[test/host.test.mjs](<../../test/host.test.mjs>)。
Consumes：scope、auth.readEvidence、AttemptSnapshot及既有refresh状态。Produces：protocolVersion2 status、按能力受限结果。

1. 写0.1.7-rc.2／0.2.0-rc.1／rc.2 API形状fixtures，缺profileContext／cancel／安全凭据身份／settings namespace都不能伪成功；status不产生写探针；销毁取消控制器并停止订阅。
2. Run `node --test test/compatibility.test.mjs test/auth-host.test.mjs`；缺能力fixture在旧实现上应出现错误／静默失败。
3. status只聚合本地AuthBinding与风险／能力，不输出全库epoch或令牌派生marker；不把credential读取失败变false；明确归属与可能共享说明。现有refresh状态也改为读取初始化时缓存的安装分类，status不调用会创建probe的resolveInstall；B后续替换为统一capabilities模块。不加入新强制inject导致旧宿主整个登录页消失，缺能力只禁相关修改。B尚未接管旧refresh时准确标记现行语义，不能以A就绪宣称模型事务已安全。
4. 同命令全绿；再Run `node --test test/host.test.mjs test/patch.test.mjs`，更新6→7路由断言并保留同源检查。fixtures只证明契约形状，版本声明仍需实机门禁。

### A16：验证可发布构件与交接

Files：Modify [package.json](<../../package.json>)files、[lib/client.js](<../../lib/client.js>)构建结果；Create `test/package-files.test.mjs`, `test/bundle-load.test.mjs`；[README](<../../README.md>)只更新A实际完成部分。
Consumes：最终A范围已确认、A00受限行为明确、A01–A15全绿接口、A11DOM／内存编译helper。Produces：供B复用的package／bundle自动门禁及构件，不发布。

1. package测试从`npm pack --dry-run --ignore-scripts --json`实际清单断言新增host imports全包含、测试依赖／秘密不在发布包。bundle测试加载真实构建的ModuleLoader信封，给出受控require映射和真实React，断言factory/apply注册GHC slot成功、无Node-only导入；另测试host入口及pack内相对imports可解析。
2. Run `npm run build`；Run `node --test test/package-files.test.mjs test/bundle-load.test.mjs`；未补files／构件不匹配时必须失败，单纯列清单不算bundle可加载。
3. 将A新增host运行时模块加入files，保留CJS信封和external React。test helper只控制宿主服务，不把任意require返回空对象冒充加载成功；释放DOM与测试副作用。README准确声明软撤回、局部保证与当前unsafe操作禁用，不预先说明未实现模型功能。
4. Run `npm run build`、`npm test`、`npm pack --dry-run --ignore-scripts --json`全绿；输出A接口与B尚未实施项。构件loader测试不等于现有GUI实测。

### A17：落实最低Node与三平台CI门禁

Files：Modify [ci.yml](<../../.github/workflows/ci.yml>)；Create `test/ci-contract.test.mjs`。Consumes：A16的package／bundle测试、现有yaml开发依赖和npm脚本。Produces：明确可执行的CI矩阵与契约测试。

1. 写yaml结构检查：OS为ubuntu-latest/windows-latest/macos-latest，Node矩阵为20.0.0与22，setup-node用matrix.node；每格依次npm ci→npm run build→npm test→npm pack --dry-run --ignore-scripts --json，不能只固定22或遗漏pack。
2. Run `node --test test/ci-contract.test.mjs`；现有Node22单轴且无pack的workflow必须失败。
3. 修改CI形成6格，Node20.0.0是engines>=20的精确最低验证，不悄悄以最新20.x代替。若新增依赖／实现不支持该最低版本，先修计划或向用户申请版本下限调整，不无声更改G01。验证工作区仅开发cordis更新满足~4.0.4，发布peer仍^4.0.2；无需升级DSH／pi-ai。CI构件加载由A16测试实际执行，不靠dry-run清单代替。
4. 同命令全绿；未来CI6格实际成功才记录最低版本／三OS自动验证，通过本地结构检查不冒充远端CI已跑。不得在当前文档阶段触发发布或改workflow。

## 执行纪律

开始实现前先批判性复查整份计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划。按任务顺序执行，不无声跳步、合并或改变目标；每任务运行其验证。阻塞、重复失败或环境与计划不符立即说明，不猜。若在main／master且用户未同意，开始实现前先确认。自然边界可在额外授权后checkpoint commit，本计划不要求或授权自动提交。全部任务后运行最终验证并输出摘要。

A和B共享代码文件，B必须在A接口评审和测试通过后开始。正常流程及安全能力无法证明时明确受限，不通过伪presence、猜profile、伪有效期或覆盖用户新修改“修复”测试。

## 最终验证与人工门禁

- 从仓库根逐条Run：`npm ci`；`npm run build`；`npm test`；`npm pack --dry-run --ignore-scripts --json`。先产生当前构件再验证真实loader／pack，预期测试全绿、host import完整且无新发布peer。
- A17把CI明确为三OS×Node20.0.0／22的6格，依次npm ci→npm run build→npm test→pack检查；真实运行结果才计入验证。Node20.0.0符合G01的最低下限，不能以最新20.x／Node22通过替代。
- 必须按设计A01–A06／U01验收；真实GitHub初始授权、请求撤回及unsafe退出／重新授权拒绝，在用户另行授权的测试账号／测试凭据库进行，不碰现有生产授权。撤回后结果未核实及禁止主动删除／回写的契约逐目标版本核实，不要求证明原SDK无晚写。
- Linux web、Windows desktop人工检查GHC导航、离开恢复、请求撤回／退出禁用说明、剪贴板、键盘与读屏。当前没有桌面实机的执行者应如实保留缺口，不能交付已验证声明。
- 不自动发送推理；不重启已有服务；不启动替代GUI；部署构件与现有GUI验证需另行批准。

## 评审 Checkpoint

本计划按最终A复核，重点审本地绑定与显式失效、软撤回的风险锁存／能力限制、真实现有API围栏、开发依赖与兼容fixture；不再要求宿主库级代次或强取消改造。获批准后由普通编码agent或人工按任务执行；本planning阶段停在此处，不转入编码。

## Inline 自检记录

原inline自检只检查结构，不作为真实API／安全证明。独立评审指出的前提与完成标准已按证据修订；最终状态以下表为准。本轮未改代码／依赖／构件，未运行npm／CI／真实授权或重启。

## 前三轮独立评审历史记录（更强目标下的结论）

同一个可持续只读评审Agent使用独立初始上下文，首轮只取得计划、目标和相关代码；执行Agent逐条接受并修订，两轮复核后形成如下结论。没有以作者自评为证据，也没有反驳被接受项。

| 问题 | 严重程度 | 处理与结论 | 最终状态 |
|---|---|---|---|
| RV-01：取消／最终退出缺真实drain | 阻断 | 增真实桥接A00、排队／已开始／先settle时序、当前受限行为；D-01必须由用户裁决 | **仍未解决，待用户决策**；不能以文档门当强取消已实现 |
| RV-02：共享凭据库ABA／授权边界 | 阻断 | 局部HMAC降为材料诊断；共享边界未知不trusted，保留D-02协作／宿主权威来源选项 | **仍未解决，待用户决策**；原Q30未完整达成 |
| RV-03：跨启动revision／配置归属 | 重要 | 会话ID、receipt、commit-gap和保守恢复决策表 | **已修改并复核通过（计划层）** |
| RV-04：真实unset／raw恢复与过宽门禁 | 重要 | 真继承语义fixture；门禁按sealed writeSet，纯目录not-required、需配置写才要求对应恢复 | **已修改并复核通过（计划层）** |
| RV-05：失效意图无可操作解除闭环 | 首轮阻断→重要 | resolve协议／终结与静止判断；客户端说明确认、未知查询、DOM完整链及恢复负债保护 | **已修改并复核通过（计划层）** |
| RV-06：完成／过期后的幂等证据 | 重要 | 服务端ID绑定、持久requestBinding、先查结果、消费标记与明确有限窗口 | **已修改并复核通过（计划层）** |
| RV-07：最低Node／pack与构件CI缺任务 | 重要 | 开发peer合法解析、A16真实加载、A17六格矩阵；B复用门禁 | **已修改并复核通过（计划层）** |

第3轮无新增有证据的问题。五项关闭是计划缺口关闭，不是未实现功能、CI、实机或安全验证通过。对D-01／D-02双方无事实分歧：冲突在当前宿主能力与已确认目标之间，用户须决定扩大协作范围、修改目标或保持暂停；不能只把能力flag置true。当前整体执行不放行。后续获得裁决后更新受影响目标／ADR／接口／计划，再复核。

上表是更强目标下的历史，不是当前执行阻断。用户随后确认D-01软撤回及最终范围A；第4轮接受新范围，第5轮定向修订后复核全部通过。

## 当前独立评审结论（第5轮）

| 问题 | 当前目标下的处理 | 最终状态 |
|---|---|---|
| RV-01 | 用户改为请求撤回／待核实；unsafe退出与新尝试前后端禁用，超时不建议非法重试 | 已修改并复核通过（计划层） |
| RV-02 | 用户确定局部保证A；真实现有API排他观察＋本profile意图版本，AuthorizedHandoff保原来源，晚到旧成功不填充 | 已修改并复核通过（计划层） |
| RV-03 | 会话revision／receipt／commit-gap保守恢复 | 已修改并复核通过（计划层，交叉保持） |
| RV-04 | sealed writeSet限定恢复门，纯目录not-required | 已修改并复核通过（计划层，交叉保持） |
| RV-05 | 服务端＋客户端resolve完整确认闭环，负债与风险轴独立 | 已修改并复核通过（计划层，交叉保持） |
| RV-06 | 服务端ID绑定／持久结果优先／有限窗口 | 已修改并复核通过（计划层，交叉保持） |
| RV-07 | 构件实际加载／最低Node六格CI／合法开发peer解析 | 已修改并复核通过（计划层，交叉保持） |

原只读评审Agent第5轮明确两份计划可交付为“独立评审通过、待用户批准实施”；无剩余计划分歧、无反驳接受项、无新增宿主接口前提。强取消与全库ABA没有实现或证明，其冲突由用户改变目标解决。所有新测试、CI、构件、Linux／Windows实机契约尚未执行；仍需实施与真实操作分别获授权。本阶段只修改五份文档，不进入编码。评审Agent保留可恢复只读状态。
