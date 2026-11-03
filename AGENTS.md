# AGENTS.md — dsh-copilot-auth

行为决策见 [docs/adr/](docs/adr/)（ADR-0006 起：授权动作即时作废 pending 模型操作）；实施计划见 [docs/plans/](docs/plans/)；领域词汇见 [GLOSSARY.md](GLOSSARY.md)；版本兼容与已知边界见 [README.md](README.md)。

## 测试约定（评审 Q3/Q6 教训固化，2026-11-03）

- **状态机入口迁移枚举**：refresh-flow（`src/refresh-flow.mjs`，machine 逻辑所在）里每个携带操作的态——busy / pendingRestart / result——写用例前先枚举其**全部入口迁移**（apply-ok / hydrate / query-result / retire 闭环），逐入口出用例。漏入口＝跨会话场景裸奔（Q6 实录：Q5 初版只测 apply-ok 落点，水合落点 `result` 装旧 lastResult 残影，放弃出口携旧 id → operation-mismatch 永远失败）。
- **fake 内核分支保真 + 真集成兜底**：service 层测试的 fake transaction 必须镜像真内核（`src/refresh-transaction.mjs`）的全部分支——含幂等/早退分支；新导出的 service 方法至少配一条**真内核**集成用例（假对象只留 I/O），样板 `test/integration-invalidate.test.mjs`。mock 漂移由集成层机械捕获（Q3 实录：fake retire 缺 idempotent 分支＝假绿，评审探针才暴露）。
- 协议只增不改：refresh 协议（`PROTOCOL_VERSION`）字段/取值变更前，先核对 client 三分支与 locale 键（zh/en 对称）同步——操作语义改了，用户可见文案必须跟着改。

## 发版纪律

- 版本三处同步（`package.json` + `package-lock.json` 根 + `packages.""`），不同步不 tag（know-how 031）。
- 上架判定以 npmjs 直查为准，CI 绿 ≠ 上架（know-how 018）；scoped 包长尾可到 ~1 小时，勿提前重推 tag。
- 发版说明由 `chore(release)` commit message 承载；`docs/CHANGELOG.md` 矩阵封存于 v1.2.20，不再追加。
