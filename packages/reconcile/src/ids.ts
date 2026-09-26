/**
 * Durable reconcile markers (M1-05).
 *
 * Reconcile decisions are persisted as regular per-execution events so a
 * restarted daemon can always reconstruct WHY an attempt carries its current
 * disposition. The frozen `executions` schema (migration 001) keeps its eight
 * phases; RECOVERY_REQUIRED is therefore NOT a new phase value — it is a
 * reconcile status derived from the marker event while the attempt row stays
 * in its active phase, which keeps the A23 partial unique index
 * `ux_executions_one_active_per_slot` blocking any new attempt for the slot
 * until a human resolves the item (constraint-level "never auto re-run").
 *
 * Seq bands (each kind owns exactly one seq per execution, so repeated scans
 * can never collide on UNIQUE(execution_id, seq)):
 *   protocol events            seq <    1_000_000_000  (cli-events pipeline)
 *   engine lifecycle           seq >=   1_000_000_000  (outcome, launch-failed)
 *   reconcile markers          seq >= 1_001_000_000     (this package)
 *
 * Event ids are deterministic per (executionId, kind): replaying a scan is
 * absorbed by the event primary key ("duplicate"), which is what makes
 * concurrent reconciles idempotent.
 */
import { createHash } from "node:crypto";
import { IdSchema } from "@role-orchestrator/contracts";
import { z } from "zod";

export const RECONCILE_EVENT_SEQ_BASE = 1_001_000_000;

export const RECONCILE_EVENT_TYPES = [
  "reconcile_interrupted",
  "reconcile_recovery_required",
  "reconcile_observed_running"
] as const;

export type ReconcileEventType = (typeof RECONCILE_EVENT_TYPES)[number];

export type ReconcileMarkerKind =
  | "interrupted"
  | "recovery-required"
  | "observed-running";

const KIND_SEQ_OFFSET: Readonly<Record<ReconcileMarkerKind, number>> = {
  interrupted: 1000,
  "recovery-required": 1001,
  "observed-running": 1002
};

export function reconcileEventType(kind: ReconcileMarkerKind): ReconcileEventType {
  switch (kind) {
    case "interrupted":
      return "reconcile_interrupted";
    case "recovery-required":
      return "reconcile_recovery_required";
    case "observed-running":
      return "reconcile_observed_running";
  }
}

/** Deterministic marker event id — one per (execution, kind), replay-safe. */
export function reconcileEventId(executionId: string, kind: ReconcileMarkerKind): string {
  const id = `evt-rec-${createHash("sha256").update(`${IdSchema.parse(executionId)}:${kind}`).digest("hex").slice(0, 40)}`;
  return id;
}

export function reconcileEventSeq(kind: ReconcileMarkerKind): number {
  return RECONCILE_EVENT_SEQ_BASE + KIND_SEQ_OFFSET[kind];
}

/** Zod schema for marker event types, for callers that read events back. */
export const ReconcileEventTypeSchema = z.enum(RECONCILE_EVENT_TYPES);
