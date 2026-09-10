# dsh-copilot-auth 实施计划

npm 包 `@inventec/dsh-copilot-auth` v1.0.0：为 DSH（DeepSeek Harness）内置的 GitHub Copilot LLM provider 补上 Web 端设备码（device flow）登录/注销入口，并预置一条开箱即用的 GitHub Copilot 提供方路由。

## 目标

- 交付可发布到 npm 的 DSH 插件包 `@inventec/dsh-copilot-auth`（GitHub 个人仓库 `dsh-copilot-auth`，MIT）
- 同事安装后：设置页出现「GitHub Copilot 登录」页 → 点登录 → 显示 user code + `github.com/login/device` 链接 → 浏览器授权（含 SSO 对组织 Authorize）→ Models 页直接使用 GitHub Copilot 路由
- 认证协议、token 轮换、模型发现**全部复用 DSH 内置实现，本插件零行 GitHub 协议代码**
- v1 不做 CLI 命令（已决策降级）；不干预模型选择；不打公司品牌

## 架构快照

- 目标 DSH 版本 `0.1.2-rc.1`（实测环境安装树：`/bmc/iasi/.nvm/versions/node/v22.21.1/lib/node_modules/@deepseek-ai/dsh/`，下称 `$DSH`；其 `node_modules/@deepseek-ai/` 下称 `$PKG`；pi-ai 位于 `$DSH/node_modules/@earendil-works/pi-ai`（0.84.4，与 `@deepseek-ai` 平级，**不在 `$PKG` 下**））
- 插件 = 一个 npm 包，两个半区：
  - **host 半区**（`src/host.mjs`，经 `exports."."` 加载）：cordis 插件，`inject = ["webServer","authorization","credentials"]`，在 webserver 上注册 4 条自有 HTTP 路由（`{kind:"exact", path:"/copilot-auth/start|state|status|logout", handler}`，handler 为 Node 原生 `(req,res)` 签名），内部调用 `ctx.authorization.begin()` 调起内置的 github-copilot OAuth flow（credential key 固定为 `"llm-pi-ai/github-copilot"`），interaction 自动把「企业域名」提问答空串（公司是普通 github.com 组织账号）
  - **client 半区**（`src/client.jsx` 构建为 `lib/client.js`）：浏览器侧 cordis 插件，通过 `settings.section` 插槽注册独立设置页（order 11，紧挨 Models 的 order 10），fetch 自有路由轮询渲染设备码
- `cordis.patch.yml` 三件事：
  1. `insert` 挂载 `@deepseek-ai/dsh-authorization`——**0.1.2-rc.1 的全部 6 个内置 bundle 都没挂这个服务**（base/web-app/headless/acp-app/sdk-app/sdk-minimal，逐一核验），不插入则内置登录流注册代码（被动 `ctx.inject`）永不生效
  2. `insert` 本插件 host entry
  3. 对 `id: llm-pi-ai` 行 patch `config.providers."github-copilot".displayName`——entry config 作为 settings **base 层**生效，用户 `settings.yaml` 的 `llm-pi-ai:` 节逐字段递归覆盖其上，不写 `apiKeyEnv` 即走 OAuth 凭据路径
- client bundle 格式：`window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })` 的 CJS 工厂包裹，`react` 为 external——react 由浏览器 shell 播种的模块基线提供（`dsh.client.inject` 是对宿主 web roster 的模块图依赖边声明，并非 react 的来源）；信封结构与 `$PKG/dsh-client-ui-settings-models/lib/client.js` 首（L1-8）尾（`return module.exports; } });` 结构段）对齐（参考文件尾部另有其构建自带的 sourcemap 尾注，不要求复刻）

## 全局约束

以下规则逐字继承自设计共识，执行中不得偏离：

- **命名**：npm 包名 `@inventec/dsh-copilot-auth`；GitHub 仓库名 `dsh-copilot-auth`（个人仓库）；host 插件 fiber name `copilot-auth`（小写连字符）；client 插件 fiber name `copilot-auth-ui`；patch entry id：`copilot-authorization`（挂 authorization 服务）、`copilot-auth`（本插件）；credential key 字面量 `llm-pi-ai/github-copilot`
- **文案**：Models 页路由 displayName 固定 `GitHub Copilot`（通用，不打公司品牌）；设置页标题固定「GitHub Copilot 登录」；UI 文案中文
- **功能边界**：不实现任何 GitHub OAuth/HTTP 协议代码；不配置 `modelOverrides`/`models`/`apiKeyEnv`；v1 无 CLI 命令；无取消登录按钮（设备码自然过期即失败终态）
- **依赖**：`peerDependencies` 仅 `@deepseek-ai/cordis@^4.0.2`（跟随官方 0.1.2-rc.1 的 settings-models 钉法；原 `dsh-*@^0.1.1-rc.2` 钉法废止——semver 预发布门控使该范围无法匹配 0.1.2-rc.1，官方同版也已弃用 dsh-* peer 钉，兼容边界改由 README「已知边界」陈述）；运行时依赖为零（host 半区模块级只 import Node 内建与 `./shared.mjs`，服务全部经 `ctx` 注入）；devDependencies 仅 `esbuild`、`yaml`、`react@^18.2.0`
- **发布**：MIT，版权行 = `git config user.name` 的值 + 年份 2026（若为空停下询问用户）；npm 发布到 `@inventec` scope public；采用 npm Trusted Publishing（GitHub Actions OIDC），workflow 使用 GitHub-hosted runner、`id-token: write`、Node >=22.14/npm >=11.5.1，npm 自动生成 provenance；Trusted Publisher 固定为 owner `iasiv5`、repository `dsh-copilot-auth`、workflow `release.yml`、environment 留空、允许 `npm publish`；不使用 `NPM_TOKEN`/`NODE_AUTH_TOKEN`。首次 package 尚不存在时，先完成一次性 bootstrap，再配置 Trusted Publisher；bootstrap 不通过长期 GitHub secret 实现
- **README 必含**：安装（含 pnpm 前提与 peer 解析排障）、登录步骤（含 SSO 用户须在授权页对组织点 Authorize 的提示）、配额说明（premium requests，base 模型不耗配额）、风险披露段（复用社区通用通道、非 GitHub 官方支持 API、AUP 禁批量自动化、公司账号正常强度使用）、已知边界、实测版本 `0.1.2-rc.1`
- **验证环境**：本机 bash + Node v22.21.1；`DSH_HOME` = `/bmc/iasi/.dsh`；集成验证用独立测试 profile `copilot-test`，**不得在未经用户同意时改动正在运行的 `web` profile**

### 共识修订记录（2026-09-03，评审 Agent 依用户指示直接修订本计划）

- DSH 已就地升级 `0.1.1-rc.2 → 0.1.2-rc.1`（用户确认）。评审 Agent 对 0.1.2-rc.1 安装树逐环复核后确认：原共识的全部机制决策维持不变（附录 A 已按新版刷新行号）；以下**版本事实**按新版修订，视为共识的更新版本：
  - 目标/实测版本：`0.1.2-rc.1`
  - peer 钉法：仅 `@deepseek-ai/cordis@^4.0.2`（原 dsh-* `^0.1.1-rc.2` 被 semver 预发布门控判不匹配 0.1.2-rc.1，官方同版已弃用 dsh-* peer 钉）
  - `dsh.client.inject`：采用官方 0.1.2-rc.1 的 3 项清单（`$PKG/dsh-client-ui-settings-models/package.json` L30-34）
- 修订轨迹：执行 Agent 此前已吸收评审报告 v1 的修订（路由 `kind:"exact"`、logout 幂等契约、describeRecord、repository 字段、README 排障、附录 B 两条新边界等——均保留）；评审 Agent 本次在其上补齐 v2（0.1.2-rc.1）版本事实层并修正行号漂移。其余共识条目（命名/文案/功能边界/MIT/发布流程/HUMAN 协作点）逐字不变。
- 执行 Agent 如对修订有异议，可按「执行纪律」批判性复查并给出安装树证据后修改，但须在计划内标注改动来源（如「执行 Agent 注：」）。

## 输入工件

- 设计共识：本会话 `/grilling` 全程结论（Q0–Q17）与方案定稿（对话内，无独立 ADR 文件）
- 调研报告：`/bmc/iasi/workspace/copilot-deviceflow-research.md`、`/bmc/iasi/workspace/copilot-sdk-followup.md`、DSH 插件与 provider 机制调研（会话内报告，证据锚点收录于本计划附录 A）
- 评审报告（本计划修订的直接依据）：`docs/reviews/2026-09-03-dsh-copilot-auth-plan-review.md`（v1，基于 0.1.1-rc.2）、`docs/reviews/2026-09-03-dsh-copilot-auth-plan-review-v2-dsh-0.1.2-rc.1.md`（v2 增补：0.1.2-rc.1 复核 + 锚点对照表 §4 + 修订清单 §7）

## 文件结构与职责

新仓库根：`/bmc/iasi/workspace/dsh-copilot-auth/`

- Create: `package.json` — 包声明；`exports`：`.` → `./src/host.mjs`、`./client` → `./lib/client.js`、`./package.json`；`dsh.bundle.patch` + `dsh.client` 声明；peer/devDeps；scripts；`files`
- Create: `cordis.patch.yml` — 三段 patch（挂 authorization 服务 / 本插件 entry / 预置路由）
- Create: `src/shared.mjs` — 两半区共享的 HTTP API 契约：`CREDENTIAL_KEY`、默认 `ROUTE_PREFIX`、四条路由路径、`AuthState` 形状（JSDoc）
- Create: `src/host.mjs` — host 插件：状态机 + 4 条路由 + interaction 适配 + Origin 校验
- Create: `src/client.jsx` — client 插件源码：插槽注册 + React 设置页组件
- Create: `scripts/build-client.mjs` — esbuild 打包并把 CJS 产物包进 `__ModuleLoader__` 工厂信封
- Create: `test/patch.test.mjs` — cordis.patch.yml 结构断言（node:test + yaml）
- Create: `test/host.test.mjs` — host 插件单元测试（node:test + fake ctx，零外部依赖）
- Create: `.github/workflows/ci.yml` — push/PR 构建+测试
- Create: `.github/workflows/release.yml` — tag `v*`/手动触发，使用 npm Trusted Publishing OIDC 发布（npm 自动生成 provenance）
- Create: `README.md`、`LICENSE`、`.gitignore`、`package-lock.json`（npm install 生成）
- Build 产物 `lib/client.js` **提交进仓库**（git 安装路径无需构建脚本，绕开 profile pnpm 的 allowBuilds 门槛）；`lib/` 不进 `.gitignore`
- 边界保持稳定：不修改 `$DSH` 安装树内任何文件；不修改用户 `~/.dsh` 下除测试 profile 外的任何内容

## 任务清单

### Task 0: 环境与前提核对（只读）

- 目标：确认执行环境满足所有任务的命令前提
- Files: 无（只读检查）
- 验证范围：下列命令全部返回预期值；任何一项不符即停下说明，不猜测替代
- 接口契约：Consumes 无；Produces 环境事实（后续任务的命令以此为准）

Step 1: 逐项检查

- Run: `node --version && dsh --version && pnpm --version && git config user.name && echo $DSH_HOME`
- Expected: `v22.21.1`；`0.1.2-rc.1`（若 dsh 不在 PATH，改用 `/bmc/iasi/.nvm/versions/node/v22.21.1/bin/dsh` 并在后续任务沿用该绝对路径）；pnpm 有版本号（缺失则 `npm i -g pnpm` 后复测）；`git config user.name` 非空（此值即 LICENSE 版权署名，向用户口头确认一次）；`/bmc/iasi/.dsh`
- HUMAN：向用户确认其 GitHub 用户名（Task 1 的 `repository` 字段依赖，记为 `GH_USER`）
- 执行 Agent 注（Task 0，2026-09-03）：① `--version` 合法——`$DSH/lib/bin.js` L77 `.version(version, "-V, --version", …)` 双写法等价，无需改 `-V`；② `GH_USER` 同时复用于 Task 10 的 `git remote add origin` 与 `npm view` 断言，一次询问两处受益，现有 HUMAN 流程顺畅、无需改造
- Run: `ls $PKG/dsh-authorization/lib/index.js $PKG/dsh-host-webserver/lib/index.js $DSH/node_modules/@earendil-works/pi-ai/package.json && grep -n "webServer" $PKG/dsh-host-webserver/lib/index.js | head -3`
- Expected: 三个文件存在（pi-ai 是登录协议的实际承载，位于 `$DSH/node_modules/@earendil-works/`，**不在 `$PKG` 下**——路径写错会误判"升级不完整"）；grep 命中服务名 `webServer`
- Run: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8815/`
- Expected: 任一 HTTP 状态码应答即通过（执行 Agent 注 2026-09-04 实测为 **401**：该 web 实例启用全局鉴权门——`/`、`/api`、`/api/session` 均 401、`/plugins/` 404；探活目的仅证明端口在听、HTTP 服务正常，原预期 `200` 勘正。注意：若该实例启动于 DSH 升级之前，进程内仍是旧代码——此 curl 不证明运行版本，Task 7 的重启步骤为升级后必须）

### Task 1: 仓库初始化与包声明

- 目标：建立 git 仓库与完整 `package.json`，npm 侧元数据全部就位
- Files: Create `package.json`、`.gitignore`、`LICENSE`
- 验证范围：`npm pkg get` 输出与下述逐字段一致
- 接口契约：Consumes Task 0 的 git 署名；Produces `package.json`（Task 5 的 scripts、Task 6 的安装 spec、Task 9/10 的发布配置都依赖此文件的 `name`/`files`/`scripts` 字段）

Step 1: 当前状态检查

- Run: `ls /bmc/iasi/workspace/dsh-copilot-auth 2>/dev/null; echo "exit=$?"`
- Expected: 目录不存在（`exit=2`——本机 GNU ls 对不存在路径返回 **2** 非 1，评审 Agent 注 2026-09-03 实测改写；Task 4/8 的同款检查同理）；若已存在，停下询问用户

Step 2: 确认失败（同上，目录不存在即缺失状态成立）

Step 3: 最小实现

- Run: `mkdir -p /bmc/iasi/workspace/dsh-copilot-auth && cd /bmc/iasi/workspace/dsh-copilot-auth && git init -b main`
- Change: 写入 `package.json`，内容如下（`dsh.client.inject` 三项逐字复制自 `$PKG/dsh-client-ui-settings-models/package.json` L30-34（0.1.2-rc.1 现行清单，官方已从 4 项移除 `@deepseek-ai/dsh-client-runtime`）；说明：本 client 只 `require("react")`，react 属浏览器 shell 播种基线，inject 是对宿主 web roster 的模块图依赖边声明——照抄官方清单是保守选择，要求标准 web profile；`repository.url` 中的 `GH_USER` 替换为 Task 0 问到的 GitHub 用户名，执行时写入实际值、不留占位符——npm 顶层元数据无 repository 会让 provenance 与仓库关联失效）：

```json
{
  "name": "@inventec/dsh-copilot-auth",
  "version": "1.0.0",
  "description": "Device-code sign-in UI and preconfigured route for the built-in GitHub Copilot provider of DeepSeek Harness (DSH)",
  "type": "module",
  "license": "MIT",
  "author": "<git config user.name 的值>",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/GH_USER/dsh-copilot-auth.git"
  },
  "main": "./src/host.mjs",
  "exports": {
    ".": "./src/host.mjs",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "src/host.mjs",
    "src/shared.mjs",
    "lib/client.js",
    "cordis.patch.yml",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "node scripts/build-client.mjs",
    "test": "node --test",
    "prepack": "npm run build"
  },
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "react": "^18.2.0",
    "yaml": "^2.5.0"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-remotes"
      ]
    }
  }
}
```

- 执行 Agent 注（Task 1，2026-09-03）：① 已补 `author` 字段——v2 §7 Task 1 行要求 repository/author 两项，此前仅落了 repository（author 值 = Task 0 确认的 git 署名，写入实际值不留尖括号）；② peer 方案(a) 与 `dsh.client.inject` 3 项清单已由执行 Agent 在 0.1.2-rc.1 安装树复核无误（`$PKG/dsh-client-ui-settings-models/package.json` L30-34、L39-41——peer 仅 `@deepseek-ai/cordis@^4.0.2`），认可采纳；③（2026-09-04 实测勘正）`test` 脚本原写法 `node --test test/` 在本机 Node 22.21.1 会把目录参数当模块路径加载（`MODULE_NOT_FOUND`，TAP 计 1 fail）——已改为 `node --test`（默认发现 `*.test.mjs`，实测 3/3 绿），计划内嵌 JSON 同步勘正
- 执行 Agent 注（Task 3，2026-09-04）：用户新增 turnkey 需求——「登录成功后自动把全部可用模型配置进模型目录」。实现：host 在登录成功与挂载（已登录态）两条路径调用 `ctx.settings.mutate("llm-pi-ai", [{op:"set", path:["providers","github-copilot","models"], value: ids.map(id=>({id}))}])`，数据源为凭据 payload 的 `availableModelIds`（`ctx.credentials.readRecord`）；inject 增 `"settings"`；新增 2 条测试（authorized 写入 / 挂载同步），12/12 绿，commit `a50faf9`。已知取舍：全量覆盖会重置手工模型条目的 displayName（README 已知边界同步）。背景：原生 picker 模型 = pi-ai 目录快照 ∩ 可用列表，快照落后于账号新模型时交集残缺，故需显式写入
- Change: 写入 `.gitignore`（内容：`node_modules/`、`*.log`、`.DS_Store`；**不含 `lib/`**）
- Change: 写入 `LICENSE`（MIT 模板，版权行 `Copyright (c) 2026 <git config user.name 的值>`）
- Run: `npm install`（生成 `package-lock.json` 并安装 devDeps）

Step 4: 运行并确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm pkg get name version exports repository peerDependencies dsh && ls LICENSE package-lock.json`
- Expected: name `"@inventec/dsh-copilot-auth"`、version `"1.0.0"`、exports 三键、repository 指向 `github.com/<GH_USER>/dsh-copilot-auth`、peer 仅 `@deepseek-ai/cordis@^4.0.2`、dsh 两段（bundle.patch 与 client.inject 三项）逐一正确；LICENSE 与 lockfile 存在

Step 5: checkpoint commit

- Run: `git add -A && git commit -m "chore: scaffold @inventec/dsh-copilot-auth package"`
- Expected: commit 成功

### Task 2: cordis.patch.yml（authorization 挂载 + 本插件 entry + 预置路由）

- 目标：写出三段 patch，并用结构测试锁定语义
- Files: Create `cordis.patch.yml`、`test/patch.test.mjs`
- 验证范围：`npm test` 中 patch 测试通过
- 接口契约：Consumes Task 1 的 `package.json`（entry `name` 必须与其 `name` 一致）；Produces `cordis.patch.yml`（Task 6 的 dump-config 断言依赖其中三个 id/displayName）

Step 1: 写失败测试

- Change: `test/patch.test.mjs`：

```js
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const doc = YAML.parse(readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8"));

test("insert 挂载 dsh-authorization 服务（内置 bundle 未挂载的前置）", () => {
  const insert = doc.find((row) => Array.isArray(row.insert))?.insert ?? [];
  const auth = insert.find((e) => e.id === "copilot-authorization");
  assert.equal(auth?.name, "@deepseek-ai/dsh-authorization");
});

test("insert 本插件 host entry，name 与 package.json 一致", () => {
  const insert = doc.find((row) => Array.isArray(row.insert))?.insert ?? [];
  const self = insert.find((e) => e.id === "copilot-auth");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(self?.name, pkg.name);
});

test("patch llm-pi-ai 行预置 github-copilot 路由（base 层，无 apiKeyEnv）", () => {
  const row = doc.find((e) => e.id === "llm-pi-ai" && !Array.isArray(e.insert));
  assert.equal(row?.name, "@deepseek-ai/dsh-llm-pi-ai"); // 评审 Agent 注 2026-09-03：补 v1-B5 的测试子项——yaml 的 name 防御此前未被测试锁定
  assert.equal(row?.config?.providers?.["github-copilot"]?.displayName, "GitHub Copilot");
  assert.equal(row?.config?.providers?.["github-copilot"]?.apiKeyEnv, undefined);
});
```

Step 2: 确认失败

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm test`
- Expected: patch 测试失败（`cordis.patch.yml` 不存在，模块加载即报错）

Step 3: 最小实现

- Change: 写入 `cordis.patch.yml`：

```yaml
# 1) 前置：0.1.2-rc.1 的全部 6 个内置 bundle 均未挂载 authorization 服务；
#    dsh-llm-pi-ai 的登录流注册是被动 ctx.inject（lib/index.js L2501），不挂此行则 flow 不存在。
- insert:
    - id: copilot-authorization
      name: '@deepseek-ai/dsh-authorization'
    # 2) 本插件 host 半区（web 树有 webServer 服务才会激活）
    #    路由前缀固定 /copilot-auth、不做配置项：client 侧 fetch 硬编码同一路径，
    #    配置一旦漂移 client 即 404（见附录 B）
    - id: copilot-auth
      name: '@inventec/dsh-copilot-auth'
# 3) 预置 GitHub Copilot 路由：entry config 作为 settings base 层，
#    用户 settings.yaml 的 llm-pi-ai: 节逐字段递归覆盖其上。
#    不写 apiKeyEnv → 认证走 OAuth 凭据记录（llm-pi-ai/github-copilot）。
#    带 name 做 mismatch 防御：未来 base 若改名，patch 警告而非错挂他行。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      github-copilot:
        displayName: GitHub Copilot
```

Step 4: 确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm test`
- Expected: patch 三条测试全绿

Step 5: checkpoint commit

- Run: `git add -A && git commit -m "feat: cordis patch mounts authorization service and presets github-copilot route"`
- Expected: commit 成功

### Task 3: shared 契约与 host 插件（TDD）

- 目标：实现 host 半区：状态机、4 条路由、interaction 适配、Origin 校验
- Files: Create `src/shared.mjs`、`src/host.mjs`、`test/host.test.mjs`
- 验证范围：`npm test` 全绿（patch + host 测试）
- 接口契约：
  - Consumes 无（模块级零 dsh 依赖，服务经 ctx 注入）
  - Produces `src/shared.mjs` 导出：`CREDENTIAL_KEY`（`"llm-pi-ai/github-copilot"`）、`ROUTE_PREFIX`（`"/copilot-auth"`）、`routes()` 返回固定四条路径 `{start,state,status,logout}`（前缀不配置化）、`emptyState()` 返回 `{status:"idle",notices:[],error:undefined}`；`src/host.mjs` 导出 cordis 插件三件套（`name="copilot-auth"`、`inject=["webServer","authorization","credentials"]`、`apply(ctx, config)`）；HTTP API 契约（Task 4 的 client 逐字消费）：
    - 四条路由均以 `{kind:"exact", path, handler}` 调用 `ctx.webServer.register`——真实 API 按 `kind` 分 exact/prefix 两张表，缺 `kind` 会落入 prefix 表造成子路径误命中（`$PKG/dsh-host-webserver/lib/index.js` L176-183，0.1.2-rc.1 实测）
    - `POST {prefix}/start` → `202 {"ok":true}`；已在进行中 → `409 {"ok":false,"error":"already running"}`；Origin 不符 → `403`
    - `GET {prefix}/state` → `200 {"status":"idle|running|authorized|failed","notices":[{"message","url?","code?"}],"error?":string}`
    - `GET {prefix}/status` → `200 {"configured":boolean}`（`ctx.credentials.describeRecord(CREDENTIAL_KEY)` 的 `configured` 字段——describeRecord 只回传 presence/discriminant 不含 payload，避免把带 token 的 GrantRecord 拉进轮询内存）
    - `POST {prefix}/logout` → `200 {"ok":true}`（幂等契约：`deleteRecord` 对不存在记录本就是 no-op 且正常 resolve，故不区分有无记录，真实删除与否由随后的 `/status` 反映）

Step 1: 写失败测试

- Change: `test/host.test.mjs` 核心 fixture 与断言（要点，完整可运行）：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/host.mjs";

function makeCtx() {
  const ctx = {
    routes: [],
    webServer: { register: (r) => ctx.routes.push(r) },
    authorization: { beginCalls: [], begin: async (req) => {
      ctx.authorization.beginCalls.push(req);
      for (const n of ctx.script.notices) req.interaction.notify(n);
      if (ctx.script.prompt) await req.interaction.prompt(ctx.script.prompt);
      if (ctx.script.reject) throw new Error(ctx.script.reject);
      return { status: "authorized" };
    } },
    credentials: { describeRecord: async (k) => ({ configured: ctx.script.record?.[k] !== undefined }),
                   deleteRecordCalls: [], deleteRecord: async (k) => { ctx.credentials.deleteRecordCalls.push(k); ctx.script.record = {}; return true; } },
    script: { notices: [], record: {} },
  };
  plugin.apply(ctx, {});
  return ctx;
}
const handler = (ctx, suffix) => ctx.routes.find((r) => r.path.endsWith(suffix)).handler;
const call = async (h, req = {}) => { const res = { code: 0, body: null,
  writeHead(c) { this.code = c; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await h({ headers: { host: "127.0.0.1:8815", ...req.headers }, method: req.method ?? "GET" }, res);
  return res; };

test("插件身份与路由注册", () => {
  const ctx = makeCtx();
  assert.equal(plugin.name, "copilot-auth");
  assert.deepEqual(plugin.inject, ["webServer", "authorization", "credentials"]);
  assert.ok(ctx.routes.every((r) => r.kind === "exact"), "四条路由必须都是 exact");
  assert.deepEqual(ctx.routes.map((r) => r.path).sort(),
    ["/copilot-auth/logout", "/copilot-auth/start", "/copilot-auth/state", "/copilot-auth/status"]);
});

test("start 调起 begin：key/method 正确，企业域名提问自动答空串", async () => {
  const ctx = makeCtx();
  ctx.script.prompt = { kind: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" };
  const res = await call(handler(ctx, "/start"), { method: "POST", headers: { origin: "http://127.0.0.1:8815" } });
  assert.equal(res.code, 202);
  const [req] = ctx.authorization.beginCalls;
  assert.equal(req.key, "llm-pi-ai/github-copilot");
  assert.equal(req.method, "oauth");
});

test("unexpected prompt 使 attempt 失败并进入 failed 态", async () => {
  const ctx = makeCtx();
  ctx.script.prompt = { kind: "secret", message: "Enter API key" };
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const res = await call(handler(ctx, "/state"));
  assert.equal(res.body.status, "failed");
  assert.ok(res.body.error.includes("unexpected prompt"));
});

test("begin 以 cancelled resolve 时映射为 failed（AuthorizationOutcome 双态）", async () => {
  const ctx = makeCtx();
  ctx.authorization.begin = async () => ({ status: "cancelled" });
  await call(handler(ctx, "/start"), { method: "POST" });
  await new Promise((r) => setTimeout(r, 10));
  const res = await call(handler(ctx, "/state"));
  assert.equal(res.body.status, "failed");
  assert.match(res.body.error, /取消/);
});

test("设备码 notice 经 state 可见；running 期间二次 start 返回 409", async () => {
  const ctx = makeCtx();
  ctx.authorization.begin = async (req) => { for (const n of ctx.script.notices) req.interaction.notify(n); await new Promise(() => {}); }; // 送达 notices 后永不完成（评审 Agent 注 2026-09-03：原 override 丢弃 interaction，notice 永不进 attempt，断言必挂——原样实测 7 条仅 6 绿）
  ctx.script.notices = [{ message: "Enter this code", url: "https://github.com/login/device", code: "ABCD-1234" }];
  await call(handler(ctx, "/start"), { method: "POST" });
  const state = await call(handler(ctx, "/state"));
  assert.equal(state.body.status, "running");
  assert.deepEqual(state.body.notices.at(-1), { message: "Enter this code", url: "https://github.com/login/device", code: "ABCD-1234" });
  const again = await call(handler(ctx, "/start"), { method: "POST" });
  assert.equal(again.code, 409);
});

test("status 与 logout 操作固定 credential key", async () => {
  const ctx = makeCtx();
  ctx.script.record = { "llm-pi-ai/github-copilot": { kind: "grant" } };
  assert.equal((await call(handler(ctx, "/status"))).body.configured, true);
  const out = await call(handler(ctx, "/logout"), { method: "POST" });
  assert.equal(out.body.ok, true);
  assert.deepEqual(ctx.credentials.deleteRecordCalls, ["llm-pi-ai/github-copilot"]);
  const again = await call(handler(ctx, "/logout"), { method: "POST" }); // 评审 Agent 注 2026-09-03：补 v1-A2 的「无记录时同样 ok:true」断言（首次 logout 已清空 record，此即无记录形态）
  assert.equal(again.body.ok, true);
});

test("跨站 Origin 拒绝 403，同源/无 Origin 放行", async () => {
  const ctx = makeCtx();
  assert.equal((await call(handler(ctx, "/start"), { method: "POST", headers: { origin: "http://evil.example" } })).code, 403);
  assert.equal((await call(handler(ctx, "/state"))).code, 200);
});
```

Step 2: 确认失败

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm test`
- Expected: host 测试加载 `../src/host.mjs` 失败（文件不存在）

Step 3: 最小实现

- Change: `src/shared.mjs`：

```js
export const CREDENTIAL_KEY = "llm-pi-ai/github-copilot";
export const ROUTE_PREFIX = "/copilot-auth";
export const routes = () => ({
  start: `${ROUTE_PREFIX}/start`, state: `${ROUTE_PREFIX}/state`,
  status: `${ROUTE_PREFIX}/status`, logout: `${ROUTE_PREFIX}/logout`,
});
export const emptyState = () => ({ status: "idle", notices: [], error: undefined });
```

- Change: `src/host.mjs` 实现要点（每条都要落实）：
  - `import { CREDENTIAL_KEY, emptyState, routes } from "./shared.mjs";`
  - 以 `export default` 导出插件三件套对象（评审 Agent 注 2026-09-03：测试为默认导入 `import plugin from "../src/host.mjs"`，原要点未写明导出形式，按 default 落实）
  - `apply(ctx, config)`（config 被忽略——路由前缀与 client 硬编码一致，不配置化）；`const r = routes()`；模块级可变 `let attempt = emptyState()`
  - `sameOrigin(req)`：`req.headers.origin` 缺失 → true；否则 `new URL(origin).host === req.headers.host`，URL 解析失败 → false；四条路由 handler 入口先校验，不过 `403` + `{"ok":false,"error":"forbidden origin"}`
  - `/start`：`attempt.status === "running"` → 409；否则重置 `attempt = emptyState(); attempt.status = "running"`，`ctx.authorization.begin({ key: CREDENTIAL_KEY, method: "oauth", interaction, signal })` —— `interaction.notify(n)` 把 notice push 进 `attempt.notices`；`interaction.prompt(p)` 在 `p.message.includes("Enterprise")` 时 resolve `""`，否则 `reject(new Error("unexpected prompt: " + p.message))`；begin 的 promise resolve → 按 `AuthorizationOutcome.status`（`'authorized' | 'cancelled'`，`$PKG/dsh-authorization/lib/types/types.d.ts` L68-71）映射：`'authorized'` → `attempt.status = "authorized"`；`'cancelled'` → `attempt.status = "failed"`、`attempt.error = "登录已取消"`；reject → `attempt.status = "failed"; attempt.error = String(err?.message ?? err)`；立即回 202 = **响应先行、begin 以后台任务执行，handler 返回路径不得 await begin**（否则请求 promise 悬挂、测试的 `call()` 即卡死；评审 Agent 注 2026-09-03 补）（执行 Agent 注：原表述把任何 resolve 一律当 authorized，会把用户中途取消误标为成功——cancelled 是合法 resolve 值而非异常）
  - `/state`：回当前 `attempt`
  - `/status`：`try { const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY); configured: info?.configured === true } catch { configured: false }`（不使用 `readRecord`——那会把含 token 的 GrantRecord 拉进每次轮询的内存）
  - `/logout`：`await ctx.credentials.deleteRecord(CREDENTIAL_KEY)` 后回 `{"ok":true}`（幂等契约；`deleteRecord` 对缺失记录是 no-op 且正常 resolve，不区分有无记录）
  - 所有响应 `writeHead(code, {"content-type":"application/json"})` + `end(JSON.stringify(...))`；GET/POST 之外的方法 `405`

Step 4: 确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm test`
- Expected: patch + host 全部测试通过

Step 5: checkpoint commit

- Run: `git add -A && git commit -m "feat: host half with device-code login routes over ctx.authorization"`
- Expected: commit 成功

### Task 4: client 设置页组件（源码）

- 目标：写出 client 半区源码：插槽注册 + 登录页组件
- Files: Create `src/client.jsx`
- 验证范围：本任务只产出源码（.jsx 无法直接被 node 执行），通过信号 = 文件落盘且包含下述强制要点；可运行验证在 Task 5 构建、Task 7 真机完成
- 接口契约：
  - Consumes Task 3 的 HTTP API 契约与路由路径（fetch 相对路径 `"/copilot-auth/start"` 等，同源）
  - Produces `lib/client.js`（Task 5 构建）；插槽注册形态（对照 `$PKG/dsh-client-ui-settings-models/lib/client.js` L2907-2912，0.1.2-rc.1 实测；参考注册另带可选 `children` keyed 业务插槽声明，本插件不需要、省略合法——执行 Agent 注：合法性已从契约层证实，`$PKG/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` L67-71 的 `settings.section` 座位契约仅 `kind:'list'` + owner `SettingsSectionOwnerProps`（L148-151，仅 `close: () => void`），**契约无 children 字段**，参考注册的 children 属其自身业务的 keyed 子插槽声明；Task 7 的 console 观察降级为冗余防线保留）：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "copilot", order: 11, label: () => "GitHub Copilot 登录", inject: () => ({}) }, CopilotSection))`

Step 1: 当前状态检查

- Run: `ls /bmc/iasi/workspace/dsh-copilot-auth/src/client.jsx 2>/dev/null; echo "exit=$?"`
- Expected: `exit=2`（缺失成立；本机 GNU ls 退出码，见 Task 1 评审 Agent 注）

Step 2: 确认失败（同上）

Step 3: 最小实现

- Change: `src/client.jsx` 导出 cordis 三件套 + 组件，强制要点：
  - `export const name = "copilot-auth-ui"; export const inject = ["slots"];`
  - `apply(ctx)`：按上述插槽形态注册；组件 `CopilotSection`
  - 组件状态机：`page` = `loading` → mount 时 `GET /copilot-auth/status` → `configured` ? `authorized` : `idle`；`login()` → `POST /copilot-auth/start`（409 忽略，进入轮询）→ `setInterval(1000ms)` 轮询 `GET /copilot-auth/state`，`status !== "running"` 时停表；`logout()` → `POST /copilot-auth/logout` → 回 `idle`
  - 渲染：运行中取 `notices` 最后一个含 `code` 的 notice，大字号展示 `code`（附复制按钮 `navigator.clipboard.writeText`）与 `<a href={url} target="_blank" rel="noreferrer">` 链接；状态徽标文案：未登录 / 进行中… / 已登录 / 失败（失败时附 `error`）；按钮：登录（idle/failed 态）、注销（authorized 态）
  - 文案全部中文；样式用内联 style 对象（`font-family` 继承，不依赖宿主 CSS 类）
  - 模块级只 `import { useEffect, useRef, useState } from "react";`（构建时 external）

Step 4: 运行并确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && grep -c "settings.section" src/client.jsx && grep -c "/copilot-auth/start" src/client.jsx && grep -n "copilot-auth-ui" src/client.jsx`
- Expected: 三个 grep 都命中（源码包含插槽名、路由调用、fiber name）

Step 5: checkpoint commit

- Run: `git add -A && git commit -m "feat: client settings section for copilot device-code sign-in"`
- Expected: commit 成功

### Task 5: 构建 pipeline 与打包验证

- 目标：esbuild 产出 `lib/client.js`（`__ModuleLoader__` 信封），npm pack 文件清单正确
- Files: Create `scripts/build-client.mjs`；Modify 无
- 验证范围：`npm run build` 产物信封结构与参考实现对齐；`npm pack --dry-run` 清单恰为 `files` 六项 + `package.json`
- 接口契约：Consumes Task 1 `package.json`（`prepack` 脚本、`files`）、Task 4 `src/client.jsx`；Produces `lib/client.js`（Task 6/7 加载的 client 半区）

Step 1: 当前状态检查

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm run build 2>&1; echo "exit=$?"`
- Expected: 失败（`scripts/build-client.mjs` 不存在）

Step 2: 确认失败（同上）

Step 3: 最小实现

- Change: `scripts/build-client.mjs`：

```js
import { writeFile, mkdir } from "node:fs/promises";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/client.jsx"],
  bundle: true, platform: "browser", format: "cjs",
  // 执行 Agent 注 2026-09-04：jsx:"automatic" 必须显式设置——esbuild 默认 classic
  // 产出 React.createElement 而组件无默认 React 导入；automatic 产出
  // require("react/jsx-runtime")，恰与 external 列表匹配。
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  write: false, minify: false,
});
const body = result.outputFiles[0].text;
const out = `window.__ModuleLoader__.load({\n`
  + `\tid: "@inventec/dsh-copilot-auth",\n`
  + `\tfactory: (require) => {\n`
  + `\t\tvar module = { exports: {} };\n`
  + `\t\tvar exports = module.exports;\n`
  + `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`
  + body + `\n`
  + `\t\treturn module.exports;\n`
  + `\t}\n});\n`;
await mkdir("lib", { recursive: true });
await writeFile("lib/client.js", out);
```

Step 4: 确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm run build && head -3 lib/client.js && tail -4 lib/client.js && npm pack --dry-run`
- Expected: 首行 `window.__ModuleLoader__.load({`；本包产物尾三行 `return module.exports;` / `}` / `});`（信封结构与参考实现对齐即可——参考文件尾部另有其构建自带的 `//# sourceMappingURL` 尾注，本包产物无 sourcemap、不要求复刻）；dry-run 清单 = `cordis.patch.yml`、`LICENSE`、`README.md`（Task 8 前允许缺失警告或空文件，Task 8 补齐）、`lib/client.js`、`src/host.mjs`、`src/shared.mjs`、`package.json`
- Run: `git add -A && git commit -m "build: esbuild pipeline wrapping client bundle in __ModuleLoader__ envelope"`
- Expected: commit 成功（含产物 `lib/client.js`）

### Task 6: 测试 profile 集成验证（不触碰运行中的 web profile）

- 目标：在独立 profile 里安装本插件，验证 patch 三段真实生效
- Files: 无新增（操作 `$DSH_HOME/profiles/copilot-test/`）
- 验证范围：`--dump-config` 输出包含三个断言目标
- 接口契约：Consumes Task 1 `package.json`（`dsh.bundle.patch` 声明）、Task 2 `cordis.patch.yml`、Task 5 `lib/client.js`；Produces 集成验证结论（Task 7 的前置信心）

Step 1: 当前状态检查

- Run: `dsh --profile copilot-test --dump-config 2>&1 | head -5; echo "exit=$?"`
- Expected: profile 不存在或输出中无 `copilot-authorization`（缺失成立）

Step 2: 确认失败（同上）

Step 3: 安装

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && dsh plugin --profile copilot-test add /bmc/iasi/workspace/dsh-copilot-auth`
- Expected: pnpm 安装成功，reconcile 提示 bundle 已加入 `dsh.profile.bundles`；若 pnpm 因网络不可达失败，设 `export npm_config_auto_install_peers=false` 后重试一次；再失败即停下说明（纪律条款），不要改命令猜

Step 4: 确认通过

- Run: `dsh --profile copilot-test --dump-config | grep -nE "copilot-authorization|copilot-auth|dsh-authorization|github-copilot|displayName"`
- Expected: 命中 `copilot-authorization` 行且 name 为 `@deepseek-ai/dsh-authorization`；命中 `copilot-auth` 行且 name 为 `@inventec/dsh-copilot-auth`；`llm-pi-ai` 条目配置中出现 `github-copilot` 与 `displayName: GitHub Copilot`
- Run: `dsh --profile copilot-test --dump-config > /dev/null; echo "exit=$?"`
- Expected: `exit=0`（无致命告警）
- Note：`copilot-test` 按 `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]` 初始化（仅 base、无 web-app），host 半区在该 profile 不激活属预期——`--dump-config` 是 compose 级输出，三段断言不受运行时服务影响
- 执行 Agent 注（Task 6，2026-09-03）：profile 初始化模板 `PROFILE_PNPM_WORKSPACE` 已内置 `autoInstallPeers: false`（`$PKG/dsh-app-boot/lib/index.js` L365-370）——peer 不会被自动拉装，v1-B3/U2 担心的「按旧范围把旧版 peer 拉进 profile」在 profile 层已被结构性挡住；README 排障段的 `npm_config_auto_install_peers=false` env 兜底仍保留（防用户手改 workspace 配置的情形）

### Task 7: 真机 Web 验证（HUMAN 协作点）

- 目标：在用户的 `web` profile 上完成端到端登录验证
- Files: 无新增
- 验证范围：本机 4 条路由 curl 全部返回契约响应；用户在浏览器完成设备码授权；Models 页可发起对话
- 接口契约：Consumes Task 3 HTTP API、Task 5 `lib/client.js`、Task 6 集成结论；Produces 验收结论（对应验收清单第 1–6 条）

Step 1: 安装进 web profile（HUMAN 知会后执行）

- Run: `dsh plugin --profile web add /bmc/iasi/workspace/dsh-copilot-auth && dsh --profile web --dump-config | grep -c copilot-`
- Expected: 安装成功且 dump 中出现 2 处以上 `copilot-` entry
- HUMAN：用户重启 `dsh web` 并刷新浏览器（告知用户：不重启不生效；若该实例启动于 DSH 升级到 0.1.2-rc.1 之前，此重启同时也是让新版本代码上线的必须步骤——Task 0 的 curl 只证明端口存活、不证明运行版本）

Step 2: 路由冒烟（agent 可独立执行）

- Run: `curl -s http://127.0.0.1:8815/copilot-auth/status && curl -s http://127.0.0.1:8815/copilot-auth/state`
- Expected: `{"configured":false}` 与 `{"status":"idle","notices":[]}`（若 404，说明 webserver 未带上插件——回 Task 6 排查；若 401，说明该实例的全局鉴权门覆盖到了非 /api 路由——执行 Agent 注 2026-09-04：Task 0 实测 `/` 与 `/api` 均 401，门的覆盖范围未证实——此时 curl 旁证降级为可选，改由浏览器内同源 fetch 或 UI 交互验证，不视为插件失败）

Step 3: 浏览器 UI 登录（HUMAN 主导，agent 陪跑）

- HUMAN：设置页确认「GitHub Copilot 登录」出现在 Models 之后；点「登录」，页面显示 user code 与 `https://github.com/login/device` 链接（同时留意浏览器 console 是否出现与 `settings.section` 注册相关的 schema 告警——0.1.2-rc.1 参考注册新增可选 `children` 声明、本插件省略，若有告警记录并反馈评审）
- HUMAN：新标签打开链接，用公司 GitHub 账号输入 code；**SSO 用户在授权页对组织点 Authorize**；回到设置页看到「已登录」
- Run（agent 旁证）: `curl -s http://127.0.0.1:8815/copilot-auth/status`
- Expected: `{"configured":true}`

Step 4: 对话验证（HUMAN 主导）

- HUMAN：Models 页确认出现 `GitHub Copilot` 路由与模型列表（登录时自动启用 + `/models` 发现），选择后发起一轮带工具调用的流式对话成功
- Run（agent 旁证 token 轮换）: 挂机 ≥31 分钟后由用户再发一轮对话，仍成功（内置 refresh_in 前自动刷新）

Step 5: 注销复归

- HUMAN：设置页点「注销」→ 状态回「未登录」
- Run: `curl -s http://127.0.0.1:8815/copilot-auth/status`
- Expected: `{"configured":false}`

### Task 8: README 定稿

- 目标：面向「同事 15 分钟从零到能用」的完整文档
- Files: Create `README.md`
- 验证范围：章节结构检查 + 与全局约束的覆盖清单逐项对照
- 接口契约：Consumes 全部前序事实；Produces `README.md`（Task 5 的 pack 清单成员）

Step 1: 当前状态检查

- Run: `ls /bmc/iasi/workspace/dsh-copilot-auth/README.md 2>/dev/null; echo "exit=$?"`
- Expected: `exit=2`（本机 GNU ls 退出码，见 Task 1 评审 Agent 注）

Step 2: 确认失败（同上）

Step 3: 写入 README，章节固定为：

1. `## 这是什么` — 一句话 + 「复用 DSH 内置通道，本插件只做登录入口与预置路由」
2. `## 前置要求` — DSH `0.1.2-rc.1`（实测版本，标注）；每人有 Copilot 订阅的公司 GitHub 账号
3. `## 安装` — `dsh plugin --profile web add @inventec/dsh-copilot-auth` + 重启 dsh web；前提：`pnpm` 可用（`dsh plugin` 是 pnpm 转发器）；含 `### 故障排查` 子节：企业镜像/私有源环境下 pnpm 解析 peer 失败的处理（`export npm_config_auto_install_peers=false` 后重试，与计划 Task 6 的 fallback 同款）
4. `## 登录` — 设置 → 「GitHub Copilot 登录」→ 登录 → 打开 `github.com/login/device` 输入 code；**SSO 用户必须对组织点 Authorize**；看到「已登录」
5. `## 使用` — Models 页 `GitHub Copilot` 路由；配额说明：base 模型（GPT-4o/4.1 一类）不耗 premium requests，premium 模型消耗月度配额（Business 300 次/月量级，超额计费），默认建议 base 档
6. `## 注销与卸载`
7. `## 工作原理` — 三段 patch 的作用；凭据存 `~/.dsh/.credentials.yaml`（600 权限）记录 `llm-pi-ai/github-copilot`
8. `## 风险与合规` — 通道为社区通用路线（非 GitHub 官方支持 API，可能随服务端变更失效）；AUP 禁止批量自动化滥用；公司账号请正常强度使用
9. `## 已知边界` — Models 页凭据圆点不反映 OAuth 登录状态；用户自行在 `cordis.patch.yml` patch `llm-pi-ai` 整段 config 会覆盖预置；`settings.yaml` 的 `llm-pi-ai:` 节只能稀疏覆盖字段、无法删除预置路由（禁用须卸载或 patch 覆盖）；路由前缀两侧硬编码不可配置；DSH rc 版本耦合（实测 `0.1.2-rc.1`，peer 仅 `@deepseek-ai/cordis@^4.0.2`；注意 registry 的 `latest` dist-tag 尚指向旧版、0.1.2-rc.1 在 `next` 下，排障勿被误导）
10. `## License` — MIT

Step 4: 确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && grep -c "^## " README.md && grep -c "Authorize" README.md && grep -c "premium" README.md`
- Expected: `## ` 计数 ≥10；`Authorize` 与 `premium` 均命中
- Run: `git add -A && git commit -m "docs: README with sign-in guide, quota notes and risk disclosure"`
- Expected: commit 成功

### Task 9: CI 与 OIDC release workflows

- 目标：push/PR 自动构建测试；tag `v*` 或手动触发自动通过 npm Trusted Publishing（GitHub Actions OIDC）发布 npm
- Files: Create `.github/workflows/ci.yml`、`.github/workflows/release.yml`
- 验证范围：YAML 可解析 + OIDC 结构断言（真实 Trusted Publisher 触发在 Task 10）
- 接口契约：Consumes Task 1 `package.json` scripts、`package-lock.json`（`npm ci`）；Produces 无 token 的 OIDC 发布流水线（Task 10 依赖）

Step 1: 当前状态检查

- Run: `ls /bmc/iasi/workspace/dsh-copilot-auth/.github/workflows/ 2>/dev/null; echo "exit=$?"`
- Expected: `exit=2`（目录不存在，本机 GNU ls 退出码——见 Task 1 评审 Agent 注；若目录已存在但为空则 `exit=0` 且无输出，同样视为缺失成立）

Step 2: 确认失败（同上）

Step 3: 写入两个 workflow：

- `ci.yml`：`on: [push, pull_request]`；单 job `ubuntu-latest`：`actions/checkout@v4` → `actions/setup-node@v4`（`node-version: 22`）→ `npm ci` → `npm run build` → `npm test`
- `release.yml`：

```yaml
name: Publish to npm (trusted publishing / OIDC)
on:
  push:
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "24"
          registry-url: "https://registry.npmjs.org/"
          package-manager-cache: false
      - name: Install deps (prepare/build toolchain)
        run: npm ci --no-audit --no-fund
      - name: Ensure npm supports trusted publishing
        run: |
          npm install --global npm@latest
          node --version
          npm --version
      - name: Check version not already published
        run: |
          PKG_VERSION=$(node -p "require('./package.json').version")
          PKG_NAME=$(node -p "require('./package.json').name")
          if npm view "$PKG_NAME@$PKG_VERSION" version >/dev/null 2>&1; then
            echo "::error::$PKG_NAME@$PKG_VERSION already published. Bump version first."
            exit 1
          fi
          echo "Publishing $PKG_NAME@$PKG_VERSION"
      - name: Build and test
        run: |
          npm run build
          npm test
      # npm detects the GitHub OIDC environment and creates a short-lived publish credential.
      - name: Publish
        run: npm publish --access public

# Configure this exact publisher in npm package settings:
# GitHub Actions / iasiv5 / dsh-copilot-auth / release.yml / no environment.
```

Step 4: 确认通过

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')" && grep -c "id-token: write" .github/workflows/release.yml && ! grep -qE "NPM_TOKEN|NODE_AUTH_TOKEN|--provenance" .github/workflows/release.yml && grep -c "npm publish --access public" .github/workflows/release.yml`
- Expected: `yaml ok`；`id-token` 计数 `1`；无 token/provenance 字符串命中；`npm publish` 计数 `1`
- Run: `git add -A && git commit -m "ci: build/test on push, npm publish through OIDC on tags"`
- Expected: commit 成功

### Task 10: 发布 v1.0.0（HUMAN 协作点）

- 目标：npm 上出现 `@inventec/dsh-copilot-auth@1.0.0`，并从 registry 回装验证
- Files: 无新增
- 验证范围：`npm view` 返回版本与仓库链接；干净 profile 从 registry 安装并 dump-config 通过
- 接口契约：Consumes Task 9 OIDC release.yml；Produces npm 发布物（Task 11 最终验收对象）

Step 1: HUMAN 前置（用户操作，agent 停下等待）

- HUMAN：GitHub 仓库已创建为 `https://github.com/iasiv5/dsh-copilot-auth`；先由 agent 添加该 origin 并 push `main`
- HUMAN：由于 `@inventec/dsh-copilot-auth` 当前尚未发布，先完成 npm 的一次性 bootstrap；package 出现后，在 npm package settings → Trusted Publisher 配置 GitHub Actions：owner `iasiv5`、repository `dsh-copilot-auth`、workflow filename `release.yml`、environment 留空、允许 `npm publish`
- HUMAN：确认 Trusted Publisher 配置已保存，且 workflow 使用 GitHub-hosted runner；不在 GitHub Secrets 配置 `NPM_TOKEN`/`NODE_AUTH_TOKEN`
- 执行 Agent 注（2026-09-04）：用户将发布方案从 token 改为 OIDC；先推 `main`，不直接打 `v1.0.0` tag。npm Trusted Publisher 是 package 级配置，首次 package 尚不存在时需要先完成一次 bootstrap，再绑定 publisher。

Step 2: Trusted Publisher 配置确认后打 tag并推送

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && git tag v1.0.0 && git push origin v1.0.0`
- Expected: tag 推送成功；Actions run 变绿

Step 3: 确认发布

- Run: `npm view @inventec/dsh-copilot-auth@1.0.0 version repository.url`
- Expected: `1.0.0` 与 `git+https://github.com/iasiv5/dsh-copilot-auth.git`（Actions 完成前会 404，轮询间隔重试，超过 10 分钟停下排查 Actions 日志）

Step 4: registry 回装验证

- Run: `dsh plugin --profile copilot-verify add @inventec/dsh-copilot-auth && dsh --profile copilot-verify --dump-config | grep -c "copilot-authorization"`
- Expected: 安装成功；grep ≥1

### Task 11: 最终验证与同事验收（HUMAN）

- 目标：跑通全部验收项并归档结果
- Files: 无新增
- 验证范围：验收清单 8 条逐项确认
- 接口契约：Consumes 全部任务产物；Produces 验收结论

Step 1: 本地全套回归

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm ci && npm run build && npm test && npm pack --dry-run`
- Expected: 测试全绿、构建成功、pack 清单完整

Step 2: 验收清单逐项核对（对应共识 Q14）

1. 干净 profile 安装成功且 dump 无警告（Task 6/10 已证）
2. Models 页出现 `GitHub Copilot` 路由（Task 7 Step 3/4 已证）
3. 设备码登录端到端（Task 7 Step 3 已证）
4. 模型列表与套餐一致（Task 7 Step 4 已证）
5. 流式 + tool calling 对话（Task 7 Step 4 已证）
6. token 自动刷新（Task 7 Step 4 已证）
7. 注销清除凭据（Task 7 Step 5 已证）
8. HUMAN：找一位同事按 README 裸机操作，15 分钟内从零到能用；结果回填本节

Step 3: 修改摘要

- 输出：新增仓库 `dsh-copilot-auth`（13 个文件）、两个 DSH 测试 profile（`copilot-test`、`copilot-verify`）、npm 发布物 `@inventec/dsh-copilot-auth@1.0.0`

## 执行纪律

- 开始实现前，先批判性复查整份计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划再动手
- 按任务顺序执行，不无声跳步、合并步或改变任务目标
- 每完成一个任务，运行该任务定义的验证并确认预期信号
- 遇到阻塞、重复失败或计划与仓库现实不符，立即停下说明，不要猜
- 凡依赖 `$DSH` 版本的断言，先 `dsh -V`（或 `--version`）比对当前安装树再动手，不匹配即停——版本事实层是计划快照，上游升级会使其过时（0.1.1-rc.2→0.1.2-rc.1 已有真实案例；v2 评审 §10 建议）
- 标注 HUMAN 的步骤必须停下等用户完成，不得代替用户操作（尤其 Task 7 重启、Task 10 的 GitHub/npm 凭据）
- 未经用户同意不改动 `web` profile 与 `$DSH` 安装树
- 全部任务完成后，运行最终验证并输出修改摘要

## 最终验证

- Run: `cd /bmc/iasi/workspace/dsh-copilot-auth && npm ci && npm run build && npm test`
- Expected: host/patch 测试全绿；`lib/client.js` 首行为 `window.__ModuleLoader__.load({`
- Run: `curl -s http://127.0.0.1:8815/copilot-auth/status`
- Expected: `{"configured":true}`（用户已登录态；注销态则 false，与 UI 一致即可）
- Run: `npm view @inventec/dsh-copilot-auth@1.0.0 version`
- Expected: `1.0.0`
- HUMAN 终验：同事裸机 15 分钟可用（验收第 8 条）

## 审阅 Checkpoint

- 计划正文结束；审阅通过前不进入实现
- 2026-09-03 修订轨迹：执行 Agent 已吸收评审报告 v1 的修订（A/B 级落盘）；评审 Agent 随后依据 v2（DSH 0.1.2-rc.1 复核）直接补齐版本事实层修订并刷新附录 A。当前版本 = 0.1.2-rc.1 基线的完整修订版，待执行 Agent 重新吸收并补充其想法后，交新评审会话复审
- 执行 Agent 批判性复查结论（2026-09-03，本轮）：v2 §7 的 14 行修订逐行确认已正确落盘，仅 1 个漏项（`author` 字段，已补）；4 个开放点全部裁决——① `children` 省略已从 `slots.d.ts` 契约层证实合法（L67-71、L148-151）；② 附录 B headless 表述已按 `INSTALLATION_OWNED_PROFILE_TUPLES`（app-boot L351-355）证据改写：installation-owned headless 含 dsh-web-app、host 半区会激活；③ peer 方案(a) 认可（官方 package.json L39-41 已复核）；④ `--version`/`-V` 双合法（bin.js L77），GH_USER 流程顺畅。另有两处实质改进：begin 的 `cancelled` 分支映射（`AuthorizationOutcome` 双态，types.d.ts L68-71，含新增测试）与 profile 层 `autoInstallPeers: false` 发现（app-boot L365-370，Task 6 注记）。等待新评审会话复审；复审通过前不进入 Task 0
- 评审 Agent 复审结论（v3，2026-09-03）：10 处执行 Agent 注逐条对安装树核验——9 处属实/成立（author 补齐、children 契约裁决、peer 方案(a)、`--version`/`-V`、cancelled 双态映射及其新测试、`autoInstallPeers:false` 结构性挡板、dsh -V 纪律、Checkpoint 记录、Task 0 注）；1 处裁决方向相反（附录 B headless：`INSTALLATION_OWNED_PROFILE_TUPLES` 实为**退役元组迁移表**（`normalizeShippedProfile` L776-798 将其改写回无 web-app 的现行模板 L337-339），现行 headless 下 host 半区一律不激活——已按实据改写该条）。「v2 §7 仅 1 个漏项」勘正为 3 个（另 2 个：Task 2 测试未锁 patch 行 `name`、Task 3 缺「无记录 logout」断言，均已由评审补齐）。另发现 2 处实证缺陷并已修：Task 3「设备码 notice」测试的 override 不经 `req.interaction.notify`（按计划原样实跑 7 条仅 6 绿，修后 7/7 绿）；Task 1/4/8 的 `ls` Expected `exit=1` 在本机 GNU ls 下实为 `2`。host 实现要点补两条精度（`export default`、/start 响应先行后台执行 begin）。完整证据与运行记录见 `docs/reviews/2026-09-03-dsh-copilot-auth-plan-review-v3.md`。**结论：放行进入 Task 0**；执行 Agent 可依执行纪律对本轮评审修订做批判性复查后再动手

## 附录 A：机制证据锚点（DSH 0.1.2-rc.1 安装树，2026-09-03 评审 Agent 逐条实测刷新）

| 机制 | 证据位置 |
|---|---|
| authorization 服务未被任何内置 bundle 挂载 | 全部 6 个 bundle patch 均无 `authorization`：`$PKG/dsh-base/`、`$PKG/dsh-web-app/`、`$PKG/dsh-headless/`、`$PKG/dsh-acp-app/`、`$PKG/dsh-sdk-app/`、`$PKG/dsh-sdk-minimal/` 各自的 `cordis.patch.yml` |
| 登录流被动注册（挂服务才生效） | `$PKG/dsh-llm-pi-ai/lib/index.js` L2501 `ctx.inject(["authorization"], …)` |
| flow key 与 run 形态 | 同文件 L2322-2356（`registerPiAiFlows`：`recordKeyFor(providerId)`、`models.login(providerId, …)`）；登录 method `"oauth"` 的 id 见同文件 L2231 |
| 设备码→notice 翻译（url+code） | 同文件 L2266-2271 `case "device_code"`（形状 `{message, url, code}` 不变） |
| 企业域名首问（答空串=github.com） | `$DSH/node_modules/@earendil-works/pi-ai/dist/auth/oauth/github-copilot.js` L336-347；message 逐字 `"GitHub Enterprise URL/domain (blank for github.com)"`；grep 全文件确认 login 流程仅此一个 prompt |
| token 轮换/`proxy-ep` base URL/模型发现/自动启用 | 同文件 L40（proxy-ep→baseURL）、L128（/models 发现）、L244/L274（token 交换与刷新）、L289/L320（模型 policy 启用；L320 即原 `enableAllGitHubCopilotModels` 改名的 `enableGitHubCopilotModels`，login 于 L366 调用） |
| patch 语义（insert；同 id 逐 key 覆盖、name 不匹配跳过；base 层合并不踩用户 settings） | `$PKG/cordis-plugin-include/lib/index.js` L57 起 `applyEntryPatches`；`$PKG/dsh-settings/lib/index.js` L210 `mergeLayers`、L327-343 `SettingsProvider.installSection`（原 `installSettingsSection` 改名，`base: entry` 在 L329）；`$PKG/dsh-llm-pi-ai/lib/index.js` L2455 起 `apply`（`installSection` 调用点 L2545） |
| `providers."github-copilot"` 为 catalog 路由、无 apiKeyEnv 走 OAuth | `$PKG/dsh-llm-pi-ai/lib/index.js` L2479-2486（apiKeyEnv 未设 → 不走凭据引用）、L944/L976（schema）、L1066（`namesCredential`）；`$DSH/node_modules/@earendil-works/pi-ai/dist/providers/github-copilot.js` L10-15（auth.oauth；另新增 `isSubscription: true` 字段，无碍） |
| authorization 公开 API（begin/interaction） | `$PKG/dsh-authorization/lib/index.js` L137-161（`begin`；`ALREADY_IN_FLIGHT` L143）、L242-243（NOT_COMMITTED commit 校验用 `describeRecord().configured`）；类型契约 `lib/types/index.d.ts` |
| credentials record 读写（状态/注销） | `$PKG/dsh-credentials/lib/types/index.d.ts` L159 `readRecord`、L165 `describeRecord`、L188-191 `deleteRecord`（absent 记录为 no-op） |
| webServer 插件路由为一等能力 | `$PKG/dsh-host-webserver/lib/index.js` L176-183（`register(route)`，`kind` 分 exact/prefix 两张表）、L234（`await route.handler(req, res)`，Node 原生签名）、L322（`match`）；web 树挂载见 `$PKG/dsh-web-app/cordis.patch.yml` L116（`- id: webserver`） |
| settings.section 插槽（Models=order 10） | `$PKG/dsh-client-ui-settings-models/lib/client.js` L2907-2912（参考注册另带可选 `children` 声明）；插槽契约 `$PKG/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` |
| client bundle 信封格式 | `$PKG/dsh-client-ui-settings-models/lib/client.js` L1-8 首部；尾部 `return module.exports; } });` 结构段（其后仅参考构建自带的 sourcemap 尾注） |
| dsh.client.inject 清单来源（官方 peer 现仅 cordis） | `$PKG/dsh-client-ui-settings-models/package.json` L30-34（inject 3 项）、L39-41（peerDependencies 仅 `@deepseek-ai/cordis@^4.0.2`） |
| 插件安装与 bundle reconcile | `$DSH/lib/plugin-*.js`（构建哈希文件名，按符号锚定：`exportsPatch`、`reconcilePlugins`；2026-09-03 实测文件为 `plugin-F7ZVfRyo.js`） |
| 插件 client bundle 的发现与下发（`dsh.client` 声明 → `__DSH_BOOT__` 模块图 → `/plugins/<id>/client.js`；exports 必须含 `"./client"`；react 属 shell 播种基线） | `$PKG/dsh-client-modules/lib/index.js` L631（platform≠web 跳过）、L636（声明 dsh.client 但 exports 无 `"./client"` 报错）；同包 `README.md` 模块基线段 |
| 凭据存储 | `$PKG/dsh-credentials-local/lib/index.js` L81/L104（`$DSH_HOME/.credentials.yaml` 恒 0600） |

## 附录 B：已知边界与风险（README「已知边界」的来源）

- Models 页凭据圆点只反映 `apiKeyEnv` 引用状态，OAuth 登录成功后圆点仍可能显示未配置（外观问题，功能不受影响）
- 用户在自己 `cordis.patch.yml` patch `id: llm-pi-ai` 且带 `config` 时，按 DSH 语义整体覆盖预置（既有行为）
- 通道基于 pi-ai 内部实现（VS Code client_id 路线），非 GitHub 官方支持 API，服务端变更可能导致失效；AUP 禁批量自动化滥用
- 自有路由不在 `/api` 的 browser-trust fence 内：host 侧做了 Origin 校验（跨站 Origin 403），无 Origin 请求（curl、DNS rebinding 边缘）放行——本地监听形态下可接受（执行 Agent 注 2026-09-04：实测 0.1.2-rc.1 web 实例对 `/` 与 `/api` 均返回 401，存在全局鉴权门的迹象，但该门是否覆盖插件自有路由未证实，Origin 校验作为独立防线保留）
- peer 仅 `@deepseek-ai/cordis@^4.0.2`，实测版本 `0.1.2-rc.1`：DSH rc 演进可能破坏兼容，README 标注实测版本（注意 registry 的 `latest` dist-tag 尚指向旧版、0.1.2-rc.1 在 `next` 下，排查安装问题勿被 latest 误导）
- 用户 `settings.yaml` 的 `llm-pi-ai:` 节只能「稀疏覆盖」预置路由的字段，**无法删除预置路由本身**（entry config 作为 base 层常驻）；要彻底移除须卸载本插件
- 路由前缀 `/copilot-auth` 在 host 与 client 两侧硬编码一致、未配置化：配置一旦漂移，client 的 fetch 会 404（这是放弃 `routePrefix` 配置项的原因）
- host 半区是否激活取决于 profile 的 bundle 元组，两种形态都无害（评审 Agent 注，2026-09-03 v3 复审改写——执行 Agent 同日注的方向读反了。实据：`$PKG/dsh-app-boot/lib/index.js` 的 `PROFILE_TEMPLATES.headless` 为 `[dsh-base, dsh-headless]`（L337-339，**无 web-app**）；`INSTALLATION_OWNED_PROFILE_TUPLES.headless = [dsh-base, dsh-web-app, dsh-headless]`（L351-355）**不是现行安装元组，而是被退役的旧元组**——`normalizeShippedProfile`（L776-798）在 profile 加载时检测到 manifest 仍带该旧元组（`isRetiredTuple`）即自动改写回现行模板（`writeProfileManifest`），web-app 被移除；且全部 bundle patch 中仅 `dsh-web-app/cordis.patch.yml` L116-117 挂 webserver，`dsh-headless` 自身不挂。故 0.1.2-rc.1 下：headless 形态与自定义 profile（`DEFAULT_PROFILE_BUNDLES=[dsh-base]`，L357）一样，host 半区**一律不激活**（fiber 等待，无害）；唯 web 类元组（如 `web` 模板 `[dsh-base, dsh-web-app]`，L333-335）激活。「两种形态都无害」的底线结论不变，v2 §8 观察-4 以此实据正式关闭）
