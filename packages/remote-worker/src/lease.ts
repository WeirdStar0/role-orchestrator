/**
 * The control-plane lease authority for remote worker slots (M7-03).
 *
 * REUSE, not re-invention: the lease rows live in a real @role-orchestrator/store
 * database (`claimLease` / `releaseLease` / `releaseExpiredLeases`), so the
 * semantics under simulation are the shipped ones:
 *
 * - at most one LIVE lease per `resourceKey` (partial unique index);
 * - `fencing_token` is monotonic per resource (MAX(existing)+1 at claim);
 * - an expired lease is NEVER stolen automatically — "超时只代表需 reconcile":
 *   a claim on a key whose (expired) lease was not yet released returns
 *   `needs-reconcile`, and only the explicit `releaseExpiredLeases` step
 *   frees the slot;
 *
 * Plus the protocol-level fencing check the store leaves to callers
 * (`validateWriteBack`): a worker write-back is accepted only when the
 * presented token belongs to the CURRENT live lease AND the lease has not
 * expired. The three refusals map 1:1 to the distributed-systems failure the
 * remote worker adds:
 * - `no-live-lease`  — the slot was reconciled/released: any late write is a
 *                      zombie's, refused outright;
 * - `stale-token`    — the slot was RE-LEASED (a newer attempt owns it): the
 *                      old holder's write must never land;
 * - `lease-expired`  — the holder overstayed its TTL: its writes are refused
 *                      AND the slot stays blocked until explicit reconcile
 *                      (we do not know what the worker did in the meantime —
 *                      that is exactly the A22 posture).
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  claimLease,
  listLiveLeases,
  releaseExpiredLeases,
  releaseLease,
  TimestampSchema,
  type LeaseClaimResult,
  type LeaseRow
} from "@role-orchestrator/store";
import { IdSchema } from "@role-orchestrator/contracts";
import { FencingRejectedError, type FencingRejectReason } from "./errors.js";

const ResourceKeySchema = z.string().regex(/^[a-z][a-z0-9:._-]{0,127}$/, {
  message: "resourceKey must match ^[a-z][a-z0-9:._-]{0,127}$"
});

const ClaimInputSchema = z
  .strictObject({
    leaseId: IdSchema,
    executionId: IdSchema,
    resourceKey: ResourceKeySchema,
    expiresAt: TimestampSchema,
    now: TimestampSchema
  })
  .refine((value) => value.expiresAt > value.now, {
    message: "expiresAt must be after now",
    path: ["expiresAt"]
  });

export type AuthorityClaimInput = z.input<typeof ClaimInputSchema>;

const WriteBackInputSchema = z.strictObject({
  resourceKey: ResourceKeySchema,
  fencingToken: z.number().int().min(1),
  now: TimestampSchema
});

export type WriteBackInput = z.input<typeof WriteBackInputSchema>;

export interface WriteBackVerdict {
  readonly ok: true;
  readonly lease: LeaseRow;
}

export class WorkerLeaseAuthority {
  constructor(private readonly db: DatabaseSync) {}

  /** Claim the slot for an execution. Passes through the store's `held` / `needs-reconcile` refusals. */
  claim(input: AuthorityClaimInput): LeaseClaimResult {
    const value = ClaimInputSchema.parse(input);
    return claimLease(this.db, {
      id: value.leaseId,
      executionId: value.executionId,
      resourceKey: value.resourceKey,
      expiresAt: value.expiresAt,
      now: value.now
    });
  }

  /** The explicit reconcile step (the ONLY path that frees an expired lease). Returns rows released. */
  reconcileExpired(now: string): number {
    return releaseExpiredLeases(this.db, { now: TimestampSchema.parse(now) });
  }

  /** Explicit release of a live lease (the happy-path terminal hand-back). */
  release(leaseId: string, now: string): boolean {
    return releaseLease(this.db, { id: IdSchema.parse(leaseId), now: TimestampSchema.parse(now) });
  }

  liveLease(resourceKey: string): LeaseRow | null {
    const key = ResourceKeySchema.parse(resourceKey);
    const live = listLiveLeases(this.db).find((lease) => lease.resourceKey === key);
    return live ?? null;
  }

  /**
   * THE fencing check every state-bearing worker write-back must pass before
   * the session applies it. Throws `FencingRejectedError` with the exact
   * refusal reason; returns the live lease on success.
   */
  validateWriteBack(input: WriteBackInput): WriteBackVerdict {
    const value = WriteBackInputSchema.parse(input);
    const lease = this.liveLease(value.resourceKey);
    if (lease === null) {
      throw this.refusal("no-live-lease", value.resourceKey, value.fencingToken, null);
    }
    if (lease.fencingToken !== value.fencingToken) {
      throw this.refusal("stale-token", value.resourceKey, value.fencingToken, lease.fencingToken);
    }
    if (value.now >= lease.expiresAt) {
      // Expired-but-not-released: the store keeps the slot occupied (timeout
      // alone never frees it) and the overstay holder loses write authority.
      throw this.refusal("lease-expired", value.resourceKey, value.fencingToken, lease.fencingToken);
    }
    return { ok: true, lease };
  }

  private refusal(
    reason: FencingRejectReason,
    resourceKey: string,
    presentedToken: number,
    currentToken: number | null
  ): FencingRejectedError {
    return new FencingRejectedError(reason, resourceKey, presentedToken, currentToken);
  }
}
