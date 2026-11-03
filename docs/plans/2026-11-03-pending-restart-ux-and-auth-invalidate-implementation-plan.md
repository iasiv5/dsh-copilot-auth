# pending-restart 分态文案与 busy 出口扩展 + 授权动作即时作废 pending（实施计划）

## 目标

落地 ADR-0006 与 2026-11-03 事故（know-how 032 §6）暴露的三类缺口，随 v1.2.25 发布：

1. **P0-1 busy 横幅分态文案**：`pending-restart` 态不再显示「另一个操作正在处理此资源，请稍后再试」（该文案在此场景下永远无法通过重试满足），改显示「上一次更改已保存、待重启生效」语义的横幅。
2. **P0-2 busy 态 retire 出口扩展**：busy 态的「结束旧配置意图」按钮从仅 `recovery-needed` 扩展到 `pending-restart`，使用区分文案（放弃的是「待重启的更改」而非「旧意图」），GUI 自足、无需 API。
3. **P1 授权动作即时作废（ADR-0006）**：`logout` / `start` bump 栅栏的同一时刻，即时把进行中的 refresh 操作终结为 `intent-retired`（`error: "superseded-by-auth-action:<source>"`），消除「重启才暴露 drift」的时序陷阱；boot 漂移检查降级为崩溃窗口兜底。
4. **README 已知边界**按新语义改写（原「apply 后到重启前避免授权动作」的自律约束不再必要）。

## 设计依据

- ADR-0006（`docs/adr/0006-auth-action-immediately-invalidates-pending-refresh.md`，2026-11-03）：方案比较（A 现状 / B 即时作废【采纳】 / C 身份绑定【拒绝，无身份观测】 / D bump 后置【已被 1.2.24 门禁前置覆盖】）。
- 2026-11-03 实录时序链与两态鉴别：`01_docs/dsh-intall-know-how/032-copilot-auth-refresh-busy-intent-drift.md` §6。
- 既有事实（源码定谳 2026-11-03）：
  - `start()` ALREADY_CONFIGURED 门禁已前置于 bump（`src/auth-host.mjs` L66-71），被拒 start 无副作用；
  - `logout()` 无条件 bump（`src/auth-host.mjs` L145，注释「旧预览/模型配置意图先行失效」）；
  - 授权 handoff `onAuthorized → runSync → syncAvailableModels`（`src/host.mjs` L385-397）确实可能写模型数据——共享栅栏对 handoff 路径必要，故不拆栅栏、只提前暴露。

## 全局约束（违反即停）

1. **失效语义零变化**（ADR-0006 决策 1）：作废不可回滚、已落盘目录增量保留、可重新预览重做；`logout`/`start` 的门禁、时延、返回值语义不变。
2. **协议只增不改**：`lastResult.error` 新增受控取值 `superseded-by-auth-action:auth-start|logout`；`PROTOCOL_VERSION` 不变；既有字段零改动。
3. **水合判序钉死判据不变**（继承 1.2.21 计划全局约束 7）：hydrate 仅在 `phaseResult.status === "recovery-needed"` 时优先于旧 `lastResult`；`pending-restart` 的水合行为（`restartStates ∪ pendingRestart` 落 pendingRestart 态）零改动。
4. **客户端不新增控件种类**（继承 1.2.21 约束口径）：仅扩展既有横幅/按钮/弹窗的可见条件与文案键。
5. **授权主路径不被阻塞**：`onIntentBump` 为 fire-and-forget 注入回调；invalidate 失败只 `ctx.logger?.warn`，绝不影响 `start`/`logout` 的结果。
6. **测试桩与生产键名一致**；门禁 = `node --test` 全量绿（基线见测试任务）。
7. **发版纪律**：031（package.json + package-lock 根 + `packages.""` 三处同步，不同步不 tag）、018（npmjs 直查轮询，绿 ≠ 上架）、037/039 §8（分离式重启通道）。

## 架构快照

```
auth-host.mjs（授权侧）
  start():  [gates] → intentIO.bump() ──→ onIntentBump?.("auth-start")   ← 新增注入回调，同步触发、不 await
  logout(): intentIO.bump() ──────────→ onIntentBump?.("logout")
host.mjs（接线）
  createAuthorizationController({ …, onIntentBump }) ←→ refreshService（晚绑定：service 可能晚于 controller 创建）
  onIntentBump = (source) => void refreshServiceRef?.invalidateForAuthAction(source)?.catch(warn)
refresh-service.mjs
  invalidateForAuthAction(source)                     ← 新增；source ∈ {auth-start, logout}
    └─ queue(() => transaction.retire({ operationId: <active?.operationId>, reason }))
         ├─ activeOperation 存在 → terminalize：lastResult={status:"intent-retired", error:reason, drift:true}
         └─ 不存在 → { ok:true, invalidated:false }（幂等）
refresh-transaction.mjs
  retire({operationId, reason})                       ← 加 reason 参数；error = reason ?? (drift ? 旧文案 : null)
  bootRecover 漂移检查（L394）保留为兜底，注释更新
client.jsx（P0，构建产物 lib/client.js 随包发布）
  busy 横幅：active.phaseResult.status === "pending-restart" → t("busyPendingRestart")，否则 t("busy")
  busy 按钮：status ∈ {recovery-needed → retireBtn, pending-restart → retireBtnPending}
  retireConfirm 弹窗文案按同条件选 retireConfirmText / retireConfirmPending
  result 态：lastResult.error 前缀 superseded-by-auth-action → t("retiredByAuth")
```

## 文件结构与职责

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/refresh-transaction.mjs` | 改 | `retire` 增加 `reason` 形参；boot 漂移检查注释改写为兜底定位 |
| `src/refresh-service.mjs` | 改 | 新增 `invalidateForAuthAction(source)` 并导出 |
| `src/auth-host.mjs` | 改 | `createAuthorizationController` 新增 `onIntentBump` 注入项；两处 bump 后调用 |
| `src/host.mjs` | 改 | 构造 `onIntentBump` 晚绑定接线并传入 controller |
| `src/client.jsx` | 改 | 新增 4 个文案键（zh/en）；busy 横幅/按钮/确认弹窗分态；result 态 retiredByAuth 分支 |
| `lib/client.js` | 构建 | `npm run build` 产物，随源码同 commit |
| `test/refresh-transaction.test.mjs` | 改 | retire reason 用例 |
| `test/refresh-service.test.mjs` | 改 | invalidateForAuthAction 有/无 activeOperation 两用例 |
| `test/auth-host.test.mjs` | 改 | onIntentBump 触发矩阵（成功 start / ALREADY_CONFIGURED 拒绝 / logout / ATTEMPT_RUNNING 拒绝） |
| `README.md` | 改 | 已知边界段改写 |
| `docs/CHANGELOG.md` | 改 | 1.2.25 条目 |
| `package.json` / `package-lock.json` | 改 | 1.2.25 三处同步（031） |

不新增文件；不触碰 `syncAvailableModels`/`model-update.mjs`、凭据读写、目录写盘、preview/apply 门禁。

## 任务清单

### Task 1：`refresh-transaction.retire` 支持 reason

- 文件：`src/refresh-transaction.mjs`
- 动作：`async function retire({ operationId } = {})` → `async function retire({ operationId, reason } = {})`；构造 `result` 处 `error:` 字段改为 `reason ?? (drift ? "intent-version-drift: old target not consumed" : null)`；`reason` 非字符串或长度 >120 时忽略（防御）。bootRecover 漂移分支（L394 附近）上方注释追加一行：「兜底定位：正常路径的失效已由 auth 动作即时作废（ADR-0006），此处只应被崩溃窗口/外部改写触达」。
- 验证：`cd ~/workspace/dsh-copilot-auth && node --test test/refresh-transaction.test.mjs` 现有用例全绿；新增用例（同文件）：retire 携 `reason:"superseded-by-auth-action:logout"` → `lastResult.error` 逐字等于该串、`status:"intent-retired"`；不携 reason 的既有用例行为不变。
- 失败先行：先写用例跑一次确认红（reason 尚不支持），再改实现转绿。

### Task 2：`refresh-service.invalidateForAuthAction`

- 文件：`src/refresh-service.mjs`
- 动作：新增 `async function invalidateForAuthAction(source)`：`requireDeps()`；`source` 不在 `["auth-start","logout"]` → `throw flowError("INVALID_SOURCE", "invalid invalidate source")`；`return queue(async () => { const res = await transaction.retire({ operationId: undefined, reason: \`superseded-by-auth-action:${source}\` }); return res?.ok && res?.idempotent !== true ? { ok:true, invalidated:true, result: res.result } : { ok:true, invalidated:false }; })`。加入 `return { … }` 导出表。
- 注意（评审 Q3 修订）：真内核 retire 在无 active 且 lastResult 为空时会经 `lastResult.operationId === undefined` 误入 idempotent 分支返回 `{ok:true,idempotent:true,result:null}`——故 invalidate 的映射必须以 `idempotent !== true` 守卫，该情形映射为 `invalidated:false`（没有任何操作被终结，不虚报契约语义）；内核 retire 语义零改动（全局约束 1），内核怪癖由 TX_RETIRE_UNDEFINED_OP 钉例防漂移。`operationId` 恒传 `undefined`（transaction.retire 的既有语义＝终结当前 activeOperation）——service 层不需要读 state，也不需要校验归属。
- 验证：`node --test test/refresh-service.test.mjs`；新增两用例：①有 activeOperation（用既有夹具构造）→ `invalidated:true` 且 `/status` 的 `activeOperation` 为 null、`lastResult.error` 逐字匹配；②无 activeOperation → `invalidated:false` 且不抛。非法 source 用例断言抛 `INVALID_SOURCE`。
- Consumes：Task 1 的 `retire({reason})`。Produces：`invalidateForAuthAction`（Task 3 接线消费）。

### Task 3：auth-host 注入回调 + host.mjs 接线

- 文件：`src/auth-host.mjs`、`src/host.mjs`
- 动作：
  - auth-host：`createAuthorizationController(ctx, { …, onIntentBump } = {})`；`start()` 内 `const originIntentVersion = intentIO.bump();` 之后、构造 attempt 之前：`if (typeof onIntentBump === "function") { try { onIntentBump("auth-start"); } catch { /* 回调异常不阻断授权 */ } }`；`logout()` 内 `intentIO.bump();` 之后同型调用 `onIntentBump("logout")`。两处均为同步触发、不 await、不感知回调内部失败（回调自身兜异常）。
  - host.mjs：已核实（2026-11-03）controller 创建于 `src/host.mjs:393`、`refreshService` 创建于 `src/host.mjs:479`（晚于 controller，且依赖 installInfo/transaction 解析）——晚绑定方案确认必要：controller 创建前声明 `let refreshServiceRef = null;`，`onIntentBump = (source) => { const svc = refreshServiceRef; const f = svc?.invalidateForAuthAction; if (typeof f !== "function") return; Promise.resolve(f.call(svc, source)).catch((err) => ctx.logger?.warn?.("copilot-auth: invalidate for %s failed: %s", source, String(err?.message ?? err))); }`；service 创建处（L479）回填 `refreshServiceRef = refreshService;`；controller opts（L393-397）传入 `onIntentBump`。invalidate 只经 service 自身 queue 串行化即可，不叠加 `refreshMutex`（那是 route 层与 preview 互斥的机制，auth 路径无需）。
- 验证：`node --test test/auth-host.test.mjs`；新增四用例（注入 spy）：①门禁全过的 start → spy 逐字收到 `"auth-start"` 恰一次；②ALREADY_CONFIGURED 拒绝的 start → spy 不被调用；③成功 logout → spy 收到 `"logout"`；④ATTEMPT_RUNNING 拒绝的 logout → spy 不被调用。另有 host.test.mjs 接线冒烟（若该文件已有宿主组装用例则追加「logout 后 service 的 lastResult.error 前缀匹配」用例；无组装用例则依赖 Task 2 单测 + 真机 E2E）。
- Consumes：Task 2 的 `invalidateForAuthAction`。

### Task 4：client.jsx 分态文案与 busy 出口

- 文件：`src/client.jsx`（构建产物 `lib/client.js` 由 `npm run build` 再生，随同 commit）
- 动作：
  - 文案键新增（zh L180-185 区、en L85-95 区各 4 键）：
    - `busyPendingRestart`：zh「上一次更改已保存、待重启生效；重启前无法应用新的更改。」en `"The previous change is saved and takes effect after restart. New changes cannot be applied until then."`
    - `retireBtnPending`：zh「放弃待重启的更改」en `"Discard the pending change"`
    - `retireConfirmPending`：zh「放弃后，本次待重启的更改将被丢弃；已落盘的目录数据保留，后续可重新预览并应用。」en 对应
    - `retiredByAuth`：zh「授权状态已变化（登录或退出登录），进行中的模型配置更改已作废；请重新预览并应用。」en 对应
  - busy 横幅（L765-766）：文案按 `flow.active?.phaseResult?.status === "pending-restart"` 选 `t("busyPendingRestart")`，否则 `t("busy")`；`retireError` 后缀逻辑保留。
  - busy 按钮（L768-771）：渲染条件扩展为 `["recovery-needed","pending-restart"].includes(...)`；按钮文案按同条件选 `retireBtn` / `retireBtnPending`。
  - retireConfirm 弹窗：文案键按同条件选 `retireConfirmText` / `retireConfirmPending`（定位 `t("retireTitle")` 渲染处，L1162 附近的 bundle 对应源码区）。
  - machine：busy 态 `retire-request` 分支条件（源码内 `state.name === "busy" && state.active?.phaseResult?.status === "recovery-needed"`）扩展为 `|| … === "pending-restart"`。
  - result 态：`lastResult.status === "intent-retired"` 且 `lastResult.error` 以 `superseded-by-auth-action:` 为前缀时，结果消息渲染 `t("retiredByAuth")`（既有 intent-retired 其余形态渲染不变）。
- 约束自查：不新增控件种类（仅既有横幅/按钮/弹窗的条件与文案）；水合判序零改动。
- 验证：`npm run build` 成功；`grep -o "busyPendingRestart\|retireBtnPending\|retireConfirmPending\|retiredByAuth" lib/client.js | wc -l` ≥ 8（zh+en 各键）；`grep -o "superseded-by-auth-action" lib/client.js | wc -l` = 1（一处 `startsWith` 前缀匹配即覆盖 auth-start/logout 全部受控取值，语义完备——评审 Q2 修订：原「≥2」为计划数字错误）。真机视图验证列入 Task 7 E2E（不主动制造 pending-restart 状态，见最终验证）。
- Consumes：无（纯前端分支）。Produces：无服务端依赖。

### Task 5：README 已知边界改写

- 文件：`README.md`
- 动作：`grep -n "已知边界\|重启\|授权" README.md` 定位已知边界/使用说明段；改写为行为说明：「模型更改含目录增量时，应用后需重启宿主生效（页面会提示）；期间新的更改会被拒绝并明确提示等待重启。登录/退出登录会立即作废进行中的模型更改（历史结果中标注原因），重新预览应用即可。」删除/改写任何与「apply 后避免授权」自律约束相关的旧表述（若尚无此段则新增小节）。
- 验证：人工读一遍改动 diff；`grep -n "superseded\|待重启\|即时作废" README.md` 命中新表述。

### Task 6：全量测试 + CHANGELOG + 版本三处同步

- 动作：`node --test` 全量绿（记录用例总数，对照 1.2.24 基线只增不减）；版本说明**不写** `docs/CHANGELOG.md`——该矩阵已封存于 v1.2.20（文件头自我声明），1.2.21 起发版说明由 `chore(release)` commit message 承载（仓库惯例，评审 Q1 裁定采纳）；`package.json` 与 `package-lock.json`（根 + `packages.""`）同步 1.2.24→1.2.25（031：`grep '"version"' package.json package-lock.json | head -3` 三行同版本，不同步不 tag）。
- 验证：`node --test` 退出码 0；三处版本 grep 一致；`npm run build` 后 `git status` 中 lib/client.js 已更新。

### Task 7：发版、装机与端到端验证

- 动作（顺序执行，逐条留痕）：
  1. commit（feat/chore 分开或合并按仓库惯例，参照 `git log` 近期风格）；`git tag v1.2.25`；`git push origin main --tags`（分支名以 `git branch --show-current` 为准）。
  2. OIDC Release run 轮询（018：绿 ≠ 上架）：`npm_config_cache=<workspace 内可写路径> npm view @inventec/dsh-copilot-auth version --registry=https://registry.npmjs.org` 直查出 1.2.25 才算上架；scoped 包 staged 长尾可达约 1 小时，勿提前重推 tag。
  3. 装机：`dshm_upgrade` 工具升 `@inventec/dsh-copilot-auth`（市场收录条目）。
  4. 分离式重启（037/039 §8 Host B 通道：`nohup bash -c 'sleep 20 && XDG_RUNTIME_DIR=/run/user/1039 systemctl --user restart openbmc-dsh.service' … &`，当轮最后动作），下一轮核验。
  5. E2E 核验（重启后）：`curl -s http://127.0.0.1:8815/copilot-auth/status` 四项（`activeOperation:null`、`settingsNotServed:[]`、`catalogWritable:true`、`registryInstanceMismatch:false`）；装机版本=1.2.25（profile package.json）；构建指纹探针（037 §5）：从运行实例取插件 client.js，`grep` 新文案键逐字存在；GUI 冒烟：设置页正常渲染、管理模型列表可开可预览。
  6. know-how 032 收尾：§6 追加「已随 1.2.25 收编（ADR-0006：授权动作即时作废；busy 分态文案与出口），真机验证 <一句话证据>」；索引行同步。
- 验证：上述每步的退出码/输出留痕；E2E 四项全绿 + 指纹探针命中才宣告完成。
- 说明：`pending-restart` 与 `retired-by-auth` 两种真机视图**不主动制造**（会改动用户真实模型配置），其验证依赖 Task 2/3 单测 + Task 4 产物断言 + 后续自然复发观察（032 §6 观察期条目承接）。

## 风险与回退

- 回退单位 = 整个 1.2.25（无本地补丁，纯版本回退：`dshm_upgrade` 不支持降级时按 020 操作员通道装指定版）；代码层回退 = revert 单个发版 commit 区间。
- `invalidateForAuthAction` 若与进行中的 apply 并发：queue 串行化保证顺序，最坏情形是 apply 已 terminalize 后 invalidate 落 `invalidated:false`（幂等无害）。
- 晚绑定窗口（service 未建时 auth 动作）：`onIntentBump` 静默跳过，boot 兜底仍在——不产生新死角。

## 执行纪律

- 开始实现前批判性复查本计划；发现缺项/矛盾先修计划再动手。
- 按任务顺序执行，不无声跳步；每任务完成即跑该任务验证。
- 客户端逻辑改动不引入 JSX 测试（仓库无 JSX 测试载体），逻辑性判断尽量留在服务端（本计划已如此切分）。
- 阻塞或计划与仓库现实不符（如 host.mjs 创建顺序与假设不符）→ 停下说明，不猜。

## 最终验证

1. `cd ~/workspace/dsh-copilot-auth && node --test` 全绿，用例数 > 224 基线。
2. `npm run build` 产物含全部新文案键（grep 断言）。
3. 发版链：tag → OIDC run 绿 → npmjs 直查 1.2.25 → `dshm_upgrade` 装机 → 分离式重启 → status 四项全绿 + 指纹探针命中 + GUI 冒烟通过。
4. know-how 032 §6 收编标注完成。

## 评审修订记录（评审 Agent 多轮往来沉淀，2026-11-03）

- Q1（建议→采纳方案 a）：Task 6 CHANGELOG 条目取消——矩阵封存于 v1.2.20，1.2.21 起沿革由 README「版本兼容」+ chore(release) commit message 承载（commit 0f5b791）。
- Q2（建议→采纳）：Task 4 断言 `superseded-by-auth-action` 计数 ≥2 修正为 =1（一处 startsWith 前缀匹配覆盖 auth-start/logout 全部受控取值，原为计划数字错误）（commit 0f5b791）。
- Q3（重要→已修复）：invalidate 映射以 `idempotent !== true` 守卫——真内核在无 active 且 lastResult 为空时经 `undefined===undefined` 误入幂等分支，原实现虚报 invalidated:true；内核 retire 语义零改动，TX_RETIRE_UNDEFINED_OP 钉例防漂移，service mock 补齐幂等分支消除假绿（commit c0e4103）。
- Q4（重要→已修复，组装层）：作废/放弃后内核 restartState 残留使 /status pendingRestart 恒真、刷新后水合落 pendingRestart 态遮蔽作废事实——host.mjs /status 组装处对「activeOperation==null 且 lastResult.status=intent-retired」置 pendingRestart=false；正常 pending-restart 与水合判序（约束 3）零改动；host 正反两态测试 + flow 用例 F（本提交）。
- V6 备注：计划「文件结构与职责」表漏列 src/refresh-flow.mjs（Task 4 machine 改动实际落点），实现正确、计划表笔误，随本节补记。
- Q5（建议→**主人裁定 A：并入 1.2.25**，2026-11-03）：pendingRestart 态主视图放弃出口已实现——machine 增 result 入口分支（携 result.operationId；cancel/retire-fail 回落 pendingRestart 可重试，不落静默空态）、渲染层横幅附「放弃待重启的更改」按钮、结果态新增 discarded 文案（intent-retired 三分支：superseded 前缀→retiredByAuth、error==null→discarded、其余→recoveryNeeded）；README 恢复直述写法。评审补核后随本版发布。
