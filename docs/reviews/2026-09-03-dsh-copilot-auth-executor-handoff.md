交接上下文 / HANDOFF CONTEXT
============================

用户请求（保留原话） / USER REQUESTS (AS-IS)
-------------------------------------------
- "刚才搞错了，你本身就是评审 agent，然后另外一个 执行 agent 并不知道你直接改了 实施计划，所以 交接文案变成 你把当前发生的事情，比如说你根据新版的 DSH 直接更新了 实施计划，所以你要执行 agent 重新吸收你修改过的计划，并且添加它的想法，我会另起一个新的会话 作为今日的全新评审agent 来评审 它的产出。"

目标 / GOAL
-----------
重新吸收评审 Agent 已直接修订的《dsh-copilot-auth 实施计划》（现为 DSH 0.1.2-rc.1 基线的完整修订版），按计划「执行纪律」批判性复查，把你自己的想法/异议/补充直接编辑进计划并标注来源；完成后由用户新起的评审会话复审你的产出，复审通过前不进入 Task 0 实现。

已完成工作 / WORK COMPLETED
--------------------------
- 评审 Agent（0.1.1-rc.2 基线）完成 v1 深度评审：附录 A 15 处机制锚点全部属实；产出 3 项阻断 + 6 项应修 + 5 项次要（docs/reviews/2026-09-03-dsh-copilot-auth-plan-review.md）
- 执行 Agent（你，前一会话）已把 v1 修订落进计划：路由 kind:"exact"、logout 幂等契约、/status 改 describeRecord、repository/GH_USER、README 排障段、附录 B 两条新边界、附录 A 补 client-modules 行——这部分工作已被完整保留，未回退
- DSH 就地升级 0.1.2-rc.1 后，评审 Agent 完成 v2 复核：16+1 组锚点全部成立；变化=行号位移、installSettingsSection 改名 installSection、enableAllGitHubCopilotModels 改名、内置 bundle 3→6 个、官方 peer 简化为仅 cordis ^4.0.2、dsh.client.inject 4→3 项、semver 预发布门控实测证明 ^0.1.1-rc.2 不匹配新版（docs/reviews/2026-09-03-dsh-copilot-auth-plan-review-v2-dsh-0.1.2-rc.1.md）
- 评审 Agent 依用户指示**直接修改了实施计划**，在你已落盘的 v1 修订之上补齐全部 0.1.2-rc.1 版本事实层：peer 钉法、inject 3 项、版本号三处、Task 0 增 pi-ai 存在性检查与运行版本警示、新增「共识修订记录」节、附录 A 整表刷新为新行号、shared.mjs routes() 参数化收敛、附录 B peer/headless 更新

当前状态 / CURRENT STATE
------------------------
- 计划文件已是 0.1.2-rc.1 基线完整修订版；修订轨迹见计划内「共识修订记录」与「审阅 Checkpoint」两节
- 尚无代码：/bmc/iasi/workspace/dsh-copilot-auth/ 仓库不存在，一切从 Task 0 起步
- 环境：dsh 0.1.2-rc.1（dsh -V 可验）、pi-ai 0.84.4（$DSH/node_modules/@earendil-works/pi-ai）、cordis 4.0.2、内置 bundle 6 个；registry 上 0.1.2-rc.1 挂 next dist-tag（latest 停在旧版）；@inventec/dsh-copilot-auth 未被占用
- 运行中的 dsh web（127.0.0.1:8815）可能是升级前代码，版本断言一律以 dsh -V / 安装树文件为准

待办事项 / PENDING TASKS
------------------------
- 通读修订版计划全文（重点：共识修订记录、全局约束-依赖、Task 0/1/3、附录 A/B），对照 v2 报告 §7 的 14 行修订清单逐项确认理解
- 按计划「执行纪律」第 1 条批判性复查：把你的想法/异议/补充直接编辑进计划，标注「执行 Agent 注：」；可以反驳评审修订，但须给出安装树证据（文件+行号/符号），不要静默覆盖既有修订
- 4 个开放点欢迎你拍板或补证：① Task 7 的 children schema 告警观察是否足够，或从 dsh-client-ui-slots 类型直接证明 children 可选；② 附录 B headless/webServer 表述的低置信度注记（查 INSTALLATION_OWNED_PROFILE_TUPLES）；③ peer 方案(a)（仅 cordis ^4.0.2）是否认可；④ repository 的 GH_USER 询问流程（Task 0 HUMAN 步骤）是否顺畅
- 完成后告知用户：计划已更新为含执行 Agent 想法的最终版，等待新评审会话复审；复审通过前不进入 Task 0

关键文件 / KEY FILES
--------------------
- docs/plans/2026-09-03-dsh-copilot-auth-implementation-plan.md - 被评审对象，现为 0.1.2-rc.1 完整修订版（含修订轨迹），你的编辑目标
- docs/reviews/2026-09-03-dsh-copilot-auth-plan-review-v2-dsh-0.1.2-rc.1.md - v2 评审：§4 锚点对照表、§7 修订清单（14 行验收标准）、§8 低置信度观察
- docs/reviews/2026-09-03-dsh-copilot-auth-plan-review.md - v1 评审（历史依据；其 C1-1 路径建议已被 v2 勘误）
- copilot-deviceflow-research.md / copilot-sdk-followup.md - 计划的调研输入（存在性已确认，内容未复核）

重要决策 / IMPORTANT DECISIONS
-------------------------------
- 修订权责：评审 Agent 管事实层修订（已落盘）；执行 Agent（你）管批判性复查与补充想法（本次任务）；新评审会话管复审放行
- peer 修订采用方案(a)：仅 @deepseek-ai/cordis ^4.0.2（实测官方 0.1.2-rc.1 同款；dsh-* peer 钉被 semver 门控与官方弃用双重否定）
- 既定技术决策（维持）：routePrefix 不配置化、logout 幂等契约 ok:true、/status 用 describeRecord、路由 kind:"exact"
- 事实源裁定：v1 与 v2 冲突以 v2 为准；0.1.2-rc.1 安装树是唯一事实源；一切结论锚定「文件+行号/符号」

显式约束 / EXPLICIT CONSTRAINTS
-------------------------------
- "标注 HUMAN 的步骤必须停下等用户完成，不得代替用户操作（尤其 Task 7 重启、Task 10 的 GitHub/npm 凭据）"
- "未经用户同意不改动 web profile 与 $DSH 安装树"
- "审阅通过前不进入实现"

建议技能 / SUGGESTED SKILLS
--------------------------
- writing-plans - 计划质量基准；吸收、再编辑与自检计划时按其标准执行

续接上下文 / CONTEXT FOR CONTINUATION
-------------------------------------
- 第一个动作：读计划全文（先看「共识修订记录」与「审阅 Checkpoint」了解修订轨迹），再对照 v2 报告 §7 逐行确认
- 高频坑：pi-ai 在 $DSH/node_modules/@earendil-works/pi-ai（不在 $PKG 下，路径写错会误判"升级不完整"）；$DSH/lib/plugin-*.js 是构建哈希文件名（用符号 exportsPatch 锚定）；registry latest 停旧版、0.1.2-rc.1 在 next tag；行号引用一律以计划附录 A（0.1.2-rc.1 实测）为准
- 你的产出 = 更新后的计划文件本身（直接在同一文件上编辑）；改完不必自行宣布"可执行"，交新评审会话判定
- DSH 若再次升级：先 dsh -V 比对，任何断言不匹配即停（计划 Task 0 与执行纪律均如此规定）

正文结束 / END OF HANDOFF CONTEXT
================================
