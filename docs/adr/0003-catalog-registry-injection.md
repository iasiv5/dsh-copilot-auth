# ADR 0003 — 只读安装树的落地通道：进程内目录注册表注入

日期：2026-10-03 · 状态：已采纳 · 落地版本：v1.2.5

## 背景与问题

ADR 0001 的数据级目录补丁要求把合并后的目录写回 pi-ai 的
`dist/providers/data/github-copilot.json`。ADR 0002 承认 dsh-desktop（Electron）
把整个运行时树打进只读的 `resources/app.asar`，于是该形态下刷新入口被置灰。
置灰解决了"天书报错"，但没解决用户的诉求：**desktop 上账号已可用的新模型落不了地**
（2026-10-03 本机实测：账号可用集 20 个模型里，`gpt-6.1-sol` 不在打包目录 0.87.1
描述的 32 个之内——虽然它在已发布的 pi-ai 1.0.0 目录里）。

三条已核验的硬事实决定了可行空间：

1. **写盘无路**：`app.asar` 内 pi-ai 的 231 个文件 `unpacked=false`；
   `DSH_INSTALL`/`DSH_APP_ROOT` 等环境变量不存在，插件也没有任何目录路径覆盖；
   官方安装树由 electron-updater（nightly 通道）随时覆盖。
2. **裸文件路径也无路**：pi-ai 用静态 ESM JSON import 读目录
   （`import values from "./data/github-copilot.json" with { type: "json" }`），
   每个进程只读一次；路径由相对 specifier 硬编码。
3. **但进程内还有第二个面**：`MODELS["github-copilot"]`
   （= `GITHUB_COPILOT_MODELS`，`providers/github-copilot.models.js` 导出的普通对象，
   键 = 模型 id，**未冻结**），DSH 的 `catalogModels()` 每次构建快照都现读它
   （`Object.values(MODELS[provider])`），且 asar 的**读**完全正常。

## 决策

在只读安装树上，把"写目录文件"换成**注入进程内目录注册表**：

1. **通道判定按目标可写性，不按 profile 名**。`resolveInstall()` 已产出的
   `writable` 是唯一分叉依据：可写 → 原 ADR 0001 写盘通道（行为一字未改）；
   不可写 → 本 ADR 的注册表通道。
2. **注入面 = `GITHUB_COPILOT_MODELS`**。用 `findPiAiInstallation()`（既有定位层，
   `process.argv[1]` 向上 8 层）拿到 asar 内 `dist` 目录，先试裸 specifier
   （由宿主 `dsh-app-boot` 的解析拦截路由到安装树内同一份包，模块实例与宿主同一），
   失败再退 asar 绝对路径 `file://` URL（Electron 的 asar VFS 读 + ESM 加载，探针已证）。
   注入后**必须** `getBuiltinModels("github-copilot")` 回读可见，否则整体判失败。
3. **不新增路由、不改宿主任何文件、不改官方产物**。内置 `github-copilot` 路由自己把
   新模型端出来：OAuth 凭据、DSH↔pi-ai 消息翻译、三协议分派（`model.api` 决定——
   注入条目自带 `api`/`baseUrl`/`headers`）、picker 与设置页全部复用既有链路。
   （自建"补充路由"方案被否决，理由见下。）
4. **注入成功才写 settings，写完立刻端到端自证**。apply 顺序：注入 →
   `settings.mutate` 落 target → `ctx.llm.listModels("github-copilot")` 回读
   （短重试）→ 缺任何 target id 即**回滚 settings**（恢复到刷新前视图）并返回
   500 `registry-not-effective`。绝不产出"能选中但发不出去"的假模型。
5. **条目按本机形状裁剪**。`allowedKeys` = 本机目录条目字段并集；pi-ai ≥0.99.0 新增的
   `type: "chat"` 之类字段不进 0.87.x 的模型对象。
6. **远端目录形状规范化（同批修复）**。pi-ai ≥0.99.0 把目录 JSON 的键改成
   `chat:<内层裸 id>`（`flattenChatModelCatalog` 的产物，运行时仍按裸 id 编键）。
   `normalizeRemoteCatalog()` 在 preview/apply 共用的取数层统一规范化回裸 id 形状，
   并跳过键与内层 id 冲突的条目。**这条对 web/服务形态同样是缺陷修复**：不规范化时
   刷新会"拿到新目录却一个条目都加不进来"（`validateCatalog` 的 `entry.id === key` 必挂）。
7. **不写盘 ⇒ 无重启相位**。注册表注入当次 boot 即生效，boot2a 在本 boot 就完成
   settings 同步（写盘通道才需要"写目录 → 下个 boot 同步 settings"的两阶段）。
   `apply` 返回 `restartRequired:false` + `mode:"registry"`；持久化的
   `appliedOverlay` 供下次 boot 幂等重放（应用更新后注入面清空，重放即恢复）。
8. **失效即降级，零破坏**。注册表不可写（冻结）、模块不可加载、回读不可见、
   条目非法——任一情形都只返回结构化错误（`registry-modules-unavailable` /
   `not-visible-after-inject` / `invalid-entries`）并可 grep；boot 序列保留
   journal/overlay、不阻断挂载。可写安装树根本不加载注册表面
   （`install.writable === true` 时跳过），web 形态零新增副作用。

## 否决的替代方案

- **自建"补充路由"（插件自己的 provider + adapter）**：需要 `ctx.llm.registerAdapter`
  自建 adapter，而 adapter 契约里的 `prepareCall` 必须把 DSH 消息翻译成 pi-ai context
  （`toPiContext`）、把 pi-ai 事件流转回 DSH chunk（`toStreamChunks`）——两者都是
  `dsh-llm-pi-ai` bundle 内的**模块私有函数，无导出**。等于重写宿主的翻译层，
  且要在 picker 里多出一条重复路由。淘汰。
- **改官方安装树**（解包 `app.asar` → `resources/app`、或另拷可写安装）：触及官方产物、
  被 electron-updater 每次覆盖、macOS 侧还受 fuses（`OnlyLoadAppFromAsar`）约束。淘汰。
- **只用 settings 声明目录外 id**：`models` 是"替换目录"语义且条目 schema 无 per-model
  `api`/`baseURL`，目录外 id 只能靠 route 级 `api`，而 route 级 api 会把整条路由压成
  单协议（github-copilot 横跨 3 协议，Claude/Gemini 系分派即废）。这正是 ADR 0001 当初
  否决的路线，维持否决。
- **等上游**（dsh-desktop 把 pi-ai 加 asarUnpack，或 pi-ai 提供目录路径覆盖）：作为长期
  背案保留（ADR 0002 的退役条件不变）；上游落地后本通道按退役规则复审——
  届时可写路径自动生效，注册表分支自然不再被走到。

## 后果

- desktop（只读安装树）首次可以真正"刷新生效"：新模型进入内置路由、无需重启、
  无需改任何官方产物；web/服务形态行为与 v1.2.4 一致（多一条格式规范化修复）。
- 插件对 pi-ai 内部数据形状产生**显式耦合**（`MODELS[provider]` 未冻结、扁平、键=id）。
  这是实测事实而非公开契约：守卫（`Object.isFrozen` + 注入后回读）保证上游改形状时
  只降级不破坏。
- 观测面：`/status` 增加 `catalogMode`（`file` | `registry`）与 `registryInjected`
  （已注入条目数）；preview 增加 `catalogMode` 与 `catalogNormalized`；apply 增加
  `mode`/`restartRequired`/`injected`。三者均为纯增量字段，旧 client 不受影响。
- 测试：新增 `test/catalog-format.test.mjs`（形状规范化，含"不规范化 → 加不进来"的
  回归面）与 `test/catalog-registry.test.mjs`（注入/不覆盖/拒绝/裁剪/冻结守卫）；
  host 测试覆盖 apply 成功、注入失败、自证失败回滚、boot0/boot1 注入落地、
  可写树不咨询注册表面。CI 三平台矩阵（ubuntu/windows/macos）照旧。

## 实测记录（2026-10-03，Windows 桌面机 / dsh-desktop 0.2.0-rc.2 / pi-ai 0.87.1）

- 探针 A（Electron-as-node，Electron 44.0.0 / node 24.18.1）：asar 内 `fs` 读通过、
  `import()` 加载 asar 内 pi-ai 通过、`githubCopilotProvider()` 返回 32 个模型、
  `createModels`/`createProvider`/`lazyOAuth`/`loadGitHubCopilotOAuth` 全部可用。
- 探针 A3（同进程）：`MODELS["github-copilot"] === GITHUB_COPILOT_MODELS` = true、
  两者均未冻结；注入 pi-ai 1.0.0 的 `gpt-6.1-sol` 条目后 `getBuiltinModels()` 32 → 33
  立即可见，且其描述符与 0.87.1 条目字段集**只差一个 `type:"chat"`**。
- 单元/集成：本机 136/136 通过（含 22 条新增）；CI 三平台矩阵（ubuntu/windows/macos）全绿。
- **v1.2.5 装机实测（desktop profile，只读 app.asar）**：`/status` →
  `catalogMode:"registry"`、`catalogWritable:false`、`registryInjected:2`、`lastError:null`；
  apply 后 `appliedOverlay` 含 `gpt-6.1-sol`（openai-responses）与 `claude-sonnet-5.5`
  （anthropic-messages），`appliedProvenance.sourcePiAiVersion:"1.0.0"` 对
  `appliedAgainstPiAiVersion:"0.87.1"`；preview 的 `catalogNormalized.renamed=34`
  （远端 1.0.0 目录的 `chat:` 键全部被规范化）。
- **端到端真实请求验证**：同日 17:05:53 会话（`session-82369130-…`）以
  `provider:"github-copilot" / model:"gpt-6.1-sol"` 提问「你是什么模型」，收到回答
  「我是 **gpt-6.1-sol**，当前通过 **DeepSeek Harness** 运行的 AI 编程助手。」；
  会话元数据 `contextWindow: 1050000` 与注入条目的 `contextWindow` 完全一致
  （打包目录 0.87.1 根本不存在该 id，任何回退路径都不可能产生这个数值），计费记于
  `github-copilot/gpt-6.1-sol`（1 次请求 / 12924 tokens）⇒ 注入条目确实被宿主路由
  加载并完成了真实推理调用，而官方安装树**一字未改**。
