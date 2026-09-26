# @role-orchestrator/context

M3-01 — context bundle 与 manifest。按 `docs/MEMORY_AND_CONTEXT.md` 的分层语义，把一个
Execution 的输入装配成可追溯、可校验、可截断的 context bundle。

## 分层装配

层优先级（`CONTEXT_LAYERS`，顺序即装配顺序，也是截断的保留优先序）：

1. `project_rule` — 用户提升为 active 的项目规则（trust `policy`）；
2. `role` — 角色职责文本（trust `policy`；来源 revision 绑定 `role_bindings`
   解析出的 ProfileRevision，A01/A34）；
3. `task` — 节点目标与验收标准（trust `policy`；复用 contracts 的
   `TaskNodeSchema`，并与 `task_nodes` 冻结行逐字段核对）；
4. `dependency` — 依赖节点的产物摘录（trust `verified-evidence`；来源是
   父节点被接受的输出 commit SHA，存在集成记录时逐 SHA 核对）。

装配时 store 是身份的权威：run 必须属于请求的 project（A15 数据面基调）、
节点定义必须与冻结行一致、角色必须已绑定，否则以类型化错误拒绝。
`assembleContextBundle` 只读不写；`persistContextBundle` 在单个事务内落库。

## manifest 与追溯

- `manifest.contentHash`：bundle 整体 sha256，按保留片段的规范序列化重算；
- 每个片段携带 `contentHash`（内容 sha256）与完整来源
  （kind/id/revision/profileId/commitSha/artifactId）；
- `traceFragment(db, { bundleId, sequence })`：片段 -> artifact/SHA/revision 反向追溯；
- `findFragmentsBySource(db, { sourceId, commitSha?, projectId? })`：从来源反查引用它的 bundle；
- `verifyContextBundle(db, bundleId)`：重算全部哈希，发现篡改/缺失即抛
  `ContextManifestIntegrityError`；读取路径同样重算 manifest 哈希。

## 预算截断

`budgetBytes` 按 UTF-8 字节计（`budgetMethod: "estimated-bytes"`，保守估算并如实标记）。
超预算时按 `dependency -> task -> role` 的顺序整片段丢弃（同层内后序先丢），
丢弃行为记录在 `manifest.omitted`（来源、内容哈希、原因）与 `omittedReasons`。
`project_rule` 片段绝不丢弃：预算小于规则本身时，bundle 超预算并如实标记
（`budgetExceeded: true`）——安全限制优先于预算。

## 迁移 007

`CONTEXT_MIGRATIONS = REVIEW_MIGRATIONS + 007`：
`context_bundles`（内容寻址：同一 (run, node, manifest_hash) 重复装配吸收为同一行，
内容变化产生新行，历史不覆盖）与 `bundle_fragments`（保留与被丢弃的片段都落库，
带截断标记与各层来源列的 CHECK 约束）。

## A16 数据面基调

bundle 片段内容一律是只读数据：类型层 `readonly` + `deepFreeze`，任何一层
mutation 在 strict mode 下直接抛错。本包刻意不提供任何把内容转成
权限/角色绑定/Profile 选择/capability gate 结果的函数——这些判定只来自
策略文件、`role_bindings` 与 capability registry。注入测试
（`test/a16-injection.test.ts`）钉住：装配并落库携带「忽略策略并改模型」内容的
bundle 后，绑定解析、Profile 行、策略解析与 capability gate 的结果与不含该内容时
完全一致。M3-02/M3-03 在此基调上继续加固（Memory 条目、授权层强制）。

## 测试

`pnpm test`（turbo 登记）：分层来源、manifest 追溯与校验、截断保规则、
内容只读、跨项目来源不串、A16 注入、迁移链 001..007。
