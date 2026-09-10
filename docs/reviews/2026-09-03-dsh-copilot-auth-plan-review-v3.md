# 《dsh-copilot-auth 实施计划》评审报告 v3 —— 执行 Agent 批判性复查轮次的复审

- 评审对象：`/bmc/iasi/workspace/docs/plans/2026-09-03-dsh-copilot-auth-implementation-plan.md`（DSH 0.1.2-rc.1 基线完整修订版，含执行 Agent 本轮 10 处「执行 Agent 注（…，2026-09-03）」）
- 前置：v1（`docs/reviews/2026-09-03-dsh-copilot-auth-plan-review.md`，0.1.1-rc.2 基线）、v2（`docs/reviews/2026-09-03-dsh-copilot-auth-plan-review-v2-dsh-0.1.2-rc.1.md`，§4 锚点对照表、§7 修订清单）。v1/v2 未被本文推翻的结论继续有效。
- 复审方法：
  1. 对本轮 10 处「执行 Agent 注」的全部证据锚点**逐条在本机 0.1.2-rc.1 安装树溯源核对**（`dsh -V` 实测 `0.1.2-rc.1`；事实源以安装树为准，遵守已知坑：pi-ai 在 `$DSH/node_modules/@earendil-works/`、`plugin-*.js` 按符号锚定、registry `latest` 停旧版）；
  2. **把计划 Task 3 的测试代码与实现要点原样落地实跑**（本机 Node v22.21.1，`node --test`），检验新增测试与既有 fake fixture 的自洽性——不只做纸面推演；
  3. 抽查 v2 §4 锚点表的承重梁行（#1/#2/#9/#11 + 信封/扫描链）在安装树是否仍成立；
  4. 确认 `/bmc/iasi/workspace/dsh-copilot-auth/` 仍不存在（复审通过前不进 Task 0 的前提未被破坏）。

## 一、一句话结论

**10 处执行 Agent 注中 9 处证据属实、裁决成立（含本轮最有价值的 cancelled 双态映射修复——经实跑验证自洽）；但 1 处裁决（附录 B headless）把 `INSTALLATION_OWNED_PROFILE_TUPLES` 的语义读反了——它是退役元组迁移表而非现行安装元组，据此改写的附录 B 条目事实方向错误，已由本文按代码实据直接改写。另实证发现 1 处测试 fixture 缺陷（设备码 notice 用例必挂）与 1 组精度问题（`ls` 退出码）。以上修订均已由评审 Agent 直接落盘并标记，计划现可放行进入 Task 0。**

## 二、10 处「执行 Agent 注」逐条核验表

| # | 修订内容 | 声称的锚点 | 本机核验结果 | 判定 |
|---|---|---|---|---|
| 1 | v2 §7 14 行逐行确认 + 补 author 漏项 | v2 §7 / v1-A3 | author 已入 Task 1 package.json（L115）且注记「写入实际值不留尖括号」；但「仅 1 个漏项」**不成立**——实为 3 个（见 §五），另 2 个本轮已由评审补齐 | ⚠️ 大体属实，声明 overstated |
| 2 | children 省略合法性从契约层证实 | `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` L67-71、L148-151 | 逐字命中：`settings.section` 座位契约 = `{kind:'list', scope:'root', owner: SettingsSectionOwnerProps}`，**无 children 字段**；owner 接口仅 `close: () => void`（L148-151）。L57-59 注释明确列举注册身份选项 `id`/`order`/`label`。参考注册（settings-models client.js L2907-2917）的 `children` 是 Models 自有的 `settings.models.*` 子座位声明，普通 section 无需。裁决成立；Task 7 console 观察降级为冗余防线恰当 | ✅ 成立 |
| 3 | headless/webServer 裁决改写附录 B | `dsh-app-boot/lib/index.js` L351-355、L357 | 锚点逐字存在，但**语义读反**：`INSTALLATION_OWNED_PROFILE_TUPLES` 是 `normalizeShippedProfile`（L776-798）里的 **`isRetiredTuple`（退役元组）**——headless manifest 若仍带 `[base, web-app, headless]` 旧元组，加载时被自动改写回现行模板 `[dsh-base, dsh-headless]`（L337-339，**无 web-app**）。且全部 bundle patch 中仅 `dsh-web-app/cordis.patch.yml` L116-117 挂 webserver。故 headless 形态下 host 半区**一律不激活**，与执行 Agent 结论相反。底线「两种形态都无害」碰巧仍成立（不激活=fiber 等待=无害），但机制叙事必须改 | ❌ 方向相反，已改写 |
| 4 | peer 方案(a) 认可并复核 | `dsh-client-ui-settings-models/package.json` L30-34、L39-41 | 逐字命中：`dsh.client.inject` 恰 3 项（L30-34）、`peerDependencies` 仅 `@deepseek-ai/cordis@^4.0.2`（L39-41） | ✅ 成立 |
| 5 | `--version`/`-V` 双写法等价 | `$DSH/lib/bin.js` L77 | 逐字命中：`.version(version, "-V, --version", "output the version number")` | ✅ 成立 |
| 6 | begin 按 `AuthorizationOutcome.status` 双态映射 + 新增 cancelled 测试 | `dsh-authorization/lib/types/types.d.ts` L68-71 | 逐字命中：`AuthorizationOutcome { status: AuthorizationStatus }`，`AuthorizationStatus = 'authorized' \| 'cancelled'`（L59）；L61-66 注释明确「failure 以 throw 到达调用方」——cancelled 是合法 resolve 值。**强化证据**（执行 Agent 未引用）：lib/index.js L236 `if (signal.aborted \|\| observed.declined) return { status: "cancelled" })`、L144 signal 预中止也 resolve cancelled——用户拒绝/中止在真实设备流可达，此修复并非理论洁癖。新测试经实跑自洽（见 §三-2） | ✅ 成立且必要 |
| 7 | `PROFILE_PNPM_WORKSPACE` 内置 `autoInstallPeers: false` | `dsh-app-boot/lib/index.js` L365-370 | 逐字命中（模板串 L365-370，`autoInstallPeers: false` 在 L369）；`initProfile` 注释「Existing files are never touched」与 README env 兜底的保留理由（防用户手改 workspace）自洽 | ✅ 成立 |
| 8 | 执行纪律新增「版本断言先 `dsh -V` 比对」 | v2 §10 建议 | 已落「执行纪律」节（计划 L704），措辞与 v2 建议一致 | ✅ 已落盘 |
| 9 | 「审阅 Checkpoint」记录复查结论 | — | 已落（计划 L723）；但其中第②点复述了 #3 的错误 headless 裁决，本文追加的 v3 标记已勘正 | ⚠️ 已落但含错 |
| 10 | Task 0 注：`--version` 合法 + GH_USER 复用 Task 10 | bin.js L77 / Task 10 流程 | bin.js L77 属实；GH_USER 复用与 Task 10 Step 1（remote url）及 Step 3（`npm view … repository.url` 期望值）闭环一致 | ✅ 成立 |

## 三、本轮发现的缺陷与处置（均已直接修订计划）

### 1.【F1·事实错误】附录 B headless 条目按误读证据改写（已改写）

**证据链**（`$PKG/dsh-app-boot/lib/index.js`）：

- L337-339 `PROFILE_TEMPLATES.headless = { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] }` —— 现行模板**无 web-app**；
- L350 注释「Installation-owned bundle tuples **normalized to the shipped template**」；
- L351-355 `INSTALLATION_OWNED_PROFILE_TUPLES = { headless: [base, web-app, headless] }`；
- L776-798 `normalizeShippedProfile`：`isRetiredTuple`（manifest 恰带旧元组）→ `writeProfileManifest` 改写回 `template.bundles`（即移除 web-app），注释明说「A changed value is written back during profile loading」；
- bundle patch 全树 grep：`webserver` 仅出现于 `dsh-web-app/cordis.patch.yml` L116-117；`credentials` 在 `dsh-base` L97-98；`authorization` 零命中。

**推论**：0.1.2-rc.1 下 headless 与自定义 profile（`DEFAULT_PROFILE_BUNDLES=[dsh-base]`，L357——此半句执行 Agent 写对了）一样，host 半区一律不激活（fiber 等待）；唯 web 类元组（`web` 模板 `[dsh-base, dsh-web-app]`）激活。v2 §8 观察-4 的疑虑以**正确方向的实据**正式关闭。「两种形态都无害」底线不变。

**处置**：附录 B 该条已由评审 Agent 整条改写并标注；Task 6 Note（L521，`copilot-test` 按 DEFAULT_PROFILE_BUNDLES 初始化）本就正确、未动。

### 2.【F2·测试缺陷】「设备码 notice」用例与 fake fixture 不自洽（已修，附实跑证据）

把计划 Task 3 的测试块**原样**与一份严格按实现要点写出的 `host.mjs` 在本机对跑（Node v22.21.1，fire-and-forget 语义的 /start）：

| 运行 | 结果 |
|---|---|
| A：计划原样测试 | **6/7 绿**——cancelled 新用例 ✅、unexpected prompt ✅、409 ✅、status/logout ✅、Origin 403 ✅、身份/路由 ✅；**「设备码 notice 经 state 可见」❌** |
| B：仅把该用例的 override 改为「先 `req.interaction.notify` 送达 notices 再挂起」 | **7/7 绿** |

病因：原 override `ctx.authorization.begin = () => new Promise(() => {})` 把 `req`（含 `interaction`）整个丢弃，`ctx.script.notices` 永不进入 `attempt.notices`，`state.body.notices.at(-1)` 为 `undefined`，`deepEqual` 必挂——对**任何**正确的 host 实现都挂。这会诱导执行者去「修实现」而不是修测试。顺带说明：若 /start 实现把 begin `await` 在 handler 返回路径上（同样符合旧要点字面），测试会直接卡死在 `call()` 的 await 上（本评审第一轮仿真实测确认，7 条挂 3 条）——故已同步在实现要点补「响应先行、后台任务执行 begin」的强制措辞。

**处置**：override 已改为 `async (req) => { for (const n of ctx.script.notices) req.interaction.notify(n); await new Promise(() => {}); }`；cancelled 用例经实跑确认自洽、未动。

### 3.【F3·精度组】（已顺手落盘）

- **`ls` 退出码**：本机 GNU ls 对不存在路径返回 **2** 非 1（实测）；Task 1/4/8 三处 Step 1 的 Expected `exit=1` 均已改为 `exit=2`——否则按「任何一项不符即停下」纪律，Task 1 第一步就会触发一次无谓的人工停机。
- **`export default`**：Task 3 测试用默认导入 `import plugin from "../src/host.mjs"`，实现要点原文未写明导出形式（本评审第一轮仿真即因此 ERR_MODULE_NOT_FOUND）——已补「以 `export default` 导出三件套」。
- **v1-B5 测试子项**：Task 2 yaml 的 `name: '@deepseek-ai/dsh-llm-pi-ai'` 防御已落盘但测试未锁定——已补 `assert.equal(row?.name, …)`。
- **v1-A2 测试子项**：幂等契约（方案 2）缺「无记录时 logout 同样 ok:true」断言——已补于「status 与 logout」用例尾部（复用首次 logout 后的空 record 形态）。

## 四、v2 §4 承重梁抽查（均仍成立）

| v2 §4 行 | 抽查结果 |
|---|---|
| #1 authorization 未被任何内置 bundle 挂载 | ✅ 对 $PKG 下**全部** `cordis.patch.yml` grep `authorization` 零命中（比 6 个 bundle 更强） |
| #2 llm-pi-ai 被动注册 | ✅ L2501 逐字：`ctx.inject(["authorization"], (authorized) => { registerPiAiFlows(authorized, auth); })` |
| #9 begin 契约 | ✅ `begin` L137-161、`ALREADY_IN_FLIGHT` L143、NOT_COMMITTED commit 校验 `describeRecord(key)).configured` L242-243；另见 §二-6 的 L236/L144 强化证据 |
| #11 webServer 路由 | ✅ `register` L176-183（kind 分 exact/prefix 双表）、`await route.handler(req, res)` L234、`match` L322；`dsh-web-app/cordis.patch.yml` L116-117 `- id: webserver` |
| 附加：信封/扫描链/插件符号 | ✅ settings-models client.js L1-8 信封首部逐字（含 `Symbol.toStringTag` 行）；尾部 `//# sourceMappingURL=client.js.map` 尾注如 v2 所述；client-modules L631/L632-635（platform≠web 跳过）、L636（声明 dsh.client 但 exports 无 `./client` 即 throw）逐字命中；`$DSH/lib/plugin-F7ZVfRyo.js` 文件名与 v2 记录一致 |
| 附加：企业域名首问 | ✅ pi-ai github-copilot.js L336-347，message 逐字 `"GitHub Enterprise URL/domain (blank for github.com)"` |

## 五、对「v2 §7 仅 1 个漏项」声明的勘正

执行 Agent 声称「14 行逐行确认已落盘，仅 author 一个漏项」。复核后实为 **3 个漏项**：

1. `author` 字段（执行 Agent 自行发现并补上 ✅）；
2. v1-B5 的测试子项——Task 2 yaml 补了 `name` 但测试未加 `row?.name` 断言（本轮已补）；
3. v1-A2 的测试子项——选了幂等契约（方案 2）但未补「无记录 logout」断言（本轮已补）。

另注：v2 §7 Task 3 行写的「/logout 先 describeRecord（A2+B2）」按方案 1 预设，计划实取方案 2（幂等）并已在 v1 吸收时写明理由，Task 4 文案不区分「本来就没登录」——契约、实现、client 三层自洽，视为等效落盘而非漏项；v1-A2「无论选哪个须补断言」的半句则确属漏项（见上 #3）。

## 六、本轮评审直接落盘的修订清单（供执行 Agent 再批判性复查）

| 计划位置 | 修订 |
|---|---|
| Task 1/4/8 Step 1 | `ls` Expected `exit=1` → `exit=2`（本机 GNU ls 实测） |
| Task 2 测试 | 补 `assert.equal(row?.name, "@deepseek-ai/dsh-llm-pi-ai")`（v1-B5 子项） |
| Task 3 测试 | 「设备码 notice」override 改为送达 notices 后挂起；「status 与 logout」补无记录 logout 断言（v1-A2 子项） |
| Task 3 实现要点 | 补 `export default` 导出形式；补「/start 响应先行、begin 后台任务执行、handler 不得 await begin」 |
| 附录 B | headless 条目按 `normalizeShippedProfile` 实据整条改写（方向修正） |
| 审阅 Checkpoint | 追加评审 Agent v3 复审标记（含结论与勘正） |

## 七、结论

1. 本轮执行 Agent 的批判性复查质量总体很高：10 处中 9 处锚点逐字属实、裁决成立；cancelled 双态映射是本次三轮评审里第一个**靠执行者自己从契约类型里挖出来的真实行为缺陷**，且新测试设计正确（实跑通过）；`autoInstallPeers: false` 的发现把 v1-B3/U2 的一个理论风险变成了结构性不可能。
2. 唯一的方向性错误（headless 元组语义）源于把常量名当语义、未追到唯一使用点（L777 的 `isRetiredTuple` 分支）——这是「锚点属实 ≠ 裁决成立」的典型案例，也正是本轮复审存在的价值。
3. 全部必需修订已由评审 Agent 按既定工作流直接落盘（均带「评审 Agent 注 2026-09-03」标记）；核心架构链（insert 挂服务 → 被动 flow 注册 → begin/interaction → 设备码 notice → settings base 层预置路由 → webServer exact 路由 → client 信封/插槽）在本机 0.1.2-rc.1 安装树下**逐环复核全部成立**。
4. **放行进入 Task 0**。执行 Agent 依「执行纪律」对本轮评审修订做一轮批判性复查（重点：附录 B 改写条目与 Task 3 测试两处新文本）后即可开工；开工前照例 `dsh -V` 比对。

— 评审 Agent，2026-09-03（v3，对应 DSH 0.1.2-rc.1；测试代码实跑于本机 Node v22.21.1）
