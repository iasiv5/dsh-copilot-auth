# 双 profile 授权与模型管理设计规格

状态：2026-10-03 经31项问答确认，后按用户D-01裁决及最终“确定A”收敛修订；**目标设计，尚未实现**。本阶段仅文档及独立复核，不授权编码、部署、发版、真实授权或重启。最新范围替代此前“宿主必须提供库级持久授权边界”的方向。

## 阅读入口

术语见[领域词汇表](<../../GLOSSARY.md>)，取舍见[ADR 0004](<../adr/0004-safe-model-management-and-profile-isolation.md>)。实施拆成[授权与状态计划](<../plans/2026-10-03-copilot-authorization-state-implementation-plan.md>)及[模型事务计划](<../plans/2026-10-03-copilot-model-transactions-implementation-plan.md>)，按此前后顺序执行并分别评审。

现行实现基线是插件 v1.2.7。历史设计见 [ADR 0001](<../adr/0001-data-level-catalog-patch.md>)、[ADR 0002](<../adr/0002-read-only-catalog-target-gate.md>)和[ADR 0003](<../adr/0003-catalog-registry-injection.md>)；以下新决策不是这些功能已经上线的声明。

## 1. 全局约束

- G01：Node.js >=20；保持现有发布 peer `@deepseek-ai/cordis: ^4.0.2`，不升级 DSH 或 pi-ai 代码。
- G02：DSH 0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2 为兼容目标；能力门禁与验证结果分别记录，不把版本范围当成无条件能力保证。
- G03：保留导航“GHC设置”／“GHC Settings”；正文标题使用 GitHub Copilot，操作为“授权登录／请求撤回／重新授权／退出登录”“补充模型”“重建模型列表”“应用更改”；unsafe退出／重新授权必须禁用并说明。
- G04：沿用 `/copilot-auth` 路由前缀和 `llm-pi-ai/github-copilot` 凭据键；en/zh 主信息等义；技术详情折叠并脱敏。
- G05：模型补充默认非破坏性；全量重建单独确认；底层目录只增不覆盖已有描述；不写官方归档、不通过路由级单协议绕过混合协议目录、不新增提供方路由。
- G06：共享宿主凭据库与公共安装目录数据，隔离 profile 配置、刷新事务、激活、缓存和诊断；遵循宿主 DSH_HOME 与稳定 profile 身份。
- G07：预览有效期 10 分钟；缓存可应用上限 24 小时且绑定同一本地授权绑定；断网状态自动重试最多 60 秒；无上游有效期时本地授权等待上限 15 分钟，以上均是产品策略而非 GitHub 保证。
- G08：不自动重启、不增加长期备份或用户撤销、不自动发送推理请求；真实授权、重启和可能耗配额的验证另获授权。
- G09：当前交付只含文档与计划；实现、安装、构建、提交、推送和发布均未获授权。

## 2. 已确认决策树

| 决策 | 结论 |
|---|---|
| Q1 | 默认补充保留定制，另设显式全量重建入口。 |
| Q2 | 各 profile 的刷新生命周期独立。 |
| Q3 | github.com 个人及组织账号；自定义 Enterprise 域名暂不支持。 |
| Q4 | 完整讨论文案、交互、正确性与隔离；确认后只记录文档。 |
| Q5 | 现有模型对象、顺序、参数、覆盖保持；缺失项为候选，初始不勾选，支持显式全选。 |
| Q6 | 两通道重建同语义，只重建 Copilot 模型配置，清除条目参数与 modelOverrides。 |
| Q7 | 可信缓存可补充不可重建；无有效缓存阻止应用；目录失败可显式选择本地／内置来源。 |
| Q8 | 权威空集合允许独立二次确认清空；不可与缺失证据混同。 |
| Q9 | 通道由实际能力决定；可写文件补丁、只读运行时注入；不可用时明确阻止。 |
| Q10 | 继续复用宿主凭据；退出前确认共享凭据库影响。 |
| Q11 | D-01已修订：仅请求撤回／结果待核实；无法证明安全时禁用退出及新尝试切换，离开页面不自动撤回。 |
| Q12 | 凭据、尝试、模型配置、调用能力分层；不自动验证推理。 |
| Q13 | 公共目录可共享，配置意图绝不跨 profile 消费；共同资源写入跨进程互斥。 |
| Q14 | 稳定 profile 身份与 DSH_HOME；安装版本为兼容元数据；旧状态保留、重新确认采用。 |
| Q15 | 补充保留当前不可用／不可解析模型并警告；宿主拒绝提交时阻止，不暗中删除。 |
| Q16 | 缓存必须同本地授权绑定且不超过24小时；无时间戳、过期、本profile意图版本或观察到的凭据身份变化时只供参考。 |
| Q17 | 两通道可恢复意图、快照绑定、条件回滚；用户的新修改优先。 |
| Q18 | 仅事务恢复基线，不增加长期备份／撤销；旧迁移与损坏原件保留，无自动删除。 |
| Q19 | 仅恢复本 profile 确认过的历史条目；跨基线缺失须重新确认；插件升级保留激活。 |
| Q20 | 预览可取消；实际提交后不宣称安全取消；待处理意图不可覆盖；重启手动；无变化无写入。 |
| Q21 | 保留首次无配置时填充；重新授权仅在安全门允许时启用，当前不安全宿主禁用；插件不先删除或回写旧凭据，宿主晚写只报告实际观察。 |
| Q22 | 10分钟服务端预览快照，绑定身份／授权／配置／目录／策略／选择；漂移必再确认。 |
| Q23 | 安全失败不静默降级；显式切源再预览；状态查询与可能写探针的能力检查分开。 |
| Q24 | 同实例共享单一尝试，attemptId 防乱序；跨进程尝试不承诺互相取消。 |
| Q25 | 先启动成功再串行轮询；有限退避；写操作不盲目重发；真实有效期或明确本地等待上限。 |
| Q26 | **保留GHC导航**，其余采用面向结果的双语文案与完整无障碍交互。 |
| Q27 | 目录只增；源版本／年龄／两阶段跳过原因完整展示；目录、列表、恢复、实际可见数量分开。 |
| Q28 | 维持版本兼容目标，缺能力明确降级；三平台CI不冒充三平台桌面实测。 |
| Q29 | 经当前运行时验证的纯配置变化可立即生效；需要重新加载目录才待重启。 |
| Q30 | 最终A：本profile经本插件接受的显式操作先使本地旧意图失效；观察到稳定凭据身份变化也失效；不保证未观察的其他参与者同材料ABA，公共目录数据不回删。 |
| Q31 | 允许带持久恢复、条件恢复与真实验证的临时快照切换；优先可靠宿主接口。 |

最终追加请求：据此写两份可评审的实施计划，随后进入评审；本轮不实现。

## 3. 授权与状态契约

### 3.1 账号与共享范围

插件不建立多用户账号体系，继续通过宿主授权服务和固定凭据键使用 github.com。组织 SSO／策略／套餐／配额可能影响服务，但“账号列表取得成功”不证明每个模型都可推理。自定义 Enterprise 域名明确不支持；已存在的 Enterprise 凭据不得被静默当成 github.com 凭据使用。

共享范围按宿主实际凭据库解释，不能仅依据操作页面判断。退出清除该键的凭据，不是退出当前标签页、撤销 GitHub 全部授权或注销 GitHub 账号。不同 DSH_HOME／不同配置的凭据库不自动视为共享；无法证明具体库身份时给保守范围说明，不虚报只影响当前 profile。

### 3.2 独立状态维度

- credential：unknown／absent／present／read-error；present只表示记录存在。
- attempt：idle／starting／waiting／finishing／authorized／withdrawal-pending-unverified／timed-out-unverified／failed；attemptId唯一，宿主cancelled仅作源结果，不映射为已确认底层终止。
- model configuration：not-initialized／ready／pending-restart／applying／conflict／partial／recovery-needed／failed。
- connectivity：online／retrying／disconnected／unknown，与授权结果独立。

同一实例只维护一个尝试。另一页面恢复同一进度，撤回影响共同尝试须说明。离开／重挂载只停本页追踪，不撤回宿主。撤回或本地等待超时产生unverified风险锁存；begin结束、一次presence、正常token轮换或本地操作版本改变都不能解除。插件重挂不能清锁存，也不靠删除本地记录解除；若无可信底层结束证据，风险状态至少维持整个当前运行进程生命周期。新的实际进程只允许在旧写者确已退出且没有未跟踪子写者的已验证生命周期边界重新核实，不能仅以新组件或新随机ID自称安全。

D-01采用软撤回：能调用宿主撤回接口时只说明请求已发送；调用缺失／失败则说明未能发送。任何响应均不承诺晚写停止。当前已读目标宿主缺少安全退出／重新授权切换所需保证，这两项默认禁用，服务端同样拒绝且不调用deleteRecord或开启替换尝试。初始授权仅在本插件本实例无已知未核实风险、宿主无可见inFlight且无需替换已有授权时可发起；不承诺控制其他进程或未知外部客户端历史。保留未来可信安全路径的能力门，但本轮不改宿主、不等待其提供强取消。插件不主动删除／复制／回写旧grant；晚到SDK凭据变化显示事实，不冒称撤回成功或旧记录绝未变化。

### 3.3 本地授权绑定与缓存（最终A）

保证限于当前profile经本插件接受的明确操作，以及每次从宿主当前记录实际观察到的稳定身份变化。真实OAuth／凭据读写／临时token刷新继续由宿主负责；不新增宿主接口、不建库级sidecar协议，也不承诺观察停机期间任意参与者“变化后恢复同材料”的完整历史。Windows desktop与另一主机web不因此视为共享同一凭据库。

`AuthBinding={profileId,intentVersion,credentialObservationId}`：两个版本标识是profile内持久opaque ID，不是token摘要或全局epoch。接受初始授权、请求撤回，或将来确被安全门允许的退出／重新授权前，在profile操作锁内先持久更新intentVersion，失败则不发送操作；被安全门拒绝的请求不发起SDK动作、不冒称发生授权边界。重复同一已接受动作只更新一次。失效与凭据是否最后写成功分开，保守失效不删除凭据。

凭据身份观察以已验证的grant稳定refresh材料及规范化enterprise身份为内部比较依据，忽略access／expires／availableModelIds自然变化；原始材料不落盘，比较用的HMAC及随机key只在私有观察记录，绝不进入HTTP、普通恢复状态或导出。credentialObservationId在实际观察到缺失／新材料时更换，已有相同材料不伪称发生未观察边界。形状未知、读取错误、观察记录或私钥损坏时不生成假绑定，旧缓存／意图不可消费，保留原件并要求重新核实。

观察更新在宿主真实credentials.modifyRecord的排他当前记录回调中完成并返回undefined；已持有该回调时必须使用recordProvided路径，不再排队读／改凭据。status只读快照，记录更新事件仅异步调度观察，不在宿主凭据锁内await再次入队。局部metadata锁保护intentVersion和观察结果，保持profile操作→凭据记录→本地观察→安装目录锁序；不将过期的锁外记录写回覆盖新观察。

缓存／预览／待生效意图存AuthBinding并在提交／恢复时核实。账号缓存只有成功现场获取才记可信时间，24小时内且绑定相同可补充不可重建；旧payload缓存无时间只参考。明确的本profile操作／观察变化使旧绑定失效；本插件之外发生而未被观察、最后恢复同材料的历史不在保证范围。这是用户确认的范围收敛，不是HMAC解决了库级ABA。

### 3.4 请求、等待与有效期

统一解析HTTP状态、业务错误及非JSON代理响应，保留状态码并脱敏。启动响应确认后才追踪；409显示共同尝试而不是失败。请求串行、带代次及取消本页请求能力，旧初始化结果不得覆盖新操作。状态断网保留最后可信事实、指数退避，60秒后显示手动重试；写请求超时先查询操作结果，不盲目重发。

只有上游实际传递有效期才显示设备码倒计时。宿主若丢弃该字段，不从令牌expires或固定15分钟伪造设备码期限。15分钟是本地等待保护，显示“等待超时，结果待核实”；可请求撤回但锁存未核实风险，不能因此清旧尝试或自动开启新的授权。

### 3.5 首次填充

仅在模型列表从未配置且无有效覆盖配置时填入账号与当前可解析目录交集；显式空列表／合成层列表算已配置。accepted attempt固定originIntentVersion/originActionId，成功回调只可在当前版本仍属于原尝试且未接受其撤回／超时风险时创建首次填充handoff；晚到SDK成功仍可更新凭据事实，但不生成新的配置意图或把旧事件改绑到新版本。正常成功允许credentialObservationId从启动前absent变成成功后的grant观察ID，handoff据成功时观察创建完整expectedBinding，同时保留原intentVersion。释放创建handoff的profile锁后再调用填充回调，避免递归取锁；填充取数后与提交围栏内再核原版本／尝试归属／完整binding和无配置，变化则不mutate。填充与撤回以同一profile操作锁线性化：已先提交的填充不因随后接受撤回自动回滚；撤回先接受则旧成功不会填充。失败不否认已保存授权，重启／重新授权不重建列表。

## 4. 模型管理契约

### 4.1 两种用户操作

补充：保留当前完整模型对象、顺序、参数与 modelOverrides，只在末尾加入用户勾选的合格候选（去重，按预览展示顺序）。当前缺失项不等价于新模型：可能曾被用户精简，因此全部候选初始不勾选。不可用或不可解析的现有项仅警告；若保留它们导致宿主拒绝提交则阻止补充，指明问题项。

重建：目标为实时账号报告集合与可解析目录的交集，按预览的稳定顺序重建纯ID条目并在同一受保护配置提交中清除modelOverrides；不更改提供方名称、代理、认证及其他路由字段。显示全部删除和参数损失；仅有列表裁剪也须说明会恢复全量，不能只靠字段定制数组判断有无破坏性风险。可信空目标需独立确认；该确认绑定预览，变化后失效。

目录补充与模型列表变更分开展示。零勾选但目录有新数据仍可经明确确认应用目录；真正无目录、配置、恢复或运行时快照变化才是无操作，不写状态、不改变激活、不要求重启。

### 4.2 证据与预览

可解析集合包括磁盘目录、当前宿主认可的运行时注入项及经校验的新目录条目；自有注册表可见不等于宿主列表真的端出。预览分别给出新目录条目、列表候选／新增／移除／保留、参数重置、不可解析项、规范化跳过与合并校验跳过、来源版本／时间／失败原因。移除原因用“未包含在本次账号列表”“当前目录无法解析”，不一概称失效。

服务端快照绑定稳定profile身份、当前本地授权绑定、raw配置完整内容与revision、磁盘摘要、运行时摘要、目录来源内容／版本、账号证据采集时间、操作策略和选择。client不能任意换目标ID或改来源。10分钟过期或事实漂移返回重新预览；提交不重新下载不同的“latest”内容。必要的账号事实复核失败不使重建悄悄退化为缓存重建。

普通网络失败可展示本地／缓存降级并按规则应用；完整性、解包、目录形状等安全／兼容异常必须明确阻止当前在线应用。用户显式切换已验证的本地／内置来源会生成新的预览，不能自动使用内置数据。内置目录必须展示随包数据源版本与非最新性质。

### 4.3 通道与生效

通道按实际能力分类为file／registry／blocked／unknown，未知不承诺可应用。status读取不执行写探针；初始化或显式能力检查可检测并缓存，应用前复核可写性、模块身份、兼容形状及宿主效果。

- 文件目录变化需原子写且旧进程未加载时，保存待生效意图，下次启动核实再同步配置。
- 无需新目录加载、当前运行时确能解析全部目标的纯配置变更可以立即应用并验证。
- registry先验证全部条目再注入；注入后配置提交与宿主listModels复核都成功才称已生效。
- readonly不一定是app.asar，文案按实际原因解释；无可靠替代通道时禁用应用，不建议用户修改官方归档。

临时提供方名称切换仅作没有可靠宿主刷新接口时的兼容路径。保存前值、探针值和操作归属；恢复只在当前值仍属于本操作时发生，遇并发用户改名优先保留用户值；崩溃恢复可见。成功后可说无净变化，不能保证所有失败路径名称逐字节不变。

### 4.4 事务与冲突

两个通道均在不可逆变化前持久保存操作意图；配置视图与revision同次捕获，异步注入后不以新revision提交旧target。配置恢复只在当前内容仍等于本操作写入结果且归属可证明时进行；否则返回回滚冲突。registry中的新增对象也须记录归属，不能为补偿删除其他操作的条目。

启动恢复与apply同一实例串行；相同profile状态及共同安装目录的写入分别跨进程互斥。固定锁顺序，争用显示busy；持久锁归属不明确时阻止写入，不只凭时间过期偷锁。用户发出的重复操作通过operationId幂等核实；后一个操作不覆盖未完成意图。

恢复每阶段重新核实profile、本地授权绑定、配置归属、pi-ai基线、目录可解析性与宿主效果。授权变化只使旧模型配置意图失效，公共目录数据不强制回删。不同阶段错误分别保存，清除目录加载标记不能抹掉配置冲突。状态形状／未知版本拒绝执行不明意图，保留原件与明确诊断。

### 4.5 自动恢复与迁移

状态归稳定profile，安装位置与版本是兼容元数据，不将变化的进程ID／版本化安装路径直接作为持久profile身份。旧用户级共享状态不自动复制、认领或消费journal；保留原件并提示当前profile重新预览确认采用历史条目。无法解析可靠profile身份时允许读取说明，阻止修改，不回退全局共享路径。

全新无状态实例未激活；插件升级保留已有激活。只重放本profile曾确认且成功保存的条目，不联网发现新条目、不自动精简列表、不自动应用随包覆盖层。pi-ai基线改变：全部原生已描述可无操作，否则提示重新确认，不强行重放。写盘自愈需要再次启动加载时明确说明，无自动重启。registry不写官方目录，但仍写用户配置、恢复状态与能力探针，不称“零写盘”。

不加长期备份／用户撤销；活动事务保留完整基线以恢复，成功完成后清除活动意图，保留最新非秘密结果摘要；损坏与旧迁移原件不自动删除。宿主常规日志仍遵循脱敏规则。

## 5. 双语文案与交互规范

| 键／场景 | 中文 | English |
|---|---|---|
| nav | GHC设置 | GHC Settings |
| title | GitHub Copilot | GitHub Copilot |
| intro | 使用具有 Copilot 权限的 github.com 个人或组织账号授权，无需填写 API Token。 | Authorize with a personal or organization account on github.com that has Copilot access. No API token is required. |
| credential.present | 已保存授权凭据 | Authorization credentials saved |
| credential.absent | 未保存授权凭据 | No authorization credentials saved |
| credential.unknown | 正在获取授权状态… | Checking authorization status… |
| credential.error | 暂时无法获取授权状态，请重试。 | Unable to check authorization status. Please retry. |
| attempt.starting | 正在获取授权码… | Getting an authorization code… |
| attempt.waiting | 等待你在 GitHub 完成授权 | Waiting for you to authorize on GitHub |
| attempt.finishing | 正在完成授权，请稍候… | Finishing authorization. Please wait… |
| attempt.authorized | 授权完成 | Authorization completed |
| attempt.withdrawal | 撤回请求已发送，结果仍待核实。 | Withdrawal requested; the outcome remains unverified. |
| attempt.withdrawalUnavailable | 未能向宿主发送撤回请求，结果仍待核实。 | The withdrawal request could not be sent to the host; the outcome remains unverified. |
| authUnsafe | 尚不能确认授权流程已安全结束，暂不能退出或发起新的授权尝试。 | Safe completion of the authorization flow is unconfirmed. Sign-out and a new authorization attempt are unavailable. |
| attempt.timeout | 等待授权超时，结果仍待核实。当前不能发起新的授权尝试，请查询状态或人工核实。 | Authorization wait timed out; the outcome remains unverified. A new authorization attempt is unavailable. Check the status or verify it manually. |
| attempt.shared | 此实例已有授权正在进行。 | An authorization attempt is already running in this instance. |
| login / reauthorize / logout | 授权登录／重新授权／退出登录 | Sign in / Reauthorize / Sign out |
| withdrawAuth | 请求撤回 | Request withdrawal |
| codeHint | 打开 GitHub 授权页面，输入以下设备码。完成后返回此页，状态会自动更新。 | Open the GitHub authorization page and enter this device code. Return here when done; the status updates automatically. |
| copy / copied | 复制／已复制 | Copy / Copied |
| copyFailed | 复制失败，请手动选中设备码复制。 | Copy failed. Select and copy the device code manually. |
| logoutScope | 将清除此凭据库中的 Copilot 授权，使用同一凭据库的其他实例也会受到影响。此操作不注销 GitHub 账号。 | This removes Copilot authorization from this credential store and affects other instances using it. It does not delete your GitHub account. |
| logoutPending | 正在退出登录并核实结果… | Signing out and checking the result… |
| logoutFailed | 退出登录未完成，授权凭据仍可能存在。请重试。 | Sign-out did not complete; authorization credentials may remain. Please retry. |
| unsupportedEnterprise | 暂不支持自定义 GitHub Enterprise 域名，请使用 github.com 账号。 | Custom GitHub Enterprise domains are not supported. Use an account on github.com. |
| supplement / rebuild | 补充模型／重建模型列表 | Add models / Rebuild model list |
| catalogChanges / listChanges | 目录条目变化／模型列表变化 | Catalog entry changes / Model list changes |
| candidates / selectAll | 可新增的模型／全选 | Models available to add / Select all |
| confirm / cancel | 应用更改／取消 | Apply changes / Cancel |
| supplementRisk | 将保留现有模型及定制，只添加你勾选的模型。 | Existing models and customizations will be kept. Only selected models will be added. |
| rebuildRisk | 将按本次可信账号列表重建 Copilot 模型配置，并清除下列模型参数与覆盖配置。其他提供方设置不变。 | This rebuilds Copilot model configuration from the verified account list and clears the model customizations below. Other provider settings remain unchanged. |
| clearRisk | 本次将清空 Copilot 模型列表并清除其模型定制。请单独确认清空。 | This clears the Copilot model list and its model customizations. Confirm clearing separately. |
| removed.account | 未包含在本次账号模型列表 | Not included in this account model list |
| removed.unresolvable | 当前目录无法解析 | Not resolvable by the current catalog |
| source.live | 账号模型：实时获取 | Account models: live |
| source.cache | 账号模型：缓存，获取于 {time}，仅可用于补充 | Account models: cached at {time}; add-only use |
| source.stale | 缓存缺少可信时间、已过期或授权已变化，仅供参考。 | The cache has no trusted timestamp, is expired, or belongs to changed authorization; reference only. |
| source.local | 本地目录数据，不代表最新目录 | Local catalog data; not necessarily the latest |
| source.overlay | 插件内置目录数据，来源版本 {version}，可能不是最新 | Bundled catalog data from {version}; it may not be current |
| previewStale | 配置或数据已变化，请重新预览并确认。 | Configuration or data changed. Preview and confirm again. |
| authChanged | 授权信息已变化，请重新预览。 | Authorization changed. Preview again. |
| noChanges | 无需更改。 | No changes are needed. |
| applied | 更改已生效，无需重启。 | Changes are active. No restart is needed. |
| pendingRestart | 更改已保存，待重启生效。请重启运行此实例的服务或应用；仅刷新页面不会生效。 | Changes are saved and require restarting this instance's service or application. Refreshing the page alone is not enough. |
| conflict | 配置已变化。为保护你的修改，请重新预览并确认。 | Configuration changed. To protect your edits, preview and confirm again. |
| unknownResult | 尚未确认操作完成。请核实当前状态，勿重复提交。 | Completion has not been confirmed. Check the current status before submitting again. |
| partial | 更改未完全应用，请查看当前状态和恢复建议。 | Changes were only partially applied. Review the current status and recovery guidance. |
| rolledBack | 本次模型配置更改已回滚。目录数据可能仍已补充。 | This operation's model configuration changes were rolled back. Catalog data may still have been added. |
| rollbackConflict | 检测到更新的配置，已保留你的修改；自动回滚未完成。 | Newer configuration was detected and preserved. Automatic rollback did not complete. |
| busy | 另一个操作正在处理此资源，请稍后重试。 | Another operation is using this resource. Please retry shortly. |
| connection | 连接异常，显示的是最后确认的状态。 | Connection lost. The last confirmed status is shown. |
| corrupt | 恢复状态无法读取，原件已保留。请重新预览确认。 | Recovery state could not be read; the original was preserved. Preview and confirm again. |
| legacy | 检测到旧的共享恢复状态。不会自动应用，请在当前 profile 重新预览确认。 | Legacy shared recovery state was found. It will not be applied automatically; preview and confirm in this profile. |
| security | 目录数据未通过完整性或兼容检查，本次在线应用已停止。 | Catalog data failed integrity or compatibility checks. This online operation was stopped. |
| unavailable | 当前运行时缺少安全应用所需的能力，暂不能应用更改。 | This runtime lacks the capabilities needed to apply changes safely. |

动态值不得拼入未经脱敏的异常文本。模型ID和条目损失用可复制列表；技术字段modelOverrides可在详情解释为模型覆盖配置。显示真实profile与实际落地方式，但主信息面向结果。只有存在删除／损失时显示对应风险；重建的全量恢复后果始终说明。

弹窗具可访问名称、焦点圈定、背景隔离、Esc取消（仅可取消阶段）、关闭后恢复焦点；危险确认初始焦点在取消。状态、复制与错误可被辅助技术读出；应用中只读进度，无隐藏后台按钮可触达。

## 6. 验收矩阵

以下是实施后门禁，不是本轮已执行结果。

| ID | 必须通过的场景 |
|---|---|
| A01 | presence、读取失败、授权成功与模型填充失败独立展示；无自动推理。 |
| A02 | start 202后追踪；409恢复同attempt；403／500／HTML代理错误可见。 |
| A03 | 慢init不覆盖新操作，串行轮询无乱序，卸载停止本页请求，重挂载恢复进度。 |
| A04 | 排队／已开始／先settle后晚写；请求撤回及超时始终准确待核实；unsafe退出／新尝试前后端均拒绝；组件重挂不解除风险。 |
| A05 | 本profile已接受显式操作先失效旧绑定；正常token轮换保留观察ID；真实材料变化失效；形状／观察读取未知受限；不同profile不共享本地操作版本。 |
| A06 | 仅有效原尝试首次成功可填充；start V1→已接受withdraw V2（发送失败／不可用）→晚到authorized只更新事实，models mutate=0；正常成功的新观察ID可填充；取数／提交中版本变化拒绝，空列表／合成层／覆盖不重置。 |
| M01 | 补充完整保留模型对象／顺序／覆盖，候选不预选，勾选ID合法且无重复。 |
| M02 | 两通道重建清同样字段；不改其他路由；空目标独立确认。 |
| M03 | live/cache/missing/expired区分；24小时与AuthBinding变化；缓存不可重建；库级停机同材料ABA不作检测承诺。 |
| M04 | 已注入模型在npm失败后不误归删除；磁盘可见不冒充当前宿主已加载。 |
| M05 | 规范化与合并跳过全部显示；安全失败阻止隐式降级；明确切源生成新预览。 |
| M06 | 预览10分钟、选择／配置／授权／目录／运行时漂移；不隐式应用新latest。 |
| M07 | 两通道每个持久化／目录／注入／配置／验证边界崩溃，恢复可重复且不丢意图。 |
| M08 | 异步注入中用户编辑、验证中编辑、回滚冲突、临时改名中用户编辑；新修改保留。 |
| M09 | sealed／frozen／getter抛错／混合非法条目／部分注入；异常结构化、补偿不误删。 |
| M10 | registry成功后可再次操作；无变化无写入；纯配置即时，真写目录按需重启。 |
| M11 | boot/apply串行、同profile多进程、不同profile共安装、锁争用／归属不明。 |
| M12 | 配置错误不被目录标记清理吞掉；boot真实宿主验证失败保留诊断与意图。 |
| M13 | 旧共享状态不跨端消费；非默认DSH_HOME；未知profile／schema／版本阻止写。 |
| M14 | 插件升级保留激活；同pi-ai恢复；跨基线gate；授权在待重启期间变化。 |
| U01 | en/zh等义；保留GHC导航；复制失败、键盘弹窗、读屏状态与危险确认。 |
| E01 | Linux web真实安装形态，构建正确下发到现有GUI，刷新后核对效果。 |
| E02 | Windows desktop真实asar，apply+二次操作+重启后宿主列表仍可见。 |
| E03 | 同安装双profile真实隔离，公共目录共享不会传递用户配置意图。 |
| E04 | 三平台CI及Node20最低目标；macOS/Linux桌面未实测时不标记已验证。 |

真实调用只证明被验证模型和当时账号的调用结果；listModels只证明列表可见／可解析，不证明推理成功。

## 7. 历史语义保全与变更范围

原词汇表混合了术语、机制与规格。本次保全到此处：旧自动路径仅首次填充，已有配置让路；旧“手动刷新”是单一镜像式重建，现拆成补充与重建；不增加长期备份的裁决继续保留，恢复能力不能被称为任何时刻都能还原定制。原“安装／升级未激活”订正为全新无状态实例未激活。原两阶段目录加载约束在真实写盘需要跨启动时继续适用，不能套到已验证的纯配置变更。显式耦合的账号模型适配仍只做只读GET /models，不自实现token获取／刷新／policy修改；现有0.84.4适配与当前目标运行时必须做差异校验，失败不自动应用不可信集合。供应链的integrity、限额、严格解包、URL与schema守卫继续保留。

历史ADR与现行README继续描述v1.2.7；原desktop注入／快照／重启方案继续复用。后续用户先选宿主持久边界、再经范围核对明确“确定A”；最终A替代前一方向，Q11软撤回与本地绑定是当前唯一目标。评审不得把旧三轮对更强目标的阻断或本规格当成新代码已上线。
