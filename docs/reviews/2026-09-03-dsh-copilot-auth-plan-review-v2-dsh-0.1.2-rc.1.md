# 《dsh-copilot-auth 实施计划》评审报告 v2 —— DSH 0.1.2-rc.1 升级影响复核（增补）

- 评审对象：`/bmc/iasi/workspace/docs/plans/2026-09-03-dsh-copilot-auth-implementation-plan.md`（未修改的原计划）
- 前置：v1 评审报告（`docs/reviews/2026-09-03-dsh-copilot-auth-plan-review.md`）基于 DSH **0.1.1-rc.2**；本机安装树已**就地升级**至 **0.1.2-rc.1**（`dsh -V` 实测），v1 的全部结论需在新版本下重验
- 本报告性质：①对计划在 0.1.2-rc.1 下的再评审；②v1 报告的勘误；③可执行的修订清单。**v1 中未被本文推翻的结论继续有效**

## 一、一句话结论

**核心机制链在 0.1.2-rc.1 下逐环复核全部成立，架构不需要返工；但计划的「版本事实层」已全面过时——peer 钉法 `^0.1.1-rc.2` 被 semver 预发布门调证明不匹配已安装的 0.1.2-rc.1，附录 A 约 2/3 锚点行号位移、1 个函数改名、1 个批量启用函数改名。按 §7 修订清单（v1 的 A1–A3 + 本文 U1–U7）更新计划后即可进入 Task 0。**

## 二、v1 勘误（先纠正我自己）

v1 报告 C1-1 建议把 pi-ai 路径「写全为 `$PKG/@earendil-works/pi-ai/dist/...`」——**这个路径是错的**。pi-ai 实际位于：

```
$DSH/node_modules/@earendil-works/pi-ai/        # $DSH/node_modules 下，与 @deepseek-ai 平级
```

而 `$PKG` 被计划定义为 `$DSH/node_modules/@deepseek-ai`，故 `$PKG/@earendil-works/...` 等于 `node_modules/@deepseek-ai/@earendil-works/...`，**不存在**。v1 第五节核对表中两处 pi-ai 路径同此更正。（本次复核最初两轮曾误报「pi-ai 缺失/升级中间态」，实为同一处路径拼接错误，安装树本身稳定。）

## 三、0.1.2-rc.1 环境快照（实测）

| 事实 | 值 |
|---|---|
| `dsh -V` / dsh 包 | `0.1.2-rc.1`（同路径就地升级：`/bmc/iasi/.nvm/.../node_modules/@deepseek-ai/dsh/`） |
| `@deepseek-ai/dsh-*` 全系（authorization/credentials/host-webserver/llm-pi-ai/settings/client-*/base/web-app/headless/app-boot） | `0.1.2-rc.1` |
| cordis | `4.0.2`（未变）；cordis-plugin-include `1.0.7` |
| pi-ai | `0.84.4`（llm-pi-ai 声明 `^0.84.2`） |
| 内置 bundle | 由 3 个增至 **6 个**：新增 `dsh-acp-app`、`dsh-sdk-app`、`dsh-sdk-minimal`（各带 cordis.patch.yml） |
| web profile 模板 | `[dsh-base, dsh-web-app]`（不变）；`DEFAULT_PROFILE_BUNDLES = [dsh-base]`（自定义 profile 如 `copilot-test` 只挂 base——dump 验证不受影响，见 §6-1） |
| registry | `dsh-authorization`、`dsh-llm-pi-ai` 已发布 `0.1.2-rc.1`（dist-tag **`next`**；注意 `latest` 停在旧版 0.1.1-rc.1）；cordis `latest=4.0.2`；`@inventec/dsh-copilot-auth` 仍 404（可注册） |
| CLI 面 | `--dump-config` / `plugin` 子命令 / `-V` 全部不变 |

## 四、机制锚点复核总表（v1 附录 A 的 15 行 + v1 补充项，新行号）

> 判定说明：✅ = 机制与证据均在，仅行号/名称更新；机制本身零例外全部成立。

| # | 机制 | 0.1.1-rc.2（v1 记录） | 0.1.2-rc.1（本次实测） | 判定 |
|---|---|---|---|---|
| 1 | authorization 未被内置 bundle 挂载 | 3 个 bundle patch 无 authorization | **6 个** bundle patch（base/web-app/headless/**acp-app/sdk-app/sdk-minimal**）逐一 grep 均无 | ✅ 成立且更强，附录措辞需更新 |
| 2 | llm-pi-ai 被动注册登录流 | `L2429 ctx.inject(["authorization"])` | **L2501** | ✅ |
| 3 | flow 注册形态 | L2251-2285 `registerPiAiFlows` | **L2322-2356**；`registerFlow({key, methods, run(session)})` 结构不变；method `"oauth"` id 在 **L2231** | ✅ |
| 4 | 设备码→notice 翻译 | L2195-2200 `case "device_code"` | **L2266-2271**；形状 `{message, url, code}` 不变 | ✅ |
| 5 | 企业域名首问 | pi-ai L264-276 | **L336-347**；message 逐字不变（仍含 "Enterprise"）；**grep 全文件确认 login 流程只有这一个 prompt**（无新增 select/secret 提问）——「答空串 + 拒绝意外 prompt」策略仍然完备 | ✅ |
| 6 | token 轮换 / proxy-ep / 模型发现 / 自动启用 | L39-58、L84-96、L193-228、L233-263 | `getBaseUrlFromToken` **L40**、`fetchGitHubCopilotModels` **L128**、`refreshGitHubCopilotAccessToken` **L244**、`refreshGitHubCopilotToken` **L274**、`enableGitHubCopilotModel` **L289**、`enableGitHubCopilotModels`（**改名**，原 `enableAllGitHubCopilotModels`）**L320**，login 中 **L366** 调用 | ✅ 机制不变，锚点全部位移 |
| 7 | patch 语义 + settings base 层 | `applyEntryPatches` L57-105；`installSettingsSection` L618-636；`mergeLayers` L229-241；llm-pi-ai `apply` L2384-2491 | `applyEntryPatches` **L57 起**（不变）；**`installSettingsSection` 改名为 `SettingsProvider.installSection` 方法（L327-343，`base: entry` 在 L329）**，语义逐字等价（base 注册/脱离回退 entry/watch 通知）；`mergeLayers` **L210**；llm-pi-ai `apply` **L2455**，`installSection` 调用点 **L2545** | ✅ 机制不变，**1 处函数改名** |
| 8 | providers catalog / 无 apiKeyEnv 走 OAuth | L2408-2414、L932-1051；pi-ai providers L13-16 | `resolveApiKey`（apiKeyEnv undefined → return undefined）**L2479-2486**；displayName schema **L944**、`Config` **L976**、`namesCredential` **L1066**；pi-ai providers/github-copilot.js id/name/oauth **L10-15**（新增 `isSubscription: true` 字段，无碍） | ✅ |
| 9 | authorization begin 契约 | L137-161；ALREADY_IN_FLIGHT/NOT_COMMITTED | **L137-161**（几乎未动）；`ALREADY_IN_FLIGHT` **L143**、commit 校验 `describeRecord(key)).configured` **L242-243** | ✅ |
| 10 | credentials 读写语义 | types L138-200 | `readRecord` **L159**、`describeRecord` **L165**、`deleteRecord`（absent = no-op）注释 **L188** / 签名 **L191** | ✅ → v1-A2 仍成立 |
| 11 | webServer 路由注册 | register L128-135；handler L186 | register **L176-183**（`kind: "exact"\|"prefix"` 双表不变）、`await route.handler(req, res)` **L234**、`match` **L322** | ✅ → v1-A1 仍成立 |
| 12 | settings.section 插槽（Models=order 10） | client.js L2784-2790；slots.d.ts | 参考注册 **L2907-2915**（`order: 10` 在 **L2910**）；slots.d.ts 的 `settings.section` 契约（list + `{id, order, label}` + owner `{close}`）不变；**新现象**：参考注册现在附带 `children` keyed 业务插槽声明（L2913-2915），插件的简化注册预计仍有效，见 §8 观察-1 | ✅ |
| 13 | client bundle 信封 | L1-8、L2805-2810 | 首部 **L1-8 逐字不变**；尾部结构不变，但参考文件末尾**新增 `//# sourceMappingURL=client.js.map` 尾注** → Task 5 的「逐字对齐」措辞需放宽为「信封结构对齐」（本插件产物无 sourcemap，自身首尾断言不受影响） | ✅ |
| 14 | dsh.client.inject 清单来源 | package.json L34-39（4 项） | **L30-34，官方清单变为 3 项**（移除 `@deepseek-ai/dsh-client-runtime`） | ⚠️ 见 U4 |
| 15 | 插件安装与 reconcile | `lib/plugin-9h8shc4d.js` L35-74 | 文件名随构建哈希变化：现为 **`lib/plugin-F7ZVfRyo.js`**（`exportsPatch` **L25-32**、reconcile 循环 **L53** 起，逻辑不变）→ 附录锚定方式改为「`lib/plugin-*.js` 文件名模式 + `exportsPatch` 符号」 | ✅ |
| 16 | （v1 补充）client-modules 扫描链 | lib/index.js L67-71、L389-395 | platform≠web 跳过 **L631**、声明 dsh.client 但 exports 无 `./client` 报错 **L636** | ✅ |
| 17 | （v1 补充）凭据文件 0600 | credentials-local L81/L104 | **L81/L104**（未变） | ✅ |

## 五、v1 评审结论在新版本下的存活复核

| v1 编号 | 内容 | 0.1.2-rc.1 下状态 |
|---|---|---|
| **A1** | webServer.register 缺 `kind:"exact"`（阻断） | **仍阻断**，证据移至 L176-183；修订指令不变 |
| **A2** | `/logout`「无记录 ok=false」不可实现，deleteRecord 是 no-op（阻断） | **仍阻断**，证据 L188-191；修订指令不变 |
| **A3** | package.json 缺 repository + `npm view dist.repository.url` 路径错误（阻断） | **仍阻断**（与 DSH 版本无关） |
| B1 | fake prompt 形状应 `{kind,...}` 非 `{type,...}` | 仍适用（`restate` 输出 kind 形状，新行号 L2290-2311） |
| B2 | `/status` 改用 `describeRecord` | 仍适用（L165；attempt 的 commit 校验同款 L243） |
| B3 | README 补 pnpm/peer 排障 | 仍适用；**新增注意**：0.1.2-rc.1 只挂在 `next` dist-tag 下、`latest` 停在旧版——凡按裸版本/latest 解析的场景会拿到旧包，本插件 peer 用明确范围不受影响，但 README 排障段值得提一句 |
| B4 | 已知边界补两条 + routePrefix 取舍 | 仍适用（mergeLayers 语义未变，L210） |
| B5 | patch `llm-pi-ai` 行补 `name` 防御 | 仍适用（applyEntryPatches 的 name 校验逻辑未变） |
| B6 | 附录补 client-modules 扫描锚点 | 仍适用，行号更新为 L631/L636 |
| C1 | 附录行段精度 | **被本文 §2 勘误 + §4 表取代**（以 §4 为准） |
| C2–C5 | 其余 C 级 | 全部仍适用，行号按 §4 |

## 六、升级引入的计划修改项（U 级）

### U1 版本事实三处过期（不改则 Task 0 第一条命令就触发「停下说明」）

- 架构快照「目标 DSH 版本 `0.1.1-rc.2`」→ `0.1.2-rc.1`
- Task 0 Expected：`dsh --version` 输出 `0.1.1-rc.2` → `0.1.2-rc.1`
- 全局约束 README 必含「实测版本 `0.1.1-rc.2`」+ Task 8 第 2 节前置要求 → `0.1.2-rc.1`

### U2 peer 钉法失效（semver 预发布门控，实测证明）

用 semver 7.7.3 实测：

| 候选版本 | 满足 `^0.1.1-rc.2`（计划现值） | 满足 `^0.1.2-rc.1` | 满足 `^0.1.1-rc.2 \|\| ^0.1.2-rc.1` |
|---|---|---|---|
| 0.1.1-rc.2 | ✅ | ❌ | ✅ |
| 0.1.1 | ✅ | ❌ | ✅ |
| **0.1.2-rc.1（本机已装）** | **❌** | ✅ | ✅ |
| 0.1.2（未来正式版） | ✅ | ✅ | ✅ |

预发布版本只匹配「同 major.minor.patch 元组且带预发布的 comparator」，所以 `^0.1.1-rc.2` **永远匹配不上 0.1.2-rc.1**。虽然 host 半区零 import、未满足 peer 在 pnpm 下多为告警，但这是错误的兼容性声明，且 auto-install-peers 会按错误范围从 registry 拉旧版本装进 profile。

**推荐方案（a）：跟随官方新风格。** 0.1.2-rc.1 的 `dsh-client-ui-settings-models` peer 已简化为**仅** `"@deepseek-ai/cordis": "^4.0.2"`，dsh-\* 全部移除（实测其 package.json L39-41）。本插件 host 半区同样零 import、只依赖服务组合事实——官方等于替我们示范了正确做法。peer 块改为：

```json
"peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
```

实测版本与兼容边界交给 README「已知边界」陈述。
备选（b）：三个 dsh-\* 钉 `^0.1.2-rc.1`（明确钉新实测版）；备选（c）：`^0.1.1-rc.2 || ^0.1.2-rc.1`（确需同时服务未升级同事时）。三选一写死，不要留歧义。

### U3 附录 A 需按 §4 表整体刷新

除行号外注意五点：①「所有内置 bundle」= 6 个并列出；②`installSettingsSection` → `installSection`（方法，L327-343）；③pi-ai 两处路径按 §2 勘误写对；④`plugin-9h8shc4d.js` 改为「`lib/plugin-*.js` + `exportsPatch` 符号」锚定；⑤Task 5 的「首尾逐字对齐」放宽为「信封结构对齐」（参考文件尾部现有 sourceMappingURL 尾注）。

### U4 Task 1 的 `dsh.client.inject` 照抄源已变

官方清单 4 项 → **3 项**（`ui-settings`、`locale`、`api-remotes`；package.json L30-34）。计划内嵌的 package.json 与「四项逐字复制自 L34-39」的说明需同步改。结合 v1-B6 的分析（本 client 只 require react，react 属 shell 基线；inject 是模块图依赖边，多声明 = 对宿主 roster 的额外要求面），**建议直接采用新 3 项清单**并在注释注明「复制自 0.1.2-rc.1 settings-models package.json L30-34」。

### U5 共识治理：给「逐字继承」开一条显式修订通道

全局约束声称「逐字继承自设计共识，执行中不得偏离」，而其中的 peer 钉法已被上游升级事实废止。若不改计划文本，执行纪律的「与仓库现实不符立即停下」和「不得偏离共识」会互相打架。请在计划中新增一小节**「共识修订记录」**：2026-09-03 DSH 就地升级 0.1.1-rc.2 → 0.1.2-rc.1（用户确认），版本与 peer 约束按 U1/U2 修订，其余共识条目不动。

### U6 运行中的 `dsh web` 可能仍是升级前代码

若 web 实例在升级前启动，进程内是旧代码。Task 0 的 `curl 200` 只证明端口在听、**不证明版本**。Task 7 Step 1 的重启（HUMAN）从「生效步骤」升级为「升级后必须」，并在 Task 0 备注此事实。

### U7 Task 0 增补一条存在性检查

`ls $DSH/node_modules/@earendil-works/pi-ai/package.json`——pi-ai 是登录协议的实际承载（且是本次评审两轮乌龙的源头），一行检查即可把「升级不完整/路径想当然」两类事故挡在 Task 0。

## 七、给执行 Agent 的按章节修订清单（合并 v1-A、本文-U、v1-B 的最终视图)

| 计划位置 | 修订动作 | 来源 |
|---|---|---|
| 架构快照 | 版本行 → `0.1.2-rc.1`；补「pi-ai 0.84.4 位于 `$DSH/node_modules/@earendil-works/pi-ai`」 | U1/§2 |
| 全局约束-依赖 | peer 块按 U2 方案(a)（或写死的 b/c） | U2 |
| 全局约束 | 新增「共识修订记录」小节 | U5 |
| Task 0 | Expected 三处版本值；增补 pi-ai 存在性检查；curl 步骤注明仅证明端口存活 | U1/U7/U6 |
| Task 1 | package.json：peer 块（U2）、`dsh.client.inject` 3 项+来源注释（U4）、补 `repository`/`author`（v1-A3） | U2/U4/A3 |
| Task 2 | 测试/yaml：`kind` 相关无涉；`routePrefix` 按 v1-B4 决策联动；patch 行补 `name` 防御（v1-B5） | B4/B5 |
| Task 3 | 路由注册 `kind:"exact"`（A1）；`/logout` 先 `describeRecord`（A2+B2）；fake prompt 改 `{kind,...}`（B1） | A1/A2/B1/B2 |
| Task 5 | 尾部验收措辞放宽（信封结构对齐） | U3-⑤ |
| Task 6 | 逻辑不变；可加一句「copilot-test 只含 dsh-base（DEFAULT_PROFILE_BUNDLES），host 半区不激活属预期，dump 三段断言不受影响」 | §3 |
| Task 7 | 重启标注「升级后必须」（U6）；验证时留意 §8 观察-1 的 children 告警 | U6 |
| Task 8 | README 实测版本 → 0.1.2-rc.1（U1）；pnpm/peer 排障段（B3，含 `next` dist-tag 提示） | U1/B3 |
| Task 10 | `npm view ... version repository.url`（A3） | A3 |
| 附录 A | 整表替换为本文 §4（16+1 行） | U3 |
| 附录 B | 增补：settings.yaml 稀疏覆盖删不掉预置路由（B4-1）；routePrefix 决策落文字（B4-2）；「headless 无 webServer」表述标注低置信度待 Task 6 顺验（§8 观察-4） | B4/§8 |

## 八、新观察（C 级，不阻断）

1. **参考注册的 `children` keyed 插槽声明**（settings-models client.js L2913-2915）：插件不带 `children` 的简化注册预计仍有效（slots.d.ts 的 `settings.section` 契约未变），Task 7 验证时留意浏览器 console 有无 schema 告警即可。
2. pi-ai copilot OAuth 声明新增 `isSubscription: true`（providers L15）：无碍；README 配额段措辞可顺手与「订阅」语义对齐（可选）。
3. llm-pi-ai 新增 `dsh-brand`、`dsh-util-values` 依赖：与本插件无关，无需动作。
4. app-boot 出现 `INSTALLATION_OWNED_PROFILE_TUPLES`（headless 的 installation-owned 元组含 dsh-web-app，L351-355）：附录 B「headless profile 无 webServer 服务」在新版下未必对每种 profile 形态都成立——低置信度观察，Task 6 dump 时顺带看一眼即可。
5. registry 的 `latest` dist-tag 落后（dsh-authorization latest=0.1.1-rc.1）：任何按 latest 解析的场景拿到的是旧版；本插件 peer 用明确范围不受影响（已并入 B3 的 README 排障段）。

## 九、仍然成立的核心机制链（给执行者的信心清单）

以下每一环都在 0.1.2-rc.1 安装树内重新验证过（证据行号见 §4）：

1. 插件 pnpm 安装 → `exportsPatch`/reconcile 把声明 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`（`lib/plugin-F7ZVfRyo.js`）；
2. patch 三段语义不变：无 id `insert` push、同 id 逐 key 覆盖（config 整值替换）、name 不匹配 warn+skip（`applyEntryPatches` L57 起）；
3. `authorization` 服务在全部 6 个内置 bundle 下仍未挂载——插件的 insert 前置依然必要且有效；
4. 挂载后 llm-pi-ai 被动 inject（L2501）→ `registerFlow(key="llm-pi-ai/github-copilot", methods 含 "oauth")`（L2322-2356、L2231）；
5. `begin({key, method, interaction, signal})` 契约、ALREADY_IN_FLIGHT、NOT_COMMITTED commit 校验全部未变（L137-161、L242-243）；
6. 企业域名 prompt 文本逐字未变、且 login 全程只有这一个 prompt——host 的「答空串 + 拒绝意外 prompt」策略完备（pi-ai L336-347）；
7. 设备码 notice `{message, url, code}` 全链字段一致（L2266-2271）；
8. entry config = settings base 层 + 用户 settings 递归覆盖（`installSection` L327-343、`mergeLayers` L210）——预置路由机制不变；
9. `webServer.register({kind, path, handler})` + Node 原生 `(req,res)`（L176-183、L234）；fiber 名 `webServer`/`authorization`/`credentials` 未变；
10. client 信封格式、`settings.section` 插槽（order 11 紧挨 Models 的 10）、client-modules 扫描链（L631/L636）全部就绪；
11. `@inventec/dsh-copilot-auth` 仍可注册，关键 peer 在公共 registry 均可得（0.1.2-rc.1 在 `next` tag 下）。

## 十、结论

这次升级没有动摇任何核心机制（16+1 组锚点逐环复核全部成立；变化的只是行号、两个函数名、官方 peer 风格），但暴露了计划的一个结构性特征：**机制层锚点质量极高、版本事实层却是硬编码的快照**。除按 §7 清单修订外，建议执行 Agent 在 Task 0 固化一条习惯：凡依赖 `$DSH` 版本的断言，先 `dsh -V` 再比对，不匹配即停——这与计划现有纪律一致，只是现在有了真实案例。

v1 的 A1–A3 三项阻断**全部依然成立**，与本文 U1–U7 合并处理完毕后，计划即可进入 Task 0。

— 评审 Agent，2026-09-03（v2 增补，对应 DSH 0.1.2-rc.1）
