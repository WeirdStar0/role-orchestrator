/**
 * Idempotent, guarded application of reconcile decisions.
 *
 * Every write runs inside ONE `withTransaction` (BEGIN IMMEDIATE) that
 * RE-CHECKS the row state, so two concurrent reconciles — two connections,
 * two processes, or a racing engine terminal write — serialize on the write
 * lock and the loser observes the winner's result instead of double-applying:
 *
 *   - the phase move is guarded by `wherePhaseIn` with the exact phase that
 *     was decided on (zero rows -> the row moved on; reported as
 *     "phase-changed", never a thrown guess);
 *   - the marker event id is deterministic per (execution, kind), so a repeat
 *     application is absorbed by the event primary key ("already-applied").
 *
 * Reconcile NEVER launches, re-dispatches, or kills anything. The only phase
 * it ever writes is INTERRUPTED (from an active phase).
 */
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@role-orchestrator/contracts";
import {
  appendEvent,
  getExecution,
  getEvent,
  setAttemptPhase,
  withTransaction,
  type AttemptPhase,
  type ExecutionRow
} from "@role-orchestrator/store";
import { ReconcileTargetStateError } from "./errors.js";
import {
  reconcileEventId,
  reconcileEventSeq,
  reconcileEventType,
  type ReconcileMarkerKind
} from "./ids.js";
import type { DecisionDetail } from "./decide.js";

export type ApplyResult = "applied" | "already-applied" | "phase-changed";

export interface MarkerSideEffects {
  readonly pendingDispatchIds: readonly string[];
  readonly hasProtocolEvents: boolean;
}

export interface ApplyMarkerInput {
  readonly executionId: string;
  readonly detail: DecisionDetail;
  /** The phase the decision was made on; the write re-checks it under the write lock. */
  readonly fromPhase: AttemptPhase;
  readonly sideEffects: MarkerSideEffects;
  readonly now: string;
}

function markerPayload(input: ApplyMarkerInput, kind: ReconcileMarkerKind): Record<string, JsonValue> {
  // Deliberately excludes dispatch tokens and the pid-identity nonce (the
  // same fields the local API never serves); pid + timestamps are enough to
  // audit a disposition.
  return {
    kind,
    reason: input.detail.reason,
    explanation: input.detail.explanation,
    fromPhase: input.fromPhase,
    storedCreationTime: input.detail.storedCreationTime,
    observedCreationTime: input.detail.observedCreationTime,
    sideEffects: {
      pendingDispatchCount: input.sideEffects.pendingDispatchIds.length,
      pendingDispatchIds: [...input.sideEffects.pendingDispatchIds],
      hasProtocolEvents: input.sideEffects.hasProtocolEvents
    }
  };
}

/** Persist the reconcile marker WITHOUT touching the phase (recovery-required / observed-running). */
export function applyReconcileMarker(
  db: DatabaseSync,
  input: ApplyMarkerInput,
  kind: Extract<ReconcileMarkerKind, "recovery-required" | "observed-running">
): ApplyResult {
  const payload = markerPayload(input, kind);
  return withTransaction(db, () => {
    const row: ExecutionRow | null = getExecution(db, input.executionId);
    if (row === null) return "phase-changed";
    if (row.phase !== input.fromPhase) return "phase-changed";
    const result = appendEvent(db, {
      id: reconcileEventId(input.executionId, kind),
      executionId: input.executionId,
      seq: reconcileEventSeq(kind),
      type: reconcileEventType(kind),
      payload,
      occurredAt: input.now
    });
    return result === "stored" ? "applied" : "already-applied";
  });
}

/**
 * Dispose an active attempt as INTERRUPTED inside one transaction: marker
 * event (dedup by deterministic id) + exact-phase-guarded transition. Returns
 * "phase-changed" when the row moved on concurrently (engine finalized it,
 * another writer claimed it). Idempotent: a second identical application
 * returns "already-applied".
 */
export function applyInterrupt(
  db: DatabaseSync,
  input: ApplyMarkerInput
): ApplyResult {
  const payload = markerPayload(input, "interrupted");
  return withTransaction(db, () => {
    const row: ExecutionRow | null = getExecution(db, input.executionId);
    if (row === null) return "phase-changed";
    if (row.phase === "INTERRUPTED") return "already-applied";
    if (row.phase !== input.fromPhase) return "phase-changed";
    appendEvent(db, {
      id: reconcileEventId(input.executionId, "interrupted"),
      executionId: input.executionId,
      seq: reconcileEventSeq("interrupted"),
      type: reconcileEventType("interrupted"),
      payload,
      occurredAt: input.now
    });
    setAttemptPhase(db, {
      id: input.executionId,
      phase: "INTERRUPTED",
      wherePhaseIn: [input.fromPhase],
      now: input.now
    });
    return "applied";
  });
}

function readMarkerSideEffects(
  db: DatabaseSync,
  executionId: string,
  kind: ReconcileMarkerKind
): MarkerSideEffects {
  const event = getEvent(db, reconcileEventId(executionId, kind));
  if (event !== null) {
    try {
      const payload = JSON.parse(event.payload) as { sideEffects?: unknown };
      const side = payload.sideEffects;
      if (typeof side === "object" && side !== null) {
        const ids = (side as { pendingDispatchIds?: unknown }).pendingDispatchIds;
        const hasEvents = (side as { hasProtocolEvents?: unknown }).hasProtocolEvents;
        return {
          pendingDispatchIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
          hasProtocolEvents: hasEvents === true
        };
      }
    } catch {
      // fall through to the conservative default below
    }
  }
  return { pendingDispatchIds: [], hasProtocolEvents: false };
}

/**
 * Operator-side resolution of a RECOVERY_REQUIRED item (never called by the
 * scanner): after a human has established what happened, move the attempt to
 * INTERRUPTED so the A23 slot frees and a NEW attempt may be created. This
 * still never re-dispatches the original launch.
 */
export function resolveRecoveryRequired(
  db: DatabaseSync,
  input: {
    readonly executionId: string;
    readonly note: string;
    readonly now: string;
  }
): ApplyResult {
  const row = getExecution(db, input.executionId);
  if (row === null) {
    throw new ReconcileTargetStateError(input.executionId, "does not exist");
  }
  if (row.phase === "INTERRUPTED") return "already-applied";
  if (getEvent(db, reconcileEventId(input.executionId, "recovery-required")) === null) {
    throw new ReconcileTargetStateError(
      input.executionId,
      "does not carry a reconcile_recovery_required marker; nothing to resolve"
    );
  }
  return applyInterrupt(db, {
    executionId: input.executionId,
    detail: {
      reason: "recovery-resolved",
      explanation: `operator resolved the recovery-required item: ${input.note}`,
      storedCreationTime: null,
      observedCreationTime: null
    },
    fromPhase: row.phase,
    sideEffects: readMarkerSideEffects(db, input.executionId, "recovery-required"),
    now: input.now
  });
}
