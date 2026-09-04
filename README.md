# @inventec/dsh-copilot-auth

为 DSH（DeepSeek Harness）内置的 GitHub Copilot LLM provider 补上 Web 端设备码（device flow）登录/注销入口，并预置一条开箱即用的 GitHub Copilot 提供方路由。

## 这是什么

用公司分配的 GitHub 账号（带 Copilot 订阅）登录 DSH 的方式，和其他 Copilot 客户端一致：**网页 + 设备码**，全程不填 API Token。

本插件**复用 DSH 内置通道**（pi-ai 的 github-copilot provider），不实现任何 GitHub 协议代码——token 自动轮换、模型发现、协议适配全部由内置实现负责。插件本身只做三件事：挂载 DSH 内置但默认未启用的授权服务、提供「登录/注销」设置页、预置 `GitHub Copilot` 路由。

## 特性

- 🔐 **设备码登录/注销**：网页 + user code，免 API Token；SSO 组织授权友好
- 🧩 **预置提供方路由**：安装即出现在 Models 页，无需手动配置
- 📦 **模型目录自动同步**：登录成功或插件启动时，自动把账号全部可用模型写入模型目录，开箱即用
- 🌐 **中/英双语界面**：跟随 DSH 语言设置自动切换
- 🔑 **凭据安全托管**：存入 DSH 内置凭据库（文件强制 0600 权限），Copilot 临时 token 到期自动刷新
- 🧪 **测试与 CI**：13 条单元测试；GitHub Actions 构建测试 + tag 触发自动发布（provenance）

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
5. 回到设置页看到「已登录」即成功；模型目录此时已自动同步

> 设备码有时效（约 15 分钟），请拿到代码后尽快完成授权。若超时，页面会显示失败原因，重新点「登录」即可。

## 使用

- Models 页选择 `GitHub Copilot` 路由，模型目录已在登录/启动时自动同步账号全部可用模型，无需手动「添加模型」
- **配额说明**：base 模型（GPT-4o/4.1 一类）不耗 premium requests；premium 模型（Claude、Gemini、o 系列等）每次调用消耗月度配额。日常建议 base 档，premium 模型按需手动选

## 注销与卸载

- 注销：设置页「注销」按钮（清除本机凭据记录）
- 卸载：`dsh plugin --profile web remove @inventec/dsh-copilot-auth` 后重启 dsh web

## 工作原理

- 通过 `cordis.patch.yml` 三段生效：
  1. 挂载 `@deepseek-ai/dsh-authorization` 服务（DSH 内置 bundle 未挂载，不挂则内置登录流不存在）
  2. 注册本插件（host 侧在 webserver 上开 4 条本地路由：`/copilot-auth/start|state|status|logout`，跨站 Origin 拒绝）
  3. 以 settings base 层预置 `github-copilot` 路由（用户 `settings.yaml` 可逐字段覆盖）
- 登录走 GitHub 设备码流；凭据存 `~/.dsh/.credentials.yaml`（强制 600 权限）的 `llm-pi-ai/github-copilot` 记录，Copilot 临时 token 到期自动刷新
- **模型目录自动同步**：登录成功或插件启动时，取「账号可用模型 ∩ pi-ai 内置目录」写入该路由的模型目录，同步失败经 `/copilot-auth/status` 的 `syncError` 字段暴露

## 开发

```bash
npm install
npm test        # node:test：patch 结构 + host 行为共 13 条
npm run build   # esbuild 打包 client 到 lib/client.js（__ModuleLoader__ 信封）
npm pack --dry-run
```

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml` | 三段 patch（authorization 挂载 / 本插件 entry / 预置路由） |
| `src/host.mjs` · `src/shared.mjs` | host 半区：登录状态机、4 条本地路由、模型目录同步 |
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
- 每次登录成功或插件启动，会用账号最新发现的可用模型**全量覆盖** GitHub Copilot 路由的模型目录——对目录的手工定制（如模型显示名）会在下次同步时被重置为裸模型 id
- 模型目录只写入 pi-ai 内置目录已描述的模型：目录快照外的新模型暂不写入（catalog 路由的校验要求模型协议可解析），pi-ai 升级目录后会随同步自动出现

## License

MIT
