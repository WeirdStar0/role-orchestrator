import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { NoRowUpdatedError } from "../errors.js";
import { withTransaction } from "../transactions.js";
import type { Row } from "../rows.js";
import { optStr, reqInt, reqStr } from "../rows.js";
import { TimestampSchema } from "../time.js";

/**
 * Resource leases (DOMAIN_MODEL `ResourceLease`): at most one LIVE lease per
 * `resource_key` (partial unique index on unreleased rows), a per-resource
 * monotonic `fencing_token` so stale holders are detectable, and — critically
 * — an expired lease is NOT stolen automatically: per DOMAIN_MODEL, "超时只
 * 代表需 reconcile". A caller must first reconcile the holder and then
 * explicitly release (`releaseLease` / `releaseExpiredLeases`) before the
 * slot can be claimed again.
 */
export interface LeaseRow {
  readonly id: string;
  readonly executionId: string;
  readonly resourceKey: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly createdAt: string;
}

export type LeaseClaimResult =
  | { readonly granted: true; readonly lease: LeaseRow }
  | { readonly granted: false; readonly reason: "held" | "needs-reconcile" };

const ClaimLeaseInputSchema = z
  .strictObject({
    id: IdSchema,
    executionId: IdSchema,
    resourceKey: z.string().min(1).max(256),
    expiresAt: TimestampSchema,
    now: TimestampSchema
  })
  .refine((value) => value.expiresAt > value.now, {
    message: "expiresAt must be after now",
    path: ["expiresAt"]
  });

export type ClaimLeaseInput = z.input<typeof ClaimLeaseInputSchema>;

/**
 * Claim a resource lease inside one `BEGIN IMMEDIATE` transaction:
 * check for a live lease on the key -> insert with fencing token
 * `max(existing) + 1` -> commit. Concurrent claimants serialize on the write
 * lock; the unique index is the backstop, so exactly one claimant wins even
 * across processes.
 */
export function claimLease(db: DatabaseSync, input: ClaimLeaseInput): LeaseClaimResult {
  const value = ClaimLeaseInputSchema.parse(input);
  return withTransaction(db, () => {
    const live = db
      .prepare("SELECT id, expires_at FROM leases WHERE resource_key = ? AND released_at IS NULL")
      .get(value.resourceKey);
    if (live !== undefined) {
      return {
        granted: false as const,
        reason: String(live.expires_at) > value.now ? ("held" as const) : ("needs-reconcile" as const)
      };
    }
    const fencingRow = db
      .prepare(
        "SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next_token FROM leases WHERE resource_key = ?"
      )
      .get(value.resourceKey);
    const fencingToken = Number(fencingRow?.next_token);
    if (!Number.isInteger(fencingToken) || fencingToken < 1) {
      throw new Error(`claimLease: could not derive fencing token for "${value.resourceKey}"`);
    }
    db.prepare(
      "INSERT INTO leases(id, execution_id, resource_key, fencing_token, expires_at, released_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).run(value.id, value.executionId, value.resourceKey, fencingToken, value.expiresAt, value.now);
    return {
      granted: true as const,
      lease: {
        id: value.id,
        executionId: value.executionId,
        resourceKey: value.resourceKey,
        fencingToken,
        expiresAt: value.expiresAt,
        releasedAt: null,
        createdAt: value.now
      }
    };
  });
}

function mapLeaseRow(row: Row): LeaseRow {
  return {
    id: reqStr(row, "id"),
    executionId: reqStr(row, "execution_id"),
    resourceKey: reqStr(row, "resource_key"),
    fencingToken: reqInt(row, "fencing_token"),
    expiresAt: reqStr(row, "expires_at"),
    releasedAt: optStr(row, "released_at"),
    createdAt: reqStr(row, "created_at")
  };
}

/** Release a live lease. Returns false when the lease was absent or already released. */
export function releaseLease(
  db: DatabaseSync,
  input: { readonly id: string; readonly now: string }
): boolean {
  const parsed = z.strictObject({ id: IdSchema, now: TimestampSchema }).parse(input);
  const result = db
    .prepare("UPDATE leases SET released_at = ? WHERE id = ? AND released_at IS NULL")
    .run(parsed.now, parsed.id);
  return Number(result.changes) === 1;
}

/**
 * The explicit reconcile step: release every lease whose expiry has passed.
 * This is the ONLY path that frees an expired lease (timeout alone never
 * does); returns the number of leases released.
 */
export function releaseExpiredLeases(
  db: DatabaseSync,
  input: { readonly now: string }
): number {
  const parsed = z.strictObject({ now: TimestampSchema }).parse(input);
  const result = db
    .prepare("UPDATE leases SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?")
    .run(parsed.now, parsed.now);
  return Number(result.changes);
}

export function getLease(db: DatabaseSync, id: string): LeaseRow | null {
  const row = db.prepare("SELECT * FROM leases WHERE id = ?").get(id);
  return row === undefined ? null : mapLeaseRow(row);
}

export function listLiveLeases(db: DatabaseSync): readonly LeaseRow[] {
  const rows = db
    .prepare("SELECT * FROM leases WHERE released_at IS NULL ORDER BY resource_key ASC")
    .all();
  return rows.map(mapLeaseRow);
}

export function requireLease(db: DatabaseSync, id: string): LeaseRow {
  const lease = getLease(db, id);
  if (lease === null) {
    throw new NoRowUpdatedError(`lease "${id}" does not exist`);
  }
  return lease;
}
