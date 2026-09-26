/**
 * THE fault-injection matrix (M4-05): the ordered, fixed registry of every
 * injected fault. The order and the injection descriptions are part of the
 * contract — a rerun walks the SAME list in the SAME order and dies at (or
 * recovers from) exactly the same points. See README.md for the
 * matrix-to-acceptance mapping table.
 */
import type { MatrixCase } from "./report.js";
import {
  runDbExecutionInsertCrash,
  runDbIntegrationCompletionCrash,
  runDbIntegrationManifestCrash,
  runDbIntegrationPauseCrash,
  runDbApprovalOpenCrash
} from "./cases/db-boundary.js";
import {
  runProcLaunchWindowCrash,
  runProcSpawnFailure,
  runProcTreeKillGrandchild,
  runProcPidReuseHolderSurvives
} from "./cases/process-boundary.js";
import {
  runGitMergeConflictPaused,
  runSideEffectUnknownNoAutoRerun,
  runApprovalConsumedEvidencePreserved,
  runApprovalConsumeRollbackAtomic,
  runRetryCapThreeAttempts,
  runChainResumeAfterRecovery
} from "./cases/recovery-boundary.js";

const ALL_PLATFORMS: readonly string[] = ["win32", "linux", "darwin"];
const WINDOWS_ONLY: readonly string[] = ["win32"];

export const FAULT_MATRIX: readonly MatrixCase[] = [
  {
    id: "FM-DB-01",
    boundary: "db",
    acceptance: ["A23"],
    title: "尝试行 INSERT 事务内崩溃：整体回滚，恢复后链路以正确结果继续",
    injection: "prepare('INSERT INTO executions...') 于 startExecution 的 PREPARING 事务（序号 1）",
    platforms: [...ALL_PLATFORMS],
    run: runDbExecutionInsertCrash
  },
  {
    id: "FM-DB-02",
    boundary: "db",
    acceptance: ["A25"],
    title: "集成完成 UPDATE 前崩溃：reconcile 以 manifest 回填 DB，零重复提交",
    injection: "prepare(\"UPDATE integration_records SET state = 'COMPLETED'...\")（序号 1）",
    platforms: [...ALL_PLATFORMS],
    run: runDbIntegrationCompletionCrash
  },
  {
    id: "FM-DB-03",
    boundary: "db",
    acceptance: ["A25"],
    title: "集成 manifest 写入前崩溃：safe-to-retry，重试复现同一 candidateSha",
    injection: "prepare('UPDATE integration_records SET manifest...')（序号 1）",
    platforms: [...ALL_PLATFORMS],
    run: runDbIntegrationManifestCrash
  },
  {
    id: "FM-DB-04",
    boundary: "db",
    acceptance: ["A10", "A25"],
    title: "PAUSED_CONFLICT 写入前崩溃：merge-in-progress 手工处置，分支无损",
    injection: "prepare(\"SET state = 'PAUSED_CONFLICT'\")（序号 1）",
    platforms: [...ALL_PLATFORMS],
    run: runDbIntegrationPauseCrash
  },
  {
    id: "FM-DB-05",
    boundary: "db",
    acceptance: ["A19"],
    title: "检查点 INSERT 前崩溃：审批+检查点+节点迁移整体回滚，重放恰好一次",
    injection: "prepare('INSERT INTO approval_checkpoints...') 于 openApprovalCheckpoint 事务（序号 1）",
    platforms: [...ALL_PLATFORMS],
    run: runDbApprovalOpenCrash
  },
  {
    id: "FM-PROC-01",
    boundary: "process",
    acceptance: ["A22", "A23", "A24"],
    title: "spawn 后记录 PID 前崩溃：RECOVERY_REQUIRED 等人，槽位约束阻塞，绝不重发",
    injection: "STARTING 行无 pid_identity（引擎 spawn→setExecutionPidIdentity 窗口的持久终态）",
    platforms: [...ALL_PLATFORMS],
    run: runProcLaunchWindowCrash
  },
  {
    id: "FM-PROC-02",
    boundary: "process",
    acceptance: ["A21"],
    title: "spawn 失败（ENOENT）：确定性 launch-failed 证据，auto 分类受 A21 上限",
    injection: "快照 executable 指向不存在的 direct 可执行文件（每次 launch 必现）",
    platforms: [...ALL_PLATFORMS],
    run: runProcSpawnFailure
  },
  {
    id: "FM-PROC-03",
    boundary: "process",
    acceptance: ["A26"],
    title: "kill 预算终止整棵进程树：taskkill /T /F 证据，孙进程确认死亡",
    injection: "fake-cli grandchild 场景 + timeoutSeconds=2 的引擎 kill 预算",
    platforms: [...WINDOWS_ONLY],
    run: runProcTreeKillGrandchild
  },
  {
    id: "FM-PROC-04",
    boundary: "process",
    acceptance: ["A27"],
    title: "PID 被复用：真实占位进程+身份回拨，reconcile 中断尝试且不误杀持有者",
    injection: "记录身份早于现持有者创建时间 60s（真实 Win32_Process 探针）",
    platforms: [...WINDOWS_ONLY],
    run: runProcPidReuseHolderSurvives
  },
  {
    id: "FM-GIT-01",
    boundary: "git",
    acceptance: ["A10"],
    title: "同 行 merge 冲突：PAUSED_CONFLICT 保全双方分支，BLOCKED 无出边",
    injection: "两个父分支修改 shared.txt 同一行（确定性冲突）",
    platforms: [...ALL_PLATFORMS],
    run: runGitMergeConflictPaused
  },
  {
    id: "FM-A22-01",
    boundary: "side-effect",
    acceptance: ["A22"],
    title: "副作用已提交+结果未知：RECOVERY_REQUIRED 落节点状态，全系统无自动重跑",
    injection: "续行 execution 处于 STARTING 且 dispatch 已提交、pid 从未记录",
    platforms: [...ALL_PLATFORMS],
    run: runSideEffectUnknownNoAutoRerun
  },
  {
    id: "FM-APR-01",
    boundary: "approval",
    acceptance: ["A17", "A18", "A22"],
    title: "审批已消费但执行未发生：消费证据跨 reconcile/处置逐字节保留",
    injection: "续行执行进入 A24 窗口后走完整恢复路径",
    platforms: [...ALL_PLATFORMS],
    run: runApprovalConsumedEvidencePreserved
  },
  {
    id: "FM-APR-02",
    boundary: "approval",
    acceptance: ["A17", "A18"],
    title: "审批消费记录回滚：消费事务整体回滚，重放续行仍单次有效",
    injection: "prepare(\"UPDATE approvals SET status = 'CONSUMED'\") 于 continueAfterApproval 事务（序号 1）",
    platforms: [...ALL_PLATFORMS],
    run: runApprovalConsumeRollbackAtomic
  },
  {
    id: "FM-RETRY-01",
    boundary: "retry",
    acceptance: ["A21"],
    title: "三次总尝试耗尽：AttemptsExhausted + 预算 hold，第四次永不发生",
    injection: "每轮 launch 固定 error-result（确定性失败）+ requeueForRetry",
    platforms: [...ALL_PLATFORMS],
    run: runRetryCapThreeAttempts
  },
  {
    id: "FM-CHAIN-01",
    boundary: "retry",
    acceptance: ["A21"],
    title: "全链恢复：链路中段确定性失败→受控 requeue→链路完成且结果正确",
    injection: "alpha 首次尝试固定 error-result，其余全部 success（dag→调度→engine→worktree→集成→review）",
    platforms: [...ALL_PLATFORMS],
    run: runChainResumeAfterRecovery
  }
];
