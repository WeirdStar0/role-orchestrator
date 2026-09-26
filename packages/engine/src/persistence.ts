/**
 * Durable persistence of normalized events (the engine's write side of the
 * `events` table).
 *
 * - Protocol events keep the pipeline's seq numbering (1-based, continuous),
 *   which satisfies UNIQUE(execution_id, seq) per execution.
 * - Engine lifecycle events (launch failures, terminal outcomes) live in a
 *   HIGH seq band far above anything the byte-limited protocol stream can
 *   produce, so the two spaces never collide.
 * - Event ids are the pipeline eventId (replay-idempotent by primary key) or
 *   a deterministic lifecycle id derived from the execution id.
 * - Every batch is appended inside one `withTransaction` so a line's events
 *   (e.g. result + usage) commit atomically.
 * - A36 落盘前脱敏: every payload passes `redactEventPayload` BEFORE the row
 *   is built, so secret-shaped text (`Bearer <token>`, `token=<value>`, …)
 *   is already a `[REDACTED]` placeholder when it reaches the events table.
 *   The store checksum is computed over the exact stored (redacted) payload
 *   inside `appendEvent`, so integrity verification stays consistent.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Dialect } from "@role-orchestrator/cli-events";
import { redactJsonValue } from "@role-orchestrator/cli-events";
import type { JsonValue, NormalizedEvent } from "@role-orchestrator/contracts";
import {
  appendEvent,
  withTransaction,
  type AppendEventInput,
  type AppendEventResult
} from "@role-orchestrator/store";
import { sha256Hex } from "@role-orchestrator/runtime-profile";

/** Protocol streams are byte-limited; lifecycle seqs start far above them. */
export const LIFECYCLE_EVENT_SEQ_BASE = 1_000_000_000;

/**
 * A36 落盘前脱敏 (single choke point for every engine event write): deep-redact
 * every string inside the payload before it is stored. Only string VALUES are
 * rewritten; the JSON structure is untouched, so the event schema validation
 * in `appendEvent` still passes. The placeholder never re-matches the pattern
 * list, which makes the transformation idempotent (double-redacting — e.g.
 * re-serving an already-redacted payload — is a no-op).
 */
export function redactEventPayload(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  return redactJsonValue(payload).value as Record<string, JsonValue>;
}

/**
 * `appendEvent` with the A36 pre-persist redaction applied to the payload.
 * All engine event writes (protocol batches, terminal outcomes, launch
 * failures) go through this wrapper; the checksum is computed by the store
 * over the exact redacted payload text, so `verifyEventChecksums` stays
 * green.
 */
export function appendRedactedEvent(db: DatabaseSync, input: AppendEventInput): AppendEventResult {
  return appendEvent(db, {
    ...input,
    payload: redactEventPayload(input.payload as Record<string, JsonValue>)
  });
}

/** The normalized event type that carries the CLI session/thread id. */
export function sessionIdFromEvent(dialect: Dialect, event: NormalizedEvent): string | null {
  if (event.type !== "started") return null;
  const key = dialect === "claude" ? "sessionId" : "threadId";
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface PersistBatchResult {
  readonly stored: number;
  readonly duplicated: number;
  /** First `started` event in the batch (session/thread id), if any. */
  readonly sessionId: string | null;
}

export function persistDrainedEvents(
  db: DatabaseSync,
  dialect: Dialect,
  executionId: string,
  events: readonly NormalizedEvent[]
): PersistBatchResult {
  if (events.length === 0) {
    return { stored: 0, duplicated: 0, sessionId: null };
  }
  let stored = 0;
  let duplicated = 0;
  let sessionId: string | null = null;
  withTransaction(db, () => {
    for (const event of events) {
      const result = appendRedactedEvent(db, {
        id: event.eventId,
        executionId,
        seq: event.seq,
        type: event.type,
        payload: event.payload as Record<string, JsonValue>,
        occurredAt: event.occurredAt
      });
      if (result === "stored") stored += 1;
      else duplicated += 1;
      if (sessionId === null) {
        sessionId = sessionIdFromEvent(dialect, event);
      }
    }
  });
  return { stored, duplicated, sessionId };
}

/**
 * Deterministic lifecycle event id: one outcome/launch-failure record per
 * execution, stable across retries of the terminal write.
 */
export function lifecycleEventId(executionId: string, kind: "outcome" | "launch-failed"): string {
  return `evt-lc-${sha256Hex(`${executionId}:${kind}`).slice(0, 40)}`;
}

/** Deterministic outbox message id (IdSchema-safe: lowercase hex, bounded). */
export function lifecycleOutboxId(
  executionId: string,
  attempt: number,
  tag: "dispatched" | "finished"
): string {
  return `ob-${sha256Hex(`${executionId}:${String(attempt)}:${tag}`).slice(0, 40)}`;
}
