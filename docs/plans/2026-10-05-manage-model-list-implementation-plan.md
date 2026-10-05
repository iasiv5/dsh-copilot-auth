# 管理模型列表（目标状态编辑）实施计划

## 目标

把「补充模型／重建模型列表」双入口合并为单一「管理模型列表」操作：勾选集合即期望终态，移除成为一等能力；风险门控从「按按钮」改为「按实际 diff」（removed>0 ⟹ live 证据＋升级确认）；弹窗改为按状态分组的单表（可新增／在列／待删除候选），支持挽留、清除定制复选框与「对齐账号与目录」快捷动作。设计依据：[设计规格 §4.1/§4.2（2026-10-05 修订）](<../design/2026-10-03-dual-profile-auth-and-models.md>)、[ADR 0005](<../adr/0005-manage-model-list-target-state-editing.md>)、决策树 Q32–Q36。

## 架构快照

- 数据流不变：client 状态机（refresh-flow）→ 8 条 HTTP 路由 → 预览服务（refresh-service，快照 10 分钟）→ 纯策略（model-update）→ 事务内核（refresh-transaction，零改动）。
- 语义核心：`buildModelChange` 从「supplement=追加 / rebuild=交集重建」改为单一 `manage`——目标＝勾选集合；`rows`（全表行集）由纯函数计算，服务端原样投影；新增按账号报告顺序追加末尾，被保留模型维持原对象/顺序，被移除模型定制随模型消失。
- 默认状态三处一致（UI 初始勾选、服务端默认选择、设计默认）：**默认目标＝在列∩(账号∩可解析)**——健康在列保留、候选不勾、待删除候选不勾（删除提案）。存在漂移时初始预览即含删除提案，摘要行如实计数。
- 门控：preview 不因「缓存证据＋删除提案」失败（有效缓存下允许表达删除并由自动升级兜底）；apply 时服务端强制 `removed>0 ⟹ evidence=live 且 catalogSource=latest`，否则 `removals-need-live`。升级确认 ⟺ removed>0 ∨ clearOverrides ∨ 空目标，由 reducer 强制。
- 自动 live 升级：confirming 内任一 preview-ok（含初始预览）满足「removalClass ∧ evidence.source==="cache" ∧ catalogSource==="latest" ∧ 未闩锁」→ client 直接发**新鲜预览**（带同一 selectedIds/clearOverrides/confirmEmpty，不走 basePreviewId），闩锁每次预览会话至多一次；previewId 更换后确认态重置。升级失败回退到原缓存快照的 materialize（保留勾选），横幅提示 `removalNeedsLive`，apply 由服务端门兜底拒绝。
- 协议：`PROTOCOL_VERSION` 2→3；`supplement`/`rebuild` 字面量不再被接受（服务端与 client 均无 legacy 归一分支，两半同包发布，升级后刷新页面即换新 client）。

## 全局约束

- Node.js >=20；peer `@deepseek-ai/cordis: ^4.0.2` 不升级（G01）。
- 兼容目标 DSH `0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`（G02）。
- 路由前缀 `/copilot-auth`、凭据键 `llm-pi-ai/github-copilot` 不变；en/zh 主信息等义；技术详情折叠脱敏（G04）。
- 目录只增不覆盖；不写官方归档；不新增提供方路由（G05）。
- 预览 10 分钟、缓存 24h 同 intentVersion；不自动重启（G07/G08）。
- 文案键**键名沿用现有 DICTS 驼峰风格**（srcLive/srcCache/removedAccount/…），设计规格 §5 表为文案语义规格而非键名字面规格，只要求 en/zh 等义对齐；本轮新增键见「接口契约 → DICTS 键变更」。危险确认初始焦点在取消；可取消阶段 Esc 等价取消。

## 输入工件

- 设计：`docs/design/2026-10-03-dual-profile-auth-and-models.md` §4.1、§4.2、§5、§6（Q32–Q36、M01/M02/M15/M16）
- ADR：`docs/adr/0005-manage-model-list-target-state-editing.md`
- 词汇：`GLOSSARY.md`（管理模型列表／目标状态编辑／在列模型／待删除候选／删除类变更）

## 文件结构与职责

- Modify: `src/shared.mjs` — `PROTOCOL_VERSION` 2→3（唯一改动点）。
- Modify: `src/model-update.mjs` — `buildModelChange` 重写为 manage 语义＋`rows` 计算（纯函数，不触网络/磁盘）。
- Modify: `src/refresh-service.mjs` — 只接受 `operation:"manage"`；默认选择＝在列∩(账号∩可解析)；`clearOverrides`/`confirmEmpty` 透传；投影新增 `rows/overridesMeta/hadModels/catalogNewEntries/clearOverrides`、移除 `candidates`；apply 增 `removals-need-live` 门；删除 rebuild 专用 live 证据门死代码（现 L136-137）及其文件头注释（现 L30）。
- Modify: `src/refresh-flow.mjs` — start 恒发 manage；confirm 门控 diff 化；自动 live 升级闩锁＋失败回退；`select` 事件携带 `clearOverrides`/`confirmEmpty`；`runEffect` 请求体组装扩展。
- Modify: `src/client.jsx` — 单按钮；RefreshModal 重构为分组单表＋工具行动作＋摘要行＋动态风险线；DICTS 增删键。
- Test: `test/model-update.test.mjs`、`test/refresh-service.test.mjs`、`test/refresh-flow.test.mjs`、`test/host.test.mjs`（重写受影响用例；node:test＋assert/strict，中文用例名，沿用现有文件内 helper 风格）。
- Modify: `README.md` — 按内容定位：特性 bullet「➕➖ …（v2 双入口）」（约 L23）、L91-96 节、L111 `protocolVersion: 2`、**两处**测试计数（约 L26「🧪 测试与 CI」与 L123）、L155-156 提法。
- 不改动：`refresh-transaction.mjs`（消费 `diff.writeSet`，形状不变）、`host.mjs`（协议门用 `PROTOCOL_VERSION` 常量自动生效；`removals-need-live`/`empty-target-unconfirmed` 不入其 `serviceError` 白名单，走 409 兜底分支，client 端语义正确）、catalog/auth 两族文件。

## 接口契约（跨任务，先在此钉死）

### buildModelChange（model-update.mjs 导出，Task 2 产出，Task 3 消费）

```js
buildModelChange({
  operation,            // 只接受 "manage"；其他值 → { allowed:false, reason:"invalid-operation", ...}
  rawView, effectiveView, // 形状不变 {modelsPresent, models, modelOverridesPresent, modelOverrides}
  accountIds, resolvableIds,
  selectedIds,          // 完整目标集合（勾选=终态）；undefined/缺省 → 在列∩(账号∩可解析)
                        //   （= rows 中 status==="listed" 者，与 UI 初始勾选态一致）；
                        //   显式传 [] 视为用户空目标意图（触发空目标确认判定）
  clearOverrides = false,
  confirmEmpty = false,
  catalogNewEntryCount = 0,
}) → {
  allowed, reason,      // reason ∈ "invalid-operation" | "inherited-overrides-unclearable" | "empty-target-unconfirmed" | null
  rows,                 // [{ id, status:"addable"|"listed"|"removal-proposal", reason?, customized: bool }]
                        //   addable = 账号∩可解析−在列；listed = 在列∩(账号∩可解析)；
                        //   removal-proposal = 在列−(账号∩可解析)，reason 优先级：不在账号→"not-in-account"，否则"unresolvable"
                        //   customized = id ∈ keys(raw.modelOverrides)；rows 按来源固定，不随勾选迁移
                        //   术语：「在列」单指 status==="listed"（健康在列）；「raw 在列全表」＝全部 rawIds（listed ∪ removal-proposal）
  selectedIds,          // 规范化后目标集合（去重、过滤非法为 warning、保持首现顺序）
  added,                // 勾选∩addable，按 accountIds 预览顺序（非选择顺序）
  removed,              // [{id, reason}]，raw 在列全表（含 removal-proposal）−勾选；reason 优先级：不在账号→"not-in-account"，
                        //   不可解析→"unresolvable"，否则（用户主动取消勾选的健康在列行）→"unchecked"
  kept,                 // 勾选∩raw 在列全表
  warnings,             // {id, reason:"invalid-selection"|"unresolvable"|"already-configured"}（服务端防御，UI 不应能产生）
  targetView,           // {modelsPresent, models, modelOverridesPresent, modelOverrides}
                        //   modelsPresent = raw.modelsPresent ∨ selected 非空（确认后的空目标 = true + []，见下）
                        //   models = 上述为真时 [...rawModels.filter(kept), ...added.map(id=>({id}))]，否则 null
                        //   clearOverrides 且可清 → modelOverridesPresent:false, modelOverrides:null；
                        //   否则布尔/值＝raw 定制**按 kept 过滤**（被移除模型的定制条目不保留，防重加模型复活定制；
                        //   被移除者是唯一定制模型时 present:false → unset；事务端 buildConfigOps 依赖布尔决定 set/unset）
  removalClass,         // removed.length > 0
  overridesMeta,        // { rawPresent, clearable, inheritedOnly }
                        //   rawPresent = raw.modelOverridesPresent 且 keys>0；inheritedOnly = !rawPresent 且 effective 有覆盖；
                        //   clearable = rawPresent；clearOverrides && inheritedOnly → allowed:false
  writeSet,             // { catalogEntries: catalogNewEntryCount>0,
                        //   models: added>0 ∨ removed>0 ∨ (!raw.modelsPresent ∧ selected>0)，
                        //   modelOverrides: clearOverrides ∧ clearable，
                        //   overridesUnclearable: clearOverrides ∧ inheritedOnly }
}
```

- 空目标确认仅约束**用户显式提交**的空选择：`selectedIds` 显式提供（!==undefined，含 []）∧ rawIds.length>0 ∧ selected 空 ∧ !confirmEmpty → `allowed:false, reason:"empty-target-unconfirmed"`。服务端默认选择（未传 selectedIds）为空——raw 在列全表全部为待删除候选的全漂移账号——时初始预览**放行**（removed＝raw 在列全表），风险由确认门 needsEscalate（removed>0）与空目标 `event.empty` 兜底，弹窗必须能打开（M01）。
- 确认后的空目标落盘形状：rawIds>0、selected 空、confirmEmpty:true → targetView 为 **modelsPresent:true, models:[]（显式空列表）**，不是 unset——unset 会使路由回到「尚未配置」，下次登录被首次填充静默回填整表（§3.5），恰违背清除语义；与旧 rebuild 的落盘形状一致。判据用 **rawIds.length>0**（raw 在列全表非空）而非 raw.modelsPresent：显式空列表没有可清除对象，显式提交空选择且无在列时是无操作、不需要 confirmEmpty。
- selected 空且 rawIds 空 → 无操作（writeSet.models:false、targetView 与 raw 一致）。

### refresh/preview 请求与投影（Task 3 产出，Task 4/5 消费）

- 请求体：`{ protocolVersion:3, operation:"manage", catalogSource?, basePreviewId?, selectedIds?, clearOverrides?, confirmEmpty? }`。
- 投影（projectPreview 返回体）在现有字段基础上：新增 `rows`（原样投影 diff.rows）、`overridesMeta`、`hadModels`（**rawIds.length>0**，与空目标判据同源）、`catalogNewEntries`（catalog.newEntryCount ?? 0）、`clearOverrides`（快照回显）；`diff.selectedIds`（规范化目标集合）加入 diff；删除 `diff.candidates`。
- 错误码（沿用服务端 `flowError(code, code)` 小写蛇形）：新增 `removals-need-live`（apply 阶段）；`empty-target-unconfirmed`（preview 阶段，替代原 `empty-intersection-unconfirmed` 字面量）；`inherited-overrides-unclearable` 保留。三者均不经 host.mjs `serviceError` 白名单，走 409 兜底分支（httpStatus 409，client 端语义正确），host.mjs 无需改动。

### refresh-flow 状态（Task 4 产出，Task 5 消费）

- `start` 事件：`{type:"start", operation:"manage"}`（`operation` 字段保留，恒为 manage；无 legacy 字面量归一分支）。
- `select` 事件：`{type:"select", selectedIds, clearOverrides, confirmEmpty}`（`confirmEmpty` 由 UI 在 selectedIds 为空且 `preview.hadModels` 时置 true，供空目标物化）。
- `runEffect` preview 请求体组装：`selectedIds/clearOverrides/confirmEmpty` 在 effect 上有定义时即携带（不依赖 basePreviewId 存在）；无任何选择字段的初始预览不携带（服务端走默认选择）。
- confirming 状态新增 `liveUpgradeUsed:boolean`（闩锁）与 `lastSelection`（记录最近一次提交选择字段的**在场性**：`{selectedIds?, clearOverrides?, confirmEmpty?}`；初始默认预览为空对象）。任一 preview-ok 落入 confirming 时判定：`!liveUpgradeUsed ∧ diff.removed.length>0 ∧ evidence.source==="cache" ∧ catalogSource==="latest"` → 置闩锁并发**新鲜预览** effect，选择字段**逐字段复制 lastSelection**——初始默认预览升级时不带任何选择字段，服务端按新鲜 live 数据重算默认（全漂移 corner 因此不可能触发空目标确认）；否则原位替换。
- 升级软降级：升级的 preview-ok 落地后若 `evidence.source` 仍非 "live"（live 拉取失败被服务端回退有效缓存，refresh-service.mjs:43-51 的 catch 路径）→ 视同回退口径：置 `staleNotice`；闩锁保持已消耗、不再重试升级；不落 failed，UI 按 Task 5 的禁用条件禁用 apply 并显示 `removalNeedsLive` 横幅。
  - 锁定口径（与设计 §4.1 降级清单一致）：仅 `evidence.stale ∨ catalogSource∈{local,overlay}` 锁定待删除候选；**有效缓存（≤24h 同 intentVersion）不锁定**，删除表达由自动升级兜底。
  - 升级失败回退：新鲜预览 `preview-fail` 且本次会话已闩锁升级 → 以升级前快照的 previewId 发 materialize（选择字段同样**逐字段复制 lastSelection**），弹窗保持挂载、勾选保留，`staleNotice` 置位提示 `removalNeedsLive`；apply 由服务端门兜底拒绝。materialize 也失败才落 failed。
- confirm 事件门（reducer 强制）：`needsEscalate = diff.removed.length>0 ∨ preview.clearOverrides===true ∨ (diff.selectedIds空 ∧ preview.hadModels)`；needsEscalate 时 `event.second!==true` 拒绝；空目标另需 `event.empty===true`；`materializing` 时拒绝；`evidence.stale` 时拒绝。UI 的 stage 0→1→2 流程与今日重建相同（1=二次确认，2=空目标追加确认）。

### DICTS 键变更（Task 5；键名沿用现有驼峰风格）

- 删除：`supplement、rebuild、supplementTitle、rebuildTitle、candidates、supplementRisk、rebuildRisk、addedModels、removedModels、keptModels`。
- 保留但语义变为全表：`selectAll、selectNone`。
- 新增：`manageModels（管理模型列表/Manage model list）、groupAddable（可新增/Available to add）、groupListed（在列/In list）、groupRemoval（待删除候选/Proposed for removal）、alignAction（对齐账号与目录/Align with account & catalog）、removalRisk（将移除 {count} 个在列模型，其定制随之清除。/{count} listed models will be removed; their customizations are removed with them.）、clearOverrides（同时清除全部模型定制。/Also clear all model customizations.）、inheritedOverrides（存在继承的模型定制，无法在此清除。/Inherited model customizations cannot be cleared here.）、retain（挽留：重新勾选以保留/Keep: re-check to retain）、summaryLine（应用后共 {total} 个：保留 {kept} · 新增 {added} · 移除 {removed}/After applying: {total} models — {kept} kept · {added} added · {removed} removed）、catalogNotice（目录将新增 {count} 条描述/{count} catalog entries will be added）、removalNeedsLive（移除类更改需要实时账号证据/Removals require live account evidence）、noChanges（无需更改，目录也无新数据。/No changes and no new catalog entries.）、customizedBadge（有定制/Customized）`。
- 改文案不改键名：`removedAccount→账号未报告/Not reported by this account`、`removedUnresolvable→目录无法解析/Not resolvable by the current catalog`、`srcCache→账号模型：缓存，获取于 {time}；移除类更改需升级为实时证据/removals require upgrading to live evidence`（原「仅可用于新增，不可用于移除」在 Q36 自动升级交互下图文打架，按 R2-6 微调；设计 §5 对应行同步修订）。
- 不新增 `authChanged`（反驳，见评审记录 R1-8）：§4.2 的自动重预览使 auth-changed 呈亚秒级瞬态，专用横幅无信息增量；残余场景由 `previewStale` 覆盖。§5 中 `catalogChanges/listChanges/security` 等历史欠账键不在本计划范围（`catalogNotice` 已承担目录维度知情）。

---

## 任务清单

### Task 1: 协议版本升级 2→3

- 目标：新旧两半不同版本时干净拒绝，防止 v2 client 逼近 v3 host 的语义陷阱。
- 涉及文件：`src/shared.mjs`（L5）。
- 接口契约：Consumes 无；Produces `PROTOCOL_VERSION=3`（host L676 门与 client-http 请求体自动跟随）。
- 验证范围：全量测试绿；所有硬编码 `protocolVersion: 2` 的测试改为 import 常量。

- [ ] Step 1: 检查硬编码：`grep -rn "protocolVersion" test/ src/ | grep -v "src/shared.mjs"`
- Run: `grep -rn "protocolVersion" /home/ubuntu/workspace/dsh-copilot-auth/test /home/ubuntu/workspace/dsh-copilot-auth/src | grep -v "src/shared.mjs"`
- Expected: 列出全部引用点；已知 `test/host.test.mjs` 多处硬编码 `protocolVersion: 2`、`test/refresh-flow.test.mjs` 断言字面量 2——将它们改为 import `PROTOCOL_VERSION`
- [ ] Step 2: 修改 `PROTOCOL_VERSION = 3`，行尾注释补「v3：manage 目标状态编辑（ADR 0005）」
- [ ] Step 3: 全量测试
- Run: `npm test`（workdir: `/home/ubuntu/workspace/dsh-copilot-auth`）
- Expected: 0 failing（字面量断言已改为常量；仅 `invalid operation` 类负例不受影响）

### Task 2: buildModelChange 重写为 manage 语义（TDD）

- 目标：纯策略层实现「勾选集合即终态」，产出 rows/overridesMeta/removalClass。
- 涉及文件：`test/model-update.test.mjs`（重写）、`src/model-update.mjs`（重写）。
- 接口契约：Produces 上述「接口契约」节的 `buildModelChange` 签名与语义；Consumes 无（纯函数）。
- 验证范围：本任务测试文件全绿。

- [ ] Step 1: 重写 `test/model-update.test.mjs`，用例清单（沿用现有 `view()` helper）：
  1. 默认选择（selectedIds 缺省）＝在列∩(账号∩可解析)：全部健康在列时 zero-change（对象/顺序逐字保留、writeSet 全 false）；存在漂移时 removed 恰为 removal-proposal 行
  2. 勾选一个候选 → 追加在末尾、按 accountIds 顺序（打乱 selectedIds 顺序断言）、writeSet.models=true
  3. 取消勾选：健康在列行 → reason "unchecked"；removal-proposal 行 → "not-in-account"/"unresolvable"（按优先级）；被移除模型定制随之消失（不在 targetView.modelOverrides）、其他模型 modelOverrides 保留、removalClass=true；若被移除者是唯一定制模型 → modelOverridesPresent:false（unset）
  4. 挽留：removal-proposal 行重新勾选 → 进 kept、不出现在 removed、其定制保留
  5. rows 三态与 customized 标记正确（含 reason 优先级：既不在账号也不可解析 → not-in-account）；rows 不随勾选变化
  6. clearOverrides=true 且 raw 有覆盖 → targetView.modelOverridesPresent=false、modelOverrides=null、writeSet.modelOverrides=true
  7. clearOverrides=true 且仅继承覆盖 → allowed:false, reason:"inherited-overrides-unclearable"、overridesUnclearable:true
  8. 空目标：rawIds>0 且**显式** selectedIds=[] → 无 confirmEmpty 时 allowed:false "empty-target-unconfirmed"；confirmEmpty:true 时 targetView＝modelsPresent:true、models:[]（显式空列表，防首次填充回填）、writeSet.models:true；显式空选择但 rawIds=0（含显式空列表配置）→ 无操作、不需要 confirmEmpty；selectedIds 缺省且全漂移（raw 在列全表全部为 removal-proposal）→ allowed:true、removed＝raw 在列全表、removalClass=true
  9. 空选择且无配置 → 无操作（writeSet.models:false、modelsPresent:false）
  10. 非法选择（不在 rows 宇宙/重复/不可解析）→ 过滤＋warnings；operation:"supplement"/"rebuild" → invalid-operation
- Run: `node --test test/model-update.test.mjs`
- Expected: 全部失败（旧实现无 rows/overridesMeta/removalClass，语义不符）
- [ ] Step 2: 按接口契约重写 `src/model-update.mjs`（保留文件头注释风格，更新为 manage 语义说明）
- [ ] Step 3: 跑测试至绿
- Run: `node --test test/model-update.test.mjs`
- Expected: 全部通过
- [ ] Step 4: checkpoint commit（建议信息：`model-update: manage 目标状态语义＋rows 计算`）

### Task 3: refresh-service 接线、投影与 apply 门（TDD）

- 目标：服务端只认 manage、默认选择、投影新字段、apply 强制删除类证据门；清理 rebuild 死代码。
- 涉及文件：`test/refresh-service.test.mjs`、`test/host.test.mjs`、`src/refresh-service.mjs`。
- 接口契约：Consumes Task 2 的 `buildModelChange`；Produces「接口契约」节的 preview 投影字段与 `removals-need-live`/`empty-target-unconfirmed` 错误码。
- 验证范围：本任务两个测试文件全绿；`test/refresh-transaction.test.mjs` 不回归。

- [ ] Step 1: 更新/新增用例：
  - `test/refresh-service.test.mjs`：
    1. preview 不带 selectedIds → diff.selectedIds＝在列∩(账号∩可解析)、漂移时 removed 含 reasons、rows 三态正确、投影含 overridesMeta/hadModels/catalogNewEntries/clearOverrides、无 candidates 字段；含**全漂移夹具**（raw 在列全表全部为 removal-proposal）→ 初始预览放行、removed＝raw 在列全表
    2. basePreviewId materialize 携带 selectedIds+clearOverrides+confirmEmpty → 新 previewId、原 expiresAt、clearOverrides 回显
    3. operation:"supplement"/"rebuild" → 400 INVALID_OPERATION
    4. 空目标确认仅限显式路径：materialize 携带 selectedIds=[] 且无 confirmEmpty（rawIds>0）→ `empty-target-unconfirmed`；带 confirmEmpty → allowed 且 targetView＝显式空列表（modelsPresent:true, models:[]）
    5. clearOverrides 且仅继承覆盖 → `inherited-overrides-unclearable`（preview 即拒，沿用 flowError(diff.reason) 路径）
    6. apply 门：快照 diff.removed>0 且 evidence.source="cache" → `removals-need-live`（409 兜底，非 5xx）；catalogSource="overlay" 同拒；live+latest → 通过并进入事务（mock transaction 断言 writeSet）
    7. 回归：纯新增 cache 证据 apply 成功；幂等/423/stale 用例改用 manage 字面量后保持绿
  - `test/host.test.mjs`：8 个走真实路由的模型用例改用 import 的 `PROTOCOL_VERSION` 常量与 `operation:"manage"`；原 rebuild 空交集用例改写为 manage 空目标 confirmEmpty 语义；保留授权族用例不动
- Run: `node --test test/refresh-service.test.mjs test/host.test.mjs`
- Expected: 新用例失败（旧实现）
- [ ] Step 2: 修改 `src/refresh-service.mjs`：
  - `preview()`：operation 校验只认 "manage"（删除 supplement/rebuild 分支）；body 读取 `clearOverrides`/`confirmEmpty`；`selectedIds` 缺省时取 `rawIds∩(accountIds∩resolvableIds)`（从 `config.view` 与本次 evidence/catalog 取），**显式提供（含 []）原样透传**——空目标确认仅对显式路径生效（由 buildModelChange 以 selectedIds!==undefined 判定）；`diffFromInputs` 透传 `clearOverrides`；快照存 `clearOverrides`
  - `projectPreview()`：按接口契约增删字段（含 `hadModels: rawIds.length>0`）
  - `apply()`：在现有 `snap.evidence.stale` 检查后追加——`if ((snap.diff.removed ?? []).length > 0 && (snap.evidence.source !== "live" || snap.catalog.catalogSource !== "latest")) throw flowError("removals-need-live", "removals-need-live")`——(code, code) 约定：该码不经 host serviceError 白名单，409 兜底透传 err.message，只有 message 同为码时 client 端 errorCode 才是小写码
  - 删除 rebuild 专用 live 证据门死代码（现 L136-137 `EVIDENCE_UNAVAILABLE` 分支）与文件头对应注释（现 L30）
- [ ] Step 3: 跑测试至绿（含 refresh-transaction 回归）
- Run: `node --test test/refresh-service.test.mjs test/host.test.mjs test/refresh-transaction.test.mjs`
- Expected: 全部通过
- [ ] Step 4: checkpoint commit（建议信息：`refresh-service: manage 接线＋removals-need-live 门＋host 用例迁移`）

### Task 4: refresh-flow 状态机（TDD）

- 目标：确认门控 diff 化＋自动 live 升级闩锁与失败回退＋select 携带 clearOverrides/confirmEmpty＋runEffect 组装扩展。
- 涉及文件：`test/refresh-flow.test.mjs`、`src/refresh-flow.mjs`。
- 接口契约：Consumes Task 3 投影字段（rows/diff.selectedIds/hadModels/overridesMeta/clearOverrides/evidence/catalogSource）；Produces「接口契约」节的状态机行为；`refreshBlocked` 不变。
- 验证范围：本任务测试文件全绿。

- [ ] Step 1: 更新/新增 `test/refresh-flow.test.mjs` 用例（沿用文件内 `previewBody`/`makeFetch` helper，previewBody 增加 `rows/overridesMeta/hadModels/clearOverrides` 字段）：
  1. start（operation 缺省/manage）→ preview 请求体 operation:"manage"；无 legacy 字面量分支
  2. 确认门矩阵：removed>0 / clearOverrides=true / 空目标 各自单独 confirm(second:false) 被拒；second:true 通过；纯新增单次 confirm 通过
  3. 空目标：second:true 但 empty 缺省 → 拒；empty:true → 通过
  4. 自动 live 升级：缓存证据（evidence.source="cache"）下——① 初始预览含 removed>0 → preview-ok 后自动发**新鲜** preview effect（无 basePreviewId、选择字段逐字段复制 lastSelection）、闩锁置位；② 同一会话再次 preview-ok 含删除 → 不再升级；③ live 证据 / stale 证据 / catalogSource∈{local,overlay} → 不触发升级；④ 升级在途 materializing=true → confirm 被拒（防旧缓存 previewId 提交），落地/回退后清位；⑤ 全漂移＋cache＋latest：初始预览（无选择字段）放行后升级 → 新鲜预览 effect **不带任何选择字段**（lastSelection 为空对象），不触发 empty-target-unconfirmed；⑥ 软降级：升级后 preview-ok 仍落 cache（live 拉取失败，服务端回退有效缓存）→ 闩锁已消耗不再升级、staleNotice 置位、不落 failed（UI 据此禁用 apply）
  5. 升级失败回退：新鲜预览 preview-fail 且已闩锁 → 发出对升级前 previewId 的 materialize select（同选择字段）、弹窗状态保持 confirming、staleNotice 置位；materialize 再失败才落 failed
  6. select 事件：selectedIds 空且 hadModels → confirmEmpty:true 传入 effect；非空选择不携带 confirmEmpty
  7. materializing 时 confirm 被拒；preview-stale 409 → 自动重预览路径用 manage
- Run: `node --test test/refresh-flow.test.mjs`
- Expected: 新用例失败（旧实现）
- [ ] Step 2: 修改 `src/refresh-flow.mjs`：
  - `start`/preview effect：operation 归一 "manage"；select effect body 增加 `clearOverrides`/`confirmEmpty`
  - `runEffect` preview 分支：`selectedIds/clearOverrides/confirmEmpty` 在 effect 有定义时即携带（不依赖 basePreviewId；现 L218-224 的条件组装改为字段级判空）
  - 闩锁判定覆盖**两条迁移路径**：previewing→confirming 的初始 preview-ok（现 refresh-flow.mjs:89-91 分支）与 confirming 内 preview-ok（现 L116-119 分支）都执行「接口契约」的分流规则；升级发起时置 `materializing:true`、落地/回退后清位
  - confirming 分支：新鲜预览失败回退 materialize（见接口契约）；`select` 事件把选择字段写入 `lastSelection`，升级/回退 effect 从 `lastSelection` 逐字段构造；confirm 门按 needsEscalate/emptyTarget 规则替换现 `isRebuild`/`emptyTarget` 逻辑；`p.diff.selectedIds` 与 `p.hadModels` 取代 `p.diff.targetView.models` 计数
- [ ] Step 3: 跑测试至绿
- Run: `node --test test/refresh-flow.test.mjs`
- Expected: 全部通过
- [ ] Step 4: checkpoint commit（建议信息：`refresh-flow: diff 门控＋live 升级闩锁与回退`）

### Task 5: client.jsx 弹窗重构与双语文案

- 目标：单按钮入口＋分组单表＋工具行动作＋清除定制复选框＋摘要行＋动态风险线。
- 涉及文件：`src/client.jsx`。
- 接口契约：Consumes Task 3 投影与 Task 4 状态机行为；Produces 无下游。
- 验证范围：构建成功；本仓库无 client 单测框架，行为由 Task 4 状态机测试与 Task 6 手动清单兜底。

- [ ] Step 1: DICTS 按「接口契约 → DICTS 键变更」增删改（en/zh 同步；auth 族键不动）
- [ ] Step 2: 主区按钮：删除「重建模型列表」按钮，「补充模型」改为「管理模型列表」，onClick `drive({ type: "start", operation: "manage" })`；两个按钮共用的 disabled 逻辑合并
- [ ] Step 3: 重构 RefreshModal（保持固定高度三段式骨架与 sampleThemeSurface 采样）：
  - 滚动区：三组段落（`groupAddable`/`groupListed`/`groupRemoval`，组头带计数），组内行＝checkbox＋mono id＋徽章（removal 行按 reason 用 `removedAccount`/`removedUnresolvable`；`customized` 行加 `customizedBadge` 小徽章；`retain` 释义放组头 title）。分组按 rows.status 固定，用户取消勾选的健康在列行**不迁移**到待删除组，由摘要行/风险线表达移除意图
  - 选择状态：单个 `Set` 承载全表勾选，初始值＝`diff.selectedIds` 回显（服务端默认已与设计一致：健康在列勾、候选与待删除候选不勾）；`emitSel` 上报 `{selectedIds, clearOverrides, confirmEmpty}`（selectedIds 空且 `preview.hadModels` 时 confirmEmpty:true）；`useEffect` 乐观回显逻辑保留
  - 工具行：`selectAll`/`selectNone`/`alignAction`（align＝勾选 rows 中 status!=="removal-proposal" 的全部行；仅 removal-proposal 计数>0 时渲染；锁定降级时 disabled）
  - 锁定规则（与设计 §4.1 降级清单一致）：仅 `evidence.stale ∨ catalogSource∈{local,overlay}` → removal-proposal 行 checkbox 强制勾选＋disabled；**有效缓存不锁定**（删除由自动升级兜底，见 Task 4）
  - `clearOverrides` 复选框：`overridesMeta.clearable` 时渲染；`inheritedOnly` 时渲染 disabled＋`inheritedOverrides` 提示
  - 风险线：stage 流程沿用（0→1→2）；stage1 显示规则——removed>0 → `removalRisk`（计数＝`diff.removed.length`，含用户取消勾选的健康在列行）；clearOverrides 勾选 → `clearOverrides` 文案行；removed=0 时（仅 clearOverrides 升级）追加 `secondConfirm` 提示行作「再次点击」指引（removed>0 时 removalRisk 已含警示语义，不重复）；空目标 stage2 → `clearRisk`
  - 摘要行（操作栏上方常驻）：`summaryLine`（kept=勾选∩raw 在列全表（含 removal-proposal 行）、added=勾选∩addable、removed=raw 在列全表−勾选、total=kept+added；计数口径与风险线同源）＋`catalogNewEntries>0` 时追加 `catalogNotice`；三者全零且无目录新数据 → `noChanges` 提示
  - 旧区块处置：`skipped`（`skippedModels`）折叠与 `catalogError`/技术详情折叠**原样保留**；`warnings` 不再设独立区块——出现时并入技术详情折叠内展示（manage 语义下 warnings 仅服务端防御产物）
  - 应用按钮 disabled 条件：`evidence.stale`（既有）∨（存在未锁定删除意图 ∧（`evidence.source!=="live"` ∨ `catalogSource!=="latest"`））——统一覆盖升级硬失败回退与软降级（live 拉取失败落回缓存）两种形态；命中时附 `removalNeedsLive` 横幅
- [ ] Step 4: 构建
- Run: `npm run build`
- Expected: 构建成功、无未定义变量/键告警
- [ ] Step 5: checkpoint commit（建议信息：`client: 管理模型列表单表交互＋双语文案`）

### Task 6: 文档收尾与全量验证

- 目标：README 与实现一致；全量测试收口；人工验证清单交接。
- 涉及文件：`README.md`。
- 接口契约：Consumes 全部前序任务。

- [ ] Step 1: README 更新六处（按内容定位，行号为约值）：特性 bullet「➕➖ 补充模型 / 重建模型列表（v2 双入口）」（约 L23）改为管理模型列表单表＋diff 门控、L91-96 节改写为「管理模型列表（目标状态编辑）」语义（勾选=终态、挽留、清除定制复选框、对齐动作、removals-need-live、自动 live 升级）、L111 `protocolVersion: 2`→「3」、**两处测试计数**（约 L26「🧪 测试与 CI」与 L123）按实际用例数刷新、L155-156 两处「补充模型」提法改为「管理模型列表」
- [ ] Step 2: 全量测试
- Run: `npm test`
- Expected: 全部通过，0 failing
- [ ] Step 3: 构建
- Run: `npm run build`
- Expected: 成功
- [ ] Step 4: 最终 commit
- [ ] Step 5: 输出修改摘要，并交付以下人工验证清单（真机安装类需用户另行授权）：
  - M01：默认打开弹窗——健康在列勾选、候选与待删除候选不勾、摘要计数与 rows 一致；挽留待删除候选后其定制徽章保留
  - M02：移除一个定制模型（徽章消失）；清除定制复选框出现/勾选后风险线并入；仅继承覆盖时复选框禁用＋提示；取消全选触发空目标二次确认
  - M15：缓存证据下取消勾选 → 自动升级为 live（证据行变化、确认重置）；二次确认阶梯（删除/清定制/空目标）；stale 与本地目录下待删除候选锁定＋apply 拒绝
  - M16：对齐动作仅漂移时出现且一键取消全部待删除候选；全选包含待删除候选；升级中断网 → 回退保留勾选＋横幅
  - U01：zh/en 切换抽查新增 14 键；危险确认初始焦点在取消；Esc 可取消
  - 回归：退出登录后重授权首次填充不回归；纯新增缓存 apply 成功

## 风险与回退

- 回退单位：每个任务一个 checkpoint commit，可按任务粒度 revert；语义耦合的 T2/T3 需一起回退（契约互锁），T5 可独立回退到旧双按钮 UI（T1–T4 服务端仍拒绝旧字面量，故 T5 回退后功能不可用但授权流不受影响）。
- 半升级状态：插件两半同包发布；若页面未刷新（旧 client＋新 host），preview 请求被协议门以版本不符拒绝，client 显示 HTTP 错误文案——刷新页面即恢复，不存在静默错语义。
- 自动升级失败：回退机制保证弹窗不关、勾选不丢（Task 4 用例 5）；最坏情况 apply 被服务端门拒绝并提示 `removalNeedsLive`。
- 数据风险：无迁移、无格式变更（writeSet 形状不变，事务内核零改动）；回滚不涉及用户数据。

## 执行纪律

- 开始实现前先批判性复查本计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划再动手。
- 按任务顺序执行（T1→T6），不无声跳步、合并步或改变任务目标；每任务完成即运行其验证。
- 当前如在 `main`/`master` 分支，未经用户明确同意不得开始实现。
- 遇阻塞、重复失败或计划与仓库现实不符，立即停下说明，不猜。
- 全部任务完成后运行最终验证并输出修改摘要。

## 最终验证

- `npm test` 全绿；`npm run build` 成功；grep 确认源码与文案中不再有 `supplement`/`rebuild` 操作字面量（`grep -rn '"supplement"\|"rebuild"' src/ | wc -l` 为 0，注释中的历史说明除外）。
- 环境前提：Node >=20，仓库根 `/home/ubuntu/workspace/dsh-copilot-auth`，shell 为 bash。

## 审阅 Checkpoint

- 计划正文结束后请求用户审阅；审阅通过前不进入实现。
- 默认执行方为普通编码 agent 或人工执行者。

---

## 评审修订记录

- R1（2026-10-05，评审 Agent 第一轮，13 条：阻断 2/重要 4/建议 7）：
  - 接受并修改：R1-1（select/emitSel 契约补回 `confirmEmpty`，空目标可物化；空目标判据统一为 rawIds>0 并对齐 §3.5 显式空列表）、R1-2（`removed` 增加 "unchecked" reason，用例 3 改写）、R1-3（host.test.mjs 纳入 Task 3）、R1-4（锁定条件收窄为 stale∨catalog 降级，有效缓存不锁定）、R1-5（三处默认状态统一为「在列∩(账号∩可解析)」，初始勾选=diff.selectedIds 回显，升级触发扩展到初始预览）、R1-6（放弃 legacy 字面量归一；显式删除 rebuild live 门死代码）、R1-7（错误码统一小写＋host 白名单说明＋Task 1 Expected 修正）、R1-9（runEffect 字段级组装列入 Task 4）、R1-10（skipped/catalogError 保留、warnings 并入技术详情）、R1-11（README 六处＋§5 键位范围声明）、R1-12（升级失败回退、新增「风险与回退」节、人工清单扩到 M01/M02/M15/M16/U01）、R1-13（modelOverridesPresent:false＋用例 6 断言）。
  - 反驳被接受（第二轮复核确认）：R1-8 部分——键名沿用现有 DICTS 驼峰风格（§5 为文案语义规格而非键名字面规格，G04 只要求 en/zh 等义）；`noChanges` 采纳新增；`authChanged` 拒绝（自动重预览使 auth-changed 呈亚秒瞬态，previewStale 覆盖残余场景）。
- R2（2026-10-05，评审 Agent 第二轮，R1 全部复核通过，新增 6 条：阻断 1/重要 1/建议 4，全部接受并修改）：
  - R2-1：空目标确认改为**仅约束用户显式提交的空选择**（selectedIds!==undefined）；服务端默认选择为空（全漂移账号）时初始预览放行，弹窗可打开（M01）；T3 增全漂移夹具用例。
  - R2-2：确认后的空目标落盘形状钉死为 modelsPresent:true＋models:[]（显式空列表，防 unset 后首次填充静默回填，与旧 rebuild 一致）；T2 用例 8 断言改写。
  - R2-3：闩锁判定覆盖 previewing→confirming 与 confirming 内两条 preview-ok 迁移路径；升级在途置 materializing（confirm 门拦截），落地/回退后清位；T4 用例 4④。
  - R2-4：stage1 组合文案规则去矛盾并钉死计数（removalRisk 计数＝diff.removed.length；仅空目标升级时 secondConfirm 兜底）。
  - R2-5：README 更新改为按内容定位、五处（原 L20/L23 行号引用失准已合并修正）。
  - R2-6：srcCache 文案改为「移除类更改需升级为实时证据」（与 Q36 自动升级一致），设计 §5 对应行同步修订。
- R3（2026-10-05，评审 Agent 第三轮，R2 六条全部复核通过，新增 7 条：重要 2/建议 5，全部接受并修改）：
  - R3-1：confirming 状态新增 `lastSelection`（记录最近一次提交选择字段的在场性），升级/回退 effect 从 lastSelection **逐字段复制**——初始默认预览升级时不带选择字段，服务端按 live 数据重算默认，全漂移 corner 不可能触发空目标确认；T4 用例 4⑤。
  - R3-2：targetView.modelOverrides 非 clearOverrides 分支改为 raw 定制**按 kept 过滤**（被移除模型条目不保留，防重加复活定制；唯一定制模型被移除时 present:false → unset）；T2 用例 3 补断言。
  - R3-3：「文件结构与职责」节 README 条目同步为按内容定位（与 Task 6 一致）。
  - R3-4：README 测试计数扩为两处（约 L26 与 L123）。
  - R3-5：apply 门片段改为 `flowError("removals-need-live", "removals-need-live")`（(code, code) 约定，保证 client 端 errorCode 为小写码）。
  - R3-6：删除不可达的 secondConfirm 兜底分支；removed=0 时（仅 clearOverrides 或空目标升级）追加 secondConfirm 提示行作指引。
  - R3-7：术语钉死——「在列」单指 rows.status==="listed"；「raw 在列全表」＝全部 rawIds；removed/kept 公式与摘要行计数统一用 raw 在列全表口径。
- R4（2026-10-05，评审 Agent 第四轮，R3 七条全部复核通过，新增 3 条：重要 1/建议 2，全部接受并修改）：
  - R4-3：升级软降级 corner 补齐——live 拉取失败被服务端回退有效缓存时 preview-ok 正常落地，契约新增「落地后 evidence 仍非 live → 置 staleNotice、闩锁保持消耗、不落 failed」；T5 应用按钮禁用条件统一为「存在未锁定删除意图 ∧（evidence 非 live ∨ 目录非 latest）」，横幅 `removalNeedsLive`；T4 用例 4⑥。
  - R4-1：「在列」口径三处残留统一为「raw 在列全表 / rawIds.length>0」（空目标 bullet、removed 说明、T2 用例 8）。
  - R4-2：stage1 括号枚举修正为「仅 clearOverrides 升级」（removed=0 下「空目标升级」不可达）。
- R5（2026-10-05，评审 Agent 第五轮·最终轮，R4 三条全部复核通过，新增 1 条建议，接受并修改）：
  - R5-1：T3 用例 1 全漂移夹具的「在列全部为／removed=全部在列」改为「raw 在列全表」口径（R4-1 术语统一的第四处残留）。评审总体判断：修改后可执行，该处为唯一残留且修法唯一，已按其逐字修法落地。
