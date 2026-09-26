/**
 * The interrupted list (docs/BACKLOG.md M1-05: "中断列表接口返回全部需人工/
 * 后续处理的条目").
 *
 * Composition is derived entirely from durable state — the frozen schema
 * gains no reconcile-owned tables:
 *   INTERRUPTED        every execution whose phase is INTERRUPTED (reconcile
 *                      sets this; the lifecycle FSM never does). These await
 *                      a NEW attempt or cancellation.
 *   RECOVERY_REQUIRED  an ACTIVE attempt carrying a reconcile_recovery_required
 *                      marker (A22: side effects exist, outcome unknown). The
 *                      row deliberately stays ACTIVE so the A23 partial unique
 *                      index keeps the slot blocked — nothing auto re-runs.
 *   RUNNING_CONFIRMED  an ACTIVE attempt whose identity reconcile confirmed
 *                      alive (reconcile_observed_running marker and no
 *                      recovery-required marker). Alive, but this daemon did
 *                      not witness the launch and owns no pipe to it: someone
 *                      must resume observation and finalize it later.
 *
 * Plainly RUNNING rows WITHOUT a reconcile marker are a live daemon's
 * business and never appear here; terminal rows never appear.
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  getEvent,
  getExecution,
  listActiveAttempts,
  listEventsForExecution,
  listExecutionsForPhase,
  parseJsonRecord,
  type AttemptPhase
} from "@role-orchestrator/store";
import { resolveRecoveryRequired } from "./apply.js";
import { ReconcileTargetStateError } from "./errors.js";
import { reconcileEventId } from "./ids.js";
import type { ReconcileReason } from "./decide.js";

export const RECOVERY_ITEM_STATUSES = ["INTERRUPTED", "RECOVERY_REQUIRED", "RUNNING_CONFIRMED"] as const;
export type RecoveryItemStatus = (typeof RECOVERY_ITEM_STATUSES)[number];

export const RECOVERY_FOLLOW_UPS = ["retry-or-cancel", "manual-recovery", "resume-observation"] as const;
export type RecoveryFollowUp = (typeof RECOVERY_FOLLOW_UPS)[number];

export interface RecoveryItem {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly phase: AttemptPhase;
  readonly status: RecoveryItemStatus;
  /** Reconcile reason behind the status; null when the row was interrupted outside reconcile. */
  readonly reason: ReconcileReason | null;
  /** ISO time of the reconcile marker that established the status; null for foreign INTERRUPTED rows. */
  readonly markedAt: string | null;
  /** A22 evidence: pending dispatch outbox messages committed for this attempt. */
  readonly pendingDispatchIds: readonly string[];
  /** A22 evidence: the attempt streamed normalized protocol events. */
  readonly hasProtocolEvents: boolean;
  readonly followUp: RecoveryFollowUp;
}

interface SideEffectFacts {
  readonly pendingDispatchIds: readonly string[];
  readonly hasProtocolEvents: boolean;
}

function sideEffectsFromPayload(payloadText: string): SideEffectFacts {
  const none: SideEffectFacts = { pendingDispatchIds: [], hasProtocolEvents: false };
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonRecord(payloadText, "reconcile marker");
  } catch {
    return none;
  }
  const side = payload["sideEffects"];
  if (typeof side !== "object" || side === null) return none;
  const ids = (side as { pendingDispatchIds?: unknown }).pendingDispatchIds;
  const hasEvents = (side as { hasProtocolEvents?: unknown }).hasProtocolEvents;
  return {
    pendingDispatchIds: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [],
    hasProtocolEvents: hasEvents === true
  };
}

function reasonFromPayload(payloadText: string): ReconcileReason | null {
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonRecord(payloadText, "reconcile marker");
  } catch {
    return null;
  }
  const reason = payload["reason"];
  return typeof reason === "string" ? (reason as ReconcileReason) : null;
}

/** Rebuild the A22 evidence for an active row: live events + marker payloads. */
function activeSideEffects(db: DatabaseSync, executionId: string): SideEffectFacts {
  const events = listEventsForExecution(db, executionId);
  let pendingDispatchIds: readonly string[] = [];
  let hasProtocolEvents = false;
  for (const event of events) {
    if (event.seq < 1_000_000_000 && !event.type.startsWith("reconcile_")) {
      // Protocol band (cli-events pipeline seqs) — the CLI demonstrably streamed.
      hasProtocolEvents = true;
    }
    if (event.type.startsWith("reconcile_")) {
      const facts = sideEffectsFromPayload(event.payload);
      if (facts.pendingDispatchIds.length > 0) pendingDispatchIds = facts.pendingDispatchIds;
      if (facts.hasProtocolEvents) hasProtocolEvents = true;
    }
  }
  return { pendingDispatchIds, hasProtocolEvents };
}

/** Every entry that needs human or follow-up handling, ordered by (runId, nodeId, attempt). */
export function listRecoveryItems(db: DatabaseSync): readonly RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const row of listActiveAttempts(db)) {
    const recovery = getEvent(db, reconcileEventId(row.id, "recovery-required"));
    if (recovery !== null) {
      items.push({
        executionId: row.id,
        runId: row.runId,
        nodeId: row.nodeId,
        attempt: row.attempt,
        phase: row.phase,
        status: "RECOVERY_REQUIRED",
        reason: reasonFromPayload(recovery.payload),
        markedAt: recovery.occurredAt,
        ...activeSideEffects(db, row.id),
        followUp: "manual-recovery"
      });
      continue;
    }
    const observed = getEvent(db, reconcileEventId(row.id, "observed-running"));
    if (observed !== null) {
      items.push({
        executionId: row.id,
        runId: row.runId,
        nodeId: row.nodeId,
        attempt: row.attempt,
        phase: row.phase,
        status: "RUNNING_CONFIRMED",
        reason: reasonFromPayload(observed.payload),
        markedAt: observed.occurredAt,
        ...activeSideEffects(db, row.id),
        followUp: "resume-observation"
      });
    }
    // Active WITHOUT any reconcile marker: owned by a live daemon; not a recovery item.
  }

  for (const row of listExecutionsForPhase(db, "INTERRUPTED")) {
    const marker = getEvent(db, reconcileEventId(row.id, "interrupted"));
    items.push({
      executionId: row.id,
      runId: row.runId,
      nodeId: row.nodeId,
      attempt: row.attempt,
      phase: row.phase,
      status: "INTERRUPTED",
      reason: marker === null ? null : reasonFromPayload(marker.payload),
      markedAt: marker?.occurredAt ?? null,
      ...(marker === null
        ? { pendingDispatchIds: [], hasProtocolEvents: false }
        : sideEffectsFromPayload(marker.payload)),
      followUp: "retry-or-cancel"
    });
  }

  return [...items].sort((a, b) =>
    a.runId.localeCompare(b.runId) ||
    a.nodeId.localeCompare(b.nodeId) ||
    a.attempt - b.attempt
  );
}

const ResolveInputSchema = z.strictObject({
  executionId: z.string().min(1).max(64),
  note: z.string().min(1).max(1024),
  now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
});

/**
 * Human disposition of a RECOVERY_REQUIRED item: resolve it to INTERRUPTED
 * (freeing the A23 slot so a NEW attempt can be created). Thin validation
 * wrapper; all state guards live in `resolveRecoveryRequired`. This is the
 * only reconcile entry point meant to be called by an operator rather than
 * by the scanner.
 */
export function resolveRecoveryItem(
  db: DatabaseSync,
  input: { readonly executionId: string; readonly note: string; readonly now: string }
): "applied" | "already-applied" | "phase-changed" {
  const value = ResolveInputSchema.parse(input);
  if (getExecution(db, value.executionId) === null) {
    throw new ReconcileTargetStateError(value.executionId, "does not exist");
  }
  return resolveRecoveryRequired(db, value);
}
