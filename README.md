# @inventec/dsh-copilot-auth

[![Release](https://img.shields.io/github/v/release/iasiv5/dsh-copilot-auth?label=Release&sort=semver)](https://github.com/iasiv5/dsh-copilot-auth/releases)
[![npm](https://img.shields.io/npm/v/%40inventec%2Fdsh-copilot-auth?label=npm)](https://www.npmjs.com/package/@inventec/dsh-copilot-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/iasiv5/dsh-copilot-auth/ci.yml?branch=main&label=CI)](https://github.com/iasiv5/dsh-copilot-auth/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/iasiv5/dsh-copilot-auth?label=License)](https://github.com/iasiv5/dsh-copilot-auth/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.7--rc.2%20%7C%200.2.0--rc.1%2Frc.2%20verified-2563eb)](#前置要求)

为 DSH（DeepSeek Harness）内置的 GitHub Copilot LLM provider 补上 Web 端设备码（device flow）登录/注销入口，并预置一条开箱即用的 GitHub Copilot 提供方路由。

## 这是什么

用公司分配的 GitHub 账号（带 Copilot 订阅）登录 DSH 的方式，和其他 Copilot 客户端一致：**网页 + 设备码**，全程不填 API Token。

本插件**复用 DSH 内置通道**（pi-ai 的 github-copilot provider），不实现任何 GitHub 协议代码——token 自动轮换、模型发现、协议适配全部由内置实现负责。插件本身只做三件事：提供「登录/注销」设置页、预置 `GitHub Copilot` 路由、模型目录兜底/刷新（授权服务 0.1.7+ 由 runtime 内置；≤0.1.5 时代由本插件补丁挂载，该版本线见 v1.1.x）。

## 特性

- 🔐 **设备码登录**：网页 + user code，免 API Token；SSO 组织授权友好
- 🛑 **诚实的授权语义（v2）**：登录进行中可「**请求撤回**」——请求发出后状态如实显示「结果待核实」，不再伪装成已取消；**「退出登录」在静止状态可用**（确认弹窗 → 清除凭据 → 删后核实；尝试进行中/风险锁存期拒绝）；**「重新授权」按钮已移除**（v1.2.11：已登录只需退出登录，未登录入口本就是授权登录——独立按钮属逻辑冗余）；同一实例只有一个授权尝试，409 时恢复展示共同进度
- 🧩 **预置提供方路由**：安装即出现在 Models 页，无需手动配置
- 📦 **模型目录兜底填充**：登录成功时，若 GitHub Copilot 路由还没有模型目录，自动填入账号全部可用模型；你已精简/定制过的目录**永不覆盖**（重启、重新登录均不重置）；已请求撤回后晚到的授权成功**不会**再写你的配置
- ➕➖ **补充模型 / 重建模型列表（v2 双入口）**：「补充」默认非破坏——候选模型默认全不勾选，勾选后才加入，现有对象/顺序/modelOverrides 全部保留；「重建」显式确认后按「账号可用 ∩ 目录可解析」重建纯 ID 列表并清空本路由 modelOverrides（二次确认 + 空目标单独确认）。预览快照 10 分钟有效、绑定选择；同一操作幂等可查；配置并发编辑优先受保护
- 🌐 **中/英双语界面**：跟随 DSH 语言设置自动切换
- 🔑 **凭据安全托管**：存入 DSH 内置凭据库（文件强制 0600 权限），Copilot 临时 token 到期自动刷新
- 🧪 **测试与 CI**：181 条单元测试（ubuntu/windows/macos 三平台矩阵）；GitHub Actions 构建测试 + tag 触发自动发布（provenance）

## 前置要求

- DSH `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.0-rc.2`（实测版本，v1.2.x 的适配目标；0.2.0 起注意插件 peer 精确版本守卫，见下文版本矩阵）
  - 版本矩阵：`0.1.2-rc.1` ～ `0.1.5-rc.2` 请用 **v1.1.x**（v1.2.0 移除了旧版必需的 authorization 挂载补丁，在旧版上无法激活）
  - v1.2.0 适配了 0.1.7 的 settings API 重塑（`settings.get` 移除），目录保护逻辑改走 `describe()`：**`describe()` 读取在 value 层缺失时回退 user 层，兼容旧版 describe 行形状**；DSH 版本支持矩阵见下表

| 本插件 | DSH 实测版本 | authorization 服务 | 说明 |
|---|---|---|---|
| v1.2.13+ | `0.1.7-rc.2`+ | runtime 内置，插件不挂载 | **修复模型弹窗勾选闪烁**：勾选/全选触发的物化期间弹窗保持挂载（历史实现切回 `previewing` 导致弹窗整体卸载重挂——卡片闪现「拉取预览中」、滚动位置丢失，实测探针元素直接从 DOM 消失）；弹窗改固定高度三段式（头部/内部滚动/常驻操作栏），尺寸不再随增删列表变化；勾选走本地乐观更新（服务端回显到达后对齐）。其余同 v1.2.12 |
| v1.2.12 | `0.1.7-rc.2`+ | runtime 内置，插件不挂载 | **交互打磨**：「补充模型」的全选按钮在全选中切换为「取消全选」（任一取消勾选即恢复「全选」）；「重建」风险提示精简为一行；成功路径的「技术详情」计数移除（与弹窗增删列表重复），技术详情仅在真实失败时展示。其余同 v1.2.11 |
| v1.2.11 | `0.1.7-rc.2`+ | runtime 内置，插件不挂载 | **界面收敛：移除「重新授权」按钮与 `capabilities.reauthorize` 能力位**（逻辑冗余——已登录只需退出登录，未登录入口本就是「授权登录」；换号/重授权＝先退出再登录两步）。其余同 v1.2.10 |
| v1.2.10 | `0.1.7-rc.2`+ | runtime 内置，插件不挂载 | **退出登录正式可用**：无进行中授权尝试且无未核实风险（风险锁存）时，经确认弹窗清除凭据并**删除后立即复核**（凭据未消失则如实报「退出未完成」）；授权尝试进行中（begin 晚写窗口）与撤回/超时未核实期一律拒绝退出。`/status` 的 `authorization.capabilities.logout` 按可用性动态返回。经主人 2026-10-05 裁决替代 v1.2.8 D-01「退出全禁」策略 |
| v1.2.9 | `0.1.7-rc.2`+（`0.2.0-rc.1` web 与 `0.2.0-rc.2` desktop 已实测） | runtime 内置，插件不挂载 | **修复 v1.2.8 授权页显示回归**：授权状态机漏接 `fetch`，页面恒显「未登录」、点「授权登录」恒「失败」且请求根本不发出（2026-10-04 实机实证，nginx 全量零 `POST /copilot-auth/start`）。另加：/status 加载失败退避自愈重试（60 秒转手动＋「查询状态」）、失败原因分层展示（网络/网关/响应，不再裸「失败」）、已登录时服务端拒绝替换性授权（409 `already-configured`）且客户端自动恢复已登录视图 |
| v1.2.8 | `0.1.7-rc.2`+（`0.2.0-rc.1` web 与 `0.2.0-rc.2` desktop 已实测） | runtime 内置，插件不挂载 | **协议 v2：诚实的授权语义＋补充/重建双入口**。授权侧：等待中可「请求撤回」（结果如实显示待核实）、退出/重新授权在宿主可证明安全前禁用并说明、单实例 attempt、15 分钟等待上限、晚到授权成功不再写配置；模型侧：旧「刷新」拆为「补充模型」（候选默认不勾选、非破坏）与「重建模型列表」（二次确认＋清 modelOverrides），预览 10 分钟绑定选择、operationId 幂等、配置并发编辑优先、崩溃可恢复（「结束旧配置意图」显式闭环），状态按 profile 隔离（旧全局状态只读提示）；模型路由要求 `protocolVersion:2`，GET `/status` 零写探针；v1 函数族已从 state.mjs 移除。**已知缺陷**：授权状态机漏接 fetchImpl → 授权页恒「未登录/失败」（v1.2.9 修复） |
| v1.2.7+ | `0.1.7-rc.2`+（`0.2.0-rc.1` web 与 `0.2.0-rc.2` desktop 已实测） | runtime 内置，插件不挂载 | **重启后自动恢复**：注入后以宿主 `listModels` 复核，未端出即**净零切换**（`displayName` 改后复原；两次真内容变化 ⇒ 宿主必然重建快照，用户配置逐字节不变）触发重建；另加双路取实例 + `registryInstanceMismatch`/`registryVia` 诊断。修复 v1.2.6 的"同值写不改变配置身份 ⇒ 快照不重建" |
| v1.2.6 | `0.1.7-rc.2`+ | runtime 内置，插件不挂载 | 首次引入宿主侧复核与 `settingsNotServed` 诊断；重启自愈用的"同值触碰"**实测不足**（同值写不改变配置对象身份），重启后模型可能仍不出现——请用 v1.2.7 |
| v1.2.5 | `0.1.7-rc.2`+（`0.2.0-rc.1` web 与 `0.2.0-rc.2` desktop 已实测） | runtime 内置，插件不挂载 | **desktop 只读形态可刷新**：进程内目录注册表注入（ADR 0003），无需重启、不碰官方产物；`0.2.0-rc.2` desktop **实机端到端已验**（注入条目完成真实推理请求）；同批修复 pi-ai ≥0.99.0 的 `chat:` 目录键格式。**已知缺陷**：重启后若宿主快照先于注入定稿，注入条目会被丢弃（v1.2.6 修复） |
| v1.2.4 | `0.1.7-rc.2`+（`0.2.0-rc.1` web 与 `0.2.0-rc.2` desktop 已实测） | runtime 内置，插件不挂载 | desktop asar 只读形态：目录刷新入口显式置灰（ADR 0002），登录/路由/settings 不受影响 |
| v1.2.0 ～ v1.2.3 | `0.1.7-rc.2` ～ `0.2.0-rc.1`（web/服务形态） | runtime 内置，插件不挂载 | 适配 settings API 重塑后的 describe() 行形状；desktop asar 形态下目录刷新不可用且报错不友好 |
| v1.1.x | `0.1.2-rc.1` ～ `0.1.5-rc.2` | 由 cordis.patch.yml insert 挂载 | v1.2.0 起移除该补丁，旧版 DSH 上无法激活 |

- 有效的 GitHub Copilot 订阅（公司分配的 github.com 组织账号，SSO 登录）
- `pnpm` 可用（`dsh plugin` 是 pnpm 转发器）

## 安装

```bash
dsh plugin --profile web add @inventec/dsh-copilot-auth
```

然后**重启 dsh web 并刷新浏览器**。

### 故障排查

- 企业镜像/私有源环境下 pnpm 解析 peer 失败：`export npm_config_auto_install_peers=false` 后重试（profile 自带的 pnpm workspace 默认已关闭 peer 自动安装）。
- registry 的 `latest` dist-tag 可能落后于 `next`：显式按版本号安装/排查时勿被 `latest` 误导。

## 登录

1. 打开设置，进入侧栏「**GHC设置**」（英文界面为 *GHC Settings*，位于 Models 之后）
2. 点「登录」，页面显示一串**代码**（user code，可一键复制）与 `https://github.com/login/device` 链接
3. 新标签打开链接，用公司 GitHub 账号输入代码
4. **SSO 用户必须对组织点 Authorize**（授权页会出现该步骤，跳过则登录不生效）
5. 回到设置页看到「已登录」即成功；首次登录会自动填充模型目录（已定制过的目录不会被覆盖）

> 等待有本地时限（约 15 分钟）。若超时，页面显示「等待授权超时，结果仍待核实」——**结果待核实时不能再直接发起新的授权尝试**，请点「查询状态」或人工核实；等待期间也可随时「请求撤回」（同样只承诺请求已发出，结果待核实）。

## 使用

- Models 页选择 `GitHub Copilot` 路由，模型目录已在首次登录时自动填充账号全部可用模型，无需手动「添加模型」；之后可自由增删精简，重启 / 重新登录都不会重置你的列表
- **配额说明**：base 模型（GPT-4o/4.1 一类）不耗 premium requests；premium 模型（Claude、Gemini、o 系列等）每次调用消耗月度配额。日常建议 base 档，premium 模型按需手动选

## 撤回、退出与卸载

- **请求撤回**：授权等待期间可点「请求撤回」——插件先使本地旧意图失效，再尝试调用宿主撤销接口；无论请求是否送达，状态都如实显示「结果仍待核实」，在结果核实前不能发起新的授权尝试。
- **退出登录（v1.2.10）**：无进行中授权尝试且无未核实风险时可退出——确认弹窗（将清除同一凭据库中所有实例共享的 Copilot 授权，不注销 GitHub 账号）→ 删除凭据 → **删除后立即复核**，凭据仍在则如实显示「退出未完成，授权凭据仍可能存在」；授权尝试进行中（设备码等待期，begin 晚写窗口）与撤回/超时未核实的风险锁存期一律拒绝退出。**「重新授权」独立按钮已移除（v1.2.11）**：需要换号/重授权时，先「退出登录」再「授权登录」即可。
- 卸载：`dsh plugin --profile web remove @inventec/dsh-copilot-auth` 后重启 dsh web

## 补充模型 / 重建模型列表

pi-ai 的模型目录是打包时硬编码的 JSON：上游新增模型（如 gemini-3.8-flash）在本机无法解析。v2 把旧的单一「刷新」拆成两个明确入口（GHC 设置页，登录后可见），在不升级 pi-ai 的前提下解决目录过期问题。

- **补充模型（默认、非破坏）**：候选＝「账号可用 ∩ 目录可解析 − 已配置」，**默认全不勾选**（缺失不等于你想加回来）；勾选后从原预览快照重算（10 分钟内有效、不重新取数），确认时只追加勾选项——现有模型对象、顺序、参数与 modelOverrides 逐字保留。账号证据优先现场拉取；现场失败时 24 小时内同授权的缓存可用于补充，过期/无时间戳/授权已变化只作参考展示、**阻止应用**；重建永远要求现场拉取成功。
- **重建模型列表（显式、破坏性）**：目标＝「账号可用 ∩ 目录可解析」的纯 ID 列表，同一提交清空本路由 modelOverrides；需**二次确认**，空目标需**单独确认**。移除项按原因列出（不在账号列表 / 目录无法解析）；base 继承的 modelOverrides 无法经用户层清除时明确阻止并解释。
- **生效时机按落地通道分叉**：可写安装树（web/服务）→ 先对 `github-copilot.json` 做原子只增补丁（pi-ai 代码版本不变），**重启后**插件在目录已加载、目标全部可解析且配置未被你改动的前提下按基线提交配置（改动过则报 conflict、保留你的值）；只读安装树（desktop `app.asar`）→ 进程内注册表注入（ADR 0003），**当次生效、无需重启**，并以宿主 `listModels` 端到端自证，端不出来即回滚（仅当配置仍等于本操作写入值时；否则 rollback-conflict 保留你的新值）。
- **幂等与并发保护**：每个操作带服务端签发的 operationId——重复提交/网络超时后重查同一 ID 都返回已知结果，绝不重复执行、绝不换 ID 重发；配置提交前复核 revision，任何漂移返回 409 要求重新预览；你的并发编辑永远优先。
- **恢复与「结束旧配置意图」**：apply 前先持久操作意图，崩溃/重启后启动序列核实恢复；出现 conflict / rollback-conflict / recovery-needed 时，页面提供「结束旧配置意图」显式确认（只结束旧意图，不回滚已发生的更改），随后即可重新预览。
- **profile 隔离与旧状态（v2）**：刷新状态存于 `<profile>/copilot-auth/refresh-state.json`，配置意图绝不跨 profile 消费；旧版全局状态文件只读检测并提示重新预览确认，不自动继承。
- **激活与自愈（保留）**：首次成功操作后激活；pi-ai 升级/重装冲掉目录后，同基线启动时按已确认条目**只增重放**（file 通道写盘后提示需再重启加载；registry 通道重放后复核端出）；跨 pi-ai 基线且条目缺失时上报 `self-heal-incompatible`，不自动应用。
- **数据源与供应链（不变）**：目录数据从 npm 拉取最新 pi-ai tarball（强制 `dist.integrity` 校验、超时与大小上限、tar 严格解析）；npm 失败回退本地目录（`catalogSource: local`），可**显式**改用内置覆盖层（0.85.1 收割，integrity `sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==`）生成新预览——绝不隐式降级。
- **只增不更新**：合并只补充本机从未见过的模型条目；上游对已有 id 的元数据修正不会同步——这是「永不覆盖」语义的代价（ADR 0001）。
- **远端目录形状规范化**：pi-ai ≥0.99.0 的 `chat:` 键统一规范化回裸 id；非法/冲突条目进 skipped 列表展示，不静默。
- **净零切换（v1.2.7 机制保留）**：registry 通道注入落在宿主快照之后时，以 `displayName`「加空格再复原」的两次真内容变化触发快照重建（用户配置逐字节不变）；仍端不出来记 `registry-not-served` 并暴露 `settingsNotServed` / `registryVia` / `registryInstanceMismatch` 诊断。GET `/status` 不执行任何写探针（通道分类来自启动期缓存；`catalogMode` 为 `blocked`/`unknown` 时入口禁用并给出具体原因）。
- **单宿主进程假设**：互斥为宿主单进程内串行队列，不支持多实例/多进程并发操作同一安装目录。

## 工作原理

- 通过 `cordis.patch.yml` 两段生效：
  1. 挂载本插件 entry（host 侧在 webserver 上开 8 条本地路由：`/copilot-auth/start|state|status|logout|cancel|refresh/preview|refresh/apply|refresh/retire`，跨站 Origin 拒绝；模型路由要求 `protocolVersion: 2`，`GET /status?operationId=` 返回 active／last／unknown 三态）
  2. 以 settings base 层预置 `github-copilot` 路由（用户 `settings.yaml` 可逐字段覆盖）
- authorization 服务 **0.1.7+ 由 runtime 内置，无需也不得再挂载**（旧版 ≤0.1.5 请用 1.1.x，其依赖该 insert）
- 登录走 GitHub 设备码流；凭据存 `~/.dsh/.credentials.yaml`（强制 600 权限）的 `llm-pi-ai/github-copilot` 记录，Copilot 临时 token 到期自动刷新
- **授权状态（v2）**：授权生命周期在 `src/auth-host.mjs`——单实例 attemptId、软撤回（先持久 intentVersion+1 再调宿主撤销）、15 分钟本地等待上限（惰性判定）、进程级风险锁存（重挂不清）；`<profile>/copilot-auth/auth-intent.json` 记录本 profile 显式操作代次，撤回/超时后晚到的授权成功只更新事实、不再生成配置意图
- **模型目录兜底填充**：登录成功时，取「账号可用模型 ∩ pi-ai 内置目录」写入该路由的模型目录——仅当该路由尚未配置 `models` 且无 `modelOverrides`、且填充 handoff 仍完好时写入；目录已存在（含空列表）一律让路，插件启动/重启也绝不触碰用户 settings。同步失败经 `/copilot-auth/status` 的 `syncError` 字段暴露
- **刷新状态（v2）**：`src/refresh-service.mjs`（预览快照/证据门禁/幂等查询）＋ `src/refresh-transaction.mjs`（写前意图、两通道提交时点、条件回滚、boot 恢复与保守自愈），状态按 profile 隔离落盘

## 开发

```bash
npm install
npm test        # node:test：patch 结构 + host/授权控制器/客户端状态机/模型策略/预览服务/事务内核/profile 隔离 共 181 条（CI 跑 ubuntu/windows/macos 三平台矩阵）
npm run build   # esbuild 打包 client 到 lib/client.js（__ModuleLoader__ 信封）
npm pack --dry-run
```

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml` | 两段 patch（本插件 entry / 预置路由；authorization 服务 0.1.7+ 由 runtime 内置，不再挂载） |
| `src/host.mjs` · `src/shared.mjs` | host 半区：路由接线、status 聚合、启动期能力探测 |
| `src/auth-host.mjs` | 授权控制器：单实例尝试、软撤回＋风险锁存、禁用退出、首次填充 handoff |
| `src/runtime-scope.mjs` | 稳定 profile 身份与私有 dataDir（`<profile>/copilot-auth/`） |
| `src/refresh-service.mjs` · `src/refresh-transaction.mjs` · `src/model-update.mjs` | 预览快照/证据门禁/幂等 · 事务内核与恢复 · 纯变更策略 |
| `src/client-http.mjs` · `src/auth-flow.mjs` · `src/refresh-flow.mjs` | client 半区：HTTP 脱敏、授权状态机、模型流状态机 |
| `src/catalog-registry.mjs` | 只读安装树的落地通道：进程内目录注册表注入（ADR 0003） |
| `src/client.jsx` | client 半区：settings.section 插槽 + 授权/模型双区交互 + 双语文案 |
| `scripts/build-client.mjs` | client 打包（`__ModuleLoader__` CJS 工厂信封） |
| `lib/client.js` | 构建产物（入库，使 git 安装免构建） |

从源码安装：`dsh plugin --profile web add /path/to/dsh-copilot-auth`

## 风险与合规

- 通道为社区通用路线（基于 pi-ai 内部实现），**非 GitHub 官方支持 API**，可能随服务端变更失效
- GitHub AUP 禁止批量自动化滥用；**公司账号请正常强度使用**

## 已知边界

- Models 页的凭据状态圆点只反映 API Key 引用，OAuth 登录成功后圆点仍可能显示未配置（外观问题，功能不受影响）
- 自行在 `cordis.patch.yml` patch `llm-pi-ai` 整段 config 会覆盖预置路由
- `settings.yaml` 的 `llm-pi-ai:` 节只能稀疏覆盖字段，无法删除预置路由本身（移除须卸载本插件）
- 路由前缀 `/copilot-auth` 两侧硬编码，不可配置
- DSH rc 版本耦合：实测 `0.1.7-rc.2` 与 `0.2.0-rc.1`（v1.2.x；`0.1.2-rc.1` 由 v1.1.x 实测），peer 仅 `@deepseek-ai/cordis@^4.0.2`
- 模型目录只在「尚不存在」时由登录成功兜底填充一次，填充后归用户所有：账号新增的模型不会自动出现——用 GHC 设置页的「**补充模型**」勾选加入（见上节），或在 Models 页手动添加
- 模型目录只写入「可解析」的模型：目录快照外的新模型须先经「补充模型」补入——可写安装树补进目录文件、只读安装树（desktop）注入进程内注册表（ADR 0003），两条通道都保持 pi-ai 版本不变
- 请求撤回/等待超时后，该 profile 的旧预览与待生效配置意图按 intentVersion 失效（auth-changed / recovery-needed），须重新预览或显式「结束旧配置意图」
- DSH 升级后自愈仅在 pi-ai 基线版本不变（0.84.4）时重放；跨版本且条目未原生存在时上报 `self-heal-incompatible`，不修改安装树（重新执行一次手动刷新即可在新基线上激活）
- **dsh-desktop（Electron 桌面版）可刷新模型目录（v1.2.5 起）**：运行时树打包在只读的 `app.asar` 内，写盘通道物理不可用，但刷新改走进程内目录注册表注入（ADR 0003）——当次生效、无需重启、不碰官方产物；重启后由启动序列重放，并按 v1.2.6 的复核/同值触碰机制保证路由真的端出这些模型。前提是该进程的 pi-ai 目录注册表形态与实测一致（`MODELS[provider]` 未冻结、扁平、键=模型 id）；上游改形状时注入守卫会拦下并报 `registry-*` 结构化错误，模型列表保持原样（不写 settings）。v1.2.4 及之前该形态只能置灰刷新入口（`catalog-not-writable`，另见 ADR 0002）
- 并发保护为宿主单进程内 mutex，**不支持多实例/多进程并发刷新**
- 状态落盘后的目录 fsync 仅在 POSIX 执行：Windows 无目录 fsync 语义（对目录句柄 fsync 必然 `EPERM`），win32 直接跳过、不再刷告警，目录项一致性由 NTFS 元数据日志保证（v1.2.3 起，issue #1）；POSIX 行为不变

## 维护者发布

本项目使用 npm **Trusted Publishing（GitHub Actions OIDC）** 发布，不在仓库或 GitHub Secrets 中保存 `NPM_TOKEN`。

- 发布 workflow：`.github/workflows/release.yml`
- 触发方式：推送 `v*` tag，或在 GitHub Actions 手动触发
- npm Trusted Publisher 配置：GitHub Actions；owner `iasiv5`；repository `dsh-copilot-auth`；workflow filename `release.yml`；environment 留空；允许 `npm publish`
- workflow 使用 GitHub-hosted runner、`id-token: write`，npm CLI 自动使用 OIDC 并生成 provenance
- npm Trusted Publisher 是按 package 配置的。首次发布前如果 package 尚不存在，需要先完成 npm 要求的一次性 bootstrap，再在 package settings 中配置 Trusted Publisher；bootstrap 不应通过长期 GitHub secret 实现。详见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers)

## License

MIT
