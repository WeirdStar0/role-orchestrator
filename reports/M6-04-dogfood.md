# M6-04 · 受控 dogfood 与使用文档（证据记录）

状态：已完成（本报告只记录真实执行的命令与读回的存储/仓库事实）。
角色：Developer（受控 dogfood + 使用文档）。日期：2026-09-24。
对应任务：`docs/BACKLOG.md` M6-04（验收 A11/A17/A22；完成标准「流程可回滚，
Agent 没有修改治理策略或自批合并」）。

## 0. 结论

- 一个小功能在系统临时目录的隔离 git 仓库（A11 用户仓库）上经**完整编排链路**
  真实跑通：建图 → 调度 → 执行（writer 提交）→ 集成 → review → 扩图返工 →
  审批检查点（提案→拒改→批准→续行）→ 中断注入 → reconcile 恢复 → 重试成功。
  全链 6 节点终态 SUCCEEDED，事件校验和 0 错位，0 活动尝试残留。
- 三处失败注入点均有真实内容依据（非伪造状态），恢复动作全部由产品包协议完成；
  A11 / A17 / A22 三条验收在链路内取得实测证据（§3）。
- 全程只使用 `packages/fake-cli` 的 dist bin（dogfood）；未调用真实 claude/codex，
  未读取任何凭据或 CLI 配置文件。除测试自建的临时 fixture 仓库外，未做任何 git
  操作；`H:\role-orchestrator` 保持非 git 状态。
- 使用文档 `USAGE.md`（根目录新增）已逐条对照实现核实后写入；与根 `README.md`
  的交叉引用采取「新增文件互相引用 + PROPOSALS.md 提案」的合规路径（§6 偏离 2）。

## 1. 交付物（全部为新增文件或自建工程文件）

| 文件 | 内容 |
|---|---|
| `packages/dogfood/`（新包） | `src/world.ts`（fixture + 全迁移链 store + fake-cli Profile + 四角色绑定）、`src/scenario.ts`（图/节点的单一事实来源）、`src/driver.ts`（链路驱动 + 时间线）、`src/evidence.ts`（证据目录）、`src/errors.ts`（类型化错误 + cause）、`test/dogfood-chain.test.ts`（链路测试）、`README.md`；turbo 自动登记（`pnpm build`/`test`/`typecheck` 均含本包） |
| `reports/M6-04-dogfood.md` | 本报告 |
| `USAGE.md`（根目录新增） | 面向用户的使用说明（内容逐条对照实现核实，见 §5） |
| `PROPOSALS.md` | 追加 M6-04 披露与 README 交叉引用提案（该文件允许追加） |

冻结面零改动：`node planning-check.mjs` exit 0（78/78 冻结文件 sha256 一致，
本会话收尾复跑，见 §4）。

## 2. dogfood 链路（真实执行，2026-09-23T20:50:49Z 证据目录）

运行环境：Windows 10.0.26100 x64，Node v25.0.0，fixture 仓库
`C:\Users\star\AppData\Local\Temp\ro-e2e-dogfood-chain-JtS4sC\repo`
（base `ae6340ef21ce…`，携带用户未提交文件 `notes/scratch.txt`）。
驱动：`packages/dogfood` 的 `runDogfoodChain`，run id `run-dogfood-1`。
证据目录：`packages/dogfood/evidence/dogfood-chain-2026-09-23T20-50-49-856Z/`
（`driver.log.txt` 全时间线 + `dogfood-timeline.json` 结构化记录）。

| # | 阶段 | 真实结果 |
|---|---|---|
| 01 | 建图 | `run-dogfood-1` 四节点图（plan→impl→integrate→review）建在 base 上；plan=READY，其余 PENDING |
| 02–04 | 调度→执行→集成 | plan / impl（writer 提交 `src/feature/app.txt`，输出 `325753169b45…`）/ integrate（单 writer 集成，candidateSha `b25c897f0ae1…`）全部 attempt 1 SUCCEEDED；调度走真实 `enqueueReadyNodes`+`pollQueue`（三级配额 + 凭据锁 + fencing） |
| 05 | **注入 1：review fail** | review 的验证命令要求尚不存在的 `src/feature/fix.txt` —— 有内容依据的 FAIL；verdict 经 `getReviewVerdict` 读回为 valid fail，绑定 candidate `b25c897f0ae1…`（A12） |
| 06 | 恢复 1：受控扩图 | `requestControlledExpansion`（发起角色 coordinator 持 canCreateSubtasks，A04；expectedGraphRevision 乐观锁，A38；M4-03 三轮封顶/无环复验原样生效）铸造 `integrate-fix-2`（READY）+ `integrate-review-2`（PENDING）；graphRevision 0→1 |
| 07 | **注入 2：未授权写入提案** | 修复节点 attempt 1 经 fake-cli `action-proposal --propose-write`（fake-claude bin 真子进程）提出 unscoped 写入后安全结束：协议判定如实 FAILED（missing-final-result），持久事件流经 `extractActionProposals` 恰好挖出 1 条结构化提案（argv 含目标路径）；**写入未发生**（A19） |
| 08 | 恢复 2：审批检查点 | `openApprovalCheckpoint`：checkpoint WAITING、approval PENDING（risk=high，requiresApproval=true）、节点 integrate-fix-2=WAITING_APPROVAL |
| 09 | **A17 拒改探针** | 批准后用**改了命令路径**的 presentedAction 调 `continueAfterApproval` → `ApprovalDigestMismatchError`；审批仍 APPROVED、checkpoint 仍 WAITING、尝试行数不变 —— 原审批无法被改变后的命令消费 |
| 10 | 恢复 2 续行 | 真实批准后 `continueAfterApproval` 消费审批（CONSUMED，consumedByExecutionId=`exec-integrate-fix-2-cont`）；attempt 2（frozen Profile revision）经 fake-claude `--write-file` 真正执行该写入；修复提交 `f686f8feb376…` 落在续行分支上 |
| 11 | **注入 3：启动窗口中断** | 复审节点的真实调度认领（attempt STARTING、scheduler.dispatch outbox 已提交、4 条配额占用、无 pid 身份）后启动器不再运行 —— 持久状态恰为 A24 窗口 |
| 12 | 恢复 3：reconcile | 真实 `reconcileStartup` 扫描：scanned=1、**OS 探针 0 次调用**、outcome=recovery-required、reason=launch-window-undetermined、applied=applied；dag 桥把节点从 RUNNING → INTERRUPTED → **RECOVERY_REQUIRED** |
| 13 | **A22 不自动重跑** | 第二次尝试被 `ActiveAttemptConflictError` 拒绝（A23 约束）；恢复清单项 RECOVERY_REQUIRED/manual-recovery；二次扫描幂等（already-applied）；队列条目保持 DISPATCHED 不回流；dispatch outbox 1 条待发；配额占用 4 条保持 |
| 14 | 恢复 3 人工解决 | `resolveRecoveryItem`（记名 operator 步骤）→ 执行转 INTERRUPTED；死认领的配额由驱动簿记释放（reconcile 自身永不触碰配额/重派） |
| 15 | 恢复 3 重试成功 | 显式重试 attempt 2（engine 持有尝试路径，与 FM-PROC-01 同配方）SUCCEEDED；复审对修复候选 `f686f8feb376…` 记录 **pass**（A12 绑定新 candidateSha）；该槽位恰 2 次尝试（1 中断 + 1 成功，无重复 writer） |
| 16 | A11 验收 | 7 次 `createWorktree` 的用户仓库状态指纹全部一致；终态快照 HEAD 仍为 base、分支仍为 main、porcelain 指纹不变、`notes/scratch.txt` 逐字节相同 |
| 17 | 事件完整性 | `verifyEventChecksums` 错位 0；`listActiveAttempts` 为空 |

链路中真实 spawn 的 fake-cli 子进程共 8 次（plan/impl/integrate/review/提案/
续行/复审中断未启动不计/复审重试），全部为 dist bin。

## 3. A11 / A17 / A22 实测证据（对应 `docs/ACCEPTANCE.md`）

| 验收 | 必须观察到的结果 | 本链路实测 |
|---|---|---|
| A11（用户原仓库有 dirty 修改） | 原修改与分支保持不变 | 7 个 worktree 创建前后的 status porcelain sha256 全等（`b98e31db1a0e…`）；终态 HEAD=base、branch=main；dirty 仅 `notes/scratch.txt` 且内容逐字节一致（`DogfoodA11Evidence`，timeline.json） |
| A17（批准后改变命令/目标 SHA） | 原审批无法消费 | 批准后 presentedAction 仅改 argv 中写入路径 → `ApprovalDigestMismatchError`；审批保持 APPROVED、checkpoint 保持 WAITING、尝试行数不变；随后正确动作一次性消费（CONSUMED，绑定续行执行） |
| A22（已有副作用但执行结果未知） | RECOVERY_REQUIRED，不自动重跑 | 真实调度认领（副作用：dispatch outbox 待发 1 条、配额占用 4 条、节点 RUNNING）+ 无 pid → reconcile 判 recovery-required（launch-window-undetermined，无需 OS 探针）→ 节点 RECOVERY_REQUIRED；第二次尝试被 A23 约束拒绝；队列条目不回流；人工解决前无任何新尝试；解决后显式重试恰一次成功 |

补充边界观察（如实记录）：复审节点首次认领的队列条目在人工解决后保持
DISPATCHED——调度器的自动回流（`requeueForRetry`）按 A22 语义对 recovery 类
失败永不回流；显式重试走 engine 持有尝试路径（`packages/fault-matrix`
FM-PROC-01 同配方），这是既有设计的诚实呈现，不是缺陷。

## 4. 测试与门禁（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm exec vitest run`（packages/dogfood，本会话多次迭代） | 0（最终） | 1/1 通过（约 9.6s：8 次真实 fake-cli 子进程 + 数十次真实 git）；驱动侧两次红跑见 §6 偏离 1 |
| `pnpm run build`（packages/dogfood） | 0 | dist 产出 |
| `pnpm exec tsc -p tsconfig.json`（packages/dogfood） | 0 | 严格类型检查 |
| `pnpm typecheck` / `pnpm test` / `pnpm build`（全仓） | 见 §7（收尾全量门禁） | |
| `node planning-check.mjs` | 0 | 78/78 冻结文件一致；干净副本 self-test exit 0 |
| `python scripts/validate_bundle.py --self-test`（仓库内） | 1 | 已知保留问题（node_modules 断链扫入），未修复、未掩盖、未绕过 |

## 5. USAGE.md 的核实方式

`USAGE.md` 的每一条都先对照实现再落笔，主要核实点与本会话证据：

- 启动序列、令牌文件默认位置/形态（43 字符 base64url、每用户 ACL）、回环断言：
  `packages/local-api/src/server.ts` 的 `startLocalApiServer` 与 `packages/local-api/src/token.ts`；
- 页面导览（连接区/DAG 画布/节点编辑器/扩图/审批/diff/上下文面板与元素）：
  `packages/local-api/src/page.ts` 静态标记 + `packages/browser-e2e/src/browser.ts` 的 DOM 读取器；
- API 面与失败语义（409 附 currentGraphRevision、403 PROFILE_OVERRIDE_REJECTED、
  409 APPROVAL_INVALIDATED/EXPIRED、501 dispatch 骨架）：`packages/local-api/README.md` 的 API 表与对应实现；
- 预算文案（每运行 64 节点/深度 16、每链审查上限 3 轮）：`packages/local-api/src/page.ts` 提示文本（与 expand 包 `MAX_REVIEW_ROUNDS=3` 一致）；
- 平台支持范围：`reports/M6-01-platform-matrix.md`（本仓证据矩阵，unverified 格如实转述）；
- 维护 CLI 命令名（upgrade-drill/cleanup-plan/cleanup-execute）：`packages/maintenance/src/cli.ts`；
- Node 版本要求：根 `package.json` engines `>=20` 与端到端包 `>=25` 的差异如实分述。

USAGE.md 不含指向本地路径的 markdown 链接（全部用反引号路径），符合仓库约束。

## 6. 偏离与风险

**偏离**

1. 链路测试的中间红跑（2 次，均如实保留在 evidence 目录）：第一次把 A17 拒改
   探针放在批准之前，被 `ContinuationNotApprovedError` 拒绝（续行先查审批状态，
   属实现正确的守卫次序）——修正为「先批准、再拒改探针、后正确续行」；第二次
   对修复节点的队列条目重复调用完成态迁移被 `InvalidQueueEntryStateError`
   拒绝（续行走 engine 持有路径，不消费队列条目）——移除重复簿记。两次均为
   驱动侧次序错误，产品包行为全部正确；零断言弱化。
2. ask 交付 5「README 与 USAGE.md 的交叉引用」：根 `README.md` 属于约束 1 的
   冻结面（`根目录既有 .md`），且其 sha256 固定在 `CHECKSUMS.sha256`（
   `planning-check` 第 (a) 步逐字校验），修改将直接打红冻结完整性门。合规
   处理：`USAGE.md` 与 `packages/dogfood/README.md` 双向引用根 `README.md`/
   `USAGE.md`（反引号路径），同时在 `PROPOSALS.md` 追加提案（P-M06-6）请求
   维护者按治理流程在根 `README.md` 增补一行 USAGE 指引（含 CHECKSUMS 同步）。
   本任务未改动根 `README.md` 与 `CHECKSUMS.sha256`。
3. 「扩图返工→审批检查点」的编排：审批检查点主体选为扩图铸造的修复节点
   （`integrate-fix-2`）而非图外另立节点——这是唯一能让「扩图返工→审批→中断→
   重试」按 ask 顺序在同一无环图内成立的构图；提案经持久事件流真实提取，
   未使用 fixture 构造。
4. **对既有文件的一处修改**：`packages/release-audit/test/repo-audit.test.ts` 的
   工作区计数基线 30 → 31（新包 `packages/dogfood` 使 importer 数 +1；全量
   `pnpm exec turbo run test --force` 首跑以 `expected 31 to be 30` 真实失败后按
   M6-01 披露先例做最小更新）。该用例其余断言（specifier 一致、integrity 全钉、
   默认 registry、外部依赖恰 84 个）零改动全部通过；本任务未新增任何外部 npm
   依赖。完整披露见 `PROPOSALS.md` M6-04 节。
5. 本任务对既有测试的全部影响即上述 1 处计数基线；既有测试零删除、零跳过、
   零断言弱化。

**风险**

1. dogfood 的 writer 提交、失败尝试的队列/配额簿记是基准替身（与 M2-06/M5-05
   相同的已披露边界）；受控 Git Service 与恢复侧自动簿记属后续里程碑。
2. 本报告的 A11/A17/A22 证据是**本参考机（win32-native，Node v25.0.0，
   git 2.54.0.windows.1）的实测事实**；平台差异以 `reports/M6-01-platform-matrix.md`
   为准，本报告不外推到其他平台。
3. dogfood 链路测试真实 spawn 子进程（约 10s/次），已按仓库惯例设置 240s 测试
   超时；慢机/CI 下的余量以该值为准。

## 7. 收尾全量门禁（真实退出码，任务收尾时回填）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm typecheck`（全仓） | 0 | 53 tasks 成功（52 + 新包） |
| `pnpm build`（全仓） | 0 | 30 tasks 成功（29 + 新包） |
| `pnpm exec turbo run test --force`（最终状态全量强制复跑） | 0 | 60/60 任务、0 缓存、真实执行；**1312 个测试全部通过（165 个测试文件，30 包），0 failed / 0 skipped**（fault-matrix 平台门控 15/15 allPassed）。1312 = M6-03 终态 1311（含其 42）+ 本任务新增 1（dogfood 链路） |
| `pnpm test`（全仓，原样命令） | 0 | 60/60 任务成功（56 为上述强制跑后的 turbo 缓存回放） |
| `pnpm run planning:check` | 0 | 78/78 冻结文件 sha256 一致；干净副本 self-test exit 0（PROPOSALS.md 两次追加披露后复跑仍 0） |
| `python scripts/validate_bundle.py --self-test`（仓库内） | 1 | 已知保留问题（node_modules 断链扫入），未修复、未掩盖、未绕过 |

如实记录的全量跑中间失败（两次红跑，均已最小修复 + `PROPOSALS.md` 披露）：
第一轮 `packages/release-audit` 工作区计数基线 30 → 31（新包落地）；第二轮
`packages/process-lab` 级联用例的固定 2 秒墙钟在满载并行下不足（改用本包自有
的有界 `expectPidGone` 等待，断言语义零弱化）。第三轮全量强制复跑 exit 0。
