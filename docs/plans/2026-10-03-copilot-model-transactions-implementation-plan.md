# Copilot 模型补充、重建与双 profile 事务实施计划

状态：2026-10-03第5轮独立复核通过，**计划ready，待用户批准实施；任务均未执行**。依赖[计划A](<2026-10-03-copilot-authorization-state-implementation-plan.md>)的局部AuthBinding与真实现有API；按最终范围A无新增宿主边界前提。RV-01至RV-07全部计划层闭环，不表示实现／CI／实机已通过；获授权后仍按A→B顺序。

## 目标

将单一破坏性刷新拆成保守补充与显式重建；修正desktop二次操作、覆盖重置、registry可解析集合、并发覆盖、崩溃窗口与错误丢失；建立稳定profile状态、可信证据与快照、双通道可恢复事务，保留公共目录与宿主认证边界。

## 架构快照

[host.mjs](<../../src/host.mjs>)保留cordis入口与HTTP路由接线；刷新计算、快照、事务和启动恢复拆到独立模块。profile用户数据独立，公共可写目录仍只增；同机共目录写入使用共同资源锁。应用与恢复执行同一事务内核，模型配置变化与目录落地分开；确认前网络取数，提交时不悄悄换latest数据。

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

跨主机／不同PID命名空间共享目录不是此锁策略的支持范围，明确受限；同机不同DSH_HOME共用一个目录必须仍受同一目录锁约束。真实安装目录修改仅在另外获准的验证阶段执行。

## 输入工件

[设计规格](<../design/2026-10-03-dual-profile-auth-and-models.md>)§4–6、[ADR 0004](<../adr/0004-safe-model-management-and-profile-isolation.md>)、[计划A](<2026-10-03-copilot-authorization-state-implementation-plan.md>)、[历史目录ADR](<../adr/0001-data-level-catalog-patch.md>)与[注册表ADR](<../adr/0003-catalog-registry-injection.md>)。测试习惯为现有[host](<../../test/host.test.mjs>)、[state](<../../test/state.test.mjs>)、[registry](<../../test/catalog-registry.test.mjs>)、[flow](<../../test/refresh-flow.test.mjs>)用例；历史固定数量不是验收门槛。

## 文件结构与职责

| 动作 | 文件 | 职责 |
|---|---|---|
| Create | `src/model-update.mjs` | 纯模型策略、完整view、候选／损失／原因／顺序。 |
| Create | `src/account-evidence.mjs` | 实时账号证据、profile可信缓存、本地AuthBinding与24小时门禁。 |
| Create | `src/catalog-capabilities.mjs` | file／registry／blocked／unknown能力检测，状态只读缓存，运行时证据。 |
| Create | `src/preview-store.mjs` | 10分钟服务端快照、选择绑定、作用域及漂移校验。 |
| Create | `src/refresh-service.mjs` | preview/apply/status编排，协议2输入验证，boot/apply统一排队。 |
| Create | `src/refresh-transaction.mjs` | 两通道持久操作意图、配置提交、效果验证、条件补偿。 |
| Create | `src/refresh-recovery.mjs` | 启动恢复、跨基线gate、授权变化／旧状态确认与激活。 |
| Create | `src/settings-commit.mjs` | 同次配置view+revision、受保护提交、条件回滚与临时快照切换。 |
| Modify | [src/state.mjs](<../../src/state.mjs>) | profile schema2、分阶段诊断、活动意图与迁移只读信息。 |
| Modify | [src/catalog-registry.mjs](<../../src/catalog-registry.mjs>) | 完整预检、异常结构化、注入归属、条件补偿、实际可见结果。 |
| Modify | [src/catalog.mjs](<../../src/catalog.mjs>)、[src/catalog-fetch.mjs](<../../src/catalog-fetch.mjs>)、[src/copilot-models.mjs](<../../src/copilot-models.mjs>) | 保留目录／供应链守卫，区分错误来源，核对显式版本耦合。 |
| Modify | [src/host.mjs](<../../src/host.mjs>) | 保留A授权接线，只连接refresh service；删除被替代的重复内核。 |
| Modify | [src/refresh-flow.mjs](<../../src/refresh-flow.mjs>)、[src/client.jsx](<../../src/client.jsx>)、`src/client-copy.mjs` | 新策略预览、勾选绑定、结构化结果、可重新操作状态与风险。 |
| Modify | [src/shared.mjs](<../../src/shared.mjs>) | 协议2模型请求／结果、策略与阶段常量。 |
| Modify | [package.json](<../../package.json>)、[lib/client.js](<../../lib/client.js>)、[README](<../../README.md>) | 实施后打包新增host模块、构建及更新真实用户说明；不发版。 |
| Create | `test/model-update.test.mjs`, `test/account-evidence.test.mjs`, `test/catalog-capabilities.test.mjs`, `test/preview-store.test.mjs`, `test/settings-commit.test.mjs`, `test/refresh-transaction.test.mjs`, `test/refresh-recovery.test.mjs`, `test/profile-isolation.test.mjs`, `test/refresh-test-kit.mjs` | 按任务创建，tmp／内存fixtures、deferred竞争与故障断点。 |
| Modify | [test/state.test.mjs](<../../test/state.test.mjs>)、[test/host.test.mjs](<../../test/host.test.mjs>)、[test/catalog-registry.test.mjs](<../../test/catalog-registry.test.mjs>)、[test/refresh-flow.test.mjs](<../../test/refresh-flow.test.mjs>)、`test/client-dom.test.mjs`, `test/compatibility.test.mjs` | 保留有效旧回归，明确替换旧镜像／空集合／applied死态假设。 |

不得与A并行编辑这些共享文件。新模块按职责拆，原子JSON/fsync模块继续使用，不顺带替换为不保证fsync的写库。

## 接口契约与依赖

### 从A消费（执行B前必须存在并通过测试）

- `resolveRuntimeScope(ctx,{fs,config}) -> {known,profileId,profileDir,dshHome,dataDir,reason}`，未知归属不修改。
- `observeAuthorization(ctx,{scope,reason,clock,store,recordProvided,recordSnapshot}) -> AuthorizationEvidence`，authBinding={profileId,intentVersion,credentialObservationId}只保护本profile明确操作与观察到的稳定材料变化；正常access轮换不改变观察ID。
- `withAuthorizationFence(ctx,{scope,expectedBinding,identity},fn)`：现有modifyRecord排他当前记录＋本地观察，完整AuthBinding匹配才执行fn；provided路径不重入，回调undefined不改token，fn不刷新token。不要再要求sharedBoundaryTrusted/storeId或全库epoch。
- `withResourceLock(filename,fn,{waitMs})`：已验证宿主公共锁适配。统一锁顺序为profile操作→凭据记录→授权观察→安装目录。账号网络取数与npm下载均在写锁外。
- `ApiFailure`、`requestJson`、protocolVersion2、固定routes/key；`Dialog`和DOM测试基建、`DICTS`。

### B产出的稳定接口

| 模块／函数 | 契约 |
|---|---|
| `buildModelChange({rawView,effectiveView,accountEvidence,resolvableIds,catalogDelta,plannedSnapshotSwitch,operation,selectedIds,confirmEmpty})` | operation仅supplement／rebuild；返回targetView、writeSet、候选／选择、added／removed（带reason）、kept、losses、warnings、allowed及原因。目录-only强制模型／覆盖／snapshot配置写集为空；rawView供CAS、effectiveView供语义，恢复能力按writeSet评估。 |
| `resolveAccountEvidence({ctx,scope,identity,clock,fetchImpl})` | `{source:live|cache|missing|expired|identity-changed,ids,fetchedAt,authBinding,error,canSupplement,canRebuild}`。只成功现场GET有可信采集时间，历史payload不伪造时间；缓存单独profile文件，不与活动事务互相覆盖。 |
| `createCatalogCapabilities({ctx,scope,opts})` | `{initialize,readStatus,recheckForApply,readResolvable}`；status无探针；fresh检测返回mode、reason、安装身份、version、磁盘／运行时摘要与宿主证明来源。 |
| `createPreviewStore({clock,scope})` | `{create,materializeSelection,get,validate,release}`；opaque previewId、有效期10分钟。选择变化基于同原快照生成绑定选择的新ID，不延长原有效期；不重复下载。 |
| `captureSettings(ctx,{settingsSessionId})` | 同次describe取 `{rawView,effectiveView,baseView,revision,settingsSessionId,restorationCapability}`；完整模型字段与覆盖值进入baseline，读取失败不是空view。 |
| `commitSettings(ctx,{baseline,targetView,expectedBinding,operationId,settingsSessionId})` | 用同会话真实revision提交；返回configCommitReceipt（含ownedView／观察链）或conflict／unknown。宿主mutate返回void，不能假造返回revision；归属不明不自动回滚。 |
| `restoreOwnedSettings(ctx,{baseline,receipt,settingsSessionId,operationId})` | 当前session必须与receipt相同且完整ownedView／revision／观察链仍匹配，才恢复raw-exact view；跨启动或其他归属不明返回rollback-conflict，不覆盖用户新配置。 |
| `ensureCatalogServed(ctx,{targetIds,operationId,scope})` | 宿主listModels验证；必要时受控快照切换，返回 `{ok,missing,proof,compatibilitySwitch}`，不以自有getBuiltinModels自证替代。 |
| `createRefreshService(ctx,{scope,identity,capabilities,store,clock})` | `{preview,apply,status,resolve,bootReady,dispose}`；boot/apply/resolve同一串行队列，状态资源排他；新apply不覆盖未完成operation。resolve只终结已静止且经确认的失效配置意图，保留副作用与恢复负债。 |
| `runRefreshTransaction(ctx,{preview,operationId,scope,identity,capabilities,stateIO,failpoint})` | 在变化前持久意图；file/registry共用阶段／结果；failpoint仅测试注入，生产不暴露调试路由。 |
| `recoverRefresh(ctx,{scope,identity,capabilities,stateIO})` | 核实归属／授权／版本／配置后恢复；幂等，不自动联网发现新条目或消费旧共享journal。 |

### 配置归属与恢复决策（RV-03／RV-04）

settings revision属于当前宿主进程的内存计数，含运行fiber身份；新进程可能从0重新计数。schema中的revision只能在相同`settingsSessionId`内作为CAS／回滚证据，不能跨启动当持久版本。createRefreshService在本次服务实例初始化生成随机settingsSessionId并传入capture／commit／restore／快照恢复辅助；从持久记录读取的是旧会话标识，不能将它重新赋给新实例。标识只划定观察证据的有效会话，不充当稳定profile身份；热重挂且观察链丢失也按新会话受限。

activeOperation增加`configCommitReceipt:{settingsSessionId,preRevision,postRevision?,baselineDigest,targetDigest,ownership:owned|unknown,observations}`及`restorationCapability`；compatibilitySwitch同样记录会话与前／后字段观察。先持久prepared，再修改配置；如果配置已写但receipt尚未持久，恢复必须承认commit-gap，不按target相等推断自己拥有配置。

| 恢复观察 | 允许的动作 | 禁止的动作 |
|---|---|---|
| 新启动、当前完整raw view仍等于baseline，确认意图／本地授权绑定／基线兼容均有效 | 重新读取当前revision，以新CAS继续确认过的目标；不使用旧revision | 因旧计数不同永久卡住，或以旧revision覆盖新配置 |
| 当前view等于target，但旧receipt属于其他会话或未保存 | 记录target-observed／ownership-unknown，核实实际效果并进入需人工确认的解除流程 | 自动认领提交、自动回滚到baseline，或把数字相同当归属证明 |
| 当前view既非baseline也非target，或用户改后改回导致归属不明 | 保留当前值，记录conflict／rollback-conflict | 根据最新revision强制恢复旧值 |
| 当前同会话，完整owned view与owned revision及观察链均匹配 | 按受保护CAS补偿本操作；不证明归属时仍受限 | 凭一次最新describe把他人的值当作自己的提交 |
| 配置写已生效、configuration-committed保存失败 | 保留prepared＋commit-gap诊断；新启动重新观察，不假造持久receipt | 把prepared当成“肯定未写”或无条件再次写／回滚 |

恢复能力绑定本次已确认的writeSet，而不是整个baseline的一刀切门禁。writeSet明确列出catalog、models、modelOverrides、providerNameSnapshotSwitch，sealed preview及activeOperation保存该集合；未列出的配置写禁止临时加入。真实settings.mutate对有继承值的unset会转set(base)，config-editor仅在整个next等于inherited时清覆盖，旧mock的unset直接delete不作证明。

| 本次writeSet | 恢复门禁 | 预览／执行结果 |
|---|---|---|
| 只有目录文件或registry条目新增，models／overrides／snapshotSwitch均不写 | 模型配置restorationCapability=not-required | 允许明确的目录-only确认，不因用不到的模型raw恢复能力阻止；仍核实身份／证据／目录安全与持久意图 |
| 将写models或modelOverrides | 对会写的模型字段要求raw-exact恢复；不可证明则restoration-capability-insufficient | 在任何本操作副作用前阻止这份混合操作，不能先补目录再暗中丢配置步骤 |
| 已确认可能写临时名称以刷新快照 | 单独核实名称的归属／恢复能力；不能借模型字段能力替代 | 未确认的兼容切换不能自动加入纯目录路径；能力不足需新预览或报告具体限制 |

例：base有models、raw缺models且有无关displayName。selected=[]且writeSet仅目录新增时允许，完全不调用settings.mutate或兼容切换；选择新增模型并需提交配置时，若缺席状态无法由公共API恢复则受限。目录-only不因现有不可解析模型偷偷改列表或名称，结果只说明目录落地与未改配置；不假称未选择的新模型已经在picker可用。文件目录-only仍可能待重启加载，registry目录-only验证条目落地即可，不额外要求用配置写刷新宿主列表。

配置写路径保持raw-exact，不静默降为只恢复effective值；回滚核对raw/effective及无关路由字段，任何存在性不符不算rolled-back成功。不得整namespace replace或直接写profile文件强行达标。纯目录也不跳过其他实际需要的能力／副作用与授权门禁。

### HTTP与持久数据

所有新模型请求带protocolVersion=2。初始POST preview `{operation,catalogSource}`；catalogSource仅latest／local／overlay。补充选择变化调用同一preview路由 `{basePreviewId,selectedIds}`，服务端从原快照materialize，UI只允许确认最后一份与当前选择一致的预览。新ID沿用原expiresAt。重建空集合通过同样的预览再确认路径绑定`confirmEmpty:true`，输入变化重置确认。

apply为 `{protocolVersion:2,previewId,operationId}`，目标／选择／来源不从client另行接收。operationId由服务端随绑定选择的preview签发，client不能自选或挪用别的preview的ID。处理顺序：①按当前activeOperation／最近lastResult查operationId，先比较持久requestBinding（含previewId与请求摘要），相同返回已知结果，即使preview已过期／进程已重启；同ID不同绑定拒绝。②ID不在保留窗口，再查当前实例live preview及其签发operationId；已消费preview只能返回历史结果未知，不重复执行。③只有从未消费且作用域／签发ID匹配的live preview才继续时效、profile、完整AuthBinding、配置、目录／运行时和账号证据核实。冲突409要求新预览；旧协议400 upgrade-required；忙423 resource-busy。GET status的operationId查询明确返回active／last-result／unknown三态；unknown不是未执行。网络写响应不明先查同ID，绝不换ID自动重发。

`OperationResult`：`{operationId,requestBinding,status,terminal,configurationIntent,quiescent,phase,mode,restartRequired,changes,rollback,errors,actions}`。status为`not-applied|no-change|pending-restart|applied|conflict|partial|rolled-back|rollback-conflict|recovery-needed|intent-retired`。prepared／实际应用／pending-restart及未证明静止的partial都是nonterminal；no-change／已验证applied／已证明补偿完毕的rolled-back为terminal；conflict／rollback-conflict／recovery-needed不能只按名称自动terminalize，必须走下述解除协议。counts分catalogAdded／modelsAdded／modelsRemoved／persistedOverlayCount／actuallyVisibleCount；可见数量未知时null。requestBinding保留previewId、profileId、策略、选择摘要、来源摘要与目标摘要等非秘密归属信息，lastResult保留完整绑定及副作用／诊断摘要；不保留token或令牌派生marker。窗口明确只有当前操作和最近一个完成／终结结果，不承诺多次历史。完成第二个操作后第一个ID查询为unknown；同ID不能绑定新preview重新执行。旧实例内存preview在重启后无效，已消费preview在原有效期内保留consumed标记；因此未知老ID无法以一个新preview变成新操作。

schema2：`{version:2,profileId,activated,appliedOverlay,appliedProvenance,activeOperation,lastResult,errorsByStage,compatibilitySwitch}`。activeOperation含operationId、strategy、selectedIds、confirmedEmpty、profileId、authBinding、installedBaseline、settingsBaseline完整视图／revision、targetView、pendingOverlay、provenance及phase。阶段：prepared→catalog-landed→configuration-committed→verified，file需要加载时转pending-restart，不能完成时recovery-needed／conflict。状态转换先持久再宣布成功；清某stage只清该stage诊断。

profile文件位于A返回dataDir，刷新为`refresh-state.json`，缓存为`account-model-cache.json`；旧全局状态仅作为只读迁移候选。配置仍通过宿主settings API，不直接写宿主profile配置文件。activeOperation同时保存requestBinding、configCommitReceipt和restorationCapability；终结后将请求绑定及实际副作用／诊断摘要原子转入lastResult，再清activeOperation，不把配置基线做长期备份。

### 失效意图解除协议（RV-05）

新增同源POST `/copilot-auth/refresh/resolve`，正常body为`{protocolVersion:2,operationId,action:"retire-config-intent",confirmedEffectsDigest}`。损坏schema不能读取operationId时，改用服务端签发的`recoveryRecordId`定位已保留原件，不能伪造一个旧operationId；该票据绑定scope、原件内部校验和与当前核查说明，只返回opaque ID，不曝光坏文件内容或其秘密派生标识。该操作只结束已失效／冲突的配置意图，**不取消运行中的提交、不回滚实际效果、不撤销已写公共目录**。用户先在预览／结果界面查看当前模型配置、已确认或未知的副作用及未恢复临时字段，再显式确认；digest绑定这份说明，变化就重新核实。service／持久状态明确区分配置意图是否可继续和运行时是否安全静止。

| 条件 | 解除规则 | 下一步 |
|---|---|---|
| 授权变化使pending目标永久失效，且本操作写者已静止 | 保留公共目录事实和诊断；显式确认retire旧配置意图，terminal=true／configurationIntent=retired | 清活动槽后以当前配置与可信新授权生成新preview；绝不消费旧target |
| baseline冲突但无未完成写者 | 显示新用户值、旧预期和已知效果，用户确认只结束旧意图 | 当前用户值不变，新操作重新取baseline |
| rollback-conflict／target-observed／commit-gap | 不自动认领或回滚；用户核对当前配置并确认接受现状、结束旧意图 | 保留未知归属说明；有未恢复compatibilitySwitch等安全负债时仍禁新应用，须先完成明确恢复或人工核实 |
| 状态损坏／未来schema | 原件保留；不能解析或执行原意图。证明没有本操作活动写者后，用户核实当前配置并确认隔离旧记录，再初始化新受限状态 | 新预览不得从坏schema复制target；不能证明静止则继续blocked |
| 任一实际提交／底层写者仍在运行或无法证明停止 | 拒绝resolve，返回nonterminal busy／recovery-needed | 继续查询或明确人工恢复；不清活动槽，不启动覆盖性新任务 |

resolve在同一service队列、profile资源锁及适用的授权围栏内重读当前事实，只更新元数据，不写用户模型／覆盖／名称。quiescent依赖已跟踪的所有写promise结束或已验证原写进程退出及锁的安全接管；单看状态phase／PID数字／一次presence不构成证明。不启动未跟踪的子写者。无法证明的临时名称恢复不能被retire抹去；保留独立恢复负债并阻止依赖它的新写。

终结顺序：先持久lastResult及不可逆事实，再原子清活动配置意图；副作用摘要与新活动槽在同一schema提交，不留“丢事实但开新写”窗口。动作是完成Q20/Q30的重新预览闭环，不增加提交中取消或长期撤销功能。

## 任务清单

Run从仓库根执行，Node20+、npm，bash／PowerShell均可单独执行。新测试在对应Step1创建；测试网络mock、状态tmp隔离、时间fake clock；不要访问真实用户数据或生产安装。一次任务不满足一个明确验证则继续拆分。

### B01：定义纯模型变更策略

Files：Create `src/model-update.mjs`, `test/model-update.test.mjs`。Consumes：raw／effective配置view及已确定Q5/Q6/Q15语义。Produces：buildModelChange。

1. 写补充完整对象／顺序／覆盖保留、默认空选择、候选合法性／去重、不可解析现有项不暗删；重建纯ID清覆盖、空集合确认及继承配置。writeSet必须区分纯目录、模型字段、覆盖字段与已预览snapshot切换；零选择目录-only不可被某个未触及字段的恢复能力阻止，materialize新增选择后则重新核对对应能力。
2. Run `node --test test/model-update.test.mjs`；旧diffModels不足以满足完整view及策略要求，应红灯。
3. 实现纯策略，目录与列表分维度。对base继承覆盖若本profile层无法安全清除，阻止重建并解释，不能用unset假称清除了实际继承值；不改其他路由。
4. 同命令全绿；补充selected=[]无列表变化，重建仍准确列出恢复全量与定制损失。

### B02：提供可信账号证据

Files：Create `src/account-evidence.mjs`, `test/account-evidence.test.mjs`；Modify [copilot-models.mjs](<../../src/copilot-models.mjs>)错误分类。
Consumes：A scope／identity／资源锁、现有只读GET。Produces：resolveAccountEvidence、独立cache记录。

1. 写live成功、401／超时、missing／无时间戳／24小时边界／本地绑定变化／正常access轮换、cache只补充、authority空集测试。
2. Run `node --test test/account-evidence.test.mjs test/copilot-models.test.mjs`；旧无时间戳cache自动可信应红灯。
3. 成功GET后核实仍同AuthBinding才保存cache，记录实际成功时间，不给payload旧缓存补时间；cache文件单独排他写。GET不自行刷新token／写policy；失败显示原因与受限能力，重建永不回退缓存。
4. 同命令全绿；无网络mock遗漏，无跨profilecache，日志没有authorization header。

### B03：核对版本耦合与目录来源异常

Files：Modify [catalog-fetch.mjs](<../../src/catalog-fetch.mjs>)、[copilot-models.mjs](<../../src/copilot-models.mjs>)及现有[test/catalog-fetch.test.mjs](<../../test/catalog-fetch.test.mjs>)、[test/copilot-models.test.mjs](<../../test/copilot-models.test.mjs>)、[test/catalog-format.test.mjs](<../../test/catalog-format.test.mjs>)。
Consumes：现有供应链与混合协议守卫。Produces：network／integrity／schema／compatibility区分的来源结果。

1. 写安全失败不能隐式变local、规范化／merge两阶段skip均保留、当前SDK对应headers／endpoint／picker过滤fixture。
2. Run `node --test test/catalog-fetch.test.mjs test/copilot-models.test.mjs test/catalog-format.test.mjs`；旧统一catch回退和丢skip契约应失败。
3. 对照各目标安装pi-ai已知实现，保留HTTPS／镜像同host例外、manual redirect、sha512 integrity与大小限额／严格tar。来源显式切换才生成local／overlay新预览，显示版本与时间；未知协议被守卫拦住。
4. 同命令全绿；不因追最新数据升级pi-ai或自己实现OAuth／policy修改。

### B04：分离能力探测与状态读取

Files：Create `src/catalog-capabilities.mjs`, `test/catalog-capabilities.test.mjs`；Modify [catalog.mjs](<../../src/catalog.mjs>)分类调用边界。
Consumes：A scope、实际安装定位与现有probe。Produces：createCatalogCapabilities。

1. 写status零probe、初始化／显式检查可probe、apply前重核、readonly非asar、unknown／blocked／registry可用／实例分歧；已注入且remote失败仍可解析测试。
2. Run `node --test test/catalog-capabilities.test.mjs`；旧status每次resolveInstall应红灯。
3. 状态读缓存不写文件，按实际原因分类；读取磁盘∪当前宿主认可runtime，字段与证明来源完整。磁盘存在但当前进程未加载的条目不算立即可用。
4. 同命令全绿；unknown／不支持实例不提供确认，实际file/registry能力与profile名解耦。

### B05：保存固定预览与选择绑定

Files：Create `src/preview-store.mjs`, `test/preview-store.test.mjs`。Consumes：buildModelChange、AccountEvidence、capabilities与A scope／AuthBinding。Produces：createPreviewStore。

1. 写10分钟边界、作用域／实例绑定、完整配置字段变化、runtime摘要变化、选择ID非法、materialize原expiry不延长、clear确认漂移失效、服务端operationId与preview强绑定、消费后不可再执行、过期／重启查询已持久结果以及早于lastResult的ID明确unknown测试。
2. Run `node --test test/preview-store.test.mjs`；旧仅digests且apply重新latest不满足。
3. 内存持有不可变目录／证据快照，opaque ID按实例隔离；选择变化只从原快照重算，返回绑定选择的ID，释放过期项；apply不接受client任意target或额外ID。
4. 同命令全绿；只重算纯差异不下载，源内容不受client修改。

### B06：定义profile恢复schema

Files：Modify [state.mjs](<../../src/state.mjs>)及[test/state.test.mjs](<../../test/state.test.mjs>)；Create `test/profile-isolation.test.mjs`。
Consumes：A resolveRuntimeScope／withResourceLock、schema2契约。Produces：`loadRefreshState(scope)`／`saveRefreshState(scope,state)`、`readLegacyCandidates(scope)`。

1. 写两profile同home独立、非默认home、版本化安装路径变化不丢profile状态、旧journal不消费、坏嵌套／未来version保留原件、未知scope禁写。
2. Run `node --test test/state.test.mjs test/profile-isolation.test.mjs`；旧全局文件及浅合并version应红灯。
3. 校验schema2每个安全关键字段和归属，沿用原子JSON/fsync；旧state只读展示历史条目／未完成意图，用户重新预览才采用。没有自动删除旧或损坏原件；成功完成后清activeOperation，仅保留最新非秘密摘要。
4. 同命令全绿；目录补充数据可共享，但不复制旧settingsBaseline／target意图到两个profile。

### B07：捕获同次配置基线

Files：Create `src/settings-commit.mjs`, `test/settings-commit.test.mjs`。Consumes：host settings.describe真实user/value/base/revision。Produces：captureSettings。

1. 写raw字段变化、[]／缺失区别、namespace缺失／读取错误、合成继承modelOverrides／models；revision与view必须来自同一个descriptor。
2. Run `node --test --test-name-pattern="SETTINGS_CAPTURE" test/settings-commit.test.mjs`；旧安全读取失败回空不满足。
3. 提取可测试捕获函数，完整views和revision同次返回；读取失败结构化，不授权任何配置写。预览损失名单按实际effective结果显示，CAS仍用rawbaseline。
4. 同命令全绿；与B01的targetView形状一致。

### B08：提交受保护模型配置

Files：Modify `src/settings-commit.mjs`, `test/settings-commit.test.mjs`。
Consumes：captureSettings、A withAuthorizationFence、完整targetView。Produces：commitSettings与本操作归属记录。

1. 写注入await期间用户改变models／override、namespace revision变化、本地绑定变化、rebuild两字段一提交、supplement旧字段保留及mutate返回void测试。
2. Run `node --test --test-name-pattern="SETTINGS_COMMIT" test/settings-commit.test.mjs`；旧取新revision写旧target应红灯。
3. 在profile操作锁与授权围栏内复核baseline及expectedRevision，用一组模型路径ops提交；提交后记录实际内容／观察到revision，不假造mutate返回值。归属无法证明时结果unknown，保持恢复意图；不宣称已生效。
4. 同命令全绿；冲突未发生任何本操作配置覆盖，其他路由字段保持。

### B09：条件恢复完整模型view

Files：Modify `src/settings-commit.mjs`, `test/settings-commit.test.mjs`。
Consumes：B08 ownedView／ownedRevision、完整baseline、A身份围栏。Produces：restoreOwnedSettings。

1. fixture按真实settings与config-editor语义建模，不能沿用unset直接delete旧mock。在base含models、raw缺models且有无关displayName时，需模型写的预览因raw-exact不足受限，纯目录且无snapshot写的预览则not-required／允许；可恢复形态的无并发rollback须核对raw/effective／字段存在性／其他路由全部不变。再写用户改models／override、revision变化、旧会话revision重置、目标由用户写入／ABA及receipt缺失全部不自动回滚的测试。
2. Run `node --test --test-name-pattern="SETTINGS_ROLLBACK" test/settings-commit.test.mjs`；旧用最新revision无条件恢复baseline应红灯。
3. 核对当前完整受影响view和revision仍属于本操作，再恢复baseline中models与overrides的存在性和值；不读取新revision当成覆盖许可。不证明归属就返回rollback-conflict。
4. 同命令全绿；并发新配置永远保留，失败result携动作而不是“原样不动”。

### B10：预检并结构化注册表注入

Files：Modify [catalog-registry.mjs](<../../src/catalog-registry.mjs>)及[test/catalog-registry.test.mjs](<../../test/catalog-registry.test.mjs>)。
Consumes：目录合法条目／allowedKeys、当前模块实例。Produces：注入report `{ok,injected,present,rejected,missing,ownedEntries,reason}`。

1. 写sealed非frozen、不可写descriptor、getter抛错、混合坏条目、getBuiltinModels抛错、实例分歧、部分赋值后失败测试。
2. Run `node --test test/catalog-registry.test.mjs`；旧guard／无catch应至少在sealed与混合条目失败。
3. 完整验证所有欲新增项后才修改；每笔记录本操作注入对象归属，捕获异常；回读仅证明注册表面可见，不冒充宿主listModels。补偿只删除仍等于本次对象且归属确认的新增项，present不删。
4. 同命令全绿；不会为了回滚删别人新增或改过的目录对象。

### B11：安全刷新宿主快照

Files：Modify `src/settings-commit.mjs`, `test/settings-commit.test.mjs`；compatibilitySwitch持久字段落[state.mjs](<../../src/state.mjs>)。
Consumes：当前宿主listModels、profile事务归属、目标ID。Produces：ensureCatalogServed。

1. 写同值models旧memoized快照、临时改名前后用户编辑、两笔间崩溃、第二笔失败、probe值残留、可靠宿主刷新接口存在／缺失测试。
2. Run `node --test --test-name-pattern="CATALOG_SERVED|SNAPSHOT_SWITCH" test/settings-commit.test.mjs`；当前apply未使用净零切换／无归属恢复应红灯。
3. 优先已验证的宿主刷新接口；无接口且允许时先持久compatibilitySwitch，再临时改变名称，只在仍为本操作探针时恢复。同一机制用于apply与boot，真实listModels短重试后缺失保留恢复意图；字段保存与恢复也受用户新修改优先保护。
4. 同命令全绿；成功无净改名，失败可能部分变化必须可见，不宣称所有路径逐字节不变。

### B12：建立通道共用写前意图

Files：Create `src/refresh-transaction.mjs`, `test/refresh-transaction.test.mjs`, `test/refresh-test-kit.mjs`。
Consumes：schema2、preview、A锁／身份围栏。Produces：runRefreshTransaction的prepared阶段与幂等operationId。

1. 写首次registry应用在注入／配置前退出、prepared写失败、重复ID相同结果、相同ID不同选择拒绝、已有activeOperation不覆盖、锁争用测试。追加同一base含models／raw缺models／用户displayName baseline的对照：selected=[]且纯目录writeSet允许且绝不调用settings.mutate；选择新增并需要配置写时恢复能力不足，目录与配置均不先写。未预览的snapshot写也必须拒绝。
2. Run `node --test --test-name-pattern="TX_PREPARE|TX_IDEMPOTENCY" test/refresh-transaction.test.mjs`；旧registry无write-ahead应红灯。
3. profile锁内重读状态，授权围栏验证当前完整AuthBinding，并核实sealed writeSet与完整baseline。只对会写的配置字段要求相应raw-exact／归属恢复能力；目录-only无模型／名称写时模型restorationCapability=not-required。混合操作缺所需能力则在任何副作用前拒绝，不能悄悄变为目录-only。通过后持久prepared与writeSet，保存失败禁止外部变化。operationId必须为preview签发值，持久requestBinding与确认选择一致；已有nonterminal意图只可查询／resolve，不能覆盖。真正no-change不写state不激活。
4. 同命令全绿；所有可产生变化的阶段都有足够恢复信息且无token。

### B13：落地文件目录变化

Files：Modify `src/refresh-transaction.mjs`, `test/refresh-transaction.test.mjs`；使用[atomic-json.mjs](<../../src/atomic-json.mjs>)与现有原子测试。
Consumes：prepared、file能力、真实catalogFile共同锁。Produces：catalog-landed或pending-restart。

1. 写原子目录写各断点、共同安装不同home竞争、落地成功state推进失败、已有目录不更新、只配置即时／实际目录需加载测试。
2. Run `node --test --test-name-pattern="TX_FILE" test/refresh-transaction.test.mjs`；旧所有file都需重启及目录共享竞争应红灯。
3. 在真实catalogFile锁内重读baseline再只增合并、原子写并推进意图。真正新目录未被进程加载时配置延后；原本已解析的纯配置变化进入B08即时路径。共享目录有新输入需要新预览，不能无声合并未审核的目标变化。
4. 同命令全绿，再Run `node --test test/atomic-json.test.mjs`；持久性仍含既有fsync／平台语义，不在asar写tmp。

### B14：落地注册表配置变化

Files：Modify `src/refresh-transaction.mjs`, `test/refresh-transaction.test.mjs`。
Consumes：prepared、B10注入report、B08提交、B11宿主验证、B09回滚。Produces：applied／partial／rolled-back／rollback-conflict。

1. 写注入失败、配置失败、served失败、state最后保存失败、无新目录但快照需恢复、rebuild清overrides、补充保留、present与new数量区别的逐断点测试。
2. Run `node --test --test-name-pattern="TX_REGISTRY" test/refresh-transaction.test.mjs`；旧落配置后state丢失与结果过强应红灯。
3. 严格prepared→注入→受保护配置→真实验证→持久完成；失败按归属补偿并保留恢复信息，state保存失败不能返回applied。model配置回滚与公共目录／注入可能已保留分别说明。
4. 同命令全绿；没有registry-write安全能力就blocked，不能假成功。

### B15：恢复未完成操作

Files：Create `src/refresh-recovery.mjs`, `test/refresh-recovery.test.mjs`。
Consumes：schema2、runRefreshTransaction、A scope／身份／共同锁。Produces：recoverRefresh的prepared／pending-restart／compatibilitySwitch恢复。

1. 把B12–B14每个断点保存的fixture重启到新ctx：settings revision重置0／相同数字不同会话、用户写相同target／ABA、配置已写但receipt未保存、当前baseline安全可新CAS；再测授权变化、基线变化、served失败、错误清理和重复恢复。恢复表中需人工确认的分支必须断言不自动回滚，不将所有断点强称全自动恢复。
2. Run `node --test --test-name-pattern="RECOVERY_OPERATION" test/refresh-recovery.test.mjs`；旧清settings-conflict和忽略ensure返回值应红灯。
3. 重用同一事务内核与锁；配置意图消费前核实当前完整AuthBinding／完整baseline／可解析／真实宿主效果。授权变更不执行旧配置目标，保留记录；阶段诊断独立清理，成功证明不完整不能丢journal。
4. 同命令全绿；所有重复恢复幂等，未知phase不自动执行。

### B16：恢复历史目录并处理旧共享状态

Files：Modify `src/refresh-recovery.mjs`, `test/refresh-recovery.test.mjs`, `test/profile-isolation.test.mjs`。
Consumes：历史成功appliedOverlay／provenance、schema2、readLegacyCandidates。Produces：保守激活、自愈与迁移说明。

1. 写全新未激活、插件升级保持、同pi-ai目录被覆盖、跨版本条目已原生／缺失、旧global两profile顺序启动／并行、未知scope测试。
2. Run `node --test --test-name-pattern="RECOVERY_HISTORY|RECOVERY_LEGACY" test/refresh-recovery.test.mjs test/profile-isolation.test.mjs`；旧global自动恢复跨端意图不满足。
3. 仅本profile确认历史条目恢复；不联网发现、不改用户列表、不自动应用随包条目；跨基线缺失需重新预览。旧原件展示并保留，采用历史条目走新preview确认，不复制旧目标／settings意图。
4. 同命令全绿；自愈file重补需加载时给实际再重启说明，registry恢复核实真实宿主可见。

### B17：连接HTTP编排与排队

Files：Create `src/refresh-service.mjs`；Modify [host.mjs](<../../src/host.mjs>)刷新接线及[test/host.test.mjs](<../../test/host.test.mjs>)。
Consumes：A授权聚合、B evidence／capabilities／preview／transaction／recovery。Produces：createRefreshService和协议2路径。

1. 写boot deferred＋apply、legacy请求拒绝、非法selection／profile、预览过期、重复operation查询、忙423、空集合未确认、源切换、写超时后status结果测试。
2. Run `node --test --test-name-pattern="REFRESH_V2" test/host.test.mjs`；旧digests请求及boot/apply并发不满足。
3. host只接线，恢复与apply统一队列，所有输入白名单和同源守卫保留；预览初始数据获取在写锁外，应用不下载新latest。重建提交前在写锁外重新GET核实账号集合，变化返回409、失败阻止重建，不退化为缓存；之后在授权围栏内核实完整AuthBinding与证据仍有效。补充按24小时同本地绑定门禁；status只读聚合完整结果，dispose停止自身任务／订阅，不丢持久意图。
4. 同命令全绿，再Run `node --test test/host.test.mjs`；旧6路由与镜像语义用例准确转为新契约，不删除仍有效的安全／首次填充测试。

### B17b：解除已静止的失效配置意图

Files：Modify `src/refresh-service.mjs`, `src/refresh-recovery.mjs`, [src/shared.mjs](<../../src/shared.mjs>)及[test/host.test.mjs](<../../test/host.test.mjs>)；Modify `test/refresh-recovery.test.mjs`。Consumes：OperationResult的terminal／configurationIntent／quiescent、完整副作用说明摘要、统一队列与profile锁。Produces：`resolveRefreshOperation(ctx,{scope,operationId,recoveryRecordId,confirmedEffectsDigest,stateIO})`、service.resolve和POST `/refresh/resolve`；operationId与recoveryRecordId必须恰有一个，损坏schema用经scope绑定的opaque恢复票据，不解析坏target。

1. 写pending-restart→授权变化→显示旧副作用→确认retire→以新授权新preview/apply闭环；再测baseline冲突、commit-gap／未知归属、rollback-conflict、状态损坏、临时字段仍有恢复负债、未知／仍活动写者、说明digest变化、重复resolve。
2. Run `node --test --test-name-pattern="REFRESH_RESOLVE|RECOVERY_RETIRE" test/host.test.mjs test/refresh-recovery.test.mjs`；旧只保留activeOperation并永久busy的行为应失败。
3. status为正常operationId或损坏记录recoveryRecordId提供scope绑定的resolutionOffer：目标引用、effectsDigest、白名单summary／unknownEffects、remainingDebt、quiescent、allowed及拒绝原因；说明从当前事实重算，不能只复用旧字符串。resolve按解除表核实同一offer，只终结已静止且确认的配置意图，副作用／请求绑定摘要与活动槽清理同一原子保存；不写models／覆盖／名称、不抹兼容恢复负债。活动／不明写者拒绝；损坏记录保留原件、不读取其target。响应不明时同一目标的GET status可核实已retired／仍活动／unknown；不能把未知结果当可安全重复POST。
4. 同命令全绿；允许重启完整闭环但不消费旧target、不重复写、不靠新ID盖掉旧副作用；未解决安全负债仍明确阻止新应用，而非假称恢复完成。

### B18：修正客户端模型状态机

Files：Modify [refresh-flow.mjs](<../../src/refresh-flow.mjs>)及[test/refresh-flow.test.mjs](<../../test/refresh-flow.test.mjs>)。
Consumes：A requestJson、protocol2 OperationResult／resolutionOffer、previewStore响应与B17b resolve接口。Produces：可取消预览／不可取消提交／可再次操作flow以及显式resolve确认状态。

1. 写registry applied再次start、materialize选择乱序、预览过期／空确认重置、unknown结果先status和init乱序。新增retire-request→读取最新resolutionOffer→用户确认→resolve-effect→成功重hydrate→新preview的状态序列；digest变化必须重读并再次确认，recoveryRecordId／正常opId目标互斥，重复确认只发一次。写超时和非JSON返回转resolution-unknown，不能自动POST重发。
2. Run `node --test test/refresh-flow.test.mjs`；原applied死态、丢payload及没有resolve effect／确认协议都应红灯。
3. 新事件request-retire读取status提供的resolutionOffer（目标ID、effectsDigest、已知／未知效果、remainingDebt、quiescent、allowed）；confirm-retire只回显已审说明及恰一目标ID，POST `{protocolVersion:2,action:"retire-config-intent",operationId|recoveryRecordId,confirmedEffectsDigest}`。成功后重hydrate真实状态；terminal且无阻碍负债才启用新应用。409说明已变化返回确认页，不自动同意；unknown只GET查询同一目标，retire终态可核实则完成，否则保留核查动作。正常操作和resolve分别持有请求代次，慢结果不得覆盖新视图。
4. 同命令全绿；活动事务不能被新apply覆盖，resolve不是取消提交；无静止证明／仍有兼容恢复负债时明确禁新apply，所有phase／rollback／actions与副作用仍保留。

### B19：呈现分维度模型预览

Files：Modify [client.jsx](<../../src/client.jsx>) RefreshModal、`src/client-copy.mjs`及`test/client-dom.test.mjs`、`test/client-copy.test.mjs`。
Consumes：B01变化列表、B18 flow、A Dialog与准确双语文案。Produces：补充／重建入口、候选选择、来源／损失／清空确认。

1. 写DOM候选初始全不选、完整保留说明、全选／选择绑定、目录与模型数量分别显示、只显示实际删除损失、rebuild恢复全量提示、cache禁rebuild、空集合二次确认及keyboard测试。
2. Run `node --test --test-name-pattern="DOM_MODEL" test/client-dom.test.mjs`；旧单镜像弹窗应红灯。
3. 用A Dialog替换旧role-only弹窗，默认取消焦点；显示两阶段skip与具体移除原因、源版本／年龄，不用boot／镜像作为主解释。保持GHC导航与图标en/zh匹配；source变化重新确认。
4. 同命令全绿，再Run `node --test test/client-copy.test.mjs`；各动态参数与key集合等义。

### B20：呈现真实结果与恢复动作

Files：Modify [client.jsx](<../../src/client.jsx>)结果区域、`src/client-copy.mjs`, `test/client-dom.test.mjs`。
Consumes：OperationResult、授权独立维度、capabilities。Produces：无假成功／假零变化／假重启的主状态。

1. 写pending-restart与实际profile说明、partial／rollback-conflict、boot错误、unknown／busy、可见数量未知，以及目录-only不声称新picker模型可用。新增页面级mock链：pending-restart→auth-changed→点击结束旧意图→显示resolutionOffer→用户确认→resolve→重hydrate→新preview/apply；再测坏记录票据、digest变化再确认、重复点击、HTTP超时只查询、仍有恢复负债／未知写者时新apply确实禁用。
2. Run `node --test --test-name-pattern="DOM_RESULT|DOM_RESOLVE" test/client-dom.test.mjs`；没有解除按钮／确认dialog／闭环控制器的旧界面必须失败。
3. B18接入结果区域：仅actions允许时显示“结束旧配置意图 / End previous configuration intent”；用A Dialog展示已知／未知副作用与剩余恢复事项，默认取消，明确“只结束旧意图，不回滚或撤销已发生的更改 / End the intent only; existing changes are not rolled back or undone”。确认回显offer的目标ID和effectsDigest，不能自造或自动替用户同意新说明。digest漂移回确认页；resolve不明显示待核实，不自动重发；核实terminal且无阻碍负债才启用新的应用入口。补充等义词条intent-retired、resolve-pending、resolve-unknown、resolution-changed及recovery-debt，词典测试检查动态参数一致。
4. 同命令全绿，再Run `node --test test/client-copy.test.mjs test/refresh-flow.test.mjs`；完整页面链不得消费旧target、不可跳过确认；未解负债仍给具体核查建议。授权状态独立，技术详情脱敏；手动重启不调用命令、不虚增含present的新模型数。

### B21：验证跨profile与故障矩阵

Files：Modify `test/profile-isolation.test.mjs`, `test/refresh-transaction.test.mjs`, `test/refresh-recovery.test.mjs`, `test/compatibility.test.mjs`及[test/host.test.mjs](<../../test/host.test.mjs>)。
Consumes：所有前序模块。Produces：设计M01–M14／A与B接口组合回归矩阵。

1. 创建同机两个ctx／子进程同安装不同profile，分别confirm补充／重建；另做同profile多进程、不同home、锁holder退出、credentials换代、目录基线变化，检查不跨消费intent。
2. Run `node --test test/profile-isolation.test.mjs test/refresh-transaction.test.mjs test/refresh-recovery.test.mjs test/compatibility.test.mjs`；未完成任一必需场景视为任务红灯，不用旧测试数量替代。
3. 修复组合接口与锁序问题；最低版本缺围栏／scope／registry等必要能力时只禁依赖它的修改；弱撤回不能推出强取消，只限制unsafe退出／切换，不整体禁模型管理，不能回退全局文件或伪成功。跨PID命名空间共享storage明确不支持。
4. 同命令全绿，再Run `npm test`；捕获的每个故障对应结果／恢复／用户配置断言，mock并非实机已验证。

### B22：验证构件并更新实际说明

Files：Modify [package.json](<../../package.json>)files、[lib/client.js](<../../lib/client.js>)、[README](<../../README.md>)；Modify A16创建的`test/package-files.test.mjs`和`test/bundle-load.test.mjs`，不重新创建。
Consumes：A/B接口与场景全绿。Produces：待实机验收构件与用户说明，不发布。

1. 写package allowlist静态检查确保B新增host模块都包含，browser bundle无node-only imports；README不能保留“升级后未激活／一概需重启／零写盘／原样不动”等过强承诺。
2. Run `node --test test/package-files.test.mjs`、`npm run build`、`npm pack --dry-run --ignore-scripts --json`；缺files或错误bundle为红灯。
3. 更新实际完成功能、共享凭据与profile隔离、缓存／迁移／重启／部分失败说明；历史ADR保留事实而非伪造上线。保持version／peer未在未授权情况下发布；不把当前文档设计直接当兼容实测。
4. Run `npm test`、`npm run build`、`npm pack --dry-run --ignore-scripts --json`；产物完整，无源／构建脱节。交付变更摘要与以下人工门禁缺口，停在评审／部署授权点。

## 执行纪律

开始实现前先批判性复查整份计划，缺项／矛盾／命名／命令问题先修计划。按任务顺序执行，不无声跳步、合并或改变目标；每任务必须验证。阻塞、重复失败或现实不符立即说明，不猜。main／master上未获同意先确认。自然边界可在额外授权后checkpoint commit；本计划不授权自动提交、发布或修改生产。任务全部完成后跑最终验证并给摘要。

A基础接口不符时先回A修正，B不重复自建scope／身份／请求／锁系统。状态从prepared起必须可恢复；模型所有权与凭据身份不可靠时停止应用，不能为清测试强行覆盖或禁掉检查。

## 最终验证

仓库根逐条运行：`npm ci`；`npm run build`；`npm test`；`npm pack --dry-run --ignore-scripts --json`。消费A17定义的三OS×Node20.0.0／22六格CI，B补充A16的真实ModuleLoader／host import／pack allowlist断言；构件清单不是加载成功证明。用设计A/M/U矩阵核对覆盖，不以固定140／新数量当门禁。

真实环境在用户另行授权后进行，先测试账号和隔离profile，记录实际加载安装副本／版本／构件：

1. Linux web：补充旧定制不变、重建两字段同清、纯配置即时、真目录变化手动重启后生效；只更新现有GUI所需构件，刷新实际URL核对，不另开替代服务。
2. Windows desktop真实asar：新模型补充、二次刷新、同值快照刷新、重建、手动重启后的可见性、晚到恢复错误；官方归档不变。
3. 同安装双profile：公共目录可共享，配置和恢复意图独立；非默认DSH_HOME与不同home同目录锁仍正确。
4. 授权变化／配置并发／缓存过期／网络来源失败／崩溃断点逐场景核对；不能对生产安装随意kill进程作故障测试。
5. macOS／Linux桌面未实测时保持待验证；Windows记录不能替代所有Electron版本／OS。listModels仅证明可见；任何真实推理需另获同意并说明配额，不能本轮自动做。

## 评审 Checkpoint

先审方案和计划，特别是身份围栏、同机锁边界、preview选择materialize、raw与effective配置、恢复phase与条件归属、继承覆盖不可清除时的受限解释。评审通过且用户授权后由普通编码agent或人工执行。本planning阶段在此停止。

## Inline 自检记录

前三轮在较强目标下关闭RV-03至RV-07五项计划缺口：会话归属／commit-gap、writeSet恢复门禁、resolve完整闭环、幂等、构件／CI任务。本次仅将授权依赖收敛到用户最终A；这五项仍须交叉复核，不可削弱。历史问题表见[计划A历史记录](<2026-10-03-copilot-authorization-state-implementation-plan.md>)。

第5轮原只读评审Agent复核通过，RV-01至RV-07全部计划层闭环，无剩余计划分歧；B与[计划A当前结论](<2026-10-03-copilot-authorization-state-implementation-plan.md>)均ready、待用户批准实施。按最终A只消费局部AuthBinding，不宣称检测未观察的全库ABA；授权riskLatch独立且不能由模型resolve或绑定变化解除。原SDK强取消与库级保证未实现，测试／CI／实机未执行。本阶段仅更新五份文档，未改代码／依赖／构件，未运行npm／真实授权／刷新／重启。
