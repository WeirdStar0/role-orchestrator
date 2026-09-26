import { createHash } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { JsonRecordSchema } from "../json.js";
import { TimestampSchema } from "../time.js";

/**
 * Durable per-execution events (DOMAIN_MODEL `ExecutionEvent`). Two
 * uniqueness layers:
 * - PRIMARY KEY on `id`: replaying the same eventId is a no-op ("duplicate"),
 *   which makes at-least-once delivery replay-safe.
 * - UNIQUE(execution_id, seq): seq is monotone per execution; a DIFFERENT id
 *   reusing a seq is a genuine protocol violation and raises.
 *
 * The stored `checksum` (sha256 over executionId, seq, type and the exact
 * stored payload text) supports later replay-integrity verification; it is an
 * integrity aid, not the dedup key.
 */
export interface EventRow {
  readonly id: string;
  readonly executionId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: string;
  readonly checksum: string;
  readonly occurredAt: string;
}

export type AppendEventResult = "stored" | "duplicate";

const AppendEventInputSchema = z.strictObject({
  id: IdSchema,
  executionId: IdSchema,
  seq: z.number().int().min(0),
  type: z.string().min(1).max(128),
  payload: JsonRecordSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  occurredAt: TimestampSchema
});

export type AppendEventInput = z.input<typeof AppendEventInputSchema>;

export function eventChecksum(
  executionId: string,
  seq: number,
  type: string,
  storedPayload: string
): string {
  return createHash("sha256")
    .update(`${executionId}\u0000${String(seq)}\u0000${type}\u0000${storedPayload}`, "utf8")
    .digest("hex");
}

export function appendEvent(db: DatabaseSync, input: AppendEventInput): AppendEventResult {
  const value = AppendEventInputSchema.parse(input);
  const payloadJson = JSON.stringify(value.payload);
  const checksum = value.checksum ?? eventChecksum(value.executionId, value.seq, value.type, payloadJson);
  const result = db
    .prepare(
      "INSERT INTO events(id, execution_id, seq, type, payload, checksum, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
    )
    .run(value.id, value.executionId, value.seq, value.type, payloadJson, checksum, value.occurredAt);
  return Number(result.changes) === 1 ? "stored" : "duplicate";
}

function mapEventRow(row: Record<string, unknown>): EventRow {
  return {
    id: String(row.id),
    executionId: String(row.execution_id),
    seq: Number(row.seq),
    type: String(row.type),
    payload: String(row.payload),
    checksum: String(row.checksum),
    occurredAt: String(row.occurred_at)
  };
}

export function getEvent(db: DatabaseSync, id: string): EventRow | null {
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id);
  return row === undefined ? null : mapEventRow(row);
}

/** All events of an execution ordered by seq — the replay cursor order. */
export function listEventsForExecution(db: DatabaseSync, executionId: string): readonly EventRow[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE execution_id = ? ORDER BY seq ASC")
    .all(executionId);
  return rows.map(mapEventRow);
}

/**
 * M5-04 — ONE memory-bounded page of an execution's event log (the live
 * subscription replay primitive): rows with `seq > afterSeq` in seq order,
 * capped BOTH by row count (`limit`) and by approximate payload bytes
 * (`byteBudget`). At least one row is always returned when any row exists,
 * so a page stream always makes progress even past a payload larger than
 * the whole budget. `hasMore` is derived from the store (any row beyond the
 * last returned seq), never from the caps themselves.
 *
 * Unlike `listEventsForExecution` (which materializes the WHOLE log), this
 * read never holds more than one page in memory — a 64 MiB-scale execution
 * log streams through a bounded buffer instead of exhausting the daemon.
 */
const ListEventPageInputSchema = z.strictObject({
  executionId: IdSchema,
  /** Exclusive lower seq bound (the replay cursor). */
  afterSeq: z.number().int().min(0),
  /** Row-count cap for one page. */
  limit: z.number().int().min(1).max(1000),
  /** Approximate payload-byte cap for one page. */
  byteBudget: z.number().int().min(1).max(16 * 1024 * 1024)
});

export type ListEventPageInput = z.input<typeof ListEventPageInputSchema>;

export interface EventPage {
  readonly events: readonly EventRow[];
  /** True when at least one further row exists beyond the last returned seq. */
  readonly hasMore: boolean;
  /** Approximate payload bytes contained in THIS page. */
  readonly approxPayloadBytes: number;
}

export function listEventPageForExecution(db: DatabaseSync, input: ListEventPageInput): EventPage {
  const value = ListEventPageInputSchema.parse(input);
  const rows = db
    .prepare(
      "SELECT * FROM events WHERE execution_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
    )
    .all(value.executionId, value.afterSeq, value.limit);
  const events: EventRow[] = [];
  let bytes = 0;
  let lastSeq = value.afterSeq;
  for (const row of rows) {
    const event = mapEventRow(row as Record<string, unknown>);
    const rowBytes = Buffer.byteLength(event.payload, "utf8");
    // Progress guarantee: the first row always fits, whatever its size.
    if (events.length > 0 && bytes + rowBytes > value.byteBudget) break;
    events.push(event);
    bytes += rowBytes;
    lastSeq = event.seq;
  }
  const moreRow = db
    .prepare("SELECT 1 AS more FROM events WHERE execution_id = ? AND seq > ? LIMIT 1")
    .get(value.executionId, lastSeq);
  return {
    events,
    hasMore: moreRow !== undefined,
    approxPayloadBytes: bytes
  };
}

/** Recompute checksums of stored events; returns the ids of mismatching rows. */
export function verifyEventChecksums(db: DatabaseSync): readonly string[] {
  const rows = db.prepare("SELECT * FROM events ORDER BY execution_id ASC, seq ASC").all();
  const mismatches: string[] = [];
  for (const row of rows) {
    const event = mapEventRow(row);
    if (eventChecksum(event.executionId, event.seq, event.type, event.payload) !== event.checksum) {
      mismatches.push(event.id);
    }
  }
  return mismatches;
}
