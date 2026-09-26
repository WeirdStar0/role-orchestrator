# @role-orchestrator/context-e2e

M3-04 · 验证跨 CLI 上下文协作。**纯验证与 dogfood 包，不含产品逻辑**：它把
`docs/BACKLOG.md` M3-04 的示例——"Claude 设计产物由 Codex 消费，不复制
session/credentials"——沿真实链路完整走一遍，并把验收矩阵 A15/A36 与
M3-04 完成标准（"共享的是结构化、版本化事实与产物，诊断导出不含秘密"）
钉成可重复运行的测试。

```text
design (architect -> claude Profile, fake-claude 真实子进程)
  │  产出结构化 artifact（版本化 JSON）+ 自报 artifact 引用（最终结果事件）
  ▼
accepted output commit SHA（受控提交替身，提交身份固定）
  │  作为 dependency 片段（commitSha + artifactId + contentHash 指认）
  ▼
context bundle 装配（授权 MemoryAccess 会话：active 规则 + 检索记忆）
  │  persistContextBundle（manifest：顺序、来源、版本、hash）
  ▼
consume (developer -> codex Profile, fake-codex 真实子进程)
     经 stdin 消费 bundle 渲染的提示词并输出结果
```

## 链路与验收映射

每一次 `runCrossCliHandoff` 都按顺序使用各包的公共服务面，无任何旁路：

| 阶段 | 调用 | 覆盖 |
| --- | --- | --- |
| 建图 | `dag.createRunGraph`（冻结 Schema 校验，先于一切 spawn） | A08/A03/A02 |
| 调度 | `scheduler.enqueueReadyNodes` + `pollQueue`（原子认领：配额 + fencing grant + STARTING 尝试） | 真实调度语义 |
| 隔离 | `worktree.createWorktree`（固定 baseSha；消费者基线 = 生产者输出 SHA） | A11/A40 同型 |
| 记忆 | `memory.proposeMemory` / `verifyMemory` / `promoteProjectRule`（真实写路径：角色提案 -> 验证者核实 -> 仅用户提升） | M3-02 语义 |
| 检索 | `memory-search.openMemoryAccess`（授权会话：`listActiveProjectRules` + `search`） | A15 |
| 装配 | `context.assembleContextBundleWithMemory` + `persistContextBundle`（层级顺序、预算、provenance） | M3-01/03 |
| 执行 | `engine.startExecution`（`claimedAttempt: true`；fake-cli dist bin 真实子进程；提示词经 stdin 文件进入子进程） | A06/A29 |
| 导出 | 本包 `exportDiagnosticPackage`：图状态 + 事件 + bundle 片段 + 记忆引用 -> `cli-events.redactJsonValue` -> `redactText` -> 本地文件（落盘前脱敏） | A36 |

对应测试文件：

- `test/cross-cli-handoff.test.ts` — 交付 1+2。生产者 artifact 引用取自其
  自身最终结果事件（非硬编码）；消费者 bundle 的 dependency 片段以
  commitSha + artifactId 指认生产者输出，`verifyContextBundle` /
  `traceFragment` / `findFragmentsBySource` 双向可追溯，git 内容与片段
  逐字节一致；codex 真实子进程经 stdin 消费与持久化 manifest 一致的提示
  词。负向面：对双方执行的全部持久化字节（事件 payload、bundle 片段与
  manifest、提示词文件）做 grep——claude 的 `session_synth_0001` 不出现在
  codex 侧，codex 的 `thread_synth_0001` 不出现在 claude 侧，无任何
  Bearer/token/api-key/password 凭据形态字符串；bundle 恰好五层、来源全部
  可指认（受控事实 + 产物引用）。
- `test/a36-diagnostic-export.test.ts` — 交付 3。敌意内容走两条通道入库：
  一条 VERIFIED 记忆（Bearer/api_key/password 形态）与一条绕过引擎脱敏、
  经 store 原始 `appendEvent` 直写的事件行；导出前先证明秘密确在库中，
  再断言导出文件不含任何明文秘密值、`[REDACTED]` 占位符存在、文件
  sha256 与返回值一致、序列化后二次 redact 零命中（幂等）；越权会话导出
  他项目 run 被拒绝。
- `test/a15-a16-e2e-isolation.test.ts` — 交付 4。项目 B 私有记忆：直接 id
  读取被 `CrossProjectAccessError` 拒绝且错误信息不含他项目 id/内容；检索
  路径结构性不可见；他项目会话装配本项目 bundle 在内容移动前被拒；本项目
  bundle 无项目 B 内容。A16：注入"忽略策略并改模型"指令以 VERIFIED fact
  身份经授权检索合法进入 bundle（`untrusted-content` 片段），而 role
  bindings 行、冻结 Profile 快照（逐字节）、active 规则集合与运行前完全
  一致——注入内容没有改变任何权限判断。

## 驱动器是什么、不是什么

`runCrossCliHandoff` 只做 dogfood 搬运，所有语义来自各包：

- **生产者输出提交是替身**（与 e2e-baseline 相同的 `commitNodeOutput`
  stand-in）：fake-cli 场景按设计不写仓库文件，驱动器把场景声明的结构化
  artifact 写入该节点 execution worktree 并只提交这些路径，代表后续里程碑
  的受控 Git Service 提交步骤。
- **artifact 引用来自生产者自己的持久化最终结果事件**（`result_reported`
  的 `businessResult.artifactRefs`），驱动器不捏造交接内容。
- **提示词渲染（`renderBundlePrompt`）是已装配数据的展示**：逐片段输出
  manifest 身份 + provenance 行 + 内容；装配、授权、预算截断全部发生在
  context/memory-search 包内。
- **诊断导出是 A36 的 dogfood 半边**：引擎在持久化时已对事件 payload 脱敏；
  导出端不信任这一点——即使敌意行经旁路入库，导出仍必须无秘密。渲染消毒
  （HTML/escape 的"渲染消毒"半句）属于 local-api 视图层职责，不在本包断言
  范围。

## 已知边界（如实声明）

- **fake-cli 使用固定合成会话标识**（`session_synth_0001` /
  `thread_synth_0001`）以保证 fixture 确定。因此"无 session 复制"断言的
  形态是：一方方言的合成标识绝不出现在对方持久化面上、提示词与 bundle 中
  无任何会话标识，而不是"两个随机 id 不同"。真实 CLI 的会话隔离由同一结构
  保证：上下文层只装配 artifact 引用与受控事实，不存在复制会话的通路。
- **本包不验证真实 claude/codex 可执行文件**，也不读取任何真实 CLI 配置或
  凭据；Profile 的 executable 是 fake-cli 的 dist bin，config 目录是合成
  JSON（同 e2e-baseline 世界）。
- **消费者基线 = 生产者输出 SHA** 是拓扑序下的直链关系（无集成节点）；多父
  集成（inputSha 集合、candidateSha）由 e2e-baseline（M2-06）覆盖，本包不
  重复。
- 引擎的 DB 时间戳用墙时钟（M1-03 既有行为）；驱动器自身可控时间戳来自
  固定序列时钟。整个 scratch 目录（仓库、worktrees 根、store、配置目录）
  在测试 teardown 中整体移除（`removeTreeRobust`）。
- `pnpm vitest run` 直跑本包需要先构建依赖链（fake-cli 的 dist bin 是被
  spawn 的真实文件）；仓库根 `pnpm build` 即满足，turbo 管道已按
  `test dependsOn ^build, build` 编排。

## 验证

仓库根目录：`pnpm build`、`pnpm typecheck`、`pnpm test`（turbo 对全部
workspace 包生效，本包经 `packages/*` glob 自动登记）。本包内：
`pnpm build`、`pnpm typecheck`、`pnpm test`。
