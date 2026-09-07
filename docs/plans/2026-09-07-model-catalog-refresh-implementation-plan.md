# 模型目录手动刷新（数据级目录补丁）实施计划 v3.1

> v2 修订说明（2026-09-07，响应一轮评审）：修复凭证契约（R1）、过滤语义对齐 0.84.4（R2）、diffModels 漏报删除（R3）、preview/apply digest 绑定与并发互斥（R4）、持久 journal（R5）、原子写（R6）、同 boot 自愈后禁止同步 settings（R7）、自愈重放 durable applied entries（R8）、激活边界（R9）；吸收 Y1–Y9；测试门禁改为场景矩阵。
>
> v3 修订说明（2026-09-07，响应二轮评审）：prepared 恢复前移至激活门前、真 CAS（expectedRevision）、modelOverrides 纳入同步、overlay 二次 preview、原子写故障注入、restartState 跨 boot、主流程一次重启、自愈兼容收窄。
>
> v3.1 定点修订（2026-09-07，响应三轮评审）：①prepared journal 携带 `appliedAgainstPiAiVersion`，恢复前过兼容 gate，跨版本 → `prepared-incompatible` 不写目录（R3-1）；②settings digest/baseline 从 id 视图改为 **raw user 层完整配置视图**（`{modelsPresent, models 全字段, modelOverridesPresent, modelOverrides 全键值}`），diff 仍用 id 视图（R3-2）；③`resolveCatalogSource` 严格分支：仅 `mode==="overlay"` 读内置覆盖层，normal npm 失败只回 `catalogSource:"local"`，未知 mode → 400（R3-3）；④journal 用 catalog-shaped `pendingOverlay`，`mergeCatalog` 增返回 `addedOverlay`，provenance 与模型条目分离（R3-4）；⑤`restartState` 只表达「目录写入需跨 boot 加载」，settings CAS 唯一触发源是 committed journal（R3-5）；⑥状态 schema 增顶层 `lastError/lastErrorAt`（R3-6）；⑦atomic-json 改语义 adapter（`writeAll` 循环短写/`fsyncFile`/`rename`/`fsyncDirectory` 独立可注入）（R3-7）；⑧E2E 严格断言 status 完成态与「pi-ai 目录恰好一个且为 0.84.4」，验收对象是经 `findPiAiInstallation()` 解析的实际加载副本（R3-8）；吸收 Y3-1–Y3-6（流式限额、redirect manual 逐跳校验、effect runner 可测、staleness 门禁、preview 展示字段级重置范围）。

## 目标

- 在 `@inventec/dsh-copilot-auth` 插件的 GHC 设置页提供「刷新可用模型目录」按钮：现场拉取账号可用模型与最新 pi-ai 目录数据，diff 预览 + 二次确认后，对本机 pi-ai 的 `github-copilot.json` 做**数据级只增合并**，重启 dsh web 后把 settings 目录镜像重建为账号可用集合。
- 全程不升级 pi-ai 代码（保持 0.84.4），不动 DSH 本体；DSH 升级冲掉补丁后，已激活实例在启动时自愈重放**实际应用过的**补丁条目。

## 架构快照

**状态机**（持久于单一状态文件 `~/.dsh/copilot-auth-state.json`，原子写）：

```
inactive（无 journal 或 activated=false）
  └─ preview（只读，返回 digest 组；body 可带 mode:"overlay" 用内置覆盖层出 diff）
  └─ 用户确认 → apply { digests, mode? }：
     1. mutex 内重算输入 digest，与回传比对，漂移 → 409 preview-stale（client 收到后重新 preview）
     2. 原子写 journal: phase=prepared（含 pendingOverlay、settingsBaseline(raw 视图)、targetIds、appliedAgainstPiAiVersion、provenance）
     3. 原子提交目录文件（temp→fsync→rename）
     4. 原子合入 appliedOverlay（带 appliedAgainstPiAiVersion），置 activated=true
     5. 原子推进 journal: phase=catalog-committed-needs-restart（置 restartState.reason="refresh"）→ restartRequired
boot（插件 apply() 启动，严格按序）：
  0. journal.phase=prepared 的崩溃恢复（先于 activation gate，但**先过兼容 gate**）：
     当前 pi-ai 版本（findPiAiInstallation().version）== journal.appliedAgainstPiAiVersion
       → 用 journal.pendingOverlay 幂等重建目录补丁 → 补存 appliedOverlay/activated → 推进相位
     版本不符 → 目录零写入、journal 保留、lastError=prepared-incompatible，要求重新 preview
  1. 自愈（仅 activated，且当前 pi-ai 版本==appliedAgainstPiAiVersion）：
     appliedOverlay 中缺失条目 → 原子重放 → 记 restartState{reason:"self-heal"}；本 boot 禁止 settings 同步
     当前 pi-ai 版本≠基线：条目已原生存在 → 空操作；有缺失 → /status 报 self-heal-incompatible，不改安装树
  2. 本 boot 未写目录时，两个独立出口（R3-5 职责分离）：
     a. journal.phase=committed → settings 真 CAS（唯一同步触发源）：
        语义前置：targetIds 全部可由当前目录解析（whole-file digest 仅诊断）
        describe() 取本 boot revision；当前 raw 配置视图 == settingsBaseline
          → mutate(ns, [set models=targetIds.map(id=>({id})), unset modelOverrides], expectedRevision)
        SETTINGS_CONFLICT 或内容≠baseline 且 ≠target → 不覆盖、记 conflict、/status 上报
        成功/已等于 target → 消费 journal
     b. restartState 非空且 expected entries 已在目录 → 仅清除 restartState；
        **restartState 单独存在时不得调用 describe()/mutate()**
任一步异常：journal 保留 + 顶层 lastError，可安全重试（所有写入幂等）
```

**数据源**：账号可用模型走「现场拉取（显式耦合 pi-ai 0.84.4 的凭证与发现语义）→ 失败回退凭证缓存 `availableModelIds`」；目录数据从 npm 拉最新 pi-ai tarball 只取 `github-copilot.json`（integrity 校验），失败可用内置覆盖层 `src/catalog-overlay.json`（0.85.1 收割，仅作离线 bootstrap，绝不自动应用）。

**合并语义**：只增不更新（ADR 0001）；协议白名单过滤；条目 schema 校验。

## 全局约束

- pi-ai 代码版本保持 0.84.4；只写它的 `dist/providers/data/github-copilot.json` 数据文件，且必须原子写。
- 沿用仓库约定：node:test、`npm run build`（esbuild）产出 `lib/client.js`、路由前缀 `/copilot-auth` 硬编码两侧一致、UI 文案全走 en/zh 双语词典、host 路由同源守卫 `guard()`。
- `engines.node >= 20`：可用全局 fetch、`node:zlib`、`node:crypto`、`AbortSignal.timeout`。
- 协议边界（修订原「零 GitHub 协议代码」表述）：仅实现只读 `GET /models` 适配，不实现 token 获取/刷新/policy 修改；该适配显式耦合 pi-ai 0.84.4 的 credential 与模型发现语义，pi-ai 升级后任何偏差一律回退凭证缓存。
- **单进程单实例假设**：并发保护仅为 cordis 宿主进程内的模块级 mutex（settled-tail，回调拒绝后不中毒）；不支持多实例/多进程并发刷新，该限制写入 README。host 模块被多次挂载时各实例状态可能串扰——属不支持形态。
- **settings 两个视图分离**：diff 展示用 id 视图；**digest/baseline/CAS 用 raw user 层完整配置视图**——`{ modelsPresent, models: [全字段条目...], modelOverridesPresent, modelOverrides: {全键值} }`，取自 settings raw user 层，canonical 化时保留 `undefined` 与空数组/空对象的区别。字段级定制变化（同 id 改 displayName/contextWindow、override 改值）必须使 digest 漂移 → 409。实际 mutate 的 value 必须是 `targetIds.map((id) => ({ id }))`，empty target 写 `[]`；同一 revision-fenced mutate 内同时 `unset modelOverrides`。
- **自愈兼容边界**：自愈只在当前 pi-ai 版本等于 `appliedAgainstPiAiVersion`（本计划为 0.84.4）时重放；跨版本时条目已原生存在则空操作，否则上报 `self-heal-incompatible` 且不修改安装树。
- package.json `files` 新增：`src/catalog.mjs`、`src/catalog-fetch.mjs`、`src/copilot-models.mjs`、`src/atomic-json.mjs`、`src/state.mjs`、`src/refresh-flow.mjs`、`src/catalog-overlay.json`。
- 测试门禁：第六节「测试场景矩阵」列出的场景全部通过，不以固定数量为门禁。

## 输入工件

- `CONTEXT.md`、`docs/adr/0001-data-level-catalog-patch.md`（均已按评审修订）
- pi-ai 0.84.4 事实锚点（已复核）：
  - 凭证：`payload.access`（非 `access_token`）、`payload.enterpriseUrl`、`payload.availableModelIds`
  - baseUrl：`dist/auth/oauth/github-copilot.js` 的 `getGitHubCopilotBaseUrl()`——token `proxy-ep=proxy.<host>` → `https://api.<host>`；enterprise → `https://copilot-api.<domain>`；缺省 `https://api.individual.githubcopilot.com`
  - 过滤：`parseGitHubCopilotModelCatalog()`——`tool_calls !== false` 前置排除；`pickerEnabled === true && policyState !== "disabled"` 为主集；仅当 baseUrl 为 individual 端点且主集为空时回退 `policyState === "enabled"`
  - 请求头：同文件 `COPILOT_HEADERS` 常量（实现时原样抄录）+ `Accept: application/json` + `Authorization: Bearer <access>` + `X-GitHub-Api-Version`
  - token 刷新路径的重试策略是 `maxRetries: 0`（只读拉取对齐此行为，不做重试）

## 文件结构与职责

- Create: `src/atomic-json.mjs` — `readJson(path)`、`writeJsonAtomic(path, obj, fs?)`（同目录 temp（randomUUID + `wx` 排他创建）→ writeAll → fsyncFile → 重读 parse 校验 → rename → fsyncDirectory；语义 fs adapter 可注入）、`createMutex()`（settled-tail promise 链）
- Create: `src/catalog.mjs` — `SUPPORTED_APIS`、`extractTgzEntry(buf, { maxBytes }?)`（严格 ustar，精确匹配 `package/dist/providers/data/github-copilot.json`，重复条目抛错；`maxBytes` 经 gunzipSync `maxOutputLength` 落地）、`validateCatalog(api, id, entry)`（白名单/key==id/entry.api==section/provider/数值字段）、`mergeCatalog(local, remote) → { merged, added, addedOverlay, skipped }`（只增不更新；`added` 为展示数组 `[{id,api}]`，`addedOverlay` 为 catalog-shaped 增量，供 journal/自愈使用）、`diffModels(currentIds, availableIds, catalogIds)`（removed = current − target）、`digest(x)`（sha256，对象先 canonical JSON：递归键排序，保留 undefined 与空容器区别）、`findPiAiInstallation() → { catalogFile, packageJsonFile, version } | null`（catalog 文件与版本取自**同一解析根**的 package.json，防版本与被写文件不属同一副本）
- Create: `src/catalog-fetch.mjs` — `fetchLatestCatalog({registry, fetchImpl})`：metadata 与 tarball 各自 `AbortSignal.timeout(10000)`、`res.ok` 检查、`readCapped` 流式限额（metadata 20MB / tgz 压缩 30MB）、解压 100MB（经 extractTgzEntry 的 maxBytes）、`dist.integrity`（sha512 base64）强制校验、URL 信任（HTTPS 或与 registry 同主机，`redirect:"manual"` 逐跳校验）、包膜结构校验（catalog 为对象且 section 为对象）；**逐条目校验不在本层**（唯一归 mergeCatalog）
- Create: `src/copilot-models.mjs` — `copilotBaseUrl(access, enterpriseUrl)`、`fetchLiveAvailableModelIds({credential, fetchImpl})`（按 0.84.4 语义：headers 抄录、5s 超时、不重试、严格 picker + individual-only policy 回退）
- Create: `src/state.mjs` — 状态文件 `{version, activated, restartState, appliedOverlay, journal, lastError, lastErrorAt}` 的 load/save/迁移，journal 相位转移辅助；`appliedOverlay` 与 catalog 同构**不夹带插件私有字段**，provenance 单独存顶层 `appliedProvenance: { sourcePiAiVersion, integrity, appliedAgainstPiAiVersion, catalogSchemaVersion: 1 }`
- Create: `src/catalog-overlay.json` — 0.85.1 收割的离线 bootstrap
- Create: `src/refresh-flow.mjs` — client 侧状态机模块：`reduce` 纯函数 + `runEffect`/`advance`（副作用经注入的 fetchImpl，不引用全局 fetch）；状态：idle → previewing → confirming → applying → restartNeeded / failed / stale409→confirming；node:test 可测
- Modify: `src/shared.mjs` — `routes()` 增加 `refreshPreview`、`refreshApply`
- Modify: `src/host.mjs` — 两条刷新路由 + 启动序列（自愈/journal 消费/CAS）+ `/status` 扩展；`apply(ctx, opts)` 注入点 `{catalogFile, stateFile, fetchImpl, overlayFile}`
- Modify: `src/client.jsx` — 刷新按钮 + diff 弹窗（消费 refresh-flow 状态机）
- Modify: `package.json` + `package-lock.json` — 1.1.0、files
- Modify: `README.md` — 措辞「补充新模型目录条目」、激活/自愈/两阶段、已知边界修订
- Create: `test/catalog.test.mjs`、`test/catalog-fetch.test.mjs`、`test/copilot-models.test.mjs`、`test/atomic-json.test.mjs`、`test/state.test.mjs`、`test/refresh-flow.test.mjs`、`test/fixtures/`
- Modify: `test/host.test.mjs`

## 任务清单

### Task 1: 文档修订定稿

- 目标：CONTEXT/ADR 反映评审结论（本轮已改好，此任务做终稿核对）
- 涉及文件：Modify `CONTEXT.md`、`docs/adr/0001-data-level-catalog-patch.md`
- 接口契约：Consumes 无；Produces 全局约束文本（供 Task 11 README 对齐措辞）
- 验证范围：grep 核对关键表述

- [ ] Step 1: 核对 CONTEXT 含「激活边界」「只增不更新」「显式耦合」「收窄」（grep -c 数的是匹配行数而非关键词数，必须逐词 grep -q）
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && for w in 激活边界 只增不更新 显式耦合 收窄; do grep -q "$w" CONTEXT.md || { echo "missing: $w"; exit 1; }; done`
- Expected: 退出码 0
- [ ] Step 2: 核对 ADR Consequences 含同 boot 禁令、digest 绑定、激活边界（本轮还需把「单进程单实例」限制补入 ADR——Task 11 同步执行）
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && for w in 同一 boot digest 激活; do grep -q "$w" docs/adr/0001-data-level-catalog-patch.md || { echo "missing: $w"; exit 1; }; done`
- Expected: 退出码 0
- [ ] Step 3: checkpoint commit
- Run: `git add CONTEXT.md docs/ && git commit -m "docs: adr+context revised per review (activation gate, additive-only, journal)"`
- Expected: commit 成功

### Task 2: src/atomic-json.mjs 原子存储

- 目标：所有 JSON 写盘的唯一通道，故障注入可测
- 涉及文件：Create `src/atomic-json.mjs`；Test `test/atomic-json.test.mjs`
- 接口契约
  - Consumes: 无
  - Produces: `readJson(path)`（不存在返回 undefined，解析失败抛错）、`writeJsonAtomic(path, obj)`、`createMutex() → (fn) => Promise`（串行化）
- 验证范围：`node --test test/atomic-json.test.mjs`

- [ ] Step 1: 写失败测试

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic, writeAll, createMutex } from "../src/atomic-json.mjs";

test("readJson：缺失→undefined；坏 JSON→抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "aj-"));
  assert.equal(readJson(join(dir, "x.json")), undefined);
  writeFileSync(join(dir, "bad.json"), "{");
  assert.throws(() => readJson(join(dir, "bad.json")));
});

test("writeJsonAtomic：写入完整可读，临时文件不残留", () => {
  const dir = mkdtempSync(join(tmpdir(), "aj-"));
  const f = join(dir, "a.json");
  writeJsonAtomic(f, { a: 1 });
  assert.deepEqual(readJson(f), { a: 1 });
  assert.deepEqual(readdirSync(dir).filter((n) => n !== "a.json"), []);
});

test("writeJsonAtomic：语义 fs adapter 五故障点（R3-7）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aj-"));
  const f = join(dir, "a.json");
  writeJsonAtomic(f, { old: true });
  // adapter 形状：{ openTemp(path), writeAll(fd,buf), fsyncFile(fd), closeFd(fd), rename(a,b), fsyncDirectory(dir), remove(path) }
  // ① writeAll 抛错 → 抛错，原文件不变，无 temp 残留
  assert.throws(() => writeJsonAtomic(f, { new: 1 }, { writeAll: () => { throw new Error("disk full"); } }));
  assert.deepEqual(readJson(f), { old: true });
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
  // ③ fsyncFile 抛错 → 抛错，原文件不变
  assert.throws(() => writeJsonAtomic(f, { new: 1 }, { fsyncFile: () => { throw new Error("fsync"); } }));
  assert.deepEqual(readJson(f), { old: true });
  // ④ rename 抛错 → 抛错，原文件不变
  assert.throws(() => writeJsonAtomic(f, { new: 1 }, { rename: () => { throw new Error("rename"); } }));
  assert.deepEqual(readJson(f), { old: true });
  // ⑤ fsyncDirectory 抛错 → 不抛（降级 warn），新值已提交——语义如实成文
  writeJsonAtomic(f, { new: 2 }, { fsyncDirectory: () => { throw new Error("dirfsync"); } });
  assert.deepEqual(readJson(f), { new: 2 });
});

test("writeAll：短写循环补写 + 零进度防死循环（R4-2，方案 A：writeAll 导出、writeChunk 可注入）", () => {
  // writeAll(fd, buffer, writeChunk = fs.writeSync)
  const buf = Buffer.from("0123456789");
  let calls = 0;
  writeAll(1, buf, (fd, b, off, len) => { calls++; return Math.ceil(len / 2); }); // 每次只写一半
  assert.ok(calls >= 2, "短写被循环补写");
  assert.throws(() => writeAll(1, buf, () => 0), /no progress/, "writeChunk 返回 0 必须抛错防死循环");
});

test("mutex：并发串行，且回调拒绝后不中毒（Y2-4）", async () => {
  const mutex = createMutex();
  const order = [];
  await assert.rejects(mutex(async () => { order.push(1); throw new Error("boom"); }));
  await mutex(async () => { order.push(2); });
  assert.deepEqual(order, [1, 2], "reject 后后续任务仍执行");
});
```

- Run: `node --test test/atomic-json.test.mjs` → Expected: 模块缺失失败
- [ ] Step 2: 实现 `src/atomic-json.mjs`：temp 名 `.<name>.tmp-<randomUUID()>`、`openSync(path, "wx")` 排他创建；**导出 `writeAll(fd, buffer, writeChunk = writeSync)`**——循环按 writeChunk 返回值续写直到写满，`written <= 0` 或非整数抛 `write made no progress`；流程 = temp → writeAll → fsyncFile → 重读 JSON.parse 校验 → rename → fsyncDirectory（仅此处失败降级 warn 不抛）；rename 前任何失败清理 temp 并抛错，原文件不动。`writeJsonAtomic(path, obj, fs?)` 第三参为**语义 adapter 的部分覆盖**（未覆盖键回落默认实现），adapter 键：`openTemp/writeAll/fsyncFile/closeFd/rename/fsyncDirectory/remove`。createMutex 用 settled-tail：`const run = tail.then(fn, fn); tail = run.catch(() => {}); return run;`
- Run: `node --test test/atomic-json.test.mjs` → Expected: 全过（import 需含 readdirSync、openSync、fsyncSync、renameSync、unlinkSync 等）
- [ ] Step 3: checkpoint commit
- Run: `git add src/atomic-json.mjs test/atomic-json.test.mjs && git commit -m "feat: atomic json store with mutex"` → Expected: commit 成功

### Task 3: src/catalog.mjs 数据核心

- 目标：tgz 严格解析、条目校验、只增不更新合并、修复 R3 的 diff、digest 工具
- 涉及文件：Create `src/catalog.mjs`；Test `test/catalog.test.mjs`
- 接口契约
  - Consumes: 无
  - Produces: `SUPPORTED_APIS`、`extractTgzEntry(buf, { maxBytes }?)`（内部固定匹配 `package/dist/providers/data/github-copilot.json`）、`validateCatalog(api, id, entry) → true | string(原因)`、`mergeCatalog(local, remote) → { merged, added, addedOverlay, skipped }`（`added` 展示数组、`addedOverlay` catalog-shaped 增量）、`diffModels(currentIds, availableIds, catalogIds) → {target, added, removed, kept}`、`digest(x)`、`findPiAiInstallation({ startPath }?) → { catalogFile, packageJsonFile, version } | null`；tgz 构造器 `tgz(entries)` 抽到 `test/helpers.mjs` 供多测试文件复用
- 验证范围：`node --test test/catalog.test.mjs`

- [ ] Step 1: 写失败测试，覆盖场景矩阵中本模块部分：
  - SUPPORTED_APIS 三协议
  - extractTgzEntry：正常提取；路径精确（`xpackage/dist/...` 前缀不误判）；同一目标出现两次 → 抛错；截断 tar → 抛错；`maxBytes` 经超限输入触发语义词错误
  - validateCatalog：api 非白名单、key≠entry.id、entry.api≠section、provider≠github-copilot、contextWindow 非正数 → 各返回原因字符串；合法条目 → true
  - mergeCatalog：只增不更新（已有 id 的元数据变化不覆盖）、白名单过滤、幂等（二次合并 added 为空）
  - **addedOverlay 契约**（R4-1）：catalog-shaped 且仅含本次合法新增——`assert.deepEqual(result.addedOverlay, { "openai-completions": { "gemini-3.8-flash": <remote 条目原样> } })`；非法条目与已有 id 均不进入 addedOverlay；二次 merge 的 addedOverlay 为空对象
  - findPiAiInstallation：定位到安装根 → catalogFile/packageJsonFile/version 三者同根（用夹具目录树模拟 `node_modules/@earendil-works/pi-ai/`）
  - **diffModels 集合不变量**（含 R3 反例）：

```js
test("diffModels：available 但目录不可解析的当前模型必须进 removed（R3）", () => {
  const d = diffModels(["gpt-a", "ghost"], ["gpt-a", "ghost"], new Set(["gpt-a"]));
  assert.deepEqual(d.target, ["gpt-a"]);
  assert.deepEqual(d.removed.sort(), ["ghost"]);
  // 不变量：kept∪removed=current、kept∪added=target、三者两两互斥
  const u = (a, b) => [...new Set([...a, ...b])].sort();
  assert.deepEqual(u(d.kept, d.removed), ["ghost", "gpt-a"].sort());
  assert.deepEqual(u(d.kept, d.added), d.target.slice().sort());
});

test("diffModels：empty target 是合法结果（Y1）", () => {
  const d = diffModels(["gpt-dead"], [], new Set());
  assert.deepEqual(d, { target: [], added: [], removed: ["gpt-dead"], kept: [] });
});
```

- Run: `node --test test/catalog.test.mjs` → Expected: 模块缺失失败
- [ ] Step 2: 实现 `src/catalog.mjs`。`diffModels` 核心：

```js
export function diffModels(currentIds, availableIds, catalogIds) {
  const target = [...new Set(availableIds)].filter((id) => catalogIds.has(id));
  const targetSet = new Set(target);
  const current = [...new Set(currentIds)];
  return {
    target,
    added: target.filter((id) => !current.includes(id)),
    removed: current.filter((id) => !targetSet.has(id)),   // R3：以 target 为准，不以 available 为准
    kept: current.filter((id) => targetSet.has(id)),
  };
}
```

  - `digest(x)`：`createHash("sha256")`；对象用 canonical JSON（递归键排序）后 update
- Run: `node --test test/catalog.test.mjs` → Expected: 全过
- [ ] Step 3: checkpoint commit
- Run: `git add src/catalog.mjs test/catalog.test.mjs test/helpers.mjs && git commit -m "feat: catalog core (strict tgz, validation, additive merge, R3-safe diff)"` → Expected: commit 成功

### Task 4: src/catalog-fetch.mjs npm 拉取与供应链校验

- 目标：最新 pi-ai 目录的受信获取通道
- 涉及文件：Create `src/catalog-fetch.mjs`；Test `test/catalog-fetch.test.mjs`
- 接口契约
  - Consumes: Task 3 `extractTgzEntry`（含 maxBytes）；Task 2 无依赖；**不消费 `validateCatalog`**（逐条目校验唯一归 mergeCatalog，Y2-7 裁决）
  - Produces: `fetchLatestCatalog({registry, fetchImpl}) → { catalog, piAiVersion, integrity }`
- 验证范围：`node --test test/catalog-fetch.test.mjs`

- [ ] Step 1: 写失败测试（fetchImpl 全部 mock）：
  - 正常路径：metadata（含 dist-tags.latest、versions[x].dist.{tarball,integrity}）→ tarball bytes 与 integrity 匹配 → 返回 `{ catalog, piAiVersion, integrity }`
  - metadata 非 200 / 非 JSON / 缺 dist-tags → 抛错
  - integrity 不匹配 → 抛错且**不返回** catalog
  - tarball URL 为 http 且 host ≠ registry host → 抛错；host 相同 → 放行（企业镜像例外）
  - **redirect 系列（🟡-3）**：每次 fetchImpl 调用都收到 `redirect:"manual"`；「允许 URL → 非允许 host」的 30x → 抛错；第 4 跳（超过上限 3）→ 抛错；相对 Location 以当前 URL 正确解析；A→B→A 回环 → 抛错
  - 三层大小上限均为**流式限额读取**（Y3-1：不得先无限缓冲再检查）：`readCapped(res, cap)` 逐 chunk 累计、超限立即 `res.body.cancel()` 并抛错；分别测试无 Content-Length 分块响应的 metadata 超限与 tgz 超限中途停读；解压上限由 `extractTgzEntry(buf, { maxBytes: 100_000_000 })` 经 gunzipSync `maxOutputLength` 落地（超限抛 RangeError，包装为语义词错误）
  - **redirect 边界（Y3-2）**：fetch 一律 `redirect: "manual"`；30x 时逐跳校验 Location 的协议与 host（同 tarball URL 规则）、最大 3 跳；测试「允许 URL → 非允许 host 的 redirect」必须抛错
  - 包膜结构校验（本层职责）：catalog 须为对象、每个 section 为对象——否则整体抛错；**逐条目 schema 校验不在本层**（见下）
- Run: `node --test test/catalog-fetch.test.mjs` → Expected: 模块缺失失败
- [ ] Step 2: 实现（R4-3：删除一切 `response.arrayBuffer()` 无限缓冲路径，统一走 readCapped）：

```js
const metaRes = await fetchImpl(metaUrl, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
if (!metaRes.ok) throw new Error(`npm metadata -> ${metaRes.status}`);
const metadata = JSON.parse((await readCapped(metaRes, 20_000_000)).toString("utf8"));
// ...解析 tarball URL + integrity，逐跳处理 redirect...
const tgzRes = await fetchImpl(tarballUrl, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
const tgz = await readCapped(tgzRes, 30_000_000);
// integrity 校验 → extractTgzEntry(tgz, { maxBytes: 100_000_000 }) → 包膜结构校验
```

  - `readCapped(res, cap)`：`for await (const chunk of res.body)` 累计，超过 cap 即 `res.body.cancel()` 并抛 `response too large`；integrity 用 `createHash("sha512").update(buf).digest("base64")` 对比 `dist.integrity`；registry 缺省 `process.env.npm_config_registry ?? "https://registry.npmjs.org"`；redirect 逐跳：每跳重新校验协议/host（同 tarball 规则），相对 Location 以当前 URL `new URL(loc, currentUrl)` 解析，最多 3 跳，检测到回环（重复 URL）即抛错
- **分层校验契约（Y2-7 裁决）**：fetch 层只管传输可信（integrity/超时/大小/包膜结构）；**逐条目合法性唯一归 mergeCatalog 的 validateCatalog**，非法条目进 `skipped`；preview 响应必须含 `skipped` 列表展示给用户，不得静默
- Run: `node --test test/catalog-fetch.test.mjs` → Expected: 全过
- [ ] Step 3: checkpoint commit
- Run: `git add src/catalog-fetch.mjs test/catalog-fetch.test.mjs && git commit -m "feat: trusted npm catalog fetch (integrity, timeout, size caps)"` → Expected: commit 成功

### Task 5: src/copilot-models.mjs 可用性适配（0.84.4 耦合）

- 目标：现场拉取账号可用模型，语义与 pi-ai 0.84.4 逐行对齐
- 涉及文件：Create `src/copilot-models.mjs`；Test `test/copilot-models.test.mjs`
- 接口契约
  - Consumes: 无（常量从 0.84.4 dist 抄录）
  - Produces: `copilotBaseUrl(access, enterpriseUrl)`、`fetchLiveAvailableModelIds({credential, fetchImpl}) → string[]`（credential 为 GrantRecord payload：`{access, enterpriseUrl?, availableModelIds?}`）
- 验证范围：`node --test test/copilot-models.test.mjs`

- [ ] Step 1: 写失败测试，场景：
  - individual token 含 `proxy-ep=proxy.individual.githubcopilot.com` → baseUrl `https://api.individual.githubcopilot.com`
  - enterprise（须先按 pi-ai `normalizeDomain` 语义规范化，再拼 `https://copilot-api.<domain>`）：裸域 `acme.ghe.com`；URL 形态 `https://acme.ghe.com/path` → 取 hostname；前后空白 → trim；非法值/空字符串 → 视作无 enterpriseUrl 走缺省
  - 无 proxy-ep 无 enterpriseUrl → individual 缺省
  - 严格 picker：`model_picker_enabled` 缺失/ false 的条目不入选（即使 policy enabled）——individual 端点且主集为空时才回退 policy enabled
  - `tool_calls === false` 排除；`policy.state === "disabled"` 排除
  - 非 200 → 抛错（调用方回退 cache）
- Run: `node --test test/copilot-models.test.mjs` → Expected: 模块缺失失败
- [ ] Step 2: 实现。headers 从 `dist/auth/oauth/github-copilot.js` 的 `COPILOT_HEADERS` 常量原样抄录（含 `Editor-Version: vscode/1.107.0` 等），加 `Accept: application/json`、`Authorization: Bearer`、`X-GitHub-Api-Version`（版本值抄录同文件常量）；超时 `AbortSignal.timeout(5000)`；不重试；文件头注释声明「显式耦合 pi-ai 0.84.4，语义漂移时回退 cache 的责任在调用方」
- Run: `node --test test/copilot-models.test.mjs` → Expected: 全过
- [ ] Step 3: checkpoint commit
- Run: `git add src/copilot-models.mjs test/copilot-models.test.mjs && git commit -m "feat: copilot availability adapter pinned to pi-ai 0.84.4 semantics"` → Expected: commit 成功

### Task 6: src/state.mjs 状态文件与 journal

- 目标：持久状态的唯一读写层
- 涉及文件：Create `src/state.mjs`；Test `test/state.test.mjs`
- 接口契约
  - Consumes: Task 2 `readJson`/`writeJsonAtomic`
  - Produces: `loadState(path)`（缺失 → freshState()；坏文件 → **改名留存 `.corrupt-<ts>` 不覆盖**，返回 `freshState()` 且 `lastError: "state-corrupt"`、`lastErrorAt` 置位）、`saveState(path, state)`（原子）、`freshState()` → `{ version: 1, activated: false, restartState: null, appliedOverlay: {}, appliedProvenance: null, journal: null, lastError: null, lastErrorAt: null }`；journal 形状 `{ phase, createdAt, appliedAgainstPiAiVersion, catalogIdentity: { packageName: "@earendil-works/pi-ai", catalogSchemaVersion: 1 }, settingsBaseline: <raw 完整配置视图>, targetIds, pendingOverlay: <catalog-shaped>, catalogBaselineDigest, patchedCatalogDigest, source: { kind, piAiVersion, integrity }, lastError }`，phase ∈ `prepared | catalog-committed-needs-restart`；`restartState` 形状 `{ reason: "refresh" | "self-heal", expectedEntriesDigest, since }`（自愈跨 boot 标记，仅表达「目录写入需跨 boot 加载」，**不携带 settings 意图**）；`appliedOverlay` 与 catalog 同构、**不夹带插件私有字段**，provenance 单独存顶层 `appliedProvenance: { sourcePiAiVersion, integrity, appliedAgainstPiAiVersion, catalogSchemaVersion: 1 }`
  - **lastError 规则（R3-6）**：顶层 `lastError/lastErrorAt` 是唯一诊断面；journal 相位内错误同时投影顶层；`/status.refresh.lastError` 直读顶层；任一相位成功推进/消费时清除顶层 lastError；state 损坏场景返回的安全状态带 `state-corrupt`，且下一次普通保存不得无提示抹掉 `.corrupt-<ts>` 留存文件
- 验证范围：`node --test test/state.test.mjs`

- [ ] Step 1: 写失败测试：fresh 形状；round-trip；坏文件改名留存且 load 返回 fresh；journal 各相位 round-trip
- Run: `node --test test/state.test.mjs` → Expected: 模块缺失失败
- [ ] Step 2: 实现（薄层，逻辑都在 atomic-json）
- Run: `node --test test/state.test.mjs` → Expected: 全过
- [ ] Step 3: checkpoint commit
- Run: `git add src/state.mjs test/state.test.mjs && git commit -m "feat: durable state file with journal phases"` → Expected: commit 成功

### Task 7: 收割 0.85.1 覆盖层（离线 bootstrap）

- 目标：同 v1 Task 2，语义收窄为「仅作手动刷新的离线数据源，不被自动应用」
- 涉及文件：Create `src/catalog-overlay.json`
- 接口契约：Consumes Task 3/4；Produces `src/catalog-overlay.json`（Task 8/9 的 apply mode=overlay 读取）
- 验证范围：幂等与纯增量检查

- [ ] Step 1: 定位并确认当前缺失
- Run: `export CATALOG=$(find /home/ubuntu/.local/share/dsh-runtime/node_modules/.pnpm -path '*pi-ai*/dist/providers/data/github-copilot.json' | head -1) && echo "$CATALOG" && grep -c 'gemini-3.8-flash' "$CATALOG"; true`
- Expected: grep 计数 0
- [ ] Step 2: 生成覆盖层（**带 integrity 校验**，Y2-8：本机 registry 对 0.85.1 返回 HTTP tarball，未校验不得固化进发布包）
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && export CATALOG=$(find /home/ubuntu/.local/share/dsh-runtime/node_modules/.pnpm -path '*pi-ai*/dist/providers/data/github-copilot.json' | head -1) && URL=$(npm view @earendil-works/pi-ai@0.85.1 dist.tarball) && export INTEGRITY=$(npm view @earendil-works/pi-ai@0.85.1 dist.integrity) && curl -fsSL "$URL" -o /tmp/pi-ai-0.85.1.tgz && node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { extractTgzEntry, mergeCatalog, validateCatalog } from "./src/catalog.mjs";
const buf = readFileSync("/tmp/pi-ai-0.85.1.tgz");
const actual = "sha512-" + createHash("sha512").update(buf).digest("base64");
if (actual !== process.env.INTEGRITY) { console.error("integrity mismatch", { actual, expected: process.env.INTEGRITY }); process.exit(1); }
const local = JSON.parse(readFileSync(process.env.CATALOG, "utf8"));
const remote = JSON.parse(extractTgzEntry(buf).toString("utf8"));
const overlay = {}; const bad = [];
const have = new Set(Object.values(local).flatMap((s) => Object.keys(s ?? {})));
for (const [api, section] of Object.entries(remote))
  for (const [id, entry] of Object.entries(section ?? {})) {
    if (have.has(id)) continue;
    const why = validateCatalog(api, id, entry);
    if (why !== true) { bad.push({ id, why }); continue; }
    (overlay[api] ??= {})[id] = entry;
  }
if (bad.length) { console.error("invalid entries:", bad); process.exit(1); }
writeFileSync("src/catalog-overlay.json", JSON.stringify(overlay, null, 2) + "\n");
console.log("integrity OK;", Object.entries(overlay).map(([a, s]) => a + ": " + Object.keys(s).join(",")).join("\n"));
'`
- Expected: `integrity OK` + 输出含 gemini-3.8-flash、claude-fable-5.1、gpt-6-astra（api 归属以实际为准）；命令头部补 `export INTEGRITY=$(npm view ... dist.integrity)`（与 URL 同行获取）
- 收割记录：README 或本计划验收记录中登记 `0.85.1` + integrity 值，保证「added: 3」可复现
- [ ] Step 3: 幂等验证
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && export CATALOG=$(find /home/ubuntu/.local/share/dsh-runtime/node_modules/.pnpm -path '*pi-ai*/dist/providers/data/github-copilot.json' | head -1) && node --input-type=module -e '
import { mergeCatalog } from "./src/catalog.mjs";
import { readFileSync } from "node:fs";
const local = JSON.parse(readFileSync(process.env.CATALOG, "utf8"));
const overlay = JSON.parse(readFileSync("src/catalog-overlay.json", "utf8"));
const first = mergeCatalog(local, overlay), second = mergeCatalog(first.merged, overlay);
console.log("added:", first.added.length, "skipped:", first.skipped.length, "second-pass-added:", second.added.length);
if (second.added.length || first.skipped.length || !first.added.some((e) => e.id === "gemini-3.8-flash")) process.exit(1);
'`
- Expected: `added: 3 skipped: 0 second-pass-added: 0`，退出码 0
- [ ] Step 4: checkpoint commit
- Run: `git add src/catalog-overlay.json && git commit -m "feat: catalog overlay 0.85.1 (offline bootstrap only)"` → Expected: commit 成功

### Task 8: 刷新路由 preview/apply（digest 绑定 + 互斥 + write-ahead）

- 目标：host 两条路由实现「拉取 → diff → digest 确认 → journal → 原子提交目录」
- 涉及文件：Modify `src/shared.mjs`、`src/host.mjs`；Test `test/host.test.mjs`；Create `test/fixtures/catalog-0844.json`
- 接口契约
  - Consumes: Task 2–7 全部
  - Produces: `POST /copilot-auth/refresh/preview`（body 可带 `{ "mode": "overlay" }`，离线时用内置覆盖层出 diff）→ `{ ok, source, catalogSource, catalogError, skipped, added, removed, kept, target, customizationReset: { modelEntryIds, modelOverrideIds }, digests: { settings, available, catalog, remote } }`；`POST /copilot-auth/refresh/apply`（body `{ digests, mode? }`）→ `{ ok, restartRequired: true }` 或 `400 { ok:false, error:"invalid-mode" }` / `409 { ok: false, error: "preview-stale" }`；opts 注入点 `{ catalogFile, stateFile, fetchImpl, overlayFile }`；测试基建 `makeCtx(script, opts)`
  - preview digest 定义：`settings`=**raw user 层完整配置视图**（`{modelsPresent, models 全字段, modelOverridesPresent, modelOverrides 全键值}`）的 canonical digest——字段级变化必须使其漂移（R3-2）；`available`=排序后 available ids；`catalog`=本地目录文件字节；`remote`=实际使用的目录来源对象 canonical digest（与 mode 严格对应）
  - `customizationReset`（Y3-6）：`modelEntryIds` = 当前 models 中带字段定制的条目 id；`modelOverrideIds` = modelOverrides 的键；弹窗据此列出「将被重置的定制」具体名单
  - **normal 模式 npm 失败的行为（R2-5 明确）**：preview 照常返回，但 `catalogSource="local"`、`catalogError` 非空，diff 只反映本地目录可解析的部分；UI 此时展示「使用内置覆盖层」按钮，**点击触发 `mode:"overlay"` 的第二次 preview**（新 diff 需再次确认），apply 绝不未预览自动切换数据源；`mode` 不一致或来源内容变化 → digest 不符 → 409
- 验证范围：`node --test test/host.test.mjs`

- [ ] Step 1: `src/shared.mjs` `routes()` 追加 `refreshPreview: \`${ROUTE_PREFIX}/refresh/preview\``、`refreshApply: \`${ROUTE_PREFIX}/refresh/apply\``
- [ ] Step 2: 写失败测试。文件顶部补 import（`mkdtempSync/writeFileSync/readFileSync/existsSync` from node:fs、`tmpdir` from node:os、`join` from node:path、`tgz` 与夹具常量 from `./helpers.mjs`）；`makeCtx(script = {}, opts = {})`：`ctx.opts = opts`，末尾 `plugin.apply(ctx, opts)`；`call()` 支持 `req.body`（实现侧封装 `readBody(req)`：字面量 body 直接用，否则按流读）。夹具 `test/fixtures/catalog-0844.json` = `{ "openai-completions": { "gpt-a": { "id": "gpt-a", "api": "openai-completions", "provider": "github-copilot", "contextWindow": 100000, "maxTokens": 4096 } } }`。场景：
  - preview live 成功：`source="live"`、`catalogSource="latest"`、removed 含已失效、digest 组存在、`skipped` 字段存在
  - preview `/models` 401 → `source="cache"`；npm 失败 → `catalogSource="local"`、`catalogError` 非空
  - npm 成功但无新增 → `catalogSource="latest"`（Y3：UI 不得靠空数组猜）
  - **R2-5 三件套**：latest preview → `mode:"overlay"` apply → 409；overlay preview → overlay apply → 成功；preview 与 apply 之间 overlayFile 内容变化 → 409
  - **R3-3**：normal preview + npm 失败 + overlayFile 含独有新模型 → `catalogSource="local"` 且 added 不含 overlay 独有条目（证明未读 overlay）；未知 mode（如 `"nightly"`）→ 400
  - **R3-2 字段级漂移**：preview 后仅改某同 id 条目的 `displayName` → apply 409，catalog/state 零写入；仅改某 override 键的值 → 409；raw 视图 canonical 化须区分「键缺失」与「显式空数组/空对象」
  - apply 正常：journal phase 最终为 `catalog-committed-needs-restart`、journal 含 `pendingOverlay`（catalog-shaped）与 `appliedAgainstPiAiVersion`（取自 `findPiAiInstallation().version`）、目录文件含新条目、stateFile `activated=true` 且 `restartState.reason="refresh"`、appliedOverlay 含新条目（无插件私有字段）、顶层 `appliedProvenance` 记录来源版本与 integrity
  - apply digest 漂移（篡改 settings digest）→ 409 `preview-stale`，目录文件与 stateFile 均未变
  - 并发两个 apply → 第二个等第一个完成；最终状态一致（mutex）；**第一个 apply 抛错后第二个仍执行**（settled-tail 不中毒）
  - 崩溃恢复三注入点（R2-1）：prepared 已写但目录未 rename；目录已 rename 但 appliedOverlay/activated 未存；activated 已存但相位未推进——三种现场下重启 apply() 都能幂等补全并推进到 committed
- Run: `node --test test/host.test.mjs` → Expected: 新用例失败（路由未注册）
- [ ] Step 3: 实现 `src/host.mjs`
  - `findCatalogFile()`（从 `readCatalogModelIds` 拆出的路径定位层，后者行为不变）
  - `resolveAvailable(ctx, fetchImpl)`：`readRecord(CREDENTIAL_KEY)` → 有 `payload.access` 先试 `fetchLiveAvailableModelIds`（Task 5），任何异常回退 `payload.availableModelIds`；返回 `{ ids, source }`
  - `resolveCatalogSource(opts, mode)`（R3-3 严格分支，替代 v3 的 resolveRemoteCatalog 隐式回退）：

```js
async function resolveCatalogSource(opts, mode) {
  if (mode === "overlay") {
    return { catalog: JSON.parse(readFileSync(opts.overlayFile, "utf8")),
             catalogSource: "overlay", catalogError: null, provenance: { kind: "overlay" } };
  }
  if (mode !== undefined && mode !== "latest") throw new InvalidModeError(mode); // → 400
  try {
    const r = await fetchLatestCatalog({ fetchImpl: opts.fetchImpl });
    return { catalog: r.catalog, catalogSource: "latest", catalogError: null,
             provenance: { kind: "latest", piAiVersion: r.piAiVersion, integrity: r.integrity } };
  } catch (error) {
    return { catalog: readLocalCatalog(opts), catalogSource: "local", catalogError: String(error),
             provenance: { kind: "local" } }; // normal 失败绝不读 overlay
  }
}
```
  - preview handler：guard → `readBody` 取 mode（未知 → 400）→ resolveAvailable → `resolveCatalogSource(opts, mode)` → 合并后 id 集 → `diffModels` → customizationReset → digest 组 → 200
  - apply handler：guard → `readBody`（mode 未知 → 400）→ **mutex 内**：重拉全部输入重算 digest（settings 用 raw 完整视图）→ 与 body.digests 比对，任一不符 → 409 → 一致则 write-ahead：①saveState(journal=prepared，含 `pendingOverlay`=mergeCatalog 的 **addedOverlay**（catalog-shaped）、`settingsBaseline`=raw 完整配置视图、`targetIds`、`appliedAgainstPiAiVersion=findPiAiInstallation().version`、`catalogIdentity`、source provenance) ②原子写目录 ③合入 appliedOverlay（净条目）+ 顶层 appliedProvenance、`activated=true`、`restartState={reason:"refresh"}` ④journal 相位推进为 catalog-committed-needs-restart → 200 `{ ok, restartRequired: true }`
  - 任何异常 → 500 `{ ok: false, error }`，journal 保留
- Run: `node --test test/host.test.mjs` → Expected: 全过
- [ ] Step 4: checkpoint commit
- Run: `git add src/shared.mjs src/host.mjs test/host.test.mjs test/fixtures/ test/helpers.mjs && git commit -m "feat: refresh preview/apply with digest binding, mutex, write-ahead journal"` → Expected: commit 成功

### Task 9: 启动序列（prepared 恢复 / 激活门 / 自愈 / 真 CAS 同步）

- 目标：插件 apply() 启动路径实现 R2-1/R2-2/R2-3/R2-4 与兼容 gate
- 涉及文件：Modify `src/host.mjs`；Test `test/host.test.mjs`
- 接口契约
  - Consumes: Task 2/3/6/8；DSH settings 契约 `ctx.settings.describe()`（含 ns 与 revision）与 `ctx.settings.mutate(ns, ops, expectedRevision)`（revision 不符时抛 SETTINGS_CONFLICT 类错误——实现时先在 dsh 源码锚点 `dsh-settings` 包的 mutate 定义处核对确切错误形状，再写断言）
  - Produces: `/status` 响应 `{ configured, syncError, refresh: { activated, pendingRestart, phase, lastError, piAiVersion, catalogDigest, catalogFile } }`——`pendingRestart` 派生自状态文件（journal 相位或 restartState 非空），不用模块布尔；`piAiVersion/catalogDigest/catalogFile` 来自 `findPiAiInstallation()`（version 与 catalog 同根；digest 为该文件当前字节的 sha256）——E2E 据此把被检查文件绑定到实际加载副本（R4-5）；state-corrupt 时 `lastError` 为 `state-corrupt`，UI 须显示「状态文件已损坏并隔离，自动自愈已停用，需重新刷新激活」（🟡-4）
- 验证范围：`node --test test/host.test.mjs`

- [ ] Step 1: 写失败测试，场景：
  - **R2-1 崩溃恢复**（三注入点，见 Task 8 清单；此处断言恢复在 activation gate **之前**生效：`activated=false` + journal=prepared + pendingOverlay → 启动后目录补齐、activated=true、相位推进、本 boot 不同步 settings）
  - **R3-1 恢复也过 gate**：`activated=false` + journal=prepared(`appliedAgainstPiAiVersion:"0.84.4"`) + 当前 pi-ai=0.85.x（opts.piAiVersion 钩子）→ 目录零写入、journal 保留、`/status.refresh.lastError` 含 `prepared-incompatible`
  - 未激活 + 本地目录缺条目 + 无 journal → 启动**不写**目录文件（R9）
  - 已激活 + appliedOverlay 有条目缺失 + 当前 pi-ai==基线 → 重放写目录、`restartState={reason:"self-heal"}`、**本 boot 不调 settings.mutate**（R7）
  - **R2-2 跨 boot + R3-5 职责分离**：journal=null + restartState.reason="self-heal" + 目录已满足 expected entries + 本 boot 无目录写入 → **不调用 describe/mutate**、清 restartState、`/status.refresh.pendingRestart===false`
  - **兼容 gate**：状态的 `appliedProvenance.appliedAgainstPiAiVersion` ≠ 当前 pi-ai 版本（opts 注入 `piAiVersion` 测试钩子；生产实现经 `findPiAiInstallation().version` 读取，勿实现成顶层字段）→ 条目已原生存在则空操作；有缺失则不写安装树、`/status.refresh.lastError` 含 `self-heal-incompatible`
  - **R2-3 真 CAS**：journal=committed + 内容 baseline 匹配 → mock `settings.describe()` 返回 revision 7；`mutate` 断言收到 `expectedRevision===7`；另设用例：mutate 抛 SETTINGS_CONFLICT → journal 保留、lastError=conflict、不删除状态
  - **并发写注入**：在「读 revision 之后、mutate 之前」由测试脚本先触发一次真实 settings 变更使 revision 过期 → 断言本次同步被拒绝且不覆盖
  - **R2-4 modelOverrides**：初始配置仅 `modelOverrides`（无 models）→ 同步后 models 写入且 modelOverrides 被 unset（同一 mutate 调用的两个 op）；baseline/digest 同时覆盖两者
  - empty target → `value: []`（Y1）
  - 当前 `{models,modelOverrides}` 已等于 target 形状 → 幂等消费 journal，不再 mutate
  - **Y2-3 语义前置**：目录文件被无害重格式化（字节变、条目全在）→ whole-file digest 不符也照常同步（前置是 targetIds 全部可解析）
- Run: `node --test test/host.test.mjs` → Expected: 新用例失败
- [ ] Step 2: 实现启动序列（`apply(ctx, opts)` 开头，整体 try/catch，失败只记 lastError + logger.warn，绝不阻断挂载），严格按「架构快照」boot 0→1→2 顺序：
  0. journal=prepared 恢复（**先过兼容 gate**，R3-1）：`findPiAiInstallation().version === journal.appliedAgainstPiAiVersion` 才继续，否则目录零写入、journal 保留、顶层 lastError=`prepared-incompatible` 并止步；通过后 `mergeCatalog(磁盘目录, journal.pendingOverlay)` 有 added → 原子写目录；合入 appliedOverlay、`activated=true`、相位推进 committed、restartState={reason:"refresh"}；`bootPatched=true`
  1. 自愈（仅 activated 且 piAiVersion==appliedAgainstPiAiVersion）：appliedOverlay 缺失条目 → 原子重放、restartState={reason:"self-heal"}、bootPatched=true；跨版本按 gate 规则
  2. `!bootPatched` 时两个**独立**出口（R3-5）：a. journal=committed → 语义前置（targetIds ⊆ 当前目录可解析 id 集）→ `describe()` 取 revision 与当前 raw 视图 → ==baseline → `mutate(ns, [set models, unset modelOverrides], revision)`；已==target → 幂等消费；其余 → conflict 保留；b. restartState 非空且 expected entries 已在目录 → 仅清 restartState（**不得触碰 describe/mutate**）
  3. lastError 生命周期：任一相位成功推进/消费时清顶层 lastError/lastErrorAt；失败时置位并保留 journal
- Run: `node --test test/host.test.mjs` → Expected: 全过
- [ ] Step 3: checkpoint commit
- Run: `git add src/host.mjs test/host.test.mjs && git commit -m "feat: boot recovery, gated self-heal, revision-fenced settings CAS"` → Expected: commit 成功

### Task 10: client 状态机与 UI

- 目标：`src/refresh-flow.mjs` 状态机模块（reduce 纯函数 + runEffect/advance 注入式副作用）+ client.jsx 接线
- 涉及文件：Create `src/refresh-flow.mjs`；Test `test/refresh-flow.test.mjs`；Modify `src/client.jsx`；产出 `lib/client.js`
- 接口契约
  - Consumes: Task 8/9 路由与 /status 契约
  - Produces: `reduce(state, event)` 状态机：`idle → previewing → confirming(preview) → applying → restartNeeded`；`failed(error)` 可回 idle；**apply 409 → `previewing` 自动重新拉取（Y2-1 裁决：409 响应不携带新 preview，client 重新 POST preview）→ 成功进 `confirming`（带 `staleNotice: true`，UI 提示「数据已变化，请重新确认」）→ 重新 preview 也失败 → `failed`**；`restartNeeded` 可由 /status 水合
- 验证范围：`node --test test/refresh-flow.test.mjs` + `npm run build` + `npm test` 全绿

- [ ] Step 1: 写失败测试：正常流转、preview 失败 → failed、apply 409 → previewing → confirming(staleNotice)、409 后重新 preview 失败 → failed、apply 500 → failed、confirming 取消 → idle、双击 apply 只发一次（applying 态忽略重复事件）、confirming(overlay 来源) 展示来源标记、页面刷新后 /status 的相位水合为 restartNeeded
- [ ] Step 1b: **effect runner 接线测试**（Y3-3：reducer 不证明接线）：把副作用抽成 `runEffect(effect, fetchImpl)`（effect 为状态机输出的数据化指令 `{type:"preview",mode}` / `{type:"apply",mode,digests}` / `{type:"status"}`），用 mock fetch 验证：latest 409 后以**原 mode** 发恰好一次 preview；overlay 409 后仍以 overlay 重 preview；不重发 apply；重 preview 失败进 failed
- [ ] Step 1c: **controller 闭环测试**（🟡-1：reducer 过 + runner 过 ≠ 接线正确）：再抽 `advance(state, event, fetchImpl)`——reduce → 执行 effect → 结果事件送回 reduce → 循环至无 effect；端到端断言「overlay apply 409 → 保持 overlay mode → 只重 preview 一次 → 成功后进 confirming(staleNotice)」；`client.jsx` 必须只经 `advance` 驱动，不直接调 reducer/runEffect
- Run: `node --test test/refresh-flow.test.mjs` → Expected: 模块缺失失败
- [ ] Step 2: 实现 `src/refresh-flow.mjs`：`reduce()` 保持纯函数不执行 I/O；`runEffect()` 为副作用执行器、`advance()` 为 controller（驱动 reduce → effect → 结果事件回送），两者只使用注入的 `fetchImpl`——**模块不直接引用全局 fetch**，所有网络能力经注入获得
- Run: `node --test test/refresh-flow.test.mjs` → Expected: 全过
- [ ] Step 3: `src/client.jsx`：DICTS 双语新增键（沿用 v1 清单，追加 `stalePreview`: "Inputs changed — review the new diff" / "数据已变化，请重新确认差异"；`overlayBtn`: "Preview with bundled overlay" / "改用内置覆盖层预览"；`stateCorrupt`: "State file was corrupted and quarantined; auto self-heal is disabled — run a refresh to re-activate." / "状态文件已损坏并被隔离；自动自愈已停用，请重新执行一次刷新以激活。"）；已登录区加「刷新可用模型目录」按钮；弹窗渲染 added（绿）/removed（红）/kept 计数/skipped（黄，如有）/**customizationReset 名单**（将被重置的字段定制与 overrides，Y3-6）/source 提示/三条风险文案/确认取消；`catalogSource==="local"` 时展示 `overlayBtn`，**点击 = 发 `mode:"overlay"` 的新 preview**（不直接 apply，R2-5）；409 后按状态机自动重拉并标 stalePreview；restartNeeded 提示条；`/status.refresh.lastError === "state-corrupt"` 时显示 `stateCorrupt` 而非通用错误；fetch 层只经 `advance` 驱动状态机
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && npm run build && npm test && grep -c 'refreshNow' lib/client.js`
- Expected: build 无错；测试全绿；grep ≥ 1
- [ ] Step 4: checkpoint commit
- Run: `git add src/refresh-flow.mjs src/client.jsx lib/client.js test/refresh-flow.test.mjs && git commit -m "feat: refresh UI driven by pure state machine"` → Expected: commit 成功

### Task 11: 发布准备（version / lock / files / README / pack 精确断言）

- 目标：发布物一致性
- 涉及文件：Modify `package.json`、`package-lock.json`、`README.md`
- 接口契约：Consumes Task 1–10；Produces 无
- 验证范围：pack JSON 逐项断言 + npm test

- [ ] Step 0: **clean-tree 前置检查**（R4-4：必须在修改前做；`git diff` 不含 untracked，用 porcelain）
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && test -z "$(git status --porcelain)" || { git status --short; echo "working tree is not clean" >&2; exit 1; }`
- Expected: 退出码 0（此前任务的 commit 已全部落盘；CONTEXT/docs 若未提交须先提交）
- [ ] Step 1: `package.json` version → `1.1.0`，files 追加全局约束列出的 7 项；`package-lock.json` 根 `version` 与 `packages[""].version` 同步为 1.1.0
- [ ] Step 2: README：特性新增「手动补充新模型目录条目（diff 预览 + 二次确认 + 数据级补丁，pi-ai 版本不动）」；新增「模型目录刷新」章节（两阶段、激活边界、数据源与回退、风险三条、只增不更新语义）；修订已知边界 105/106 行指向本功能；新增边界条目：①「DSH 升级后自愈仅在 pi-ai 基线版本不变（0.84.4）时重放；跨版本缺失条目上报 `self-heal-incompatible` 不改安装树」；②「并发保护为宿主单进程内 mutex，不支持多实例并发刷新」（评审接受的取舍，需成文）
- [ ] Step 3: 验证（构建产物防陈旧 + pack 精确断言；只断言 `lib/client.js` 无意外漂移，不要求整树无 diff——Step 1/2 的预期改动尚未提交；Y3-5/R4-4）
- Run: `cd /home/ubuntu/workspace/dsh-copilot-auth && npm run build && git diff --exit-code -- lib/client.js && npm test && node --input-type=module -e '
const { execSync } = await import("node:child_process");
const out = JSON.parse(execSync("npm pack --dry-run --json").toString());
const files = out[0].files.map((f) => f.path);
for (const need of ["src/catalog.mjs", "src/catalog-fetch.mjs", "src/copilot-models.mjs", "src/atomic-json.mjs", "src/state.mjs", "src/refresh-flow.mjs", "src/catalog-overlay.json", "lib/client.js"])
  if (!files.includes(need)) { console.error("missing:", need); process.exit(1); }
const pkg = JSON.parse((await import("node:fs")).readFileSync("package.json", "utf8"));
const lock = JSON.parse((await import("node:fs")).readFileSync("package-lock.json", "utf8"));
if (pkg.version !== "1.1.0" || lock.version !== "1.1.0" || lock.packages?.[""]?.version !== "1.1.0") { console.error("version mismatch"); process.exit(1); }
console.log("pack files & versions OK");
' && git diff --exit-code -- lib/client.js && git status --porcelain | grep -vE '^ M (package\.json|package-lock\.json|README\.md)$' | (! grep .)`
- Expected: build 后 `lib/client.js` 无 diff（入库产物不陈旧，prepack 重建不掩盖）；输出 `pack files & versions OK`；测试全绿；pack 后仍无 diff；脏文件仅限 Step 1/2 的三个预期文件
- [ ] Step 4: checkpoint commit
- Run: `git add package.json package-lock.json README.md && git commit -m "docs+release: 1.1.0 model catalog refresh"` → Expected: commit 成功

### Task 12: 真机端到端验收（GUI 外受控重启）

- 目标：验收五条（可见可调通 / Claude 回归 / 失效消失 / 自愈 / pi-ai 版本不变）
- 涉及文件：无（运维操作）
- 接口契约：Consumes Task 11 产物；Produces 验收记录
- 验证范围：本任务各步预期逐条达成

- [ ] Step 1: 源码重装插件（此后按 `dsh-intall-know-how/AGENTS.md`「升级后必查」核对既有本地补丁，重点：004 的 ego-browser 守卫补丁、003 的 client.js key 补丁）
- Run: `dsh plugin --profile web add /home/ubuntu/workspace/dsh-copilot-auth`
- Expected: 安装成功；know-how 必查项逐条确认（补丁是否仍在）
- [ ] Step 2: 受控重启（本步骤是**安装后**的唯一重启；健康检查参与失败链，000 一律 exit 1）。**重启由 GUI 外 SSH/人工控制面执行**（不依赖 GUI 内 agent 自杀后 nohup 存活的假设；评审已实测 GUI agent 环境无法连接 user bus）：
- Run: `sudo systemctl restart deepseek-harness.service && code=000 && for i in $(seq 1 30); do code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080); [ "$code" = 200 ] && break; sleep 1; done; [ "$code" = 200 ] || { echo "health check failed: $code" >&2; exit 1; }`
- Expected: 退出码 0（restart 失败或 30s 未 200 都会非零退出）
- [ ] Step 3: UI 操作：设置 → GHC设置 → 刷新可用模型目录 → 弹窗 diff 含 gemini-3.8-flash（新增）与失效模型（移除）→ 确认 → 重启提示。**然后执行且仅执行一次重启**（R2-7：apply 到断言之间只允许一次重启，否则掩盖「两阶段只需一次重启」的错误实现）：
- Run: 同 Step 2 的重启+健康检查命令
- Expected: 退出码 0
- [ ] Step 4: 精确断言（Node+YAML；**本步不再重启**；R3-8 + R4-5：被检查 catalog 与插件实际加载副本经 digest 绑定，不看打印值）：
- Run: `node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import YAML from "/home/ubuntu/workspace/dsh-copilot-auth/node_modules/yaml/dist/index.js";
const status = await (await fetch("http://127.0.0.1:3080/copilot-auth/status")).json();
const r = status.refresh ?? {};
// ① 权威来源是 /status 暴露的实际加载副本身份，不用 find|head-1
if (r.piAiVersion !== "0.84.4") throw new Error("unexpected loaded pi-ai: " + r.piAiVersion);
if (typeof r.catalogFile !== "string" || !r.catalogFile.endsWith("github-copilot.json")) throw new Error("no catalogFile identity");
const catalogBytes = readFileSync(r.catalogFile);
const localDigest = createHash("sha256").update(catalogBytes).digest("hex");
if (localDigest !== r.catalogDigest) throw new Error(`catalog digest mismatch: local=${localDigest} status=${r.catalogDigest}（读到的不是插件实际解析的副本）`);
const catalog = JSON.parse(catalogBytes.toString("utf8"));
const inCatalog = Object.values(catalog).some((s) => s && "gemini-3.8-flash" in s);
const settings = YAML.parse(readFileSync(process.env.HOME + "/.dsh/settings.yaml", "utf8"));
const models = settings["llm-pi-ai"]?.providers?.["github-copilot"]?.models?.map((m) => m.id) ?? [];
const state = JSON.parse(readFileSync(process.env.HOME + "/.dsh/copilot-auth-state.json", "utf8"));
if (!inCatalog) throw new Error("catalog missing gemini-3.8-flash");
if (!models.includes("gemini-3.8-flash")) throw new Error("settings missing gemini-3.8-flash");
if (state.journal !== null && state.journal !== undefined) throw new Error("journal not consumed");
if (state.lastError) throw new Error("state lastError: " + state.lastError);
if (r.phase !== null && r.phase !== undefined) throw new Error("status phase not clear: " + r.phase);
if (r.pendingRestart !== false) throw new Error("pendingRestart still true");
if (r.lastError) throw new Error("status lastError: " + r.lastError);
console.log("E2E core assertions OK");
'`
- Expected: 输出 `E2E core assertions OK`——catalog 文件即插件实际解析副本（digest 相等）、含新模型、settings 已同步、journal 已消费、status 完成态干净、加载副本为 0.84.4
- [ ] Step 5: 验收 ①②③：Models 页选 gemini-3.8-flash 真实对话一次通过；Claude 系任一模型对话回归通过；失效模型从 Models 页消失
- [ ] Step 6: 验收 ④自愈演练（独立验证其规定的两个 boot，不占主流程的重启计数）：备份目录 JSON → 删除 gemini-3.8-flash 条目 → GUI 外重启（boot 1）→ 断言文件被重放修复且 /status 报 `pendingRestart:true`、本 boot settings 未被改动 → GUI 外再重启（boot 2）→ `pendingRestart:false`、模型可用 → **恢复现场**（确认 settings/目录与演练前一致，删除临时备份）
- [ ] Step 7: 验收 ⑤ pi-ai 版本不变（R3-8-B：总数与唯一性分别断言，多版本并存必失败）：
- Run: `mapfile -t dirs < <(find /home/ubuntu/.local/share/dsh-runtime/node_modules/.pnpm -maxdepth 1 -name '@earendil-works+pi-ai@*' -printf '%f\n'); printf '%s\n' "${dirs[@]}"; [ "${#dirs[@]}" -eq 1 ] || { echo "multiple pi-ai installs" >&2; exit 1; }; [[ "${dirs[0]}" == "@earendil-works+pi-ai@0.84.4_"* ]] || { echo "unexpected version: ${dirs[0]}" >&2; exit 1; }; grep -q "earendil-works/pi-ai@0.84.4" /home/ubuntu/.local/share/dsh-runtime/pnpm-lock.yaml`
- Expected: 恰好一个 pi-ai 安装目录且为 0.84.4；lockfile 含 0.84.4；任一条件不满足即非零退出

## 执行纪律

- 开始实现前，先批判性复查整份计划；发现缺项、矛盾、命名不一致或验证命令无效，先修计划
- 按任务顺序执行，不要无声跳步、合并步或改变任务目标
- 每完成一个任务，都运行该任务定义的验证
- 遇到阻塞、重复失败或计划与仓库现实不符，立即停下来说明，不要猜
- 当前在 `main` 分支；如未获明确同意，开始实现前先确认
- 全部任务完成后，运行最终验证并输出修改摘要

## 测试场景矩阵（替代固定数量门禁）

- catalog：白名单 / tgz 正常·精确路径·重复条目·截断·maxBytes / 条目校验五类违法 / 合并只增不更新·幂等 / **addedOverlay 同构·非法不入·已有不入·二次为空** / diff 不变量·R3 反例·empty target / findPiAiInstallation 同根解析
- catalog-fetch：正常+integrity / metadata 非 200·非 JSON·缺 dist-tags / integrity 不匹配 / http 例外与拒绝 / redirect（每跳 manual·非允许 host 必抛·第 4 跳拒绝·相对 Location·回环拒绝）/ 三层超限（流式 metadata·流式 tgz·maxOutputLength 防 gzip bomb）
- atomic-json：缺失·坏 JSON / 完整写·无残留 / 五故障点注入（writeAll 抛错·fsyncFile·rename·fsyncDirectory 降级）/ **writeAll 短写循环·零进度抛错** / mutex 串行·reject 不中毒
- refresh-flow：reducer 全状态流转 / effect runner（latest 409 原 mode 重 preview·恰好一次 / overlay 409 保持 overlay / 不重发 apply / 重 preview 失败 → failed）/ **controller advance 闭环（overlay 409 → 一次重 preview → confirming(staleNotice)）** / status 水合·state-corrupt 文案
- copilot-models：proxy-ep / enterprise（裸域·URL 形态·空白·非法·空串的 normalizeDomain 语义）/ 缺省 / 严格 picker / policy 回退仅 individual / tool_calls 排除 / 非 200 抛错
- state：fresh / round-trip / 坏文件改名留存且返回 state-corrupt 安全态 / journal 相位 round-trip / 顶层 lastError 投影与清除
- host：preview live·cache 回退·catalogSource 三态·customizationReset·skipped 展示 / apply 正常·400 invalid-mode·409·并发·settled-tail 不中毒 / R2-5 三件套（latest→overlay 409、overlay→overlay 成功、overlay 文件变化 409）/ R3-3 normal 失败不读 overlay / R3-2 字段级漂移 409 / 崩溃恢复三注入点
- 启动序列：prepared 恢复先于激活门且过兼容 gate（跨版本 prepared-incompatible）/ 未激活不写 / 自愈重放且本 boot 不同步 / 跨 boot restartState 清除（单独存在时不触碰 describe/mutate）/ pi-ai 版本 gate（同基线重放·已原生存在空操作·跨版本 self-heal-incompatible）/ 真 CAS（expectedRevision 断言·冲突保留·revision 过期注入）/ modelOverrides set+unset 同 op / empty target / 幂等 / 语义前置替代 whole-file digest

## 最终验证

- `cd /home/ubuntu/workspace/dsh-copilot-auth && npm test && npm run build`（场景矩阵全绿）
- Task 11 的 pack/版本精确断言
- Task 12 真机五条验收全过

## 审阅 Checkpoint

- 计划正文结束。审阅通过前，不进入实现。
