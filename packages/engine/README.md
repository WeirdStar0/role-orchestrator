# @role-orchestrator/engine

M1-03 的单执行生命周期引擎：以冻结 run 快照解析 profile、组装 `PreparedInvocation`、
用 argv 数组（绝不经 shell 拼接）启动 CLI 进程、即时记录进程身份、经 cli-events
管道把事件落库，并按 fail-closed 公式判定结果。本包用 `@role-orchestrator/fake-cli`
的 dist bin 做端到端 dogfood（这是任务设计的一部分），不调用、不探测任何真实
claude/codex 可执行文件；真实 CLI 接入属后续里程碑。

## 生命周期

对应 `docs/ORCHESTRATION.md` 第 3 节的相位机：

```text
PREPARING -> STARTING -> RUNNING -> FINALIZING -> SUCCEEDED
任何未完成相位 -> FAILED | INTERRUPTED | CANCELLED（INTERRUPTED 由 reconcile 使用）
```

每个相位在本引擎中的含义与保证：

| 相位 | 引擎行为 | 关键保证 |
|---|---|---|
| PREPARING | 尝试行（`createActiveAttempt`）与 dispatch outbox 消息在同一事务提交；invocation 在此之前已从冻结快照解析 | 同槽位已有活跃尝试时，部分唯一索引拒绝第二次启动（`ActiveAttemptConflictError`，A23 约束层保证） |
| STARTING | 以 argv 数组 spawn 子进程；**立即**写入 `pid_identity`（进程身份在消费任何流字节之前落库） | A24：启动到记录 PID 的窗口只剩 spawn 本身；dispatch token 唯一约束保证重放启动命令不会产生第二个尝试行 |
| RUNNING | stdout 逐块喂给 cli-events 管道；每批事件一个事务落库（写入前按 A36 对 payload 脱敏，见下文）；首个 `started` 事件的 session/thread id 写入 `session_id`；预算计时器与取消句柄在此武装 | 事件按管道 seq 连续落库；崩溃时已落库事件与 pid 身份可被 reconcile（M1-05）识别 |
| FINALIZING | 进程退出且流排空之后、结果判定之前进入（`wherePhaseIn ["RUNNING"]` 守卫） | 判定发生在 FINALIZING，状态迁移本身不表达任何结论 |
| 终态 | SUCCEEDED / FAILED / CANCELLED + `lifecycle_outcome` 事件 + `execution.attempt-finished` outbox 消息，三者同一事务 | 事务性落盘：要么全部可见，要么全部不可见 |

### 已认领尝试的启动入口（M2-06）

`startExecution` 增加可选输入 `claimedAttempt`。调度器的 dispatch claim
（M2-02 `pollQueue` 的原子认领）已经在同一事务里创建了尝试行（phase
STARTING）并写入 `scheduler.dispatch` outbox；此时引擎若再走默认的
PREPARING 插入，会撞上 executions 主键与 A23 单活跃尝试约束。传入
`claimedAttempt: true` 后引擎跳过插入，改为核验认领行（存在、phase 为
STARTING、dispatch token 与槽位身份完全一致），任何不匹配都以类型化
`ClaimedAttemptInvalidError` 拒绝启动——dispatch token 是去重锚点
（A24），错配的认领绝不 spawn 进程。缺省 `false`，M1-03 的完整
PREPARING 入口不变。

## 成功判定公式（A06，fail-closed）

只有以下全部条件成立才置 `SUCCEEDED`，任何一条不满足都按原因落 `FAILED`：

```text
SUCCEEDED ⇔ exit 0
          ∧ 无协议错误（truncation/超限/不可解析行都会毒化流）
          ∧ 最终 result 事件无 error
          ∧ ExecutionResultSchema（contracts 冻结契约）校验通过
          ∧ 要求的 evidence 存在
```

evidence 门槛是方言感知的（`evidence.ts`）：

- claude（`cited-artifact-ids`）：业务结果引用的每个 `artifactRefs[].id` 都必须有
  对应的 `artifact_reported` 事件以 `artifactId` 形式报告过；
- codex（`any-artifact-reported`）：codex 协议以 `paths` 报告文件变更、不含逐条
  id，因此当结果引用了 artifact 时，要求至少存在一条 `artifact_reported` 事件。
  两个方向都 fail-closed：引用了 artifact 而协议零报告，永不成功。

失败原因按确定顺序落盘：cli-events 的
`nonzero-exit` / `protocol-error` / `missing-final-result` / `final-result-error` /
`business-schema-invalid`，引擎追加 `missing-evidence` / `timeout` / `cancelled`。
evidence 只在前面全部通过时才评估——schema 不过的结果谈不上 evidence。

## 超时与取消

- **超时**：`timeoutSeconds` 是引擎级 kill 预算（秒）。计时器触发时先检查子进程
  是否已自然退出（`exitCode`/`signalCode` 在 Node 中同步置位），仍在运行才置
  `timedOut` 并杀进程树，避免"预算边界上的自然完成"被误判。判定时 `reasons` 追加
  `timeout`（退出码本身为 null/非零也会带 `nonzero-exit`），落 `FAILED`。
- **树杀**：Windows 用 `taskkill /PID <pid> /T /F`（`/T` 是唯一会走整棵树的内置
  工具，`/F` 对控制台子进程必要；M0-05 process-lab 结论）；POSIX 对 detached
  进程组发 SIGKILL。每次 kill 的证据（argv、退出码、stderr）记入
  `lifecycle_outcome` payload。
- **取消**：`ExecutionRun.cancel(reason)` 置取消意图并杀树；幂等，进程已退出时
  返回 false（结果反映自然结局）。取消的执行落 `CANCELLED`（reasons 为
  `["cancelled"]`），取消的运行永远不会被判成 SUCCEEDED，即使流内容看起来成功。
- 取消/超时的执行不评估 evidence；原因列表里只有 `timeout`/`cancelled` 与
  cli-events 的客观原因。

## Invocation 组装（`invocation.ts`）

- **冻结快照读取**：`prepareExecutionInvocation` 通过
  `readRunRoleProfile`（M1-02）只读 `run_profile_snapshots`——绑定/模型变更影响
  不到已在执行的 run（A34）。`executable`、`configDir`、`executionTarget`、
  `runtime`、`requestedModel` 全部来自快照。
- **argv 数组，绝无 shell 字符串**：可执行形式解析为三种之一——
  `*.js|*.mjs` → `[node, script]`（fake-cli dist bin 的 dogfood 形态）；
  `*.cmd|*.bat` → `[cmd.exe, /d, /c, shim]`（仅 Windows；`/s` 会剥引号导致空格
  路径解析失败，M0-05 实测）；其余直接 spawn。
- **协议参数由适配器注入**：claude 注入 `-p --output-format stream-json --verbose`，
  codex 注入 `exec --json`；快照 `requestedModel` 非空时由引擎注入 `--model`/`-m`。
  调用方 `invocationArgs` 是唯一注入通道，出现 `-m`/`--model` 即类型化拒绝
  （`ModelOverrideArgError`，模型不可逐 invocation 覆盖）。
- **A29**：快照 `executionTarget` 非 windows-native 直接 `UnsupportedExecutionTargetError`，
  不做任何隐式路径/目标转换。
- **stdin 受控文件**：prompt 写入 `<cwd>/stdin-<executionId>.prompt.txt` 并通过
  stdin 管道喂给子进程，内容 sha256 计入 manifest。
- **manifestHash**：对快照指纹、argv、cwd、prompt 哈希、预算与 evidence 策略的
  canonical JSON 做 sha256；同样输入必得同值，任何一项变化都改变哈希。

## 中断现场（A23/A24）

本任务交付查询与状态置位原语（完整 reconcile 属 M1-05）：

- `listActiveAttempts(db)`：跨槽位扫描全部活跃尝试（重启扫描的基元）；
- `getActiveAttempt` / `getExecutionByDispatchToken`：按槽位或派发令牌找回尝试，
  而不是重发启动命令（A24）；
- `setExecutionPidIdentity` / `setExecutionSessionId`（带 `wherePhaseIn` 守卫）与
  `readExecutionPidIdentity`（读取侧同 Schema 重校验）；
- `markAttemptInterrupted` 把仍活跃的尝试置 INTERRUPTED，释放槽位后才允许新尝试
  （A23 语义，store 包测试覆盖约束层的双连接竞争）。

## 与 store/cli-events 的关系

- 事件持久化：协议事件沿用管道 seq（1 起连续），满足
  `UNIQUE(execution_id, seq)`；引擎生命周期事件（`lifecycle_outcome`、
  `lifecycle_launch_failed`）落在 `LIFECYCLE_EVENT_SEQ_BASE`（10^9）以上的高段，
  协议流受字节上限约束不可能触达。事件 id 即管道 eventId（主键幂等）。
- **落盘前脱敏（A36，发布阻断级验收）**：全部引擎事件写入——协议批次
  （`persistDrainedEvents`）与两个生命周期写入（终态 outcome、启动失败）——
  统一经 `appendRedactedEvent`，它在组行**之前**用
  `redactEventPayload`（实现为共享包 `@role-orchestrator/cli-events` 的
  `redactJsonValue`）深度脱敏 payload。含 `Bearer <token>` / `token=` /
  `api-key=` 等秘密形态的文本进入 `events` 表时已是 `[REDACTED]` 占位符：
  - store 的校验和在 `appendEvent` 内对存储后（即已脱敏）的 payload 文本计算，
    因此 `verifyEventChecksums` 天然一致；
  - 脱敏幂等（占位符不匹配任何模式），且只改字符串值、不改 JSON 结构，事件
    schema 校验不受影响；
  - 测试在 `test/persistence.test.ts` 直接读回 `events` 表原始行断言「库内
    已脱敏」，local-api 的 dogfood 亦做同样断言；local-api 出进程时的再次
    脱敏是第二层纵深防御。
- cli-events 新增 `drainNewEvents()`：不结束流的增量消费（`finalize()` 仍返回全量
  冻结结果），供边流式边落库使用。
- 终态迁移、lifecycle 事件与 outbox 消息同事务；dispatch 与 finish 消息 id 由
  (executionId, attempt, tag) 确定性派生，重放幂等。

## 已知边界

- **真实 CLI 接入属后续里程碑**：当前可执行形态覆盖 node 脚本、Windows cmd shim
  与直接可执行文件；真实 claude/codex 的参数、版本探测、审批通道、会话恢复
  （`resume`）与能力门（`requiredCapabilities` 的运行时校验）尚未接入。
- **executionTarget 仅支持 windows-native**；wsl/linux/macos 是类型化拒绝，不是
  静默转换。
- **`configDir` 只参与 manifest 指纹**：本引擎不读取、不注入任何 CLI 配置环境
  （含 env 变量），凭据永不经引擎。
- **`timeoutSeconds` 不在冻结快照里**：contracts `ProfileSnapshot` 不含该字段，
  它是 `profiles` 表的当前值；引擎要求调用方显式传入预算并自行限定
  1..86400 秒（比 profile 契约的 30..86400 宽，供合成短预算测试）。
- **`ProcessIdentity.creationTime` 是引擎侧观测**（spawn 时刻的引擎时钟），不是
  OS 查询的进程创建时间；M1-05 reconcile 需按此语义对待（nonce + PID 复用检查
  属 M1-05/M4）。
- **prepare 失败不留数据库痕迹**（冻结快照不存在、target 不支持、cwd 缺失等都在
  尝试行创建前抛出）；但 stdin 文件在 prepare 时已写入 cwd，若随后尝试行因约束
  冲突被拒，该文件会残留（cwd 是引擎管理的运行目录，属无害残留）。
- spawn 后异步失败（ENOENT 等）按"启动失败"处理：先持久化 FAILED +
  `lifecycle_launch_failed` 事件 + outbox，再以 `ExecutionLaunchError` 拒绝调用方
  ——失败永远可追溯。
- grandchild（孙进程）场景不在本包测试范围（A26 的树杀证据在 process-lab）；
  `interrupt` 场景由 cli-events 的 spawn 测试覆盖。
- 不实现：多执行并发调度、三级配额、租约、reconcile 决策、审批检查点。

## 验证

在本包目录：`pnpm build`、`pnpm typecheck`、`pnpm test`（需先构建
`@role-orchestrator/fake-cli`，仓库根 `pnpm build` 即可）。测试覆盖：双方言
success 全链路（SUCCEEDED、事件有序、pid/session 落库、outbox、checksum）、
error-result、fake-success 三变体 × 双方言全部不判成功（A06）、truncated 协议
失败、超时树杀、执行中取消、并发同槽位第二次启动被
`ActiveAttemptConflictError` 拒绝、prepare 失败无残留，invocation 组装、
模型覆盖拒绝、A29 目标拒绝、manifest 确定性与 evidence 策略单测，以及 A36
落盘前脱敏的原始行断言（秘密值不入库、占位符存在、校验和一致、幂等）。
