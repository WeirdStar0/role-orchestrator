import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { JsonRecordSchema } from "../json.js";
import { NoRowUpdatedError } from "../errors.js";
import { withTransaction } from "../transactions.js";
import { TimestampSchema } from "../time.js";

/**
 * Transactional outbox (ADR 005): business writes and their outbound
 * messages commit in the SAME transaction — `enqueueOutboxMessage` takes the
 * connection inside a `withTransaction` block and joins it. Dispatch uses
 * lease semantics: a claim sets `claim_token` + `claim_expires_at`; expired
 * claims (crashed dispatchers) become claimable again, so delivery is
 * at-least-once and receivers dedup by message id.
 */
export interface OutboxMessageRow {
  readonly id: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: string;
  readonly attempts: number;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export type EnqueueResult = "stored" | "duplicate";

const EnqueueOutboxMessageInputSchema = z.strictObject({
  id: IdSchema,
  aggregateId: z.string().min(1).max(128),
  type: z.string().min(1).max(128),
  payload: JsonRecordSchema,
  now: TimestampSchema
});

export type EnqueueOutboxMessageInput = z.input<typeof EnqueueOutboxMessageInputSchema>;

/**
 * Enqueue a message on the CURRENT connection — call this inside the same
 * `withTransaction` block as the business write so both commit atomically.
 * Duplicate message ids are absorbed ("duplicate") for idempotent producers.
 */
export function enqueueOutboxMessage(
  db: DatabaseSync,
  input: EnqueueOutboxMessageInput
): EnqueueResult {
  const value = EnqueueOutboxMessageInputSchema.parse(input);
  const result = db
    .prepare(
      "INSERT INTO outbox(id, aggregate_id, type, payload, attempts, claim_token, claim_expires_at, published_at, created_at) VALUES (?, ?, ?, ?, 0, NULL, NULL, NULL, ?) ON CONFLICT(id) DO NOTHING"
    )
    .run(value.id, value.aggregateId, value.type, JSON.stringify(value.payload), value.now);
  return Number(result.changes) === 1 ? "stored" : "duplicate";
}

const ClaimOutboxMessagesInputSchema = z.strictObject({
  claimToken: z.string().min(1).max(128),
  now: TimestampSchema,
  leaseMs: z.number().int().min(1).max(86_400_000),
  limit: z.number().int().min(1).max(1000).default(100)
});

export type ClaimOutboxMessagesInput = z.input<typeof ClaimOutboxMessagesInputSchema>;

/**
 * Claim up to `limit` dispatchable messages (unpublished AND unclaimed or
 * claim-expired) with lease semantics, inside one `BEGIN IMMEDIATE`
 * transaction. Two dispatchers therefore never hold the same message: they
 * serialize on the write lock and the second sees the fresh claim.
 */
export function claimOutboxMessages(
  db: DatabaseSync,
  input: ClaimOutboxMessagesInput
): readonly OutboxMessageRow[] {
  const value = ClaimOutboxMessagesInputSchema.parse(input);
  const expiresAt = new Date(Date.parse(value.now) + value.leaseMs).toISOString();
  return withTransaction(db, () => {
    const candidates = db
      .prepare(
        "SELECT id FROM outbox WHERE published_at IS NULL AND (claim_token IS NULL OR claim_expires_at <= ?) ORDER BY created_at ASC, id ASC LIMIT ?"
      )
      .all(value.now, value.limit);
    const claimed: OutboxMessageRow[] = [];
    for (const candidate of candidates) {
      const id = String(candidate.id);
      // Re-check in the UPDATE: cheap belt-and-braces even though
      // BEGIN IMMEDIATE already excludes concurrent writers.
      const update = db
        .prepare(
          "UPDATE outbox SET claim_token = ?, claim_expires_at = ?, attempts = attempts + 1 WHERE id = ? AND published_at IS NULL AND (claim_token IS NULL OR claim_expires_at <= ?)"
        )
        .run(value.claimToken, expiresAt, id, value.now);
      if (Number(update.changes) === 1) {
        const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
        if (row !== undefined) {
          claimed.push(mapOutboxRow(row));
        }
      }
    }
    return claimed;
  });
}

const CompleteOutboxMessageInputSchema = z.strictObject({
  id: IdSchema,
  claimToken: z.string().min(1).max(128),
  now: TimestampSchema
});

export type CompleteOutboxMessageInput = z.input<typeof CompleteOutboxMessageInputSchema>;

/**
 * Mark a claimed message published. Only the CURRENT claim token succeeds:
 * a stale token (message was reclaimed after lease expiry) returns false, so
 * a zombie dispatcher can never mask a redelivery.
 */
export function completeOutboxMessage(
  db: DatabaseSync,
  input: CompleteOutboxMessageInput
): boolean {
  const value = CompleteOutboxMessageInputSchema.parse(input);
  const result = db
    .prepare(
      "UPDATE outbox SET published_at = ?, claim_token = NULL, claim_expires_at = NULL WHERE id = ? AND claim_token = ? AND published_at IS NULL"
    )
    .run(value.now, value.id, value.claimToken);
  return Number(result.changes) === 1;
}

/** Return a claimed message to the pending queue (dispatcher-side failure/NAK). */
export function releaseOutboxClaim(
  db: DatabaseSync,
  input: { readonly id: string; readonly claimToken: string }
): boolean {
  const parsed = z
    .strictObject({ id: IdSchema, claimToken: z.string().min(1).max(128) })
    .parse(input);
  const result = db
    .prepare(
      "UPDATE outbox SET claim_token = NULL, claim_expires_at = NULL WHERE id = ? AND claim_token = ? AND published_at IS NULL"
    )
    .run(parsed.id, parsed.claimToken);
  return Number(result.changes) === 1;
}

export function getOutboxMessage(db: DatabaseSync, id: string): OutboxMessageRow | null {
  const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
  return row === undefined ? null : mapOutboxRow(row);
}

export function listPendingOutboxMessages(db: DatabaseSync): readonly OutboxMessageRow[] {
  const rows = db
    .prepare("SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at ASC, id ASC")
    .all();
  return rows.map(mapOutboxRow);
}

export function countOutboxMessages(
  db: DatabaseSync,
  input: { readonly pendingOnly: boolean }
): number {
  const row = input.pendingOnly
    ? db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL").get()
    : db.prepare("SELECT COUNT(*) AS n FROM outbox").get();
  const n = row?.n;
  if (typeof n !== "number") {
    throw new NoRowUpdatedError("outbox count query returned no row");
  }
  return n;
}

function mapOutboxRow(row: Record<string, unknown>): OutboxMessageRow {
  return {
    id: String(row.id),
    aggregateId: String(row.aggregate_id),
    type: String(row.type),
    payload: String(row.payload),
    attempts: Number(row.attempts),
    claimToken: row.claim_token === null || row.claim_token === undefined ? null : String(row.claim_token),
    claimExpiresAt:
      row.claim_expires_at === null || row.claim_expires_at === undefined
        ? null
        : String(row.claim_expires_at),
    publishedAt:
      row.published_at === null || row.published_at === undefined ? null : String(row.published_at),
    createdAt: String(row.created_at)
  };
}
