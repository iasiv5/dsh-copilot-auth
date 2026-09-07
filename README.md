# @inventec/dsh-copilot-auth

[![Release](https://img.shields.io/github/v/release/iasiv5/dsh-copilot-auth?label=Release&sort=semver)](https://github.com/iasiv5/dsh-copilot-auth/releases)
[![npm](https://img.shields.io/npm/v/%40inventec%2Fdsh-copilot-auth?label=npm)](https://www.npmjs.com/package/@inventec/dsh-copilot-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/iasiv5/dsh-copilot-auth/ci.yml?branch=main&label=CI)](https://github.com/iasiv5/dsh-copilot-auth/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/iasiv5/dsh-copilot-auth?label=License)](https://github.com/iasiv5/dsh-copilot-auth/blob/main/LICENSE)
[![DSH Web](https://img.shields.io/badge/DSH%20Web-0.1.2--rc.1%20verified-2563eb)](#前置要求)

为 DSH（DeepSeek Harness）内置的 GitHub Copilot LLM provider 补上 Web 端设备码（device flow）登录/注销入口，并预置一条开箱即用的 GitHub Copilot 提供方路由。

## 这是什么

用公司分配的 GitHub 账号（带 Copilot 订阅）登录 DSH 的方式，和其他 Copilot 客户端一致：**网页 + 设备码**，全程不填 API Token。

本插件**复用 DSH 内置通道**（pi-ai 的 github-copilot provider），不实现任何 GitHub 协议代码——token 自动轮换、模型发现、协议适配全部由内置实现负责。插件本身只做三件事：挂载 DSH 内置但默认未启用的授权服务、提供「登录/注销」设置页、预置 `GitHub Copilot` 路由。

## 特性

- 🔐 **设备码登录/注销**：网页 + user code，免 API Token；SSO 组织授权友好
- 🧩 **预置提供方路由**：安装即出现在 Models 页，无需手动配置
- 📦 **模型目录兜底填充**：登录成功时，若 GitHub Copilot 路由还没有模型目录，自动填入账号全部可用模型；你已精简/定制过的目录**永不覆盖**（重启、重新登录均不重置）
- 🔄 **手动补充新模型目录条目**：GHC 设置页一键刷新——diff 预览 + 二次确认 + 数据级目录补丁（**pi-ai 版本不动**），新模型（如 gemini-3.8-flash）即可加入、失效模型镜像移除
- 🌐 **中/英双语界面**：跟随 DSH 语言设置自动切换
- 🔑 **凭据安全托管**：存入 DSH 内置凭据库（文件强制 0600 权限），Copilot 临时 token 到期自动刷新
- 🧪 **测试与 CI**：105 条单元测试；GitHub Actions 构建测试 + tag 触发自动发布（provenance）

## 前置要求

- DSH `0.1.2-rc.1`（实测版本）
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

> 设备码有时效（约 15 分钟），请拿到代码后尽快完成授权。若超时，页面会显示失败原因，重新点「登录」即可。

## 使用

- Models 页选择 `GitHub Copilot` 路由，模型目录已在首次登录时自动填充账号全部可用模型，无需手动「添加模型」；之后可自由增删精简，重启 / 重新登录都不会重置你的列表
- **配额说明**：base 模型（GPT-4o/4.1 一类）不耗 premium requests；premium 模型（Claude、Gemini、o 系列等）每次调用消耗月度配额。日常建议 base 档，premium 模型按需手动选

## 注销与卸载

- 注销：设置页「注销」按钮（清除本机凭据记录）
- 卸载：`dsh plugin --profile web remove @inventec/dsh-copilot-auth` 后重启 dsh web

## 模型目录刷新

pi-ai 的模型目录是打包时硬编码的 JSON：上游新增模型（如 gemini-3.8-flash）在本机无法解析、失效模型残留。「刷新可用模型目录」按钮（GHC 设置页，登录后可见）在不升级 pi-ai 的前提下解决这一问题。

- **两阶段生效**：确认后先对本机 `github-copilot.json` 做原子数据级补丁（pi-ai 代码版本不变）；**重启 dsh web 后**插件再把 settings 模型目录镜像重建为「账号可用 ∩ 目录可解析」集合（目录在模块加载时读取，同 boot 内写完目录不会同步 settings）。
- **diff 预览 + 二次确认**：弹窗展示新增（绿）/移除（红）/保留计数、被校验跳过的上游条目、以及**将被重置的定制名单**（字段微调与 modelOverrides）。确认前请核对三条风险：失效模型将消失、你的定制将被重置、需重启后才生效。
- **激活边界**：插件首次安装/升级后处于未激活态，启动时不触碰 pi-ai 安装树；只有成功执行过一次手动刷新后才激活。DSH 升级冲掉补丁后，已激活实例启动时自愈重放**历史上实际应用过**的补丁条目（内置覆盖层仅作离线数据源，绝不自动应用）。
- **数据源与回退**：账号可用模型现场拉取（失败回退凭证缓存）；目录数据从 npm 拉取最新 pi-ai tarball（强制 `dist.integrity` 校验、超时与大小上限、tar 严格解析），失败时可改用内置覆盖层（0.85.1 收割，integrity `sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==`）出 diff。
- **只增不更新**：合并只补充本机从未见过的模型条目；上游对已有 id 的元数据修正（api 归属、contextWindow 等）不会同步——这是「永不覆盖」语义的代价（ADR 0001）。
- **digest 绑定**：preview 与 apply 之间以输入 digest（settings 完整配置 / 可用模型 / 本地目录 / 目录来源）绑定，任何漂移即 409 并要求重新预览确认。

## 工作原理

- 通过 `cordis.patch.yml` 三段生效：
  1. 挂载 `@deepseek-ai/dsh-authorization` 服务（DSH 内置 bundle 未挂载，不挂则内置登录流不存在）
  2. 注册本插件（host 侧在 webserver 上开 6 条本地路由：`/copilot-auth/start|state|status|logout|refresh/preview|refresh/apply`，跨站 Origin 拒绝）
  3. 以 settings base 层预置 `github-copilot` 路由（用户 `settings.yaml` 可逐字段覆盖）
- 登录走 GitHub 设备码流；凭据存 `~/.dsh/.credentials.yaml`（强制 600 权限）的 `llm-pi-ai/github-copilot` 记录，Copilot 临时 token 到期自动刷新
- **模型目录兜底填充**：登录成功时，取「账号可用模型 ∩ pi-ai 内置目录」写入该路由的模型目录——仅当该路由尚未配置 `models` 且无 `modelOverrides` 时写入；目录已存在（含空列表）一律让路，插件启动/重启也绝不触碰用户 settings。同步失败经 `/copilot-auth/status` 的 `syncError` 字段暴露

## 开发

```bash
npm install
npm test        # node:test：patch 结构 + host/目录/状态机/启动序列共 105 条
npm run build   # esbuild 打包 client 到 lib/client.js（__ModuleLoader__ 信封）
npm pack --dry-run
```

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml` | 三段 patch（authorization 挂载 / 本插件 entry / 预置路由） |
| `src/host.mjs` · `src/shared.mjs` | host 半区：登录状态机、6 条本地路由、模型目录同步、刷新 preview/apply 与启动序列 |
| `src/client.jsx` | client 半区：settings.section 插槽 + 设备码交互 + 双语文案 |
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
- DSH rc 版本耦合：实测 `0.1.2-rc.1`，peer 仅 `@deepseek-ai/cordis@^4.0.2`
- 模型目录只在「尚不存在」时由登录成功兜底填充一次，填充后归用户所有：账号新增的模型不会自动出现——用 GHC 设置页的「**刷新可用模型目录**」同步（见上节），或在 Models 页手动添加
- 模型目录只写入 pi-ai 内置目录已描述的模型：目录快照外的新模型需先经「刷新可用模型目录」补入目录条目（数据级补丁，pi-ai 版本不变）才会出现在可选列表
- DSH 升级后自愈仅在 pi-ai 基线版本不变（0.84.4）时重放；跨版本且条目未原生存在时上报 `self-heal-incompatible`，不修改安装树（重新执行一次手动刷新即可在新基线上激活）
- 并发保护为宿主单进程内 mutex，**不支持多实例/多进程并发刷新**

## 维护者发布

本项目使用 npm **Trusted Publishing（GitHub Actions OIDC）** 发布，不在仓库或 GitHub Secrets 中保存 `NPM_TOKEN`。

- 发布 workflow：`.github/workflows/release.yml`
- 触发方式：推送 `v*` tag，或在 GitHub Actions 手动触发
- npm Trusted Publisher 配置：GitHub Actions；owner `iasiv5`；repository `dsh-copilot-auth`；workflow filename `release.yml`；environment 留空；允许 `npm publish`
- workflow 使用 GitHub-hosted runner、`id-token: write`，npm CLI 自动使用 OIDC 并生成 provenance
- npm Trusted Publisher 是按 package 配置的。首次发布前如果 package 尚不存在，需要先完成 npm 要求的一次性 bootstrap，再在 package settings 中配置 Trusted Publisher；bootstrap 不应通过长期 GitHub secret 实现。详见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers)

## License

MIT
