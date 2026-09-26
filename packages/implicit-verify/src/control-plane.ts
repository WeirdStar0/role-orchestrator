import type { DatabaseSync } from "node:sqlite";
import {
  checkAssumption,
  isUsable,
  statusOf,
  type CapabilityStatus,
  type GateCliId
} from "@role-orchestrator/capability-gate";
import {
  GLOBAL_RESOURCE_KEY,
  countLiveQuotaGrants,
  evaluateDispatchGate,
  listQuotaGrants,
  type DispatchGateDecision,
  type LiveGrantCount,
  type QuotaDimension
} from "@role-orchestrator/scheduler";
import {
  checkRunProfileDrift,
  type CheckRunProfileDriftOptions,
  type RunProfileDriftResult
} from "@role-orchestrator/runtime-profile";
import {
  A35_RUNTIME_ASSUMPTION_IDS,
  M0_IMPLICIT_LOADING_EVIDENCE
} from "./evidence.js";
import { ImplicitVerifyProbeError } from "./errors.js";

/**
 * READ-ONLY control-plane probes for M4-06 (A34/A35).
 *
 * This module implements NO enforcement and NO product logic. Each probe
 * COMPOSES the public, already-enforced control surfaces — capability-gate
 * statuses, the scheduler's dispatch gate, the drift queries of
 * runtime-profile and the scheduler/budget ledgers — into typed verdicts the
 * tests pin. The enforcement semantics live where they always lived:
 * `@role-orchestrator/capability-gate` (fail-closed data), the scheduler's
 * claim transaction (quota/budget/attempt-cap) and the (future) execution
 * layer that must call the drift gate before spawning.
 */

// ---------------------------------------------------------------------------
// A35: unattended-write decision probe
// ---------------------------------------------------------------------------

/** One blocked assumption the probe consulted, restated for the verdict. */
export interface ConsultedAssumption {
  readonly id: string;
  readonly listed: boolean;
  readonly blocked: boolean;
  readonly requiredControl: string;
  readonly title: string;
}

export interface UnattendedWriteDecision {
  readonly runtime: GateCliId;
  /**
   * True only if EVERY limb of the control plane would allow an unattended
   * write mode. With the current registry (unattended cells `blocked`,
   * implicit-control cells `unverified`, assumptions blocked) this is always
   * false — and the tests pin exactly that.
   */
  readonly allowed: boolean;
  readonly entryCapabilityId: string;
  readonly entryStatus: CapabilityStatus;
  readonly unattendedCellId: string;
  readonly unattendedCellStatus: CapabilityStatus;
  readonly implicitControlCellId: string;
  readonly implicitControlCellStatus: CapabilityStatus;
  readonly consultedAssumptions: readonly ConsultedAssumption[];
  /**
   * The SCHEDULING layer's verdict for a dispatch that required the
   * unattended-write capability cell — the same query pollQueue runs before
   * any quota or state change.
   */
  readonly dispatchGate: DispatchGateDecision;
  /** One human-readable reason per refusing limb; empty only when allowed. */
  readonly reasons: readonly string[];
}

/**
 * Compose every A35 control-plane limb for one runtime's unattended write
 * mode. This is the query an unattended dispatcher would have to pass; the
 * probe reports the conjunction so tests can pin that it is refused TODAY:
 * 审批通道不可假设 + 隐式加载未经显式管理 => unattended 拒绝（gate 层和调度层
 * 双重失败关闭）。
 */
export function evaluateUnattendedWriteDecision(runtime: GateCliId): UnattendedWriteDecision {
  const evidence = M0_IMPLICIT_LOADING_EVIDENCE.find((entry) => entry.runtime === runtime);
  if (evidence === undefined) {
    throw new ImplicitVerifyProbeError(
      `implicit-verify: no M0 evidence recorded for runtime "${runtime}"`,
      { cause: { runtime, knownRuntimes: M0_IMPLICIT_LOADING_EVIDENCE.map((entry) => entry.runtime) } }
    );
  }
  const entryCapabilityId = `${runtime}.noninteractive-entry`;
  const unattendedCellId = `${runtime}.unattended-write-mode`;
  const implicitControlCellId = evidence.controlCellId;

  const entry = statusOf(entryCapabilityId);
  const unattendedCell = statusOf(unattendedCellId);
  const implicitControlCell = statusOf(implicitControlCellId);
  const consultedAssumptions: ConsultedAssumption[] = A35_RUNTIME_ASSUMPTION_IDS[runtime].map(
    (assumptionId) => {
      const decision = checkAssumption(assumptionId);
      return {
        id: decision.id,
        listed: decision.listed,
        blocked: decision.blocked,
        requiredControl: decision.requiredControl,
        title: decision.reason
      };
    }
  );
  const dispatchGate = evaluateDispatchGate(runtime, unattendedCellId);

  const reasons: string[] = [];
  if (!isUsable(entry.status)) {
    reasons.push(`entry capability "${entryCapabilityId}" is ${entry.status}; noninteractive dispatch unavailable`);
  }
  if (!isUsable(unattendedCell.status)) {
    reasons.push(
      `unattended-write cell "${unattendedCellId}" is ${unattendedCell.status}: ${unattendedCell.summary}`
    );
  }
  if (!isUsable(implicitControlCell.status)) {
    reasons.push(
      `implicit-loading control cell "${implicitControlCellId}" is ${implicitControlCell.status}: ${implicitControlCell.summary}`
    );
  }
  for (const assumption of consultedAssumptions) {
    if (assumption.blocked) {
      reasons.push(
        `assumption "${assumption.id}" is blocked (required control: ${assumption.requiredControl}); ${assumption.title}`
      );
    }
  }
  if (!dispatchGate.allowed) {
    reasons.push(`scheduler dispatch gate: ${dispatchGate.reason ?? "refused"}`);
  }

  return {
    runtime,
    allowed:
      isUsable(entry.status) &&
      isUsable(unattendedCell.status) &&
      isUsable(implicitControlCell.status) &&
      consultedAssumptions.every((assumption) => !assumption.blocked) &&
      dispatchGate.allowed,
    entryCapabilityId,
    entryStatus: entry.status,
    unattendedCellId,
    unattendedCellStatus: unattendedCell.status,
    implicitControlCellId,
    implicitControlCellStatus: implicitControlCell.status,
    consultedAssumptions,
    dispatchGate,
    reasons
  };
}

// ---------------------------------------------------------------------------
// A34: pre-start drift gate probe
// ---------------------------------------------------------------------------

export interface PreStartDriftDecision {
  readonly runId: string;
  /**
   * True only when NOTHING drifted: frozen bindings still resolve to their
   * frozen revisions AND every external config file still matches the frozen
   * revision's baseline hash. A drifted run refuses to start (漂移→不启动).
   */
  readonly allowed: boolean;
  readonly drifted: boolean;
  /** Human-readable refusal per drifted limb; empty only when allowed. */
  readonly reasons: readonly string[];
  /** The full structured drift finding (binding + external config). */
  readonly detail: RunProfileDriftResult;
}

/**
 * The pre-execution drift check an execution start must pass, composed from
 * runtime-profile's `checkRunProfileDrift` (A34 detection half). Drift is a
 * typed refusal, never a silent pass and never an implicit re-snapshot: the
 * run either starts on its frozen configuration or does not start.
 * `options` forwards the drift-check options (e.g. a tighter size cap).
 */
export async function evaluatePreStartDriftGate(
  db: DatabaseSync,
  runId: string,
  options: CheckRunProfileDriftOptions = {}
): Promise<PreStartDriftDecision> {
  const detail = await checkRunProfileDrift(db, runId, options);
  const reasons: string[] = [];
  if (detail.binding.drifted) {
    const changed = detail.binding.entries
      .filter((entry) => entry.kind !== "none")
      .map((entry) => `${entry.roleId}:${entry.kind}`)
      .join(",");
    reasons.push(`binding drift detected: ${changed}`);
  }
  for (const entry of detail.externalConfig) {
    if (entry.result === null) {
      reasons.push(`external config unavailable for ${entry.profileId}@${String(entry.revision)}: ${entry.reason ?? "unknown reason"}`);
      continue;
    }
    if (!entry.result.drifted) {
      continue;
    }
    const badFiles = entry.result.files
      .filter((file) => file.status !== "ok")
      .map((file) => `${file.path}(${file.status})`);
    if (badFiles.length > 0) {
      reasons.push(
        `external config drift for ${entry.profileId}@${String(entry.revision)}: ${badFiles.join(", ")}`
      );
    } else {
      reasons.push(
        `external config hash changed for ${entry.profileId}@${String(entry.revision)}: ` +
          `expected ${entry.result.expectedHash}, measured ${entry.result.actualHash ?? "(unverifiable)"}`
      );
    }
  }
  return {
    runId,
    allowed: !detail.drifted,
    drifted: detail.drifted,
    reasons,
    detail
  };
}

// ---------------------------------------------------------------------------
// A35: quota-ledger census (orchestrator-dispatched executions only)
// ---------------------------------------------------------------------------

export interface QuotaLedgerCensus {
  /** ALL grant rows ever written (live + released). */
  readonly grantRowsTotal: number;
  /** Grant row count per dimension — the four counted quota keys. */
  readonly grantsByDimension: Readonly<Record<QuotaDimension, number>>;
  /** Sorted distinct execution ids carrying at least one grant row. */
  readonly distinctExecutionIds: readonly string[];
  /** Live (unreleased) grant count on the `global` key. */
  readonly liveGrantsGlobal: LiveGrantCount;
}

/**
 * Census of the scheduler's `quota_grants` ledger, via the scheduler's own
 * read APIs. The A35 boundary the tests pin: every row in this ledger
 * references an execution the orchestrator's dispatch claim created (FK to
 * `executions`), so activity a CLI derives INTERNALLY (its own sub-agents,
 * MCP calls, hooks) cannot hold, consume or free any quota — 不可计费即不可
 * 放行无人值守.
 */
export function quotaLedgerCensus(db: DatabaseSync): QuotaLedgerCensus {
  const grants = listQuotaGrants(db);
  const grantsByDimension: Record<QuotaDimension, number> = {
    global: 0,
    project: 0,
    profile: 0,
    credential: 0
  };
  for (const grant of grants) {
    grantsByDimension[grant.dimension] += 1;
  }
  return {
    grantRowsTotal: grants.length,
    grantsByDimension,
    distinctExecutionIds: [...new Set(grants.map((grant) => grant.executionId))].sort(),
    liveGrantsGlobal: countLiveQuotaGrants(db, { resourceKey: GLOBAL_RESOURCE_KEY })
  };
}
