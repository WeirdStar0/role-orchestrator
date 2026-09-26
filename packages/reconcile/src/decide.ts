/**
 * The reconcile decision function (pure; no I/O).
 *
 * One row per call — a non-terminal (ACTIVE_ATTEMPT_PHASES) execution plus
 * the evidence gathered around it — mapped to exactly one outcome:
 *
 *   interrupted        determinate "the attempt is over" (process provably
 *                      gone, PID provably reused, or provably never started).
 *                      Applied as phase -> INTERRUPTED, which frees the A23
 *                      slot so a NEW attempt (never a re-dispatch) may follow.
 *   recovery-required  indeterminate (A22/A24): side effects exist (dispatch
 *                      outbox committed) but the outcome is unknown. The row
 *                      STAYS in its active phase, so the A23 constraint keeps
 *                      blocking new attempts — nothing is ever auto re-run.
 *   observed-running   identity confirmed alive; left untouched, the item is
 *                      surfaced for observation resumption.
 *
 * A27 rule: a live process whose creation time does NOT match the recorded
 * identity is a REUSED pid. The original holder is provably gone. Reconcile
 * never kills anything; it interrupts the attempt record and leaves the
 * unrelated holder strictly alone.
 */
import { z } from "zod";
import type { AttemptPhase, ProcessIdentityRecord } from "@role-orchestrator/store";
import { ActiveAttemptPhaseSchema } from "@role-orchestrator/store";
import type { ProcessProbe } from "./probe.js";
import { parseProbeTimestamp } from "./probe.js";

function isProcessProbe(value: unknown): value is ProcessProbe {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "not-found" || kind === "found" || kind === "indeterminate") return true;
  return false;
}

export const RECONCILE_OUTCOMES = ["interrupted", "recovery-required", "observed-running"] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export const RECONCILE_REASONS = [
  // -> interrupted
  "process-gone",
  "pid-reused-identity-mismatch",
  "never-started-preparing",
  "recovery-resolved",
  // -> recovery-required
  "launch-window-undetermined",
  "probe-indeterminate",
  "probe-unsupported-target",
  "probe-identity-incomplete",
  "identity-time-anomaly",
  // -> observed-running
  "process-alive-identity-confirmed"
] as const;

export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

const OUTCOME_BY_REASON: Readonly<Record<ReconcileReason, ReconcileOutcome>> = {
  "process-gone": "interrupted",
  "pid-reused-identity-mismatch": "interrupted",
  "never-started-preparing": "interrupted",
  "recovery-resolved": "interrupted",
  "launch-window-undetermined": "recovery-required",
  "probe-indeterminate": "recovery-required",
  "probe-unsupported-target": "recovery-required",
  "probe-identity-incomplete": "recovery-required",
  "identity-time-anomaly": "recovery-required",
  "process-alive-identity-confirmed": "observed-running"
};

export function outcomeForReason(reason: ReconcileReason): ReconcileOutcome {
  return OUTCOME_BY_REASON[reason];
}

export const ReconcileReasonSchema = z.enum(RECONCILE_REASONS);

/** Evidence about the attempt's durable side effects (A22 signs). */
export interface SideEffectEvidence {
  /** Pending `execution.dispatch-requested` outbox messages for this attempt. */
  readonly pendingDispatchIds: readonly string[];
  /** The attempt produced normalized protocol events (the CLI actually streamed). */
  readonly hasProtocolEvents: boolean;
}

export interface DecisionEvidence {
  readonly phase: AttemptPhase;
  /** Parsed `executions.pid_identity`; null when no process was ever recorded. */
  readonly pidIdentity: ProcessIdentityRecord | null;
  readonly probe: ProcessProbe;
  readonly sideEffects: SideEffectEvidence;
  readonly identityToleranceMs: number;
}

export interface DecisionDetail {
  readonly reason: ReconcileReason;
  readonly explanation: string;
  readonly storedCreationTime: string | null;
  readonly observedCreationTime: string | null;
}

export interface ReconcileDecisionPlan {
  readonly outcome: ReconcileOutcome;
  readonly detail: DecisionDetail;
}

const DecisionEvidenceSchema = z.strictObject({
  phase: ActiveAttemptPhaseSchema,
  pidIdentity: z.strictObject({
    pid: z.number().int().min(1),
    creationTime: z.string().min(1),
    executionNonce: z.string().min(1),
    target: z.string().min(1)
  }).nullable(),
  probe: z.custom<ProcessProbe>(isProcessProbe, { message: "a ProcessProbe result is required" }),
  sideEffects: z.strictObject({
    pendingDispatchIds: z.array(z.string().min(1)).max(1000),
    hasProtocolEvents: z.boolean()
  }),
  identityToleranceMs: z.number().int().min(100).max(60_000)
});

/**
 * Decide one active attempt. Total function over its inputs: every path
 * yields exactly one outcome, and every "cannot know" path yields
 * recovery-required (fail-closed) rather than a guess.
 */
export function decideExecution(evidence: DecisionEvidence): ReconcileDecisionPlan {
  DecisionEvidenceSchema.parse(evidence);
  const detail = (reason: ReconcileReason, explanation: string): ReconcileDecisionPlan => ({
    outcome: OUTCOME_BY_REASON[reason],
    detail: {
      reason,
      explanation,
      storedCreationTime: evidence.pidIdentity?.creationTime ?? null,
      observedCreationTime: evidence.probe.kind === "found" ? evidence.probe.identity.creationTimeIso : null
    }
  });

  // ---- no recorded pid: did the launcher even spawn? -----------------------
  if (evidence.pidIdentity === null) {
    if (evidence.phase === "PREPARING") {
      // Durable phase ordering (M1-03 lifecycle): the child is spawned ONLY
      // AFTER the STARTING transition commits. A row still in PREPARING is
      // durable evidence the spawn never happened — determinate, interruptible.
      return detail(
        "never-started-preparing",
        "attempt is durably PREPARING (spawn strictly follows the STARTING transition); the process was never started"
      );
    }
    // STARTING/RUNNING/FINALIZING without a recorded pid is the A24 window:
    // the launch command was armed but the pid was never written. Re-sending
    // the launch could create a second writer — record recovery instead (A22).
    return detail(
      "launch-window-undetermined",
      `attempt is ${evidence.phase} with no recorded pid identity; whether the process started is unknown (A24 window) — recovery required, never re-dispatched`
    );
  }

  // ---- pid recorded: the OS query decides ----------------------------------
  if (evidence.pidIdentity.target !== "windows-native") {
    return detail(
      "probe-unsupported-target",
      `recorded execution target "${evidence.pidIdentity.target}" has no identity probe in this package; refusing to interpret its pid (A29)`
    );
  }
  const probe = evidence.probe;
  if (probe.kind === "indeterminate") {
    return detail(
      "probe-indeterminate",
      `process identity query failed (${probe.reason}); liveness unknown — recovery required instead of guessing`
    );
  }
  if (probe.kind === "not-found") {
    return detail(
      "process-gone",
      `no live process holds recorded pid ${String(evidence.pidIdentity.pid)} (identity query succeeded, empty result)`
    );
  }
  const observed =
    probe.identity.creationTimeIso === null ? null : parseProbeTimestamp(probe.identity.creationTimeIso);
  if (observed === null) {
    return detail(
      "probe-identity-incomplete",
      `live process ${String(evidence.pidIdentity.pid)} reports no parseable creation time; identity cannot be confirmed — recovery required`
    );
  }
  const stored = parseProbeTimestamp(evidence.pidIdentity.creationTime);
  if (stored === null) {
    return detail(
      "probe-identity-incomplete",
      `stored pid identity creation time "${evidence.pidIdentity.creationTime}" is not parseable; identity cannot be compared — recovery required`
    );
  }
  const skew = observed - stored;
  if (Math.abs(skew) <= evidence.identityToleranceMs) {
    return detail(
      "process-alive-identity-confirmed",
      `live process ${String(evidence.pidIdentity.pid)} creation time matches the recorded identity (skew ${String(skew)}ms <= ${String(evidence.identityToleranceMs)}ms)`
    );
  }
  if (skew > 0) {
    // A LIVE holder created meaningfully later than the recorded identity:
    // the pid value was reused (A27). The original is provably gone; the
    // holder is unrelated and must be neither trusted nor killed.
    return detail(
      "pid-reused-identity-mismatch",
      `pid ${String(evidence.pidIdentity.pid)} is held by a process created ${String(skew)}ms after the recorded identity (tolerance ${String(evidence.identityToleranceMs)}ms): PID reused (A27); original gone, holder left untouched`
    );
  }
  return detail(
    "identity-time-anomaly",
    `live process ${String(evidence.pidIdentity.pid)} creation time is ${String(-skew)}ms EARLIER than the recorded identity (tolerance ${String(evidence.identityToleranceMs)}ms); clock anomaly — recovery required instead of guessing`
  );
}
