import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  isUniqueViolation,
  optStr,
  reqInt,
  reqStr,
  TimestampSchema,
  withTransaction,
  type Row
} from "@role-orchestrator/store";
import { DuplicateGrantError } from "../errors.js";
import { derivedId } from "../ids.js";
import { QuotaDimensionSchema, QuotaResourceKeySchema, type QuotaDimension } from "../keys.js";

/** Deterministic grant id: one live grant per (execution, dimension), ever. */
function grantIdFor(executionId: string, dimension: QuotaDimension): string {
  return derivedId("qg", executionId, dimension);
}

/**
 * `quota_grants` (migration 004) — counted concurrency grants with fencing.
 *
 * This is the store `leases` pattern EXTENDED from "one live holder per
 * resource" to "counted live holders per resource" (the three concurrency
 * levels are counted quotas, not mutexes). What carries over unchanged:
 *
 * - every state change happens inside ONE `BEGIN IMMEDIATE` transaction
 *   (`withTransaction`), so concurrent claimants serialize on the write lock;
 * - the fencing token is derived per resource key as `MAX(existing)+1` inside
 *   that same transaction — strictly monotonic per key, usable by downstream
 *   holders to detect that they have been released/superseded;
 * - expiry never auto-steals: an expired grant still counts toward the key's
 *   live total until `releaseExpiredQuotaGrants` (the explicit reconcile step,
 *   mirroring `releaseExpiredLeases`) frees it. "超时只代表需 reconcile".
 *
 * What is new versus `leases`: the LIMIT is policy, not the table — acquire
 * counts live rows per key and grants only below the caller-provided max, and
 * the per-key `UNIQUE(resource_key, fencing_token)` index backstops the
 * no-duplicate-grant property at the constraint level.
 */

export interface QuotaGrantRow {
  readonly id: string;
  readonly executionId: string;
  readonly dimension: QuotaDimension;
  readonly resourceKey: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly grantedAt: string;
}

/** One requested slot: which hierarchical key, and its policy maximum. */
export interface QuotaSlotSpec {
  readonly dimension: QuotaDimension;
  readonly resourceKey: string;
  /** Policy maximum of LIVE grants for this key, inclusive. 1..64. */
  readonly max: number;
}

export type QuotaAcquisitionResult =
  | { readonly granted: true; readonly grants: readonly QuotaGrantRow[] }
  | {
      readonly granted: false;
      readonly reason: "quota-full";
      /** The FIRST dimension that was full (acquisition stops there). */
      readonly blockedBy: QuotaBlockedBy;
    };

/** What blocked a quota acquisition: the full key, its policy max, and how many live grants (including expired-but-unreleased) held it. */
export interface QuotaBlockedBy {
  readonly dimension: QuotaDimension;
  readonly resourceKey: string;
  readonly max: number;
  readonly liveCount: number;
  /** Live grants past their expiry — still counting until reconciled. */
  readonly expiredHeld: number;
}

/**
 * Internal control-flow signal raised INSIDE the claim transaction when a
 * dimension is full: throwing is what rolls the whole claim (this and any
 * earlier slot's inserts) back — all-or-nothing is the point. It escapes
 * `withTransaction` deliberately; `acquireQuotaSlots` converts it into the
 * typed `quota-full` result value, and transaction-composing callers (the
 * queue poller) catch it after the rollback.
 */
export class QuotaFullSignal extends Error {
  readonly blockedBy: QuotaBlockedBy;

  constructor(blockedBy: QuotaBlockedBy) {
    super(`quota full: ${blockedBy.resourceKey} at ${String(blockedBy.liveCount)}/${String(blockedBy.max)}`);
    this.name = "QuotaFullSignal";
    this.blockedBy = blockedBy;
  }
}

const SlotSpecSchema = z.strictObject({
  dimension: QuotaDimensionSchema,
  resourceKey: QuotaResourceKeySchema,
  max: z.number().int().min(1).max(64)
});

const AcquireInputSchema = z
  .strictObject({
    executionId: IdSchema,
    /** Acquisition order = input order; callers use global -> project -> profile -> credential. */
    slots: z.array(SlotSpecSchema).min(1).max(4),
    leaseMs: z.number().int().min(1).max(86_400_000),
    now: TimestampSchema
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const slot of value.slots) {
      if (seen.has(slot.dimension)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate dimension "${slot.dimension}" in one acquisition`
        });
      }
      seen.add(slot.dimension);
    }
  });

export type AcquireQuotaSlotsInput = {
  readonly executionId: string;
  readonly slots: readonly QuotaSlotSpec[];
  readonly leaseMs: number;
  readonly now: string;
};

/**
 * The acquisition body WITHOUT opening a transaction: count live grants per
 * key -> derive the next fencing token -> insert, for every requested slot,
 * joining the CALLER'S open transaction (same composition rule as every
 * store-era entity function). Raises `QuotaFullSignal` when any dimension is
 * full — inside the caller's `withTransaction` that throw rolls back every
 * write of the claim, which is exactly the all-or-nothing property the
 * ORCHESTRATION.md section-4 claim transaction needs.
 *
 * Live counts include expired-but-unreleased grants — they still occupy
 * their slots until `releaseExpiredQuotaGrants` reconciles them.
 */
export function acquireQuotaSlotsInTransaction(
  db: DatabaseSync,
  input: AcquireQuotaSlotsInput
): readonly QuotaGrantRow[] {
  const value = AcquireInputSchema.parse({ ...input, slots: [...input.slots] });
  const expiresAt = new Date(Date.parse(value.now) + value.leaseMs).toISOString();
  const grants: QuotaGrantRow[] = [];
  for (const slot of value.slots) {
    const live = countLiveGrants(db, slot.resourceKey, value.now);
    if (live.total >= slot.max) {
      throw new QuotaFullSignal({
        dimension: slot.dimension,
        resourceKey: slot.resourceKey,
        max: slot.max,
        liveCount: live.total,
        expiredHeld: live.expired
      });
    }
    const tokenRow = db
      .prepare(
        "SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next_token FROM quota_grants WHERE resource_key = ?"
      )
      .get(slot.resourceKey);
    const fencingToken = Number(tokenRow?.next_token);
    if (!Number.isInteger(fencingToken) || fencingToken < 1) {
      throw new Error(
        `acquireQuotaSlots: could not derive fencing token for "${slot.resourceKey}"`
      );
    }
    const id = grantIdFor(value.executionId, slot.dimension);
    try {
      db.prepare(
        "INSERT INTO quota_grants(id, execution_id, dimension, resource_key, fencing_token, expires_at, released_at, granted_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, NULL, ?)"
      ).run(id, value.executionId, slot.dimension, slot.resourceKey, fencingToken, expiresAt, value.now);
    } catch (error) {
      // The deterministic grant id collides only when this execution
      // already holds a grant for the dimension (a caller bug — refused,
      // never double-counted). The (resource_key, fencing_token) unique
      // index reports via its index name and does NOT match this signature.
      if (isUniqueViolation(error, "quota_grants.id")) {
        throw new DuplicateGrantError(value.executionId, slot.dimension, { cause: error });
      }
      throw error;
    }
    grants.push({
      id,
      executionId: value.executionId,
      dimension: slot.dimension,
      resourceKey: slot.resourceKey,
      fencingToken,
      expiresAt,
      releasedAt: null,
      grantedAt: value.now
    });
  }
  return grants;
}

/**
 * All-or-nothing acquisition of one execution's quota slots, in ONE
 * transaction of its own. If ANY dimension is full the transaction rolls
 * back (zero rows persist) and the result reports which key blocked; the
 * caller simply stays where it is. For callers composing the acquisition
 * with further writes (the dispatch claim), use
 * `acquireQuotaSlotsInTransaction` inside their own `withTransaction`
 * instead.
 */
export function acquireQuotaSlots(
  db: DatabaseSync,
  input: AcquireQuotaSlotsInput
): QuotaAcquisitionResult {
  AcquireInputSchema.parse(input);
  try {
    return withTransaction(db, () => ({
      granted: true as const,
      grants: acquireQuotaSlotsInTransaction(db, input)
    }));
  } catch (error) {
    if (error instanceof QuotaFullSignal) {
      return { granted: false, reason: "quota-full", blockedBy: error.blockedBy };
    }
    throw error;
  }
}

const GrantIdSchema = z.strictObject({ id: IdSchema, now: TimestampSchema });

const NowOnlySchema = z.strictObject({ now: TimestampSchema });

/** Release one live grant. False when it was absent or already released. */
export function releaseQuotaGrant(db: DatabaseSync, input: { readonly id: string; readonly now: string }): boolean {
  const parsed = GrantIdSchema.parse(input);
  const result = db
    .prepare("UPDATE quota_grants SET released_at = ? WHERE id = ? AND released_at IS NULL")
    .run(parsed.now, parsed.id);
  return Number(result.changes) === 1;
}

const ExecutionReleaseInputSchema = z.strictObject({
  executionId: IdSchema,
  now: TimestampSchema
});

/**
 * Release every live grant of one execution — the normal completion path.
 * Returns the number of grants freed, so callers can assert the expected
 * dimensions were actually released instead of assuming.
 */
export function releaseExecutionQuotaGrants(
  db: DatabaseSync,
  input: { readonly executionId: string; readonly now: string }
): number {
  const parsed = ExecutionReleaseInputSchema.parse(input);
  const result = db
    .prepare("UPDATE quota_grants SET released_at = ? WHERE execution_id = ? AND released_at IS NULL")
    .run(parsed.now, parsed.executionId);
  return Number(result.changes);
}

/**
 * The explicit reconcile step: release every grant whose expiry has passed,
 * across all keys. The ONLY path that frees an expired grant — expiry alone
 * never does. Returns the number of grants released.
 */
export function releaseExpiredQuotaGrants(db: DatabaseSync, input: { readonly now: string }): number {
  const parsed = NowOnlySchema.parse(input);
  const result = db
    .prepare("UPDATE quota_grants SET released_at = ? WHERE released_at IS NULL AND expires_at <= ?")
    .run(parsed.now, parsed.now);
  return Number(result.changes);
}

export function getQuotaGrant(db: DatabaseSync, id: string): QuotaGrantRow | null {
  const row = db.prepare("SELECT * FROM quota_grants WHERE id = ?").get(IdSchema.parse(id));
  return row === undefined ? null : mapGrantRow(row);
}

export function listExecutionQuotaGrants(db: DatabaseSync, executionId: string): readonly QuotaGrantRow[] {
  const rows = db
    .prepare("SELECT * FROM quota_grants WHERE execution_id = ? ORDER BY fencing_token ASC")
    .all(IdSchema.parse(executionId));
  return rows.map(mapGrantRow);
}

export function listQuotaGrants(db: DatabaseSync, options: { readonly liveOnly?: boolean } = {}): readonly QuotaGrantRow[] {
  const rows =
    options.liveOnly === true
      ? db.prepare("SELECT * FROM quota_grants WHERE released_at IS NULL ORDER BY resource_key ASC, fencing_token ASC").all()
      : db.prepare("SELECT * FROM quota_grants ORDER BY resource_key ASC, fencing_token ASC").all();
  return rows.map(mapGrantRow);
}

export interface LiveGrantCount {
  readonly total: number;
  /** Of `total`: grants past `expiresAt` — still held until reconciled. */
  readonly expired: number;
}

function countLiveGrants(db: DatabaseSync, resourceKey: string, now?: string): LiveGrantCount {
  if (now === undefined) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM quota_grants WHERE resource_key = ? AND released_at IS NULL")
      .get(resourceKey);
    return { total: Number(row?.n), expired: 0 };
  }
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired " +
        "FROM quota_grants WHERE resource_key = ? AND released_at IS NULL"
    )
    .get(now, resourceKey);
  return { total: Number(row?.n), expired: Number(row?.expired) };
}

/**
 * Live-grant census per key, with the expired breakdown measured against a
 * reference `now`. Read-only; used by monitors, tests and the queue poller's
 * reconcile bookkeeping.
 */
export function countLiveQuotaGrants(
  db: DatabaseSync,
  input: { readonly resourceKey: string; readonly now?: string }
): LiveGrantCount {
  const resourceKey = QuotaResourceKeySchema.parse(input.resourceKey);
  if (input.now !== undefined) {
    TimestampSchema.parse(input.now);
  }
  return countLiveGrants(db, resourceKey, input.now);
}

function mapGrantRow(row: Row): QuotaGrantRow {
  return {
    id: reqStr(row, "id"),
    executionId: reqStr(row, "execution_id"),
    dimension: QuotaDimensionSchema.parse(reqStr(row, "dimension")),
    resourceKey: QuotaResourceKeySchema.parse(reqStr(row, "resource_key")),
    fencingToken: reqInt(row, "fencing_token"),
    expiresAt: reqStr(row, "expires_at"),
    releasedAt: optStr(row, "released_at"),
    grantedAt: reqStr(row, "granted_at")
  };
}
