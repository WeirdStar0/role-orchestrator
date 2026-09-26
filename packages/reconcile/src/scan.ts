/**
 * Startup reconcile scan (docs/ORCHESTRATION.md section 7).
 *
 * `reconcileStartup` is what a daemon calls while holding the database lock
 * at startup, and what the recovery tests call directly:
 *
 *   1. list every ACTIVE attempt (PREPARING/STARTING/RUNNING/FINALIZING —
 *      the exact set the A23 partial unique index covers);
 *   2. per attempt, gather evidence: the recorded pid identity, the pending
 *      dispatch-requested outbox messages (the A22 side-effect sign), and the
 *      presence of normalized protocol events;
 *   3. decide with the pure `decideExecution` (identity probe for every
 *      attempt that recorded a pid);
 *   4. apply idempotently (`applyInterrupt` / `applyReconcileMarker`).
 *
 * The scan itself is read-mostly: it never re-dispatches a launch, never
 * kills a process, and never creates an attempt. Interrupting is the only
 * phase write it performs.
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  listActiveAttempts,
  listEventsForExecution,
  listPendingOutboxMessages,
  readExecutionPidIdentity,
  type ExecutionRow,
  type ProcessIdentityRecord
} from "@role-orchestrator/store";
import { decideExecution, type DecisionDetail, type SideEffectEvidence } from "./decide.js";
import { applyInterrupt, applyReconcileMarker, type ApplyResult } from "./apply.js";
import { windowsProcessProbe, type ProcessProbe, type ProcessProbeFn } from "./probe.js";

export const DEFAULT_IDENTITY_TOLERANCE_MS = 5_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

const ReconcileStartupInputSchema = z.strictObject({
  /** Scan timestamp; defaults to the wall clock (all writes of one scan share it). */
  now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).optional(),
  /** |stored - observed| creation-time skew still accepted as the SAME process. */
  identityToleranceMs: z.number().int().min(100).max(60_000).default(DEFAULT_IDENTITY_TOLERANCE_MS),
  /** Per-probe PowerShell timeout. */
  probeTimeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_PROBE_TIMEOUT_MS),
  /** Injectable for tests; defaults to the real Win32_Process probe. */
  probe: z.custom<ProcessProbeFn>((value) => typeof value === "function").optional()
});

export type ReconcileStartupInput = {
  readonly now?: string | undefined;
  readonly identityToleranceMs?: number | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly probe?: ProcessProbeFn | undefined;
};

export interface ReconcileDecisionRecord {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  /** Phase the row was in when decided. */
  readonly phaseAtScan: string;
  readonly outcome: "interrupted" | "recovery-required" | "observed-running";
  readonly detail: DecisionDetail;
  readonly sideEffects: SideEffectEvidence;
  /** Write result of the idempotent application. */
  readonly applied: ApplyResult;
}

export interface ReconcileScanResult {
  /** Active attempts found by the scan. */
  readonly scanned: number;
  readonly interrupted: number;
  readonly recoveryRequired: number;
  readonly observedRunning: number;
  readonly now: string;
  readonly decisions: readonly ReconcileDecisionRecord[];
}

function gatherSideEffects(
  db: DatabaseSync,
  row: ExecutionRow
): SideEffectEvidence {
  const pendingDispatchIds = listPendingOutboxMessages(db)
    .filter(
      (message) =>
        message.aggregateId === row.id &&
        message.type === "execution.dispatch-requested" &&
        message.publishedAt === null
    )
    .map((message) => message.id);
  const hasProtocolEvents = listEventsForExecution(db, row.id).some((event) => {
    if (event.type.startsWith("reconcile_")) return false;
    // Engine lifecycle markers (lifecycle_outcome / lifecycle_launch_failed)
    // sit in the high seq band and are not protocol evidence.
    return event.seq < 1_000_000_000;
  });
  return { pendingDispatchIds, hasProtocolEvents };
}

/**
 * One startup reconcile pass. Concurrent invocations are safe: decisions are
 * derived per row and applied under the write lock with deterministic event
 * ids, so a second pass observes the first pass's dispositions and reports
 * them as already-applied / phase-changed instead of writing twice.
 */
export async function reconcileStartup(
  db: DatabaseSync,
  input: ReconcileStartupInput = {}
): Promise<ReconcileScanResult> {
  const value = ReconcileStartupInputSchema.parse(input);
  const now = value.now ?? new Date().toISOString();
  const probe = value.probe ?? windowsProcessProbe;

  const active = listActiveAttempts(db);
  const decisions: ReconcileDecisionRecord[] = [];
  let interrupted = 0;
  let recoveryRequired = 0;
  let observedRunning = 0;

  for (const row of active) {
    const pidIdentity = readExecutionPidIdentity(db, row.id);
    const sideEffects = gatherSideEffects(db, row);
    const evidencePid: ProcessIdentityRecord | null = pidIdentity;
    const probeResult: ProcessProbe =
      evidencePid === null
        ? // No pid recorded: the decision needs no OS query (PREPARING is
          // durably pre-spawn; everything else is the A24 window).
          { kind: "indeterminate", reason: "no pid identity recorded; probe not applicable" }
        : await probe(evidencePid.pid, value.probeTimeoutMs);

    const plan = decideExecution({
      phase: row.phase,
      pidIdentity: evidencePid,
      probe: probeResult,
      sideEffects,
      identityToleranceMs: value.identityToleranceMs
    });

    const inputForApply = {
      executionId: row.id,
      detail: plan.detail,
      fromPhase: row.phase,
      sideEffects,
      now
    };
    const applied =
      plan.outcome === "interrupted"
        ? applyInterrupt(db, inputForApply)
        : plan.outcome === "recovery-required"
          ? applyReconcileMarker(db, inputForApply, "recovery-required")
          : applyReconcileMarker(db, inputForApply, "observed-running");

    decisions.push({
      executionId: row.id,
      runId: row.runId,
      nodeId: row.nodeId,
      attempt: row.attempt,
      phaseAtScan: row.phase,
      outcome: plan.outcome,
      detail: plan.detail,
      sideEffects,
      applied
    });
    if (plan.outcome === "interrupted") interrupted += 1;
    else if (plan.outcome === "recovery-required") recoveryRequired += 1;
    else observedRunning += 1;
  }

  return {
    scanned: active.length,
    interrupted,
    recoveryRequired,
    observedRunning,
    now,
    decisions
  };
}
