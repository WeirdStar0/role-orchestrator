/**
 * Write paths for shared memory (M3-02): proposals, verification, USER-only
 * promotion, dispute, CAS updates and temporary expiry — the lifecycle of
 * `docs/MEMORY_AND_CONTEXT.md` with the A14 compare-and-swap contract.
 *
 * Every state change is a (memoryId, expectedVersion) compare-and-swap inside
 * one `BEGIN IMMEDIATE` transaction: the version is re-checked in the UPDATE
 * WHERE clause, so a lost race dies with `MemoryCasConflictError` (carrying
 * the current version and the current content digest) instead of silently
 * overwriting. The refusal itself is audited (`cas-conflict` event) in a
 * follow-up transaction — visible, never destructive.
 *
 * Authorization order in EVERY transition: (1) actor gate, (2) semantic
 * guards, (3) CAS, (4) write + audit. Role-type permissions come from the
 * frozen 可提交者 matrix of docs section 2; `project_rule` promotion and
 * active-rule edits go ONLY through the user actor of the explicit entry
 * point — memory CONTENT is never consulted for any authorization decision
 * (A16: content is data).
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Row } from "@role-orchestrator/store";
import { isUniqueViolation, withTransaction } from "@role-orchestrator/store";
import type { RoleId } from "@role-orchestrator/contracts";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  DuplicateMemoryError,
  MemoryEvidenceRequiredError,
  MemoryLifecycleError,
  MemoryUserRequiredError,
  MemoryCasConflictError,
  MemoryWriteRefusedError,
  UnknownMemoryError,
  UnknownMemoryProjectError
} from "./errors.js";
import { memoryContentHash } from "./hashing.js";
import { findMemoryRow } from "./queries.js";
import {
  MemoryActorSchema,
  MemoryContentSchema,
  MemoryEvidenceRefsSchema,
  MemoryTypeSchema,
  LIVE_MEMORY_STATUSES,
  PROJECT_RULE_PROMOTION_ENTRY,
  ExpectedVersionSchema,
  TimestampSchema,
  actorLabel,
  canPropose,
  requiresEvidence,
  VERIFIER_ROLES,
  type MemoryActor,
  type MemoryRecord
} from "./types.js";

const LIVE_STATUS_SQL = "('proposed', 'verified', 'active')";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** An audited refusal detected inside the (rolled-back) transition transaction. */
type TransitionRefusal =
  | {
      readonly kind: "cas-conflict";
      readonly record: MemoryRecord;
      readonly expectedVersion: number;
      readonly attemptedBy: string;
      readonly action: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "user-required";
      readonly record: MemoryRecord;
      readonly attemptedBy: string;
      readonly action: string;
      readonly occurredAt: string;
    };

interface TransitionOutcome {
  readonly record: MemoryRecord;
  readonly refusal: TransitionRefusal | null;
}

function casRefusal(
  record: MemoryRecord,
  expectedVersion: number,
  actor: MemoryActor,
  action: string,
  occurredAt: string
): TransitionRefusal {
  return {
    kind: "cas-conflict",
    record,
    expectedVersion,
    attemptedBy: actorLabel(actor),
    action,
    occurredAt
  };
}

/**
 * Audit a refusal in its OWN committed transaction (the transition
 * transaction rolled back, so this is where the trail survives) and raise
 * the typed error. Refusals are visible facts (A14: CAS 冲突可见), not noise.
 */
function refuse(db: DatabaseSync, refusal: TransitionRefusal): never {
  withTransaction(db, () => {
    appendEvent(db, {
      memoryId: refusal.record.id,
      projectId: refusal.record.projectId,
      type: refusal.kind === "cas-conflict" ? "cas-conflict" : "promotion-rejected",
      actor: refusal.attemptedBy,
      payload:
        refusal.kind === "cas-conflict"
          ? {
              action: refusal.action,
              expectedVersion: refusal.expectedVersion,
              observedVersion: refusal.record.version
            }
          : { action: refusal.action, reason: "user-required" },
      occurredAt: refusal.occurredAt
    });
  });
  if (refusal.kind === "cas-conflict") {
    throw new MemoryCasConflictError({
      memoryId: refusal.record.id,
      expectedVersion: refusal.expectedVersion,
      currentVersion: refusal.record.version,
      currentContentDigest: memoryContentHash(refusal.record.content)
    });
  }
  throw new MemoryUserRequiredError({ memoryId: refusal.record.id, action: refusal.action });
}

function nextEventSeq(db: DatabaseSync, memoryId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM memory_events WHERE memory_id = ?")
    .get(memoryId) as { max_seq: number };
  return Number(row.max_seq) + 1;
}

interface AppendEventInput {
  readonly memoryId: string;
  readonly projectId: string;
  readonly type: "proposed" | "verified" | "promoted" | "disputed" | "updated" | "expired" | "promotion-rejected" | "cas-conflict";
  readonly actor: string;
  readonly payload: Record<string, string | number>;
  readonly occurredAt: string;
}

function appendEvent(db: DatabaseSync, input: AppendEventInput): void {
  const seq = nextEventSeq(db, input.memoryId);
  db.prepare(
    "INSERT INTO memory_events(id, memory_id, project_id, seq, type, actor, payload, occurred_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    `${input.memoryId}#${String(seq).padStart(4, "0")}`,
    input.memoryId,
    input.projectId,
    seq,
    input.type,
    input.actor,
    JSON.stringify(input.payload),
    input.occurredAt
  );
}

interface AppendRevisionInput {
  readonly memoryId: string;
  readonly version: number;
  readonly status: MemoryRecord["status"];
  readonly content: string;
  readonly contentHash: string;
  readonly transition: "propose" | "verify" | "promote" | "dispute" | "update" | "expire";
  readonly actor: string;
  readonly occurredAt: string;
}

function appendRevision(db: DatabaseSync, input: AppendRevisionInput): void {
  db.prepare(
    "INSERT INTO memory_revisions(memory_id, version, status, content, content_hash, transition, actor, occurred_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    input.memoryId,
    input.version,
    input.status,
    input.content,
    input.contentHash,
    input.transition,
    input.actor,
    input.occurredAt
  );
}

function requireProjectRow(db: DatabaseSync, projectId: string): void {
  const row = db.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(projectId) as
    | Row
    | undefined;
  if (row === undefined) {
    throw new UnknownMemoryProjectError(projectId);
  }
}

function requireRecord(
  db: DatabaseSync,
  projectId: string,
  memoryId: string
): MemoryRecord {
  const record = findMemoryRow(db, projectId, memoryId);
  if (record === null) {
    throw new UnknownMemoryError({ projectId, memoryId });
  }
  return record;
}

function isLiveStatus(status: string): boolean {
  return (LIVE_MEMORY_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

const ProposeMemoryInputSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  type: MemoryTypeSchema,
  content: MemoryContentSchema,
  evidenceRefs: MemoryEvidenceRefsSchema,
  actor: MemoryActorSchema,
  authorExecutionId: IdSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  now: TimestampSchema
});

export type ProposeMemoryInput = z.input<typeof ProposeMemoryInputSchema>;

/**
 * Submit a memory proposal: a NEW memory in status `proposed`, version 1.
 * The role-type matrix, the evidence rule (fact/decision/project_rule must
 * cite evidence) and the temporary expiry rule are enforced BEFORE any write.
 * Re-proposing identical live content (same project, type, content) ABSORBS
 * into the existing row and returns it — proposal retries are idempotent and
 * never duplicate history.
 */
export function proposeMemory(db: DatabaseSync, input: ProposeMemoryInput): MemoryRecord {
  const value = ProposeMemoryInputSchema.parse(input);
  if (value.actor.kind !== "role" || value.actor.roleId === undefined) {
    throw new MemoryWriteRefusedError({
      actorKind: value.actor.kind,
      type: value.type,
      detail:
        "proposals are submitted by roles; the operator's authority is the promotion entry point, not proposal"
    });
  }
  const roleId: RoleId = value.actor.roleId;
  if (!canPropose(value.type, roleId)) {
    throw new MemoryWriteRefusedError({
      actorKind: "role",
      roleId,
      type: value.type,
      detail:
        "the 可提交者 matrix of docs/MEMORY_AND_CONTEXT.md section 2 does not allow this role to propose this memory type"
    });
  }
  if (requiresEvidence(value.type) && value.evidenceRefs.length < 1) {
    throw new MemoryEvidenceRequiredError(value.type);
  }
  if (value.type === "temporary") {
    if (value.expiresAt === undefined) {
      throw new MemoryLifecycleError({
        memoryId: value.id,
        detail: "temporary proposals must carry a future expiresAt (temporary is execution-scoped)"
      });
    }
    if (value.expiresAt <= value.now) {
      throw new MemoryLifecycleError({
        memoryId: value.id,
        detail: `temporary expiresAt ${value.expiresAt} must be later than now (${value.now})`
      });
    }
  } else if (value.expiresAt !== undefined) {
    throw new MemoryLifecycleError({
      memoryId: value.id,
      detail: "only temporary memories are execution-scoped; expiresAt must be omitted"
    });
  }

  const contentHash = memoryContentHash(value.content);
  const actor = value.actor;
  const label = actorLabel(actor);

  return withTransaction(db, () => {
    requireProjectRow(db, value.projectId);
    try {
      db.prepare(
        "INSERT INTO memories(id, project_id, scope, type, status, version, content, content_hash, " +
          "evidence_refs, author_execution_id, proposed_by, proposed_by_role, expires_at, created_at, updated_at) " +
          "VALUES (?, ?, 'project', ?, 'proposed', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        value.id,
        value.projectId,
        value.type,
        value.content,
        contentHash,
        JSON.stringify(value.evidenceRefs),
        value.authorExecutionId ?? null,
        label,
        roleId,
        value.expiresAt ?? null,
        value.now,
        value.now
      );
    } catch (error) {
      // SQLite reports violations of the partial unique INDEX through its
      // column list (not the index name).
      if (isUniqueViolation(error, "memories.project_id, memories.type, memories.content_hash")) {
        // Identical live content already proposed — absorb, never duplicate.
        const existing = db
          .prepare(
            `SELECT * FROM memories WHERE project_id = ? AND type = ? AND content_hash = ? ` +
              `AND status IN ${LIVE_STATUS_SQL}`
          )
          .get(value.projectId, value.type, contentHash) as Row | undefined;
        if (existing !== undefined) {
          return requireRecord(db, value.projectId, String(existing["id"]));
        }
        throw error;
      }
      if (isUniqueViolation(error, "memories.id")) {
        const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(value.id) as
          | Row
          | undefined;
        if (
          existing !== undefined &&
          String(existing["project_id"]) === value.projectId &&
          String(existing["type"]) === value.type &&
          String(existing["content_hash"]) === contentHash &&
          isLiveStatus(String(existing["status"]))
        ) {
          return requireRecord(db, value.projectId, value.id);
        }
        throw new DuplicateMemoryError({ memoryId: value.id, existingMemoryId: value.id });
      }
      if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
        throw new UnknownMemoryProjectError(value.projectId);
      }
      throw error;
    }

    appendRevision(db, {
      memoryId: value.id,
      version: 1,
      status: "proposed",
      content: value.content,
      contentHash,
      transition: "propose",
      actor: label,
      occurredAt: value.now
    });
    appendEvent(db, {
      memoryId: value.id,
      projectId: value.projectId,
      type: "proposed",
      actor: label,
      payload: {
        type: value.type,
        evidenceRefCount: value.evidenceRefs.length,
        authorExecutionId: value.authorExecutionId ?? "(none)",
        expiresAt: value.expiresAt ?? "(none)"
      },
      occurredAt: value.now
    });
    return requireRecord(db, value.projectId, value.id);
  });
}

// ---------------------------------------------------------------------------
// Verify (proposed -> verified)
// ---------------------------------------------------------------------------

const VerifyMemoryInputSchema = z.strictObject({
  projectId: IdSchema,
  memoryId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  actor: MemoryActorSchema,
  now: TimestampSchema
});

export type VerifyMemoryInput = z.input<typeof VerifyMemoryInputSchema>;

/**
 * Verify a proposed memory (proposed -> verified, CAS via expectedVersion).
 * Verification duty sits with reviewer/architect/coordinator; the proposing
 * role cannot verify its own proposal (不自审自批). temporary memories are
 * execution-scoped and never enter the verified chain.
 */
export function verifyMemory(db: DatabaseSync, input: VerifyMemoryInput): MemoryRecord {
  const value = VerifyMemoryInputSchema.parse(input);
  if (value.actor.kind !== "role" || value.actor.roleId === undefined) {
    throw new MemoryWriteRefusedError({
      actorKind: value.actor.kind,
      detail: "verification is role work; the operator's authority is the promotion entry point"
    });
  }
  const roleId: RoleId = value.actor.roleId;
  const label = actorLabel(value.actor);

  const outcome = withTransaction(db, (): TransitionOutcome => {
    const record = requireRecord(db, value.projectId, value.memoryId);
    if (!VERIFIER_ROLES.includes(roleId)) {
      throw new MemoryWriteRefusedError({
        actorKind: "role",
        roleId,
        type: record.type,
        detail: `verification duty sits with ${VERIFIER_ROLES.join("/")}`
      });
    }
    if (roleId === record.proposedByRole) {
      throw new MemoryWriteRefusedError({
        actorKind: "role",
        roleId,
        type: record.type,
        detail: "the proposing role cannot verify its own proposal (不自审自批)"
      });
    }
    if (record.type === "temporary") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        detail: "temporary memories are execution-scoped and are never verified"
      });
    }
    if (record.status !== "proposed") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        to: "verified",
        detail: "only a proposed memory can be verified; a disputed one must be re-proposed"
      });
    }
    if (record.version !== value.expectedVersion) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "verify", value.now) };
    }
    const applied = db
      .prepare(
        "UPDATE memories SET status = 'verified', verified_by = ?, verified_at = ?, version = version + 1, " +
          "updated_at = ? WHERE id = ? AND project_id = ? AND version = ?"
      )
      .run(label, value.now, value.now, record.id, record.projectId, value.expectedVersion);
    if (Number(applied.changes) !== 1) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "verify", value.now) };
    }
    appendRevision(db, {
      memoryId: record.id,
      version: record.version + 1,
      status: "verified",
      content: record.content,
      contentHash: record.contentHash,
      transition: "verify",
      actor: label,
      occurredAt: value.now
    });
    appendEvent(db, {
      memoryId: record.id,
      projectId: record.projectId,
      type: "verified",
      actor: label,
      payload: { verifiedBy: roleId, fromVersion: record.version },
      occurredAt: value.now
    });
    return { record: requireRecord(db, record.projectId, record.id), refusal: null };
  });

  if (outcome.refusal !== null) {
    refuse(db, outcome.refusal);
  }
  return outcome.record;
}

// ---------------------------------------------------------------------------
// Promote (verified -> active; project_rule ONLY; USER actor ONLY)
// ---------------------------------------------------------------------------

const PromoteProjectRuleInputSchema = z.strictObject({
  projectId: IdSchema,
  memoryId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  actor: MemoryActorSchema,
  now: TimestampSchema
});

export type PromoteProjectRuleInput = z.input<typeof PromoteProjectRuleInputSchema>;

/**
 * THE promotion entry point (docs section 2: 只有用户可以提升为 active 规则).
 * Accepts ONLY a `user` actor — the human operator identity carried in the
 * call, recorded verbatim in promoted_by/promoted_via/promoted_at and in the
 * `promoted` audit event. A role actor — or instruction text inside memory
 * content claiming authority — never reaches the state machine: the attempt
 * is audited (`promotion-rejected`) and refused with `MemoryUserRequiredError`.
 * Only a VERIFIED project_rule promotes; proposed cannot jump to active, and
 * no other type reaches active at all (CHECK-enforced in migration 008).
 */
export function promoteProjectRule(db: DatabaseSync, input: PromoteProjectRuleInput): MemoryRecord {
  const value = PromoteProjectRuleInputSchema.parse(input);

  const outcome = withTransaction(db, (): TransitionOutcome => {
    const record = requireRecord(db, value.projectId, value.memoryId);
    if (value.actor.kind !== "user") {
      return {
        record,
        refusal: {
          kind: "user-required",
          record,
          attemptedBy: actorLabel(value.actor),
          action: "promote",
          occurredAt: value.now
        }
      };
    }
    const label = actorLabel(value.actor);
    if (record.type !== "project_rule") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        to: "active",
        detail: "only project_rule can be promoted to active"
      });
    }
    if (record.status !== "verified") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        to: "active",
        detail:
          "promotion requires the verified state; a proposed rule cannot jump to active, a disputed one must be re-proposed and re-verified"
      });
    }
    if (record.version !== value.expectedVersion) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "promote", value.now) };
    }
    const applied = db
      .prepare(
        "UPDATE memories SET status = 'active', promoted_by = ?, promoted_via = ?, promoted_at = ?, " +
          "version = version + 1, updated_at = ? WHERE id = ? AND project_id = ? AND version = ?"
      )
      .run(label, PROJECT_RULE_PROMOTION_ENTRY, value.now, value.now, record.id, record.projectId, value.expectedVersion);
    if (Number(applied.changes) !== 1) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "promote", value.now) };
    }
    appendRevision(db, {
      memoryId: record.id,
      version: record.version + 1,
      status: "active",
      content: record.content,
      contentHash: record.contentHash,
      transition: "promote",
      actor: label,
      occurredAt: value.now
    });
    appendEvent(db, {
      memoryId: record.id,
      projectId: record.projectId,
      type: "promoted",
      actor: label,
      payload: { promotedBy: label, promotedVia: PROJECT_RULE_PROMOTION_ENTRY },
      occurredAt: value.now
    });
    return { record: requireRecord(db, record.projectId, record.id), refusal: null };
  });

  if (outcome.refusal !== null) {
    refuse(db, outcome.refusal);
  }
  return outcome.record;
}

// ---------------------------------------------------------------------------
// Dispute (proposed|verified -> disputed)
// ---------------------------------------------------------------------------

const DisputeMemoryInputSchema = z.strictObject({
  projectId: IdSchema,
  memoryId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  actor: MemoryActorSchema,
  reason: z.string().trim().min(1).max(512),
  now: TimestampSchema
});

export { DisputeMemoryInputSchema };
export type DisputeMemoryInput = z.input<typeof DisputeMemoryInputSchema>;

/**
 * Raise a dispute on a proposed or verified memory (质疑态). Any of the four
 * roles — or the operator — may challenge. An ACTIVE project rule is NOT
 * disputable by roles: challenge must not silently strip a user rule; its
 * revocation is the operator's own channel (M3-03). temporary memories are
 * not disputable (they expire instead). CAS applies.
 */
export function disputeMemory(db: DatabaseSync, input: DisputeMemoryInput): MemoryRecord {
  const value = DisputeMemoryInputSchema.parse(input);
  const label = actorLabel(value.actor);

  const outcome = withTransaction(db, (): TransitionOutcome => {
    const record = requireRecord(db, value.projectId, value.memoryId);
    if (record.type === "temporary") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        detail: "temporary memories expire instead of being disputed"
      });
    }
    if (record.status !== "proposed" && record.status !== "verified") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        to: "disputed",
        detail:
          record.status === "active"
            ? "an active rule is not role-disputable; its revocation is the operator's channel (M3-03)"
            : `a ${record.status} memory cannot be disputed`
      });
    }
    if (record.version !== value.expectedVersion) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "dispute", value.now) };
    }
    const applied = db
      .prepare(
        "UPDATE memories SET status = 'disputed', disputed_by = ?, disputed_at = ?, version = version + 1, " +
          "updated_at = ? WHERE id = ? AND project_id = ? AND version = ?"
      )
      .run(label, value.now, value.now, record.id, record.projectId, value.expectedVersion);
    if (Number(applied.changes) !== 1) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "dispute", value.now) };
    }
    appendRevision(db, {
      memoryId: record.id,
      version: record.version + 1,
      status: "disputed",
      content: record.content,
      contentHash: record.contentHash,
      transition: "dispute",
      actor: label,
      occurredAt: value.now
    });
    appendEvent(db, {
      memoryId: record.id,
      projectId: record.projectId,
      type: "disputed",
      actor: label,
      payload: { reason: value.reason },
      occurredAt: value.now
    });
    return { record: requireRecord(db, record.projectId, record.id), refusal: null };
  });

  if (outcome.refusal !== null) {
    refuse(db, outcome.refusal);
  }
  return outcome.record;
}

// ---------------------------------------------------------------------------
// Update (the CAS content write; bumps version, keeps history)
// ---------------------------------------------------------------------------

const UpdateMemoryInputSchema = z
  .strictObject({
    projectId: IdSchema,
    memoryId: IdSchema,
    expectedVersion: ExpectedVersionSchema,
    actor: MemoryActorSchema,
    content: MemoryContentSchema.optional(),
    evidenceRefs: MemoryEvidenceRefsSchema.optional(),
    now: TimestampSchema
  })
  .check((ctx) => {
    if (ctx.value.content === undefined && ctx.value.evidenceRefs === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "an update must change content or evidenceRefs",
        input: ctx.value
      });
    }
  });

export type UpdateMemoryInput = z.input<typeof UpdateMemoryInputSchema>;

/**
 * Compare-and-swap update (A14): changes content and/or evidence refs,
 * bumps version, records the superseded relation (`supersedes_version` =
 * previous version) and appends the new revision — old values are retained,
 * never overwritten (docs section 3: 所有更新增加 revision，保留旧值与
 * superseded 关系).
 *
 * A content change re-opens verification: verified/disputed become proposed
 * again (old evidence does not cover new content). An ACTIVE project_rule can
 * only be edited by the user actor and stays active (the operator's authority;
 * the promotion audit trail remains). Role updates follow the same 可提交者
 * matrix as proposals. A retry with identical content/refs is a no-op that
 * returns the current record without a version bump — but still passes the
 * CAS check, so a STALE no-op retry is a visible conflict, not silence.
 */
export function updateMemory(db: DatabaseSync, input: UpdateMemoryInput): MemoryRecord {
  const value = UpdateMemoryInputSchema.parse(input);

  const outcome = withTransaction(db, (): TransitionOutcome => {
    const record = requireRecord(db, value.projectId, value.memoryId);
    if (record.status === "superseded" || record.status === "expired") {
      throw new MemoryLifecycleError({
        memoryId: record.id,
        from: record.status,
        detail: `a ${record.status} memory is terminal; propose a new memory instead`
      });
    }
    if (value.actor.kind === "role") {
      const roleId = value.actor.roleId;
      if (roleId === undefined) {
        throw new MemoryWriteRefusedError({
          actorKind: "role",
          type: record.type,
          detail: "role actors must carry roleId"
        });
      }
      if (record.type === "project_rule" && record.status === "active") {
        return {
          record,
          refusal: {
            kind: "user-required",
            record,
            attemptedBy: actorLabel(value.actor),
            action: "update-active-rule",
            occurredAt: value.now
          }
        };
      }
      if (!canPropose(record.type, roleId)) {
        throw new MemoryWriteRefusedError({
          actorKind: "role",
          roleId,
          type: record.type,
          detail: "updates are writes; the 可提交者 matrix does not allow this role to write this type"
        });
      }
    }
    if (record.version !== value.expectedVersion) {
      return { record, refusal: casRefusal(record, value.expectedVersion, value.actor, "update", value.now) };
    }

    const newContent = value.content ?? record.content;
    const newContentHash = memoryContentHash(newContent);
    const newRefs = value.evidenceRefs ?? record.evidenceRefs;
    if (newContentHash === record.contentHash && JSON.stringify(newRefs) === JSON.stringify(record.evidenceRefs)) {
      return { record, refusal: null }; // idempotent retry of an applied update
    }
    if (requiresEvidence(record.type) && newRefs.length < 1) {
      throw new MemoryEvidenceRequiredError(record.type);
    }
    const statusTo = record.status === "active" ? "active" : "proposed";
    try {
      db.prepare(
        "UPDATE memories SET content = ?, content_hash = ?, evidence_refs = ?, status = ?, " +
          "supersedes_version = ?, version = version + 1, updated_at = ? " +
          "WHERE id = ? AND project_id = ? AND version = ?"
      ).run(
        newContent,
        newContentHash,
        JSON.stringify(newRefs),
        statusTo,
        record.version,
        value.now,
        record.id,
        record.projectId,
        value.expectedVersion
      );
    } catch (error) {
      if (isUniqueViolation(error, "memories.project_id, memories.type, memories.content_hash")) {
        const other = db
          .prepare(
            `SELECT id FROM memories WHERE project_id = ? AND type = ? AND content_hash = ? ` +
              `AND status IN ${LIVE_STATUS_SQL} AND id <> ?`
          )
          .get(record.projectId, record.type, newContentHash, record.id) as Row | undefined;
        throw new DuplicateMemoryError({
          memoryId: record.id,
          existingMemoryId: String(other?.["id"] ?? "(unknown)")
        });
      }
      throw error;
    }
    appendRevision(db, {
      memoryId: record.id,
      version: record.version + 1,
      status: statusTo,
      content: newContent,
      contentHash: newContentHash,
      transition: "update",
      actor: actorLabel(value.actor),
      occurredAt: value.now
    });
    appendEvent(db, {
      memoryId: record.id,
      projectId: record.projectId,
      type: "updated",
      actor: actorLabel(value.actor),
      payload: {
        previousVersion: record.version,
        statusFrom: record.status,
        statusTo,
        supersedesVersion: record.version
      },
      occurredAt: value.now
    });
    return { record: requireRecord(db, record.projectId, record.id), refusal: null };
  });

  if (outcome.refusal !== null) {
    refuse(db, outcome.refusal);
  }
  return outcome.record;
}

// ---------------------------------------------------------------------------
// Expire (temporary sweep)
// ---------------------------------------------------------------------------

const ExpireDueTemporariesInputSchema = z.strictObject({
  projectId: IdSchema,
  now: TimestampSchema
});

export type ExpireDueTemporariesInput = z.input<typeof ExpireDueTemporariesInputSchema>;

export interface ExpireDueTemporariesResult {
  readonly expiredMemoryIds: readonly string[];
}

/**
 * Expire every due temporary memory of one project (docs section 6:
 * 过期清理). temporary proposals carry a future expiresAt; once `now` passes
 * it, the entry flips to `expired` (revision + audit event, version bumped).
 * Verified/disputed temporaries cannot exist (lifecycle guards), so the
 * sweep targets the proposed state.
 */
export function expireDueTemporaries(
  db: DatabaseSync,
  input: ExpireDueTemporariesInput
): ExpireDueTemporariesResult {
  const value = ExpireDueTemporariesInputSchema.parse(input);
  return withTransaction(db, () => {
    const rows = db
      .prepare(
        "SELECT * FROM memories WHERE project_id = ? AND type = 'temporary' AND status = 'proposed' " +
          "AND expires_at <= ? ORDER BY created_at ASC, id ASC"
      )
      .all(value.projectId, value.now) as Row[];
    const expiredMemoryIds: string[] = [];
    for (const row of rows) {
      const record = requireRecord(db, value.projectId, String(row["id"]));
      const applied = db
        .prepare(
          "UPDATE memories SET status = 'expired', version = version + 1, updated_at = ? " +
            "WHERE id = ? AND project_id = ? AND version = ?"
        )
        .run(value.now, record.id, record.projectId, record.version);
      if (Number(applied.changes) !== 1) {
        throw new MemoryLifecycleError({
          memoryId: record.id,
          from: record.status,
          to: "expired",
          detail: "expiry sweep lost a version race; re-run the sweep"
        });
      }
      appendRevision(db, {
        memoryId: record.id,
        version: record.version + 1,
        status: "expired",
        content: record.content,
        contentHash: record.contentHash,
        transition: "expire",
        actor: `system:expiry-sweep@${value.now}`,
        occurredAt: value.now
      });
      appendEvent(db, {
        memoryId: record.id,
        projectId: record.projectId,
        type: "expired",
        actor: "system:expiry-sweep",
        payload: { expiresAt: record.expiresAt ?? "(none)" },
        occurredAt: value.now
      });
      expiredMemoryIds.push(record.id);
    }
    return { expiredMemoryIds };
  });
}
