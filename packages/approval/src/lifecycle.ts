/**
 * Approval lifecycle (M4-01) — guarded, one-shot, idempotent.
 *
 * State machine (every arrow is a guarded CAS UPDATE inside one transaction,
 * the docs/DOMAIN_MODEL.md discipline — 过期或基线改变不能消费):
 *
 *   PENDING  -> APPROVED  (approve: guarded on status AND expires_at > now)
 *   PENDING  -> REJECTED  (reject)
 *   PENDING  -> EXPIRED   (sweep, or materialized lazily when touched late)
 *   APPROVED -> CONSUMED  (consume: CAS on status + digest + expiry — exactly
 *                          one winner, ever; A18)
 *
 * Creation is idempotent by the caller's idempotency key (A18 双击/重复请求):
 * the key maps to a deterministic row id, the UNIQUE index absorbs the second
 * INSERT, and the replay returns the SAME row. A replayed key with a DIFFERENT
 * action digest is refused (`IdempotencyKeyConflictError`), never absorbed.
 *
 * Consumption (A17) recomputes the actionDigest from the action PRESENTED at
 * consumption time and CAS-consumes only on an exact match with the approved
 * digest AND a live expiry — so any post-approval change (an argv element,
 * the target SHA, the baseline, the cwd, the permission increments, the
 * frozen profile revision) makes the original approval unconsumable with a
 * typed error. APPROVED rows past their expiry keep their status as evidence
 * but are refused at consumption (过期审批不可消费).
 *
 * The requester identity (run/node/attempt) is recorded all-or-nothing at
 * creation; the consuming execution id is written only by the winning CAS
 * UPDATE. Expiry comparisons use fixed-width UTC ISO strings compared
 * lexicographically (the store-wide convention).
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  TimestampSchema,
  isUniqueViolation,
  withTransaction
} from "@role-orchestrator/store";
import { derivedId } from "@role-orchestrator/scheduler";
import { actionDigest } from "./digest.js";
import {
  ActionDescriptorSchema,
  gradeRisk,
  type ActionDescriptor,
  type RiskGrade,
  type RiskReason,
  type Runtime
} from "./risk.js";
import {
  ApprovalAlreadyConsumedError,
  ApprovalDigestMismatchError,
  ApprovalError,
  ApprovalExpiredError,
  ApprovalForbiddenArgvError,
  ApprovalRecordCorruptError,
  ApprovalStateError,
  IdempotencyKeyConflictError,
  UnknownApprovalError
} from "./errors.js";

export {
  APPROVAL_MIGRATIONS,
  APPROVAL_SCHEMA_MIGRATION,
  applyApprovalMigrations,
  type ApplyApprovalMigrationsOptions
} from "./migration.js";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "CONSUMED", "REJECTED", "EXPIRED"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);

export interface ApprovalRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly actionDigest: string;
  readonly action: ActionDescriptor;
  readonly status: ApprovalStatus;
  readonly riskGrade: RiskGrade;
  readonly requiresApproval: boolean;
  readonly riskReasons: readonly RiskReason[];
  readonly runtime: Runtime;
  readonly permissionIncrements: readonly string[];
  readonly requestedBy: {
    readonly runId: string | null;
    readonly nodeId: string | null;
    readonly attempt: number | null;
  };
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly consumedByExecutionId: string | null;
  readonly consumedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawRowShape {
  [key: string]: unknown;
}

function optionalString(row: RawRowShape, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function parseJsonField(raw: string, approvalId: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ApprovalRecordCorruptError({
      approvalId,
      detail: `column ${field} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    });
  }
}

/** Strict re-validation on read: a record that cannot vouch for itself fails closed. */
function mapApprovalRow(row: RawRowShape): ApprovalRecord {
  const approvalId = String(row.id);
  const action = ActionDescriptorSchema.parse(
    parseJsonField(String(row.action), approvalId, "action")
  ) as ActionDescriptor;
  const recomputedDigest = actionDigest(action);
  const storedDigest = String(row.action_digest);
  if (recomputedDigest !== storedDigest) {
    throw new ApprovalRecordCorruptError({
      approvalId,
      detail: `stored digest ${storedDigest} does not match the recomputed digest ${recomputedDigest}`
    });
  }
  const assessment = gradeRisk(action);
  const storedReasons = parseJsonField(String(row.risk_reasons), approvalId, "risk_reasons");
  if (JSON.stringify(assessment.reasons) !== JSON.stringify(storedReasons)) {
    throw new ApprovalRecordCorruptError({
      approvalId,
      detail: "stored risk reasons disagree with the recomputed assessment"
    });
  }
  const storedGrade = parseRiskGrade(String(row.risk_grade));
  if (storedGrade !== assessment.grade) {
    throw new ApprovalRecordCorruptError({
      approvalId,
      detail: `stored risk grade ${storedGrade} disagrees with the recomputed grade ${assessment.grade}`
    });
  }
  const requiresApproval = Number(row.requires_approval);
  if (requiresApproval !== (assessment.requiresApproval ? 1 : 0)) {
    throw new ApprovalRecordCorruptError({
      approvalId,
      detail: "stored requires_approval disagrees with the recomputed assessment"
    });
  }
  const storedIncrements = z.array(z.string().min(1)).parse(
    parseJsonField(String(row.permission_increments), approvalId, "permission_increments")
  );
  if (JSON.stringify(storedIncrements) !== JSON.stringify(assessment.permissionIncrements)) {
    throw new ApprovalRecordCorruptError({
      approvalId,
      detail: "stored permission increments disagree with the recomputed assessment"
    });
  }
  const consumedByExecutionId = optionalString(row, "consumed_by_execution_id");
  return {
    id: approvalId,
    idempotencyKey: String(row.idempotency_key),
    actionDigest: storedDigest,
    action,
    status: ApprovalStatusSchema.parse(row.status),
    riskGrade: storedGrade,
    requiresApproval: requiresApproval === 1,
    riskReasons: assessment.reasons,
    runtime: action.runtime,
    permissionIncrements: storedIncrements,
    requestedBy: {
      runId: optionalString(row, "requested_by_run_id"),
      nodeId: optionalString(row, "requested_by_node_id"),
      attempt: row.requested_by_attempt === null || row.requested_by_attempt === undefined
        ? null
        : z.number().int().min(1).parse(Number(row.requested_by_attempt))
    },
    approvedBy: optionalString(row, "approved_by"),
    approvedAt: optionalString(row, "approved_at"),
    consumedByExecutionId,
    consumedAt: optionalString(row, "consumed_at"),
    rejectedBy: optionalString(row, "rejected_by"),
    rejectedAt: optionalString(row, "rejected_at"),
    rejectionReason: optionalString(row, "rejection_reason"),
    expiresAt: TimestampSchema.parse(String(row.expires_at)),
    createdAt: TimestampSchema.parse(String(row.created_at)),
    updatedAt: TimestampSchema.parse(String(row.updated_at))
  };
}

// zod enum re-parse kept local so a bad status/grade value fails closed on read.
function parseRiskGrade(value: string): RiskGrade {
  return z.enum(["low", "medium", "high"]).parse(value);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getApproval(db: DatabaseSync, approvalId: string): ApprovalRecord | null {
  const id = z.string().min(1).max(128).parse(approvalId);
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as RawRowShape | undefined;
  return row === undefined ? null : mapApprovalRow(row);
}

export function requireApproval(db: DatabaseSync, approvalId: string): ApprovalRecord {
  const record = getApproval(db, approvalId);
  if (record === null) {
    throw new UnknownApprovalError(`id "${approvalId}"`);
  }
  return record;
}

export function getApprovalByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string
): ApprovalRecord | null {
  const key = z.string().min(1).max(128).parse(idempotencyKey);
  const row = db
    .prepare("SELECT * FROM approvals WHERE idempotency_key = ?")
    .get(key) as RawRowShape | undefined;
  return row === undefined ? null : mapApprovalRow(row);
}

export function listApprovalsForRun(db: DatabaseSync, runId: string): readonly ApprovalRecord[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare("SELECT * FROM approvals WHERE requested_by_run_id = ? ORDER BY created_at ASC, id ASC")
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapApprovalRow);
}

/** Expiry is a fact about the row and the clock, independent of status. */
export function isApprovalExpired(record: ApprovalRecord, now: string): boolean {
  const checkedNow = TimestampSchema.parse(now);
  return record.expiresAt <= checkedNow;
}

// ---------------------------------------------------------------------------
// Creation (A18 idempotent) + guarded transitions
// ---------------------------------------------------------------------------

const RequestedBySchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  attempt: z.number().int().min(1)
});

const CreateApprovalInputSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  action: ActionDescriptorSchema,
  requestedBy: RequestedBySchema.optional(),
  /** TTL from `now`; 1 second .. 30 days. */
  ttlSeconds: z.number().int().min(1).max(2_592_000),
  now: TimestampSchema
});

export interface CreateApprovalInput {
  readonly idempotencyKey: string;
  readonly action: ActionDescriptor;
  readonly requestedBy?: {
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
  } | undefined;
  readonly ttlSeconds: number;
  readonly now: string;
}

export interface CreateApprovalResult {
  /** The approval row — the SAME row for a replayed idempotency key (A18). */
  readonly approval: ApprovalRecord;
  /** False when the key was a replay returning the existing row. */
  readonly created: boolean;
}

/**
 * Grade the action, then insert the PENDING row. Grading is deterministic,
 * and its result (grade, requires-approval, reasons, increments) is frozen
 * into the row and re-verified on every read.
 *
 * A18: a replayed idempotency key returns the SAME row (created=false). The
 * same key with a DIFFERENT digest is a hard error.
 */
export function createApproval(db: DatabaseSync, input: CreateApprovalInput): CreateApprovalResult {
  const value = CreateApprovalInputSchema.parse(input);
  const assessment = gradeRisk(value.action);

  const forbidden = assessment.blockedPatterns.filter(
    (pattern) => pattern.requiredControl === "forbidden"
  );
  if (forbidden.length > 0) {
    throw new ApprovalForbiddenArgvError(forbidden.map((pattern) => pattern.id));
  }

  const digest = actionDigest(value.action);
  const id = derivedId("approval", value.idempotencyKey);
  const expiresAt = new Date(Date.parse(value.now) + value.ttlSeconds * 1000).toISOString();
  const requestedBy = value.requestedBy;
  try {
    db.prepare(
      "INSERT INTO approvals(" +
        "id, idempotency_key, action_digest, action, status, risk_grade, requires_approval, " +
        "risk_reasons, runtime, argv, cwd, repo_root, base_sha, target_sha, profile_revision, " +
        "permission_increments, requested_by_run_id, requested_by_node_id, requested_by_attempt, " +
        "expires_at, created_at, updated_at" +
        ") VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      value.idempotencyKey,
      digest,
      JSON.stringify(value.action),
      assessment.grade,
      assessment.requiresApproval ? 1 : 0,
      JSON.stringify(assessment.reasons),
      value.action.runtime,
      JSON.stringify(value.action.argv),
      value.action.cwd,
      value.action.repo.root,
      value.action.repo.baseSha,
      value.action.repo.targetSha,
      value.action.profileRevision,
      JSON.stringify(assessment.permissionIncrements),
      requestedBy?.runId ?? null,
      requestedBy?.nodeId ?? null,
      requestedBy?.attempt ?? null,
      expiresAt,
      value.now,
      value.now
    );
  } catch (error) {
    if (isUniqueViolation(error, "approvals.idempotency_key") || isUniqueViolation(error, "approvals.id")) {
      return replayOrConflict(db, value.idempotencyKey, digest);
    }
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
      throw new ApprovalError(
        `approval requester run "${String(requestedBy?.runId)}" does not exist (foreign key)`,
        { cause: error }
      );
    }
    throw error;
  }
  return { approval: requireApproval(db, id), created: true };
}

/** The A18 replay path: same key -> same row; same key + different action -> typed error. */
function replayOrConflict(
  db: DatabaseSync,
  idempotencyKey: string,
  presentedDigest: string
): CreateApprovalResult {
  const existing = getApprovalByIdempotencyKey(db, idempotencyKey);
  if (existing === null) {
    // Unique violation without a readable row: a derived-id collision from a
    // different key. Practically impossible (40-hex digest), never absorbed.
    throw new ApprovalError(
      `approval id collision for idempotency key "${idempotencyKey}"; refusing to absorb`
    );
  }
  if (existing.actionDigest !== presentedDigest) {
    throw new IdempotencyKeyConflictError({
      idempotencyKey,
      existingApprovalId: existing.id,
      existingDigest: existing.actionDigest,
      presentedDigest
    });
  }
  return { approval: existing, created: false };
}

const ApproveInputSchema = z.strictObject({
  approvalId: z.string().min(1).max(128),
  approvedBy: z.string().trim().min(1).max(128),
  now: TimestampSchema
});

export interface ApproveInput {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly now: string;
}

/**
 * PENDING -> APPROVED, guarded on status AND live expiry. A user can never
 * mint a live permission from an expired request: touching an expired
 * PENDING row materializes EXPIRED (committed) and throws afterwards.
 */
export function approveApproval(db: DatabaseSync, input: ApproveInput): ApprovalRecord {
  const value = ApproveInputSchema.parse(input);
  let failure: ApprovalError | null = null;
  const approved = withTransaction(db, () => {
    const result = db
      .prepare(
        "UPDATE approvals SET status = 'APPROVED', approved_by = ?, approved_at = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'PENDING' AND expires_at > ?"
      )
      .run(value.approvedBy, value.now, value.now, value.approvalId, value.now);
    if (Number(result.changes) === 1) {
      return requireApproval(db, value.approvalId);
    }
    failure = classifyNonPending(db, value.approvalId, "PENDING", value.now);
    return null;
  });
  if (failure !== null) {
    throw failure;
  }
  return approved as ApprovalRecord;
}

const RejectInputSchema = z.strictObject({
  approvalId: z.string().min(1).max(128),
  rejectedBy: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(2000),
  now: TimestampSchema
});

export interface RejectInput {
  readonly approvalId: string;
  readonly rejectedBy: string;
  readonly reason: string;
  readonly now: string;
}

/** PENDING -> REJECTED, guarded. Terminal: a rejected approval never grants anything. */
export function rejectApproval(db: DatabaseSync, input: RejectInput): ApprovalRecord {
  const value = RejectInputSchema.parse(input);
  let failure: ApprovalError | null = null;
  const rejected = withTransaction(db, () => {
    const result = db
      .prepare(
        "UPDATE approvals SET status = 'REJECTED', rejected_by = ?, rejected_at = ?, " +
          "rejection_reason = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'PENDING'"
      )
      .run(value.rejectedBy, value.now, value.reason, value.now, value.approvalId);
    if (Number(result.changes) === 1) {
      return requireApproval(db, value.approvalId);
    }
    failure = classifyNonPending(db, value.approvalId, "PENDING", value.now);
    return null;
  });
  if (failure !== null) {
    throw failure;
  }
  return rejected as ApprovalRecord;
}

/**
 * Materialize expiry for every PENDING row whose time is up. APPROVED rows
 * are deliberately NOT rewritten: their approval evidence stays, and the
 * consumption guard refuses them after expiry regardless of status.
 */
export function expirePendingApprovals(db: DatabaseSync, input: { readonly now: string }): number {
  const now = TimestampSchema.parse(input.now);
  const result = db
    .prepare(
      "UPDATE approvals SET status = 'EXPIRED', updated_at = ? " +
        "WHERE status = 'PENDING' AND expires_at <= ?"
    )
    .run(now, now);
  return Number(result.changes);
}

const ConsumeInputSchema = z.strictObject({
  approvalId: z.string().min(1).max(128),
  action: ActionDescriptorSchema,
  consumedByExecutionId: IdSchema,
  now: TimestampSchema
});

export interface ConsumeInput {
  readonly approvalId: string;
  /** The action AS PRESENTED at consumption time; digested and compared. */
  readonly action: ActionDescriptor;
  readonly consumedByExecutionId: string;
  readonly now: string;
}

/**
 * APPROVED -> CONSUMED, the single-shot gate (A17/A18):
 *
 *   UPDATE approvals SET status='CONSUMED', consumed_by_execution_id=?, consumed_at=?
 *   WHERE id=? AND status='APPROVED' AND action_digest=? AND expires_at > ?
 *
 * The presented action is hashed NOW — any post-approval element change
 * yields a different digest and a typed `ApprovalDigestMismatchError` while
 * the approval itself stays intact (a failed attempt never burns it).
 * Under concurrency exactly one caller's UPDATE matches; the loser reads
 * CONSUMED and is rejected. The whole classify+CAS runs inside one
 * BEGIN IMMEDIATE transaction.
 */
export function consumeApproval(db: DatabaseSync, input: ConsumeInput): ApprovalRecord {
  const value = ConsumeInputSchema.parse(input);
  return withTransaction(db, () => {
    const presentedDigest = actionDigest(value.action);
    const result = db
      .prepare(
        "UPDATE approvals SET status = 'CONSUMED', consumed_by_execution_id = ?, consumed_at = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'APPROVED' AND action_digest = ? AND expires_at > ?"
      )
      .run(
        value.consumedByExecutionId,
        value.now,
        value.now,
        value.approvalId,
        presentedDigest,
        value.now
      );
    if (Number(result.changes) === 1) {
      return requireApproval(db, value.approvalId);
    }
    throw classifyFailedConsumption(db, value.approvalId, presentedDigest);
  });
}

// ---------------------------------------------------------------------------
// Failure classification (after a guarded UPDATE matched zero rows)
// ---------------------------------------------------------------------------

function classifyNonPending(
  db: DatabaseSync,
  approvalId: string,
  expectedState: string,
  now: string
): ApprovalError {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    return new UnknownApprovalError(`id "${approvalId}"`);
  }
  const status = ApprovalStatusSchema.parse(row.status);
  if (status === "PENDING" && String(row.expires_at) <= now) {
    // Touch-time materialization: the dead request becomes EXPIRED forever.
    db.prepare(
      "UPDATE approvals SET status = 'EXPIRED', updated_at = ? " +
        "WHERE id = ? AND status = 'PENDING' AND expires_at <= ?"
    ).run(now, approvalId, now);
    return new ApprovalExpiredError({ approvalId, expiredAt: String(row.expires_at) });
  }
  return new ApprovalStateError({ approvalId, expectedState, actualState: status });
}

function classifyFailedConsumption(
  db: DatabaseSync,
  approvalId: string,
  presentedDigest: string
): ApprovalError {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    return new UnknownApprovalError(`id "${approvalId}"`);
  }
  const status = ApprovalStatusSchema.parse(row.status);
  switch (status) {
    case "CONSUMED":
      return new ApprovalAlreadyConsumedError({
        approvalId,
        consumedByExecutionId: String(row.consumed_by_execution_id),
        consumedAt: String(row.consumed_at)
      });
    case "REJECTED":
    case "PENDING":
    case "EXPIRED":
      return new ApprovalStateError({ approvalId, expectedState: "APPROVED", actualState: status });
    case "APPROVED":
      break;
  }
  const approvedDigest = String(row.action_digest);
  if (approvedDigest !== presentedDigest) {
    return new ApprovalDigestMismatchError({ approvalId, approvedDigest, presentedDigest });
  }
  return new ApprovalExpiredError({ approvalId, expiredAt: String(row.expires_at) });
}
