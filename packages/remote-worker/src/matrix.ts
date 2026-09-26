/**
 * THE remote-worker fault-injection matrix (M7-03): the ordered, fixed
 * registry of every protocol-level injected fault. Order and injection
 * descriptions are part of the contract — a rerun walks the SAME list in the
 * SAME order. Each case is executed by one test in
 * `test/matrix-driven.test.ts` (the `evidenceTest` column names it), and the
 * design document's evidence tables quote these ids verbatim.
 *
 * `targetNotes` records, per ExecutionTarget, what a REAL implementation
 * would additionally have to measure on that target — every note is an
 * unverified claim by construction (nothing real was exercised; see
 * tenancy.ts and reports/M7-03-remote-worker.md §9).
 */
import { EXECUTION_TARGETS, type ExecutionTarget } from "@role-orchestrator/contracts";
import {
  runEventsDuplicateDelivery,
  runLeaseExpiryBlocksSlot,
  runOutcomeUnknownNoAutoRerun,
  runPostureHardenedRefused,
  runSecretsMinimalExposure,
  runTransportZombieWriteBackExpiredLease,
  runTransportZombieWriteBackStaleToken,
  runCancelConfirmedTreeTerminated,
  runCancelRaceAfterTerminal,
  runCancelUnconfirmedHonestReport,
  runCancelUndeliverableSealedCable
} from "./cases.js";

export type RemoteFaultBoundary =
  | "transport"
  | "lease"
  | "cancel"
  | "events"
  | "outcome"
  | "secret"
  | "posture";

export type RemoteFaultAcceptance = "A22" | "A26" | "A31" | "A42";

export interface RemoteFaultCase {
  readonly id: string;
  readonly boundary: RemoteFaultBoundary;
  readonly acceptance: readonly RemoteFaultAcceptance[];
  readonly title: string;
  readonly injection: string;
  readonly expected: string;
  /** The pinned test that IS the evidence (test file quoted in the doc). */
  readonly evidenceTest: string;
  /** What a REAL implementation must still measure per target (all unverified). */
  readonly targetNotes: Readonly<Record<ExecutionTarget, string>>;
  readonly run: () => void;
}

/** Shared honest note fragments for the per-target columns. */
const NOTE = {
  winTreeKill:
    "真实实现需远端等效 taskkill /T /F 的实测证据（本地启动器证据 reports/M0-05 §4 场景1 不可迁移）",
  wslTreeKill:
    "真实实现需远端负 PGID SIGKILL 的实测证据（本地 WSL2 语义 reports/M0-05 §4 场景5 不可迁移）",
  linuxNothing: "无任何 Linux 宿主证据（reports/M0-06 §4）；真实实现必须先补实测",
  macNothing: "无任何 macOS 宿主证据（reports/M0-06 §4）；真实实现必须先补实测",
  winBoundary: "容器/远程文件与网络边界在本 target 无实测（A31：Hardened 声明保持禁用）",
  wslBoundary: "WSL 内容器边界无实测（A29 路径/世界混用拒绝仍在位）",
  transportGeneric:
    "真实链路的分包/重连/半开连接行为需实测；本仿真只覆盖 seal/heal/drop 三个确定性注入点"
} as const;

function notes(win: string, wsl: string, linux: string, mac: string): Readonly<Record<ExecutionTarget, string>> {
  return { "windows-native": win, wsl, "linux-native": linux, "macos-native": mac };
}

export const REMOTE_FAULT_MATRIX: readonly RemoteFaultCase[] = [
  {
    id: "RW-TRX-01",
    boundary: "transport",
    acceptance: ["A22"],
    title: "传输中断 + 僵尸 worker 携过期租约回写：fencing 以 lease-expired 拒绝，结果未知落 RECOVERY_REQUIRED",
    injection: "执行中途 transport.seal()；worker 继续执行并在租约过期后才 complete()（缓冲事件经 heal 重投）",
    expected:
      "缓冲 result 在到站时按到站时刻做 fencing 校验 → lease-expired 拒绝且不入账；租约槽位保持占用（claim 返回 needs-reconcile）；会话经 observeUnknownOutcome 落 RECOVERY_REQUIRED，autoRerun=false",
    evidenceTest: "RW-TRX-01 zombie write-back with expired lease",
    targetNotes: notes(
      `${NOTE.winBoundary}；${NOTE.transportGeneric}`,
      NOTE.wslBoundary,
      NOTE.transportGeneric,
      NOTE.transportGeneric
    ),
    run: runTransportZombieWriteBackExpiredLease
  },
  {
    id: "RW-TRX-02",
    boundary: "transport",
    acceptance: ["A22"],
    title: "僵尸回写撞上已重租的新尝试：stale-token 拒绝，新持有者同槽位写入不受扰",
    injection: "同 RW-TRX-01 后执行显式 reconcileExpired + 新 execution 重新 claim（fencing token +1），随后僵尸事件到站",
    expected:
      "僵尸旧 token 回写 → stale-token 拒绝；新尝试 token 的事件照常通过 fencing 并入账；token 严格单调（2=旧1+1）",
    evidenceTest: "RW-TRX-02 zombie write-back with stale token after re-lease",
    targetNotes: notes(NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric),
    run: runTransportZombieWriteBackStaleToken
  },
  {
    id: "RW-LSN-01",
    boundary: "lease",
    acceptance: ["A22"],
    title: "租约过期后 worker 仍继续执行：回写被拒且槽位阻塞到显式 reconcile",
    injection: "无传输故障；逻辑时钟越过 leaseExpiresAt 后 worker 才 complete()",
    expected:
      "result 回写 → lease-expired 拒绝；同刻 claim 新租约 → needs-reconcile（超时不自动抢）；仅显式 reconcileExpired 后槽位可再 claim",
    evidenceTest: "RW-LSN-01 expired lease blocks the slot until explicit reconcile",
    targetNotes: notes(
      "真实实现的时钟源（单调钟 vs 墙钟）需实测；authority 单侧判定语义不变",
      NOTE.transportGeneric,
      NOTE.transportGeneric,
      NOTE.transportGeneric
    ),
    run: runLeaseExpiryBlocksSlot
  },
  {
    id: "RW-CXL-01",
    boundary: "cancel",
    acceptance: ["A26"],
    title: "取消及时到达：远端进程树（含孙进程）全部终止，cancel-confirmed 入账",
    injection: "worker beginWork 后、complete 前投递 cancel 命令（无注入不可终止项）",
    expected:
      "worker 回 cancel-confirmed，receipt.terminated 含 root/child/grandchild 且 unresolved 为空；会话终态 cancelled-confirmed，租约正常归还",
    evidenceTest: "RW-CXL-01 cancel in time terminates the whole tree",
    targetNotes: notes(NOTE.winTreeKill, NOTE.wslTreeKill, NOTE.linuxNothing, NOTE.macNothing),
    run: runCancelConfirmedTreeTerminated
  },
  {
    id: "RW-CXL-02",
    boundary: "cancel",
    acceptance: ["A26"],
    title: "取消与结果竞态：worker 已终态后 cancel 到达 → cancel-after-terminal，会话只保留唯一终局",
    injection: "worker complete() 先发生，cancel 命令随后投递（pump 顺序模拟在途竞争）",
    expected:
      "worker 回 cancel-after-terminal（带 terminalEventId，不伪造 kill 收据）；会话终局仍为 result-delivered；后续事件全部 post-terminal 计数，不产生第二终局",
    evidenceTest: "RW-CXL-02 cancel racing a finished worker yields exactly one terminal outcome",
    targetNotes: notes(NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric),
    run: runCancelRaceAfterTerminal
  },
  {
    id: "RW-CXL-03",
    boundary: "cancel",
    acceptance: ["A26"],
    title: "孙进程不可终止：cancel-unconfirmed 如实列 unresolved，绝不宣称已终止",
    injection: "worker.injectUnterminable([proc-grandchild-1]) 后投递 cancel",
    expected:
      "worker 回 cancel-unconfirmed：terminated=[root,child]、unresolved=[grandchild]；会话终态 cancel-unconfirmed（A26 的『明确报告未终止』半边）",
    evidenceTest: "RW-CXL-03 unterminable grandchild is reported, never claimed killed",
    targetNotes: notes(
      "本机树杀语义已实测（taskkill /T）；远端『不可终止时的检测与上报』需真实远端实现补测",
      "WSL 内负 PGID kill 的失效形态需实测",
      NOTE.linuxNothing,
      NOTE.macNothing
    ),
    run: runCancelUnconfirmedHonestReport
  },
  {
    id: "RW-CXL-04",
    boundary: "cancel",
    acceptance: ["A26", "A22"],
    title: "取消不可达（断缆中）：CancelUndeliverableError，终止状态未知而非假定死亡",
    injection: "transport.seal() 后 session.cancel()",
    expected:
      "cancel 抛 CancelUndeliverableError（transport-sealed 转译）；会话无终局；随后 observeUnknownOutcome 落 RECOVERY_REQUIRED——不把『送不到取消』当成『已终止』",
    evidenceTest: "RW-CXL-04 undeliverable cancel leaves termination unknown",
    targetNotes: notes(NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric),
    run: runCancelUndeliverableSealedCable
  },
  {
    id: "RW-EVT-01",
    boundary: "events",
    acceptance: [],
    title: "事件重复交付：幂等键（eventId）去重，恰好入账一次（A39 同型原语）",
    injection: "transport.armDuplicateDelivery(result.eventId) 后 drain",
    expected:
      "同一事件两份到站：第一份入账（终局成立、租约归还恰一次），第二份 duplicatesIgnored=1；重复先于原件/后于原件到站均被吸收",
    evidenceTest: "RW-EVT-01 duplicate delivery absorbed by idempotency key",
    targetNotes: notes(NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric, NOTE.transportGeneric),
    run: runEventsDuplicateDelivery
  },
  {
    id: "RW-OUT-01",
    boundary: "outcome",
    acceptance: ["A22"],
    title: "结果未知（worker 静默失联）：RECOVERY_REQUIRED，全系统无自动重跑路径",
    injection: "worker.crash()（无传输故障）；心跳/结果永不再来；租约过期",
    expected:
      "租约过期本身不产生终局（超时只代表需 reconcile）；显式 observeUnknownOutcome 后终局 unknown-recovery-required / nodeState=RECOVERY_REQUIRED / autoRerun=false；同槽位 claim 直到显式 reconcile 前一直 needs-reconcile；本包不存在任何重跑 API（结构性质）",
    evidenceTest: "RW-OUT-01 unknown outcome lands on RECOVERY_REQUIRED, nothing auto re-runs",
    targetNotes: notes(
      "真实远端失联的检测窗口（心跳超时阈值 vs 租约 TTL）需实测标定",
      "同左（WSL 侧时钟/调度差异）",
      NOTE.linuxNothing,
      NOTE.macNothing
    ),
    run: runOutcomeUnknownNoAutoRerun
  },
  {
    id: "RW-SEC-01",
    boundary: "secret",
    acceptance: ["A42"],
    title: "secret 最小暴露：仅引用可表达，凭据形态文本被拒，worker/事件/证据无值可泄",
    injection: "向 secretRef 槽位与自由文本字段注入 10 类已知凭据形态（哨兵构造，非真实凭据）",
    expected:
      "schema 全部拒绝（SecretMaterialRejectedError / ZodError）；worker debugState 只含 ref 名；会话证据日志只含结构事实；事件闭字段集无凭据位（结构 A42）",
    evidenceTest: "RW-SEC-01 secret-shaped material is rejected everywhere",
    targetNotes: notes(
      "真实远端 secret store 的注入与驻留（内存/磁盘）行为需实测",
      "同左（WSL 侧）",
      NOTE.linuxNothing,
      NOTE.macNothing
    ),
    run: runSecretsMinimalExposure
  },
  {
    id: "RW-POST-01",
    boundary: "posture",
    acceptance: ["A31"],
    title: "Hardened 声明按 target 全数禁用：证据 unverified 时请求即拒，granted 姿态无法表达 hardened",
    injection: "对 4 个 ExecutionTarget 逐一 requestHardenedPosture / resolvePosture('hardened', …)",
    expected:
      "4 target 全部抛 HardenedPostureUnavailableError（逐 target 理由）；BOUNDARY_EVIDENCE_BY_TARGET 全格 literal unverified+null；assign 命令 posture 字段为 literal local-trusted（hardened 不可上线）",
    evidenceTest: "RW-POST-01 hardened posture is refused per target",
    targetNotes: notes(NOTE.winBoundary, NOTE.wslBoundary, NOTE.winBoundary, NOTE.winBoundary),
    run: runPostureHardenedRefused
  }
];

/** The matrix is total over the four contract targets (every case names all four). */
export function assertMatrixTargetCoverage(): void {
  for (const remoteCase of REMOTE_FAULT_MATRIX) {
    for (const target of EXECUTION_TARGETS) {
      const note = remoteCase.targetNotes[target];
      if (typeof note !== "string" || note.length === 0) {
        throw new Error(`fault ${remoteCase.id} lacks a target note for "${target}"`);
      }
    }
  }
}
