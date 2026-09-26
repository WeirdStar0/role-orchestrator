/**
 * The approval checkpoint service (M4-02).
 *
 * Two operations, both fail-closed and transactional:
 *
 * `openApprovalCheckpoint` — the A19 node checkpoint. The CLI has ENDED
 * (refused on any active attempt: a checkpoint is never a faked mid-run
 * pause); the structured proposal is graded against the capability gate and
 * turned into a one-shot approval; the node waits (RUNNING -> WAITING_APPROVAL
 * through the dag state machine). Refusal dispositions (unverified channel,
 * unbounded runtime) write NOTHING. The whole open is idempotent by
 * (execution, proposal): a replay returns the SAME checkpoint and approval.
 *
 * `continueAfterApproval` — the bounded continuation (有限续行). Exactly one
 * new execution per checkpoint, authorized by consuming the approval:
 *
 *   frozen-snapshot read (A34) -> attempt N+1 under the A23 single-active
 *   constraint -> checkpoint CAS (WAITING -> CONTINUED) -> approval CAS
 *   consumption (actionDigest match, A17/A18) -> dispatch outbox message,
 *
 * all inside ONE transaction, so a crash or a guard failure leaves either
 * everything or nothing: the approval is never burned without its execution
 * and never bounded to two. The checkpoint path itself NEVER performs the
 * proposed action — the only place the action can be carried is the new
 * execution that consumed the approval.
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema, PermissionIdSchema, withUniqueItems } from "@role-orchestrator/contracts";
import {
  ACTIVE_ATTEMPT_PHASES,
  ATTEMPT_PHASES,
  createActiveAttempt,
  enqueueOutboxMessage,
  getExecution,
  getTaskRun,
  isUniqueViolation,
  listAttemptsForSlot,
  withTransaction,
  NoRowUpdatedError,
  TimestampSchema,
  type AttemptPhase,
  type ExecutionRow
} from "@role-orchestrator/store";
import { derivedId } from "@role-orchestrator/scheduler";
import {
  ActionDescriptorSchema,
  ApprovalAlreadyConsumedError,
  ApprovalDigestMismatchError,
  ApprovalExpiredError,
  ApprovalStateError,
  ApprovalStatusSchema,
  UnknownApprovalError,
  actionDigest,
  createApproval,
  isApprovalExpired,
  requireApproval,
  type ActionDescriptor,
  type ApprovalRecord,
  type PermissionId
} from "@role-orchestrator/approval";
import { readRunRoleProfile, requireProject, type RunRoleProfile } from "@role-orchestrator/runtime-profile";
import { getNodeState, requireNodeState, transitionNodeState } from "@role-orchestrator/dag";
import {
  CheckpointExecutionNotEndedError,
  CheckpointNodeStateError,
  CheckpointRecordCorruptError,
  CheckpointStateError,
  ContinuationApprovalAlreadyConsumedError,
  ContinuationApprovalExpiredError,
  ContinuationNotApprovedError,
  ContinuationProfileMismatchError,
  ProposalDescriptorInvalidError,
  UnknownCheckpointError,
  UnboundedRuntimeError,
  UnverifiedApprovalChannelError
} from "./errors.js";
import { decideProposalDisposition } from "./channel.js";
import {
  ActionProposalSchema,
  ProposedActionSchema,
  type ActionProposal,
  type ProposedAction,
  type Runtime
} from "./proposal.js";

export { CHECKPOINT_MIGRATIONS, CHECKPOINT_SCHEMA_MIGRATION, applyCheckpointMigrations, type ApplyCheckpointMigrationsOptions } from "./migration.js";

/** Attempt phases that are over (the complement of the store's active set). */
const TERMINAL_ATTEMPT_PHASES: readonly AttemptPhase[] = ATTEMPT_PHASES.filter(
  (phase) => !(ACTIVE_ATTEMPT_PHASES as readonly string[]).includes(phase)
);

export const CHECKPOINT_STATUSES = ["WAITING", "CONTINUED"] as const;
export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];
export const CheckpointStatusSchema = z.enum(CHECKPOINT_STATUSES);

export interface CheckpointRecord {
  readonly id: string;
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly roleId: string;
  readonly approvalId: string;
  readonly proposalId: string;
  /** The proposal exactly as extracted from the protocol event (strict). */
  readonly proposal: ActionProposal;
  /** The descriptor the system built from the proposal + run context. */
  readonly action: ActionDescriptor;
  /** sha256 over the canonical descriptor — the value the approval binds. */
  readonly actionDigest: string;
  readonly status: CheckpointStatus;
  readonly continuationExecutionId: string | null;
  readonly continuedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawRowShape {
  [key: string]: unknown;
}

function parseJsonField(raw: string, checkpointId: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CheckpointRecordCorruptError({
      checkpointId,
      detail: `column ${field} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    });
  }
}

/** Strict re-validation on read: a record that cannot vouch for itself fails closed. */
function mapCheckpointRow(row: RawRowShape): CheckpointRecord {
  const checkpointId = String(row.id);
  const proposal = ActionProposalSchema.parse(
    parseJsonField(String(row.proposal), checkpointId, "proposal")
  ) as ActionProposal;
  const action = ActionDescriptorSchema.parse(
    parseJsonField(String(row.action), checkpointId, "action")
  ) as ActionDescriptor;
  const storedDigest = String(row.action_digest);
  const recomputed = actionDigest(action);
  if (recomputed !== storedDigest) {
    throw new CheckpointRecordCorruptError({
      checkpointId,
      detail: `stored digest ${storedDigest} does not match the recomputed digest ${recomputed}`
    });
  }
  const continuationExecutionId =
    row.continuation_execution_id === null || row.continuation_execution_id === undefined
      ? null
      : String(row.continuation_execution_id);
  return {
    id: checkpointId,
    executionId: String(row.execution_id),
    runId: String(row.run_id),
    nodeId: String(row.node_id),
    attempt: z.number().int().min(1).parse(Number(row.attempt)),
    roleId: String(row.role_id),
    approvalId: String(row.approval_id),
    proposalId: proposal.proposalId,
    proposal,
    action,
    actionDigest: storedDigest,
    status: CheckpointStatusSchema.parse(row.status),
    continuationExecutionId,
    continuedAt:
      row.continued_at === null || row.continued_at === undefined
        ? null
        : TimestampSchema.parse(String(row.continued_at)),
    createdAt: TimestampSchema.parse(String(row.created_at)),
    updatedAt: TimestampSchema.parse(String(row.updated_at))
  };
}

// ---------------------------------------------------------------------------
// Proposal -> ActionDescriptor
// ---------------------------------------------------------------------------

/** The run-side context a proposal needs to become a complete descriptor. */
export interface DescriptorContext {
  readonly runtime: Runtime;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly baseSha: string;
  /** The FROZEN profile snapshot revision, in its digest string form. */
  readonly profileRevision: string;
  readonly grantedPermissions: readonly PermissionId[];
}

/**
 * Complete the proposal's action essentials into a strict ActionDescriptor.
 * Throws the typed `ProposalDescriptorInvalidError` (never a raw ZodError)
 * when the combination cannot satisfy the descriptor contract — fail-closed.
 */
export function descriptorFromProposal(
  proposal: ActionProposal,
  context: DescriptorContext
): ActionDescriptor {
  const candidate: ActionDescriptor = {
    runtime: context.runtime,
    argv: proposal.action.argv,
    cwd: context.cwd,
    repo: {
      root: context.repoRoot,
      baseSha: context.baseSha,
      targetSha: proposal.action.targetSha
    },
    profileRevision: context.profileRevision,
    requiredPermissions: proposal.action.requiredPermissions,
    grantedPermissions: context.grantedPermissions,
    dimensions: proposal.action.dimensions,
    writeScope: proposal.action.writeScope,
    requiredCapabilities: proposal.action.requiredCapabilities
  };
  const result = ActionDescriptorSchema.safeParse(candidate);
  if (!result.success) {
    throw new ProposalDescriptorInvalidError({
      proposalId: proposal.proposalId,
      cause: result.error
    });
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getCheckpoint(db: DatabaseSync, checkpointId: string): CheckpointRecord | null {
  const id = IdSchema.parse(checkpointId);
  const row = db.prepare("SELECT * FROM approval_checkpoints WHERE id = ?").get(id) as
    | RawRowShape
    | undefined;
  return row === undefined ? null : mapCheckpointRow(row);
}

export function requireCheckpoint(db: DatabaseSync, checkpointId: string): CheckpointRecord {
  const record = getCheckpoint(db, checkpointId);
  if (record === null) {
    throw new UnknownCheckpointError({ checkpointId });
  }
  return record;
}

/** All checkpoints of a run, oldest first. */
export function listCheckpointsForRun(db: DatabaseSync, runId: string): readonly CheckpointRecord[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare("SELECT * FROM approval_checkpoints WHERE run_id = ? ORDER BY created_at ASC, id ASC")
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapCheckpointRow);
}

/** The checkpoint waiting on one node, if any. */
export function getWaitingCheckpointForNode(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): CheckpointRecord | null {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const row = db
    .prepare(
      "SELECT * FROM approval_checkpoints WHERE run_id = ? AND node_id = ? AND status = 'WAITING'"
    )
    .get(runId, nodeId) as RawRowShape | undefined;
  return row === undefined ? null : mapCheckpointRow(row);
}

// ---------------------------------------------------------------------------
// openApprovalCheckpoint — the A19 node checkpoint
// ---------------------------------------------------------------------------

const OpenApprovalCheckpointInputSchema = z.strictObject({
  /** The execution that carried the proposal; MUST be in a terminal phase. */
  executionId: IdSchema,
  proposal: ActionProposalSchema,
  /** Working directory the proposed action would run in (presented verbatim). */
  cwd: z.string().min(1).max(2048),
  /** Permissions the acting role currently holds (feeds the A17 digest). */
  grantedPermissions: withUniqueItems(z.array(PermissionIdSchema).max(16)),
  /** Approval TTL from `now`; forwarded to the approval package. */
  ttlSeconds: z.number().int().min(1).max(2_592_000),
  now: TimestampSchema
});

/** Manual interface (approval-package pattern): readonly arrays at the boundary. */
export interface OpenApprovalCheckpointInput {
  readonly executionId: string;
  readonly proposal: ActionProposal;
  readonly cwd: string;
  readonly grantedPermissions: readonly PermissionId[];
  readonly ttlSeconds: number;
  readonly now: string;
}

export interface OpenApprovalCheckpointResult {
  readonly checkpoint: CheckpointRecord;
  readonly approval: ApprovalRecord;
  /** False when the (execution, proposal) pair was a replay of an open already committed. */
  readonly created: boolean;
  /** The node state AFTER the checkpoint (WAITING_APPROVAL on the success path). */
  readonly nodeState: string;
}

/**
 * Turn one ended execution's structured proposal into a waiting checkpoint.
 * See the module contract for the guarantees; the refusal dispositions of
 * `decideProposalDisposition` surface as typed errors with zero writes.
 */
export function openApprovalCheckpoint(
  db: DatabaseSync,
  input: OpenApprovalCheckpointInput
): OpenApprovalCheckpointResult {
  const value = OpenApprovalCheckpointInputSchema.parse(input);

  const execution = getExecution(db, value.executionId);
  if (execution === null) {
    throw new NoRowUpdatedError(`execution "${value.executionId}" does not exist`);
  }
  if (!(TERMINAL_ATTEMPT_PHASES as readonly string[]).includes(execution.phase)) {
    throw new CheckpointExecutionNotEndedError({
      executionId: execution.id,
      phase: execution.phase
    });
  }
  const node = requireNodeState(db, { runId: execution.runId, nodeId: execution.nodeId });
  const run = getTaskRun(db, execution.runId);
  if (run === null) {
    throw new NoRowUpdatedError(`task run "${execution.runId}" does not exist`);
  }
  // A34 read path: the descriptor binds the FROZEN snapshot revision, never
  // the current binding state.
  const frozen = readRunRoleProfile(db, { runId: execution.runId, roleId: node.roleId });
  const project = requireProject(db, run.projectId);

  const descriptor = descriptorFromProposal(value.proposal, {
    runtime: frozen.snapshot.runtime,
    cwd: value.cwd,
    repoRoot: project.repoRoot,
    baseSha: run.baseSha,
    profileRevision: String(frozen.snapshot.revision),
    grantedPermissions: value.grantedPermissions
  });

  // A19 disposition BEFORE any write: refusals leave the database untouched.
  const decision = decideProposalDisposition({
    runtime: frozen.snapshot.runtime,
    proposal: value.proposal
  });
  if (decision.disposition === "reject-unverified-channel") {
    throw new UnverifiedApprovalChannelError({
      runtime: decision.runtime,
      capabilityStatuses: decision.channel.statuses
    });
  }
  if (decision.disposition === "reject-unbounded-runtime") {
    throw new UnboundedRuntimeError({ runtime: decision.runtime });
  }

  const checkpointId = derivedId("ckpt", execution.id, value.proposal.proposalId);
  const idempotencyKey = derivedId("approval", execution.id, value.proposal.proposalId);

  return withTransaction(db, () => {
    // Re-check under the write lock: the phase check is the A19 guarantee.
    const current = getExecution(db, value.executionId);
    if (current === null || !(TERMINAL_ATTEMPT_PHASES as readonly string[]).includes(current.phase)) {
      throw new CheckpointExecutionNotEndedError({
        executionId: value.executionId,
        phase: current === null ? "(missing)" : current.phase
      });
    }

    const approvalResult = createApproval(db, {
      idempotencyKey,
      action: descriptor,
      requestedBy: {
        runId: execution.runId,
        nodeId: execution.nodeId,
        attempt: execution.attempt
      },
      ttlSeconds: value.ttlSeconds,
      now: value.now
    });

    let created = true;
    try {
      db.prepare(
        "INSERT INTO approval_checkpoints(" +
          "id, execution_id, run_id, node_id, attempt, role_id, approval_id, proposal_id, " +
          "proposal, action, action_digest, status, continuation_execution_id, continued_at, " +
          "created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', NULL, NULL, ?, ?)"
      ).run(
        checkpointId,
        execution.id,
        execution.runId,
        execution.nodeId,
        execution.attempt,
        node.roleId,
        approvalResult.approval.id,
        value.proposal.proposalId,
        JSON.stringify(value.proposal),
        JSON.stringify(descriptor),
        actionDigest(descriptor),
        value.now,
        value.now
      );
    } catch (error) {
      if (
        isUniqueViolation(error, "approval_checkpoints.execution_id, approval_checkpoints.proposal_id") ||
        isUniqueViolation(error, "approval_checkpoints.id") ||
        isUniqueViolation(error, "approval_checkpoints.approval_id")
      ) {
        created = false; // replay: the SAME checkpoint row is returned below
      } else {
        throw error;
      }
    }

    // Node semantics reuse the dag state machine: RUNNING -> WAITING_APPROVAL
    // (guarded); an already-waiting node stays waiting (second proposal of the
    // same execution); anything else is a typed refusal (rollback).
    const nodeRow = getNodeState(db, { runId: execution.runId, nodeId: execution.nodeId });
    if (nodeRow === null) {
      throw new CheckpointNodeStateError({
        runId: execution.runId,
        nodeId: execution.nodeId,
        state: "(missing)"
      });
    }
    let nodeStateAfter: string = nodeRow.state;
    if (nodeRow.state === "RUNNING") {
      transitionNodeState(db, {
        runId: execution.runId,
        nodeId: execution.nodeId,
        to: "WAITING_APPROVAL",
        whereStateIn: ["RUNNING"],
        now: value.now
      });
      nodeStateAfter = "WAITING_APPROVAL";
    } else if (nodeRow.state !== "WAITING_APPROVAL") {
      throw new CheckpointNodeStateError({
        runId: execution.runId,
        nodeId: execution.nodeId,
        state: nodeRow.state
      });
    }

    const checkpoint = requireCheckpoint(db, checkpointId);
    return { checkpoint, approval: approvalResult.approval, created, nodeState: nodeStateAfter };
  });
}

// ---------------------------------------------------------------------------
// continueAfterApproval — the bounded continuation (有限续行)
// ---------------------------------------------------------------------------

const ContinueAfterApprovalInputSchema = z.strictObject({
  checkpointId: IdSchema,
  /** The NEW execution id (fresh attempt row, fresh process, fresh worktree). */
  newExecutionId: IdSchema,
  /**
   * The action the continuation claims to carry. Defaults to the checkpoint's
   * stored descriptor; an explicitly presented action must digest-match the
   * approved one (A17) or the consumption — and therefore the whole
   * continuation — is refused with `ApprovalDigestMismatchError`.
   */
  presentedAction: ProposedActionSchema.optional(),
  now: TimestampSchema
});

/** Manual interface (approval-package pattern): readonly arrays at the boundary. */
export interface ContinueAfterApprovalInput {
  readonly checkpointId: string;
  /** The NEW execution id (fresh attempt row, fresh process, fresh worktree). */
  readonly newExecutionId: string;
  /**
   * The action the continuation claims to carry. Defaults to the checkpoint's
   * stored descriptor; an explicitly presented action must digest-match the
   * approved one (A17) or the whole continuation is refused.
   */
  readonly presentedAction?: ProposedAction | undefined;
  readonly now: string;
}

export interface ContinuationPlan {
  readonly checkpoint: CheckpointRecord;
  /** The approval AFTER consumption (status CONSUMED, bound to the new execution). */
  readonly approval: ApprovalRecord;
  /** The new attempt row (phase STARTING — the engine's claimed-attempt composition). */
  readonly execution: ExecutionRow;
  readonly dispatchToken: string;
  readonly attempt: number;
  /** The frozen profile snapshot the continuation will run under (A34). */
  readonly frozen: RunRoleProfile;
}

/**
 * Create the ONE continuation a checkpoint authorizes. The caller launches
 * the returned execution through the engine's claimed-attempt composition
 * (`startExecution` with `claimedAttempt: true` + the returned dispatch
 * token) — the same dispatch pipeline every scheduler claim uses.
 */
export function continueAfterApproval(
  db: DatabaseSync,
  input: ContinueAfterApprovalInput
): ContinuationPlan {
  const value = ContinueAfterApprovalInputSchema.parse(input);
  const checkpoint = requireCheckpoint(db, value.checkpointId);
  if (checkpoint.status !== "WAITING") {
    throw new CheckpointStateError({
      checkpointId: checkpoint.id,
      expectedState: "WAITING",
      actualState: checkpoint.status
    });
  }
  const approval = requireApproval(db, checkpoint.approvalId);

  // 审批未批准 / 过期 / 已消费 — each its own typed refusal, before any write.
  if (approval.status === "CONSUMED") {
    throw new ContinuationApprovalAlreadyConsumedError({
      approvalId: approval.id,
      consumedByExecutionId: approval.consumedByExecutionId ?? "(unknown)",
      consumedAt: approval.consumedAt ?? "(unknown)"
    });
  }
  if (approval.status !== "APPROVED") {
    throw new ContinuationNotApprovedError({ approvalId: approval.id, status: approval.status });
  }
  if (isApprovalExpired(approval, value.now)) {
    throw new ContinuationApprovalExpiredError({
      approvalId: approval.id,
      expiredAt: approval.expiresAt
    });
  }

  // A34: the continuation reads the FROZEN run snapshot; a revision that
  // disagrees with the approval's bound revision is a typed refusal (the
  // digest check below is the tamper backstop).
  const frozen = readRunRoleProfile(db, { runId: checkpoint.runId, roleId: checkpoint.roleId });
  if (String(frozen.snapshot.revision) !== approval.action.profileRevision) {
    throw new ContinuationProfileMismatchError({
      approvalId: approval.id,
      approvalProfileRevision: approval.action.profileRevision,
      frozenProfileRevision: String(frozen.snapshot.revision)
    });
  }

  const node = requireNodeState(db, { runId: checkpoint.runId, nodeId: checkpoint.nodeId });
  const attempt = listAttemptsForSlot(db, {
    runId: checkpoint.runId,
    nodeId: checkpoint.nodeId
  }).length + 1;
  const dispatchToken = derivedId("dispatch", checkpoint.id, String(attempt));

  // What the continuation presents for consumption: the caller's action when
  // given (rebuilt over the approval's own context so ONLY the proposal
  // essentials can differ), otherwise the checkpoint's stored descriptor.
  const presentedDescriptor: ActionDescriptor = value.presentedAction
    ? descriptorFromProposal(
        { ...checkpoint.proposal, action: value.presentedAction },
        {
          runtime: approval.action.runtime,
          cwd: approval.action.cwd,
          repoRoot: approval.action.repo.root,
          baseSha: approval.action.repo.baseSha,
          profileRevision: approval.action.profileRevision,
          grantedPermissions: approval.action.grantedPermissions
        }
      )
    : checkpoint.action;

  return withTransaction(db, () => {
    // Re-check under the write lock (a concurrent continuation loses here or
    // at the A23 constraint below — never double-runs).
    const current = getCheckpoint(db, checkpoint.id);
    if (current === null || current.status !== "WAITING") {
      throw new CheckpointStateError({
        checkpointId: checkpoint.id,
        expectedState: "WAITING",
        actualState: current === null ? "(missing)" : current.status
      });
    }

    // A23 single-active-attempt constraint: a second ACTIVE attempt in the
    // slot (e.g. a scheduler claim that raced ahead) rolls this whole
    // continuation back — the approval is NOT consumed on conflict.
    createActiveAttempt(db, {
      id: value.newExecutionId,
      runId: checkpoint.runId,
      nodeId: checkpoint.nodeId,
      definitionRevision: node.definitionRevision,
      attempt,
      dispatchToken,
      phase: "STARTING",
      now: value.now
    });

    const casResult = db
      .prepare(
        "UPDATE approval_checkpoints SET status = 'CONTINUED', continuation_execution_id = ?, " +
          "continued_at = ?, updated_at = ? WHERE id = ? AND status = 'WAITING'"
      )
      .run(value.newExecutionId, value.now, value.now, checkpoint.id);
    if (Number(casResult.changes) !== 1) {
      throw new CheckpointStateError({
        checkpointId: checkpoint.id,
        expectedState: "WAITING",
        actualState: "CONTINUED"
      });
    }

    // A17/A18 single-shot gate — the SAME guarded CAS as the approval
    // package's `consumeApproval`, inlined because this package owns the
    // surrounding transaction (the store refuses nested transactions) and the
    // consumption must commit or roll back TOGETHER with the attempt row it
    // authorizes. Zero affected rows classify exactly like the approval
    // package classifies failed consumption (authoritative taxonomy imported
    // from it) and roll the whole continuation back.
    const presentedDigest = actionDigest(presentedDescriptor);
    const consumedRows = db
      .prepare(
        "UPDATE approvals SET status = 'CONSUMED', consumed_by_execution_id = ?, consumed_at = ?, updated_at = ? " +
          "WHERE id = ? AND status = 'APPROVED' AND action_digest = ? AND expires_at > ?"
      )
      .run(value.newExecutionId, value.now, value.now, approval.id, presentedDigest, value.now);
    if (Number(consumedRows.changes) !== 1) {
      throw classifyFailedContinuation(db, approval.id, presentedDigest);
    }
    const consumed = requireApproval(db, approval.id);

    enqueueOutboxMessage(db, {
      id: derivedId("ob", checkpoint.id, value.newExecutionId),
      aggregateId: value.newExecutionId,
      type: "checkpoint.continuation-requested",
      payload: {
        checkpointId: checkpoint.id,
        approvalId: approval.id,
        actionDigest: checkpoint.actionDigest,
        proposalId: checkpoint.proposalId,
        sourceExecutionId: checkpoint.executionId,
        executionId: value.newExecutionId,
        runId: checkpoint.runId,
        nodeId: checkpoint.nodeId,
        attempt,
        dispatchToken
      },
      now: value.now
    });

    const execution = getExecution(db, value.newExecutionId);
    if (execution === null) {
      throw new NoRowUpdatedError(`continuation execution "${value.newExecutionId}" does not exist`);
    }
    return {
      checkpoint: requireCheckpoint(db, checkpoint.id),
      approval: consumed,
      execution,
      dispatchToken,
      attempt,
      frozen
    };
  });
}

// ---------------------------------------------------------------------------

/**
 * Classify a failed continuation consumption (zero CAS rows) with the SAME
 * taxonomy as the approval package's failed-consumption classification:
 * CONSUMED -> already-consumed; REJECTED/PENDING/EXPIRED -> state error;
 * APPROVED with a digest mismatch -> digest error; APPROVED with a matching
 * digest but dead expiry -> expired. The row is re-read under this
 * transaction's write lock, so the classification is authoritative.
 */
function classifyFailedContinuation(
  db: DatabaseSync,
  approvalId: string,
  presentedDigest: string
): Error {
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
