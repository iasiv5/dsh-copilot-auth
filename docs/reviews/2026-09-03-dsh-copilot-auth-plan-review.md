# 《dsh-copilot-auth 实施计划》深度评审报告

- 评审对象：`/bmc/iasi/workspace/docs/plans/2026-09-03-dsh-copilot-auth-implementation-plan.md`（v1，Task 0–11）
- 评审方式：逐字通读计划全文；对照 writing-plans 计划质量标准；**对附录 A 全部 15 处机制证据锚点逐一在 DSH 0.1.1-rc.2 安装树（`$DSH`/`$PKG`）内溯源核对**；对计划中 fake/测试代码与真实 API 契约做一致性比对；补充核对计划未覆盖的关键机制（client bundle 发现链、npm registry 可获得性、凭据文件权限等）
- 环境事实（本次评审实测）：`$PKG` 内置包版本均为 `0.1.1-rc.2`，cordis `4.0.2`；`@deepseek-ai/dsh-authorization`、`dsh-credentials`、`dsh-host-webserver`、`cordis` 在 registry.npmjs.org 均返回 200；`@inventec/dsh-copilot-auth` 未被占用（404）

## 一、总体结论

**这份计划的机制事实基础非常扎实，核心架构链路经逐环验证全部成立；但存在 3 处「计划契约 ≠ 真实 API」的阻断级偏差（A1–A3），全部集中在 host 半区与包发布元数据，且恰好都是单测 fake 无法暴露的位置。修正 A1–A3 并采纳 B 级修正后，计划可进入执行。**

分级统计：

| 级别 | 数量 | 判定 |
|---|---|---|
| A（阻断：必须先修计划再动手） | 3 | 不修则 Task 7 / Task 10 大概率卡住或行为偏离 |
| B（应修：影响可靠性、可维护性、验收成立性） | 6 | 建议随 A 一并修入计划 |
| C（次要：精度与健壮性建议） | 5 | 可在实现时顺手处理 |

对附录 A 的核对结果：**15 处锚点全部真实存在，无一伪造**；行段精度总体很高，仅 3 处需修正（见 C1）。这个锚点质量在同类计划中属于罕见的好。

---

## 二、给执行 Agent 的行动清单（按优先级）

### A1【阻断】`webServer.register` 的路由对象缺 `kind` 字段

- **证据**：`$PKG/dsh-host-webserver/lib/index.js` L122-135：

  ```js
  register(route) {
      const table = route.kind === "exact" ? this.exact : this.prefixes;
      if (table.has(route.path)) throw new Error(...);
      table.set(route.path, route);
      ...
  }
  ```

  路由表按 `kind: "exact" | "prefix"` 二分（L102-103 两张表；L269-278 `match()` 先查 exact 表、再对 prefix 表做最长前缀匹配）。
- **计划现状**：Task 3 的接口契约、实现要点（`apply` 内注册 4 条路由）、`test/host.test.mjs` 的 fake ctx（`webServer: { register: (r) => ctx.routes.push(r) }`）全部只写 `{ path, handler }`，**没有 `kind`**。
- **后果**：`kind` 为 `undefined` 时四条路由全部落入 **prefixes 表**。匹配仍会命中（`match()` L275 允许 `pathname === prefix`），所以冒烟测试侥幸能过——但：① `/copilot-auth/state/anything` 这类未预期子路径也会命中 state 路由，攻击面/歧义面无谓扩大；② 与 webserver 自己声明的契约（“route patterns are a composition-level contract”）不符；③ duplicate 检测发生在错误的表内。fake 单测完全测不出此偏差。
- **修正指令**：
  1. Task 3 契约与实现要点改为：`ctx.webServer.register({ kind: "exact", path, handler })`，四条路由均如此；
  2. `test/host.test.mjs` 的 fake `webServer.register` 保持收纳行为即可，但「插件身份与路由注册」测试**新增断言** `ctx.routes.every(r => r.kind === "exact")`；
  3. 顺带确认（计划已写对的部分）：handler 签名就是 Node 原生 `(req, res)`（webserver L186 `await route.handler(req, res)`），`res.writeHead(code, headers)` / `res.end(body)` 用法成立。

### A2【阻断】`/logout` 契约「无记录时 ok=false」与真实 `deleteRecord` 语义冲突，不可实现

- **证据**：`$PKG/dsh-credentials/lib/types/index.d.ts` L196-200：

  ```ts
  /**
   * Remove one record; removing an absent record is a no-op.
   */
  abstract deleteRecord(key: CredentialKey): Promise<void>;
  ```

  对不存在的记录是 **no-op 且正常 resolve**，永不 reject。
- **计划现状**：Task 3 契约写 `POST {prefix}/logout → 200 {"ok":boolean}`（`deleteRecord(CREDENTIAL_KEY)`，**无记录时 ok=false**）；实现要点写 `try { await ctx.credentials.deleteRecord(...); ok: true } catch { ok: false }`。
- **后果**：`ok` 恒为 `true`，「无记录时 ok=false」这条契约**没有任何实现路径**。计划里 fake 的 `deleteRecord` 恒 `return true`，测试自洽通过——正是「fake 掩盖真实契约」的典型缺口，本条与 A1 同源。
- **修正指令**（二选一，推荐方案 1）：
  1. `/logout` 先 `readRecord`（或 `describeRecord`，见 B2）判断记录存在 → 存在则 `deleteRecord` 且 `ok: true`；不存在则不调 `deleteRecord`（或调了也行）且 `ok: false`。语义与 `/status` 对称，client 的「注销」按钮也能据此反馈；
  2. 或简化契约为恒 `{ok: true}`（幂等注销），并在 Task 4 client 文案中不区分「本来就没登录」。
  无论选哪个，同步修改 Task 3 契约文字、实现要点与 `test/host.test.mjs` 的「status 与 logout」用例（补一条「无记录时 logout」断言）。

### A3【阻断】`package.json` 缺 `repository` 字段，且 Task 10 验证命令的字段路径错误

- **证据**：Task 1 的 `package.json` 全文无 `repository`/`author` 字段；Task 10 Step 3 的命令是 `npm view @inventec/dsh-copilot-auth@1.0.0 version dist.repository.url`——npm 的 `dist` 元数据只含 tarball/shasum 等字段，**不含 repository**；repository 在顶层，正确命令是 `npm view @inventec/dsh-copilot-auth@1.0.0 version repository.url`。而由于包里根本没有 repository 字段，即使改正命令，取到的也是 `undefined`。
- **后果**：Task 10 Step 3 的 Expected（GitHub 仓库 URL）**永远无法满足**，会被误判为发布失败而进入排查死胡同；npm 包页面缺源码链接，影响同事侧的可发现性与信任度。
- **修正指令**：
  1. Task 1 的 `package.json` 补：

     ```json
     "repository": { "type": "git", "url": "git+https://github.com/<user>/dsh-copilot-auth.git" },
     "author": "<git config user.name 的值>"
     ```

     （`<user>` 占位在 Task 10 HUMAN 建仓后确定；Task 1 可先留待填并在 Task 10 Step 1 补齐提交，或 Task 1 时即向用户要 GitHub 用户名——计划需明确选一条写死，避免占位符违反计划的「禁止占位符」纪律）；
  2. Task 10 Step 3 命令改为 `npm view @inventec/dsh-copilot-auth@1.0.0 version repository.url`。

---

## 三、B 级问题（应修）

### B1 fake `interaction.prompt` 收到的对象形状与真实契约不一致（`type` vs `kind`）

- **证据链**：pi-ai 原生 prompt 形如 `{ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com" }`（`$PKG/@earendil-works/pi-ai/dist/auth/oauth/github-copilot.js` L265-269）；但 dsh-llm-pi-ai 在 `run()` 里经 `restate()` 改写为 `{ kind: "text", message, placeholder? }` 再交给 `session.prompt`（`$PKG/dsh-llm-pi-ai/lib/index.js` L2219-2240、L2280）。**host 插件的 `interaction.prompt` 实际收到的是 `kind` 形状**。
- **计划现状**：`test/host.test.mjs` 的 `ctx.script.prompt = { type: "text", message: ... }` 用 `type`。
- **风险评估**：计划的实现只依赖 `p.message.includes("Enterprise")`，功能无碍（message 文本已核实确实含 "Enterprise"，L267）。但 fake 应忠实模拟真实契约，防止执行者顺手按 `p.type` 分支、也防止未来重构时测试失去防线。
- **修正指令**：fake 中 prompt 对象统一改为 `{ kind: "text", message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com" }`（与真实文本逐字一致，顺便让 `includes("Enterprise")` 的判断被真实文本锁定）。

### B2 `/status` 建议改用 `describeRecord` 而非 `readRecord`

- **证据**：`readRecord` 返回完整 `CredentialRecord`——github-copilot 的 OAuth `GrantRecord` payload 含 access/refresh token；`describeRecord(key)` 返回 `CredentialRecordInfo`（presence/discriminant/writability），types L169-174 明说它就是给 configuration surfaces 用的；authorization 服务验证 flow commit 用的也是 `describeRecord(key)).configured`（`$PKG/dsh-authorization/lib/index.js` L243）。
- **计划现状**：Task 3 契约「`ctx.credentials.readRecord(CREDENTIAL_KEY)` 成功且非空即 true」。
- **修正指令**：`/status` 改为 `const info = await ctx.credentials.describeRecord(CREDENTIAL_KEY); configured: info.configured === true`。好处：token payload 不进每个轮询请求的内存；判据与 authorization 的 commit 验证同源。`/logout` 的存在性判断（A2 方案 1）同理用 `describeRecord`。fake ctx 相应增补 `describeRecord`。

### B3 README 安装节缺 pnpm 前提与 peer 解析故障排查

- **证据**：`dsh plugin` 是 pnpm forwarder（`$DSH/lib/plugin-9h8shc4d.js` L108 `spawnSync("pnpm", ...)`；bin.js 帮助文本同义），**pnpm 是硬前提**；同事裸机未必装有。peer 解析方面：四个 `@deepseek-ai/*` peer 本次实测在公共 registry 均 200，pnpm 默认 `auto-install-peers=true` 会自动装上（本插件 host 半区零 import，多装无害）；但公司镜像/代理未同步该 scope、或同事 pnpm 配置差异时，安装可能失败——Task 6 已备有 `export npm_config_auto_install_peers=false` 的 fallback，**但 README 安装节没有**。
- **修正指令**：Task 8 README 第 3 节「安装」补充：① 前置要求里写明需要 `pnpm`（或说明 dsh 会提示）；② 一行故障排查：「若安装因 peer 解析失败，`export npm_config_auto_install_peers=false` 后重试」。否则验收第 8 条「同事 15 分钟裸机」在非理想网络下第一步就卡死。

### B4 已知边界建议补两条 + `routePrefix` 配置化的取舍要写死

1. **settings.yaml 无法移除预置路由**：`mergeLayers`（`$PKG/dsh-settings/lib/index.js` L229-241）只递归合并 plain object，注释明说「a sparse patch cannot erase lower keys」——用户在 `settings.yaml` 写 `llm-pi-ai: {providers: {}}` **删不掉** base 层的 `github-copilot` 路由。想禁用只有 `cordis.patch.yml` patch `llm-pi-ai` 整段 config 一条路。README「已知边界」与附录 B 建议补这条（它与现有第二条是一体两面，但用户视角不同）。
2. **`routePrefix` 配置化实际是半残的**：client bundle 里 fetch 路径写死 `"/copilot-auth/..."`，用户若改 patch 里 `copilot-auth` entry 的 `config.routePrefix`，host 路由变了、client 仍打旧路径，直接断裂。
   - **推荐**：v1 **删掉** patch 中 `copilot-auth` entry 的 `config` 段（连带 Task 2 测试断言 `self?.config?.routePrefix === "/copilot-auth"` 改为只断言 `name`；Task 3 的 `routes(prefix)` 参数化保留为内部默认值即可）；README 不出现 routePrefix。
   - 备选：保留但在 README「已知边界」声明「不支持修改 routePrefix」。二选一写进计划，消除歧义。

### B5 patch `llm-pi-ai` 行建议补 `name` 做 mismatch 防御

- **证据**：`applyEntryPatches`（`$PKG/cordis-plugin-include/lib/index.js` L96-99）对带 `name` 的非 insert patch 会校验 `name === target.name`，不匹配则 warn+skip。
- **修正指令**：计划的 `cordis.patch.yml` 第 3 段补 `name: '@deepseek-ai/dsh-llm-pi-ai'`。这样未来 DSH 若调整该 row 的包名，patch 会显式跳过并在 dump 里告警，而不是把 config 静默打到「同 id 不同包」的 row 上。Task 2 测试同步加 `assert.equal(row?.name, "@deepseek-ai/dsh-llm-pi-ai")`。注意：name 校验要求与 base 层实际包名一致（本次已核实 base patch L95-96 就是 `@deepseek-ai/dsh-llm-pi-ai`）。

### B6 附录 A 缺「插件 client bundle 如何被发现」的锚点——本次评审已替你找到，请收录

计划对 host 半区的证据链完备，但 **client bundle 从「装进 profile」到「浏览器执行」的机制链没有锚点**，而这正是 Task 7 能否看到设置页的成败点。已核实成立的证据（建议作为附录 A 第 16 行收录）：

| 机制 | 证据位置 |
|---|---|
| node half 扫描 **Loader entries** 中声明 `dsh.client`（platform=web）的包，解析其 `exports["./client"]`，进 `__DSH_BOOT__` 图，经 `/plugins/<id>/client.js` 服务 | `$PKG/dsh-client-modules/lib/index.js` L67-71、L389-395（platform≠web 跳过；声明 dsh.client 但 exports 无 `./client` 会 throw）；`lib/types/client/manifest.d.ts` L50（`/plugins/<id>/client.js?rev=<rev>`）；`lib/invariant.js` L14-24（advertise 了 URL 但 resolve 不到 bundle 路径 → fail） |
| `react`/`react/jsx-runtime` 属于 shell 播种的 implicit baseline，无需在 `dsh.client.external` 声明；`dsh.client.inject` 是模块图依赖边（包名），组合期拒绝 missing suppliers | `$PKG/dsh-client-modules/README.md` L13-15 |

由此得到一个**设计说明应写入计划**的事实：`dsh.client.inject` 四项对本 client 并非功能必需（client 源码只 `import react`，react 是 baseline）；照抄参考实现是一刀切的保守选择——标准 web profile 下无害，但若同事用精简自定义 profile（roster 少了 locale/api-remotes 之一），本包会因 missing supplier 而组合失败，比不声明更脆。两个可接受方案：(a) 维持照抄 + 在计划/README 注明「要求标准 web roster」；(b) 删掉四项只留 `platform: "web"`（react 由 baseline 提供）。任选，但把理由写进 Task 1，别让后人猜。

---

## 四、C 级问题（次要与精度）

- **C1 附录 A 三处精度修正**（不影响结论，但既然做了溯源就做准）：
  1. pi-ai 的真实 scope 是 **`@earendil-works`** 不是 `@deepseek-ai`——附录 A 两处 `…/pi-ai/dist/...` 应写全 `$PKG/@earendil-works/pi-ai/dist/...`，否则执行者按 @deepseek-ai 找包会扑空；
  2. `dsh.client.inject` 行段：Task 1 写 L34-39（准确），附录 A 写 L32-42（那是整个 `dsh` 段）——统一为 L34-39；
  3. 「token 轮换」的精确锚点是 pi-ai github-copilot.js **L193-228**（`refreshGitHubCopilotAccessToken`/`refreshGitHubCopilotToken`）；附录 A 现写的 L233-263 实为「模型自动启用」（`enableGitHubCopilotModel`/`enableAllGitHubCopilotModels`）。建议拆成两行。
- **C2 验收第 6 条措辞**：token 自动刷新的「已证」完全依赖 Task 7 Step 4 的「挂机 ≥31 分钟后由用户再发一轮」——验收清单第 6 条应显式注明此前置，防止执行者不等待就打勾。
- **C3 路由 disposer**：`webServer.register` 返回 disposer（L132-134），建议 `apply` 内 `ctx.effect(() => disposer)`，符合 cordis 惯例，亦为未来 profile 热更新留路。
- **C4 `ALREADY_IN_FLIGHT` 归一**：`begin` 对同 key 并发会 throw `AuthorizationError(code="ALREADY_IN_FLIGHT")`（authorization lib L143）。host 自身状态机已挡 99% 场景；建议实现里对 begin 的该错误码也归一为 409，防御状态漂移（如未来加卸载重挂）。
- **C5 handler 兜底**：webserver 对路由 handler 的同步 throw 兜底是 **400**（webserver L198-206），语义含混。建议四条 handler 自己 try/catch 回 500 JSON，别依赖宿主兜底。

---

## 五、附录 A 逐条核对结果（15/15 属实）

| # | 附录 A 锚点 | 核对结果 |
|---|---|---|
| 1 | 三个内置 bundle patch 全文无 `authorization` | ✅ 属实；且 `find $PKG -maxdepth 2 -name cordis.patch.yml` 确认安装树内 bundle patch **恰好只有这三个**，「所有内置 bundle」表述成立 |
| 2 | `dsh-llm-pi-ai/lib/index.js` L2429 被动 `ctx.inject(["authorization"])` | ✅ 逐字命中（L2429-2431） |
| 3 | 同文件 L2251-2285 `recordKeyFor`/`models.login(providerId, …)` | ✅ `registerPiAiFlows` 全段吻合；`loginMethods` L2156-2160 确认 method `"oauth"` 存在，计划传 `method: "oauth"` 正确 |
| 4 | 同文件 L2195-2200 `case "device_code"` | ✅ notice 形状 `{message, url: verificationUri, code: userCode}` 与 Task 3/4 契约一致 |
| 5 | pi-ai oauth L264-276 企业域名首问 | ✅ 逐字吻合；message 确含 "Enterprise"，`includes("Enterprise")` 判断可靠；答空串 → `domain = "github.com"`（L276） |
| 6 | pi-ai L39-58、L84-96、L233-263 | ⚠️ 基本属实但归属需修正：L39-58 proxy-ep→baseURL ✅、L84-96 模型发现 ✅、**L233-263 是「自动启用模型」而非「token 轮换」**，轮换在 L193-228（见 C1-3） |
| 7 | `cordis-plugin-include` L57-105；`dsh-settings` L618-636、L229-241；`dsh-llm-pi-ai` L2384-2491 | ✅ 全部命中；`applyEntryPatches` 的 insert/覆盖/name 校验语义、`installSettingsSection` 的 `base: entry`、`mergeLayers` 递归覆盖，均与计划主张一致；dump-config 与真实 boot 共享同一 patch 语义（注释 L44-46 明说），Task 6 的 dump 验证可信 |
| 8 | L2408-2414、L932-1051；pi-ai providers/github-copilot.js L13-16 | ✅ `apiKeyEnv === undefined → return undefined`（L2410）+ `namesCredential: false`（L1047）+ provider `auth.oauth`（L15）共同佐证「无 apiKeyEnv 走 OAuth」 |
| 9 | `dsh-authorization` types + lib L140-243 | ✅ `begin({key, method?, interaction, signal?})`、`ALREADY_IN_FLIGHT`、NOT_COMMITTED commit 契约、`AuthorizationInteraction{notify, prompt(): Promise<string>}` 全部与计划的 interaction 适配模型一致 |
| 10 | `dsh-credentials` types L138-200 | ✅ `readRecord`/`deleteRecord` 签名属实——且正是这里暴露了 A2（absent record 是 no-op） |
| 11 | `dsh-host-webserver` register + web-app patch L121-122 | ⚠️ L121-122 精确命中；register 存在——但暴露了 A1（`kind` 字段） |
| 12 | settings-models client.js L2784-2790 + slots.d.ts | ✅ Models 的 `settings.section` 注册 order 10 属实；插槽契约 `{id, order, label}` + owner props `{close}` 与 Task 4 插槽形态一致 |
| 13 | settings-models client.js L1-8、L2805-2810 | ✅ 信封首尾逐字核对一致；参考 `id` 用完整包名，计划同风格 ✅ |
| 14 | settings-models package.json L32-42 | ✅ 存在；行段建议统一为 inject 数组的 L34-39（C1-2） |
| 15 | `$DSH/lib/plugin-9h8shc4d.js` L35-74 | ✅ reconcile 语义吻合（声明 `dsh.bundle.patch` 的依赖加入 `dsh.profile.bundles` 层栈）；`dsh plugin --profile <name> add <pkg>`、`--dump-config`、`-V` 在 bin.js 均真实存在 |

## 六、正面确认清单（评审中独立验证成立的机制链）

计划的核心主张逐环验证均成立，执行者可以放心依赖：

1. **安装→生效链**：`dsh plugin --profile X add <pkg>` → pnpm 安装 → reconcile 把声明 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`（内置模板 bundle 在前、插件层在后、用户 patch 层最后）→ 插件的 `cordis.patch.yml` 作为 bundle 层参与 compose。
2. **patch 三段全部可行**：无 id 的 `insert` 行 push 进 entry 列表（L83）；`copilot-authorization` insert 后 `authorization` 服务（fiber 名逐字核对为 `authorization`）在 web 树满足；`copilot-auth` entry 的 host 半区 `inject ["webServer","authorization","credentials"]`（fiber 名 `webServer`/`credentials` 亦逐字核对）在标准 web profile 全部可满足；对 `llm-pi-ai` 的 config patch 是整值覆盖，但内置该 row 本无 config（base patch L95-96），无破坏。
3. **被动登录流激活链**：authorization 服务挂载 → `dsh-llm-pi-ai` L2429 被动 inject 触发 → `registerFlow(key="llm-pi-ai/github-copilot", methods 含 "oauth")` → host `begin({key, method:"oauth", interaction})` 可找到 flow。
4. **settings base 层链**：patch 的 `config.providers."github-copilot".displayName` 经 `installSettingsSection(ctx, NS, Config, config=entry config)` 成为 base 层；用户 `settings.yaml` 的 `llm-pi-ai:` 节经 `mergeLayers` 逐字段递归覆盖其上；`displayName` 非空校验通过（"GitHub Copilot"）。
5. **设备码 UI 数据链**：pi-ai `device_code` 事件 → notice `{message, url, code}` → host `attempt.notices` → `GET /state` → client 渲染——字段名全链一致。
6. **client bundle 链**（计划缺锚点、本次补证）：`dsh.client` 声明的包被 client-modules 扫描进 `__DSH_BOOT__` → 浏览器经 `/plugins/copilot-auth/client.js` 取信封 bundle → `__ModuleLoader__.load` 工厂执行 → cordis client 插件 `copilot-auth-ui` 注册 `settings.section`（order 11 紧挨 Models 的 10）；`react` 属 shell implicit baseline，esbuild external 方案成立。
7. **发布链**：四个 peer 在公共 registry 均存在（auto-install-peers 下可解析、host 零 import 故多装无害）；`@inventec/dsh-copilot-auth` 包名未被占用；peer 钉 `^0.1.1-rc.2` + `^4.0.1` 与官方包自身钉法完全同款（settings-models package.json L44-52）。
8. **杂项事实**：`$DSH_HOME/.credentials.yaml` 由 provider 以 0600 创建/替换且超权可读会拒启（credentials-local L81/L104）——README 第 7 节声称属实；`dsh --version`/`--dump-config`/`plugin add` 命令均存在；pi-ai 登录成功后自动 enable 全部已知模型并拉取 availableModelIds（L258-292）——支撑 Task 7 Step 4「登录时自动启用 + /models 发现」的预期。

## 七、计划工程质量评价（对照 writing-plans 标准）

- **结构**：目标/架构快照/全局约束/文件结构/任务清单/接口契约/执行纪律/最终验证齐全；任务粒度与 reviewer gate 合理；TDD 任务均带「确认失败」步骤。
- **接口契约**：Consumes/Produces 齐备，HTTP API 契约前置到 Task 3 供 Task 4 逐字消费，是好实践。
- **全局约束**：命名/文案/依赖/发布/验证环境逐字落位，且与设计共识一致（本次评审未接触共识原文，以计划自洽性论）。
- **系统性弱点只有一个**：三处真实 API 契约偏差（A1/A2/B1）全部位于「fake 单测自洽、真机才暴露」的区域。这印证了计划的执行纪律条款「计划与仓库现实不符立即停下」是必要保险——但既然评审已把真实契约挖出，应现在修入计划，而不是留给执行时撞墙。
- **HUMAN 协作点**（Task 7 重启与授权、Task 10 建仓与 secret、Task 11 同事实测）边界清晰，与全局约束「未经同意不动 web profile」自洽。

## 八、结论

修完 A1–A3（合计改动集中在 Task 1/2/3/10 的契约、fake 与断言），采纳 B1–B6 与 C1 后，本计划即可作为高质量执行蓝本进入 Task 0。核心架构判断——**复用 DSH 内置 authorization/credentials/webServer/settings 四个 seam，插件零行协议代码，entry config 作为 settings base 层预置路由——经逐环溯源全部成立**，无需返工设计。

— 评审 Agent，2026-09-03
