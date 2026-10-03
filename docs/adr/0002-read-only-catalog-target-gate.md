# ADR 0002 — 只读安装目标的可写性门禁（desktop asar 形态）

日期：2026-10-03 · 状态：已采纳 · 落地版本：v1.2.4

## 背景与问题

dsh-desktop（Electron 桌面版）把整个运行时树打进 `resources/app.asar`（约 121MB），
`@earendil-works/pi-ai` 的唯一副本位于 `app.asar/dsh/node_modules/@earendil-works/pi-ai`；
`app.asar.unpacked` 只解包原生二进制包（node-pty、libreoffice-kit 等），**不含 @earendil-works**，
`resources/runtime` 只是 node/pnpm/python 工具链。Electron 的 asar 虚拟文件系统**读没问题、
创建/写入必被拒**。

数据级目录补丁（ADR 0001）的 apply 路由按 write-ahead 顺序先落 prepared journal、再原子写目录。
在 desktop 形态下 writeJsonAtomic 的临时文件创建（`openSync(dir/".<name>.tmp-<uuid>", "wx")`）
被 asar 拒绝，用户看到的是天书：

```text
ENOENT: dsh\node_modules\@earendil-works\pi-ai\dist\providers\data\.github-copilot.json.tmp-4502f536-... not found in C:\...\resources\app.asar
```

更糟的是 prepared journal 已经落盘：若本次 diff 恰好为空，下次 boot 的 prepared 恢复走
「added=0 → 跳过写 → 提交」幸运路径自愈（实测 2026-10-03 本机即此形态）；一旦 diff 非空，
**每个 boot 都会重试写 asar → 每次抛错**，journal 永卡 prepared、激活永不落地。

## 决策

1. **写盘前分类，而非写失败后解释**。`classifyCatalogTarget(catalogFile, writableProbe?)`
   在 `resolveInstall()` 统一产出 `writable / unwritableReason`：
   - `isAsarPath()`：路径任一段以 `.asar` 结尾（大小写不敏感、`/` `\` 都认、`.asar.unpacked`
     不误判）→ `reason: "asar"`，纯词法判定、不触盘、三平台行为一致；
   - `probeWritable(dir)`：目录内排他创建+删除 UUID 探针文件 → 失败 `reason: "probe-failed"`
     （覆盖只读卷、根属主安装、ACL 拒绝——win32 chmod 弱语义下唯一可靠的通用手段）。
2. **apply 快速失败在 write-ahead 之前**：不可写目标 → 400
   `{ ok:false, error:"catalog-not-writable", reason, catalogFile }`，**绝不落 journal**。
3. **boot 序列不重试写只读目标**：boot0 prepared 恢复与 boot1 自愈在写盘前检查门禁；
   不可写 → 记可 grep 的 `lastError`（`catalog-not-writable (<reason>): ...`）、journal 与
   appliedOverlay **原样保留**、零写入、不阻断挂载。保留（而非丢弃）的原因：目标将来变可写
   （如桌面版改为 asarUnpack pi-ai）时，既有恢复/自愈机制无需任何操作即自动完成补丁。
4. **UI 与观测面**：preview 与 `/copilot-auth/status` 暴露 `catalogWritable`；client 水合后
   置灰刷新入口并显示解释文案（双语词典 `notWritable`）；确认弹窗在 `catalogWritable===false`
   时同样禁用确认按钮。
5. **平台与形态兼容**：门禁对可写目标是纯增量（探测为两次系统调用级别的创建/删除）；
   Linux 服务部署、macOS、Windows 直装形态行为完全不变。asar 检测不依赖 Electron API
   （不用 `process.noAsar`/Electron 模块），普通 Node 进程同样可测。

## 否决的替代方案

- **写失败后回滚 journal**：仍会先写一次 journal 再失败，错误信息只能是事后包装的 ENOENT，
  且 boot0 重放路径需要同等回滚逻辑——两处失败点不如一处门禁。
- **丢弃 journal 换取 boot 干净**：丢失 pendingOverlay，目标变可写后用户必须重新完整刷新；
  保留 journal 则自动完成。
- **`process.noAsar = true` 绕道写 `.asar.unpacked` 真实路径**：pi-ai 并未被解包，归档内
  副本才是宿主实际加载的副本，写了也不生效——该路线只在桌面版上游把 pi-ai 加入
  asarUnpack 之后才有意义（届时本门禁的 asar 分支应同步放行 `.unpacked` 真实路径写入）。
- **仅词法检测不探测**：无法覆盖只读卷/ACL 等非 asar 不可写形态，同类问题会在别的部署上复发。

## 后果

- desktop 用户获得明确的中文化解释与置灰入口，而不是天书 ENOENT；状态文件不再被失败
  apply 污染。
- 测试以「目录名以 `.asar` 结尾的真实目录」模拟归档形态（三平台均可创建该目录名），
  `opts.writableProbe` 注入覆盖 probe-failed 分支；CI 扩为 ubuntu/windows/macos 三平台矩阵。
- 上游跟进路径（背案）：请 dsh-desktop 把 `**/@earendil-works/pi-ai/**` 加入 asarUnpack
  （自愈机制天然消化应用更新后的补丁重放），或请 dsh-llm-pi-ai/pi-ai 提供目录数据路径覆盖。
  两者任一落地后，本 ADR 的 asar 分支按退役规则复审。

## 实测记录（2026-10-03，本机 dsh-desktop 0.2.0-rc.2 / pi-ai 0.87.1）

- 修复前：刷新按钮 → 上图天书 ENOENT；状态文件 prepared journal 在空增量下于下次 boot 自愈。
- 修复后：`/status.refresh.catalogWritable=false`、按钮置灰、apply 400 `catalog-not-writable`
  （reason "asar"）、零落盘；web 同构安装树全量回归 114/114 通过（Windows 本机实测）。
