# ADR 0006 — 授权动作即时作废进行中的模型配置操作（pending 不再等 boot 才失效）

日期：2026-11-03 · 状态：已采纳（实施随 v1.2.25） · 落地版本：v1.2.25

## 背景与问题

`intentVersion`（`<dataDir>/auth-intent.json`，host.mjs `createIntentIO`）是 auth 与模型管理**共享**的失效栅栏：授权动作（`logout`、`start`）无条件 bump；refresh 事务在 preview/apply CAS 与 boot 漂移检查处消费它（refresh-transaction.mjs L394）。boot 漂移检查的本意是兜「preview 之后配置意图变了」的崩溃/竞态窗口，但它兜到了一条**正常路径**：

> apply（含目录增量，op 进入 catalog-landed / pending-restart 两阶段）→ 用户退出登录或重新授权（bump）→ 下次重启时 boot 判 `intent-version-drift` → 挂起的模型配置永不提交，操作滞留 `activeOperation`，用户看到「另一个操作正在处理此资源，请稍后重试」且无任何解释（2026-11-03 实录：09:45 apply → 09:47-48 logout+login → 11:42 重启 → drift，处置见 know-how 032 §6）。

设计上「授权动作作废 pending 模型操作」本身是对的：授权 handoff（`onAuthorized` → `syncAvailableModels`）确实可能写模型数据，身份/授权意图变化后，以旧意图预览的 target 不应被盲提交。**错的不是失效语义，而是失效的暴露时机**——用户在 bump 当刻毫无感知，直到下次重启撞上一个没有出路口的 busy 文案。

另注：032 §4-3 提议的「bump 移到 409 门禁后」在 1.2.24 已不成立为缺口——`start()` 的 ALREADY_CONFIGURED 门禁已前置于 bump（auth-host.mjs L66-71），被拒的 start 不再产生副作用。残余的 bump 来源只剩合法 login/logout。

## 决策

**授权动作 bump 栅栏的同一时刻，即时把进行中的 refresh 操作终结为 `intent-retired`（`error: "superseded-by-auth-action:<source>"`，source ∈ `auth-start | logout`）；boot 漂移检查保留，但降级为崩溃窗口兜底。**

1. 失效语义零变化：哪些动作作废 pending、作废是否可回滚，与今天完全一致（不可回滚；已落盘目录增量保留）。
2. 失效时机从「下次 boot」提前到「bump 当刻」：`auth-host` 的 `start`/`logout` 在 `intentIO.bump()` 成功后经注入回调 `onIntentBump(source)` 触发 `refresh-service.invalidateForAuthAction(source)`（经既有 queue 串行化；无 activeOperation 时幂等 no-op；fire-and-forget，不阻塞授权主路径）。
3. 客户端即时可见：`lastResult.status = "intent-retired"` 已在结果态 retire 按钮清单内；新增按 `error` 前缀的精确文案（「授权状态已变化…请重新预览并应用」），busy/recovery-needed 不再是用户第一次看到的失效形态。
4. 协议只增不改：`lastResult.error` 新增受控取值，`PROTOCOL_VERSION` 不变。

## 考虑过的方案

- **A 维持现状**（boot 才暴露 drift）：拒绝——把设计内失效伪装成「资源忙」错误，正是 2026-11-03 事故的观感来源。
- **B 授权动作即时作废（采纳）**：小面（一个注入回调 + 一个 service 方法 + retire 加 reason 参数）、保守语义保留、UI 即时反馈。
- **C 凭据身份绑定**（重登录同身份则 pending 存活）：拒绝——插件不观测账号身份（无 GitHub /user 观测，引入即新攻击/隐私面），且 handoff 写 settings 的路径使共享栅栏仍有防御价值；成本高收益薄。
- **D 仅把 bump 挪到门禁后**（032 §4-3 原文）：已被 1.2.24 的门禁前置覆盖；对合法 login/logout（本次实录）无效，不解决问题。

## 后果

- `lastResult.error` 出现新受控串 `superseded-by-auth-action:auth-start|logout`；客户端按前缀渲染专用文案。
- 授权动作与 refresh 操作有了可观测的因果：日志/状态里 `intent-retired + superseded-by-auth-action` 即「你退出/重登录过，之前的更改作废了」。
- 「apply 后到重启前避免授权动作」的用户自律约束不再必要（README 已知边界同步改写为行为说明）。
- boot 漂移检查不再被正常路径触达；其触发即意味着崩溃窗口或外部改写，recovery-needed 语义随之更「名实相符」。
