/**
 * M5-03 — the approval surface (A17 UI/API presentation).
 *
 * Three boundaries live here, mirroring graph.ts/expansion.ts:
 * - APPROVAL-VIEW boundary (read): `getRunApprovalView` projects the run's
 *   approval rows (approval package reads only — the stored digest is
 *   re-verified on every read there) down to explicitly allowlisted fields.
 *   EVERY digest constituent is visible BEFORE a decision: the complete argv
 *   (including argv[0]), the target repository (root/baseSha/targetSha), the
 *   cwd, the frozen profile revision, the DERIVED permission increments, the
 *   declared dimensions/writeScope, the required capabilities, the risk grade
 *   + reasons and the expiry. A user can see exactly what they are approving.
 * - INVALIDATION boundary (A17 presentation): an approval is `actionable`
 *   only while it is PENDING, unexpired, AND its bound targetSha still IS the
 *   node's current candidate SHA. When the candidate has moved on, the old
 *   approval could never be consumed (the continuation digest check would
 *   refuse it), so the UI says 已失效 and offers NO approve button — an
 *   approval that cannot grant anything is never displayed as live.
 * - DECISION-MAPPING boundary (write): `applyApprovalDecision` delegates the
 *   state change to the approval package's guarded CAS transitions
 *   (`approveApproval`/`rejectApproval`) — the actionDigest binding semantics
 *   are NOT re-implemented here, only mapped onto HTTP: unknown id → 404,
 *   expired → 409 APPROVAL_EXPIRED, already decided/consumed or a
 *   candidate-changed approval → 409 APPROVAL_INVALIDATED (A17), reject
 *   requires a reason. A decision NEVER executes the action and NEVER
 *   consumes the approval; consumption stays with the checkpoint continuation.
 *
 * The UI copy is pinned by tests: per-approval approve/reject only, no
 * global-grant vocabulary anywhere (A17 语义延续 — 审批不诱导全局放权).
 */
import type { DatabaseSync } from "node:sqlite";
import {
  UnknownApprovalError,
  ApprovalExpiredError,
  ApprovalStateError,
  approveApproval,
  isApprovalExpired,
  listApprovalsForRun,
  rejectApproval,
  requireApproval,
  type ApprovalRecord,
  type ApprovalStatus,
  type RiskGrade,
  type RiskReason
} from "@role-orchestrator/approval";
import { listCheckpointsForRun } from "@role-orchestrator/checkpoint";
import { getIntegrationRecord } from "@role-orchestrator/integration";
import { getTaskRun } from "@role-orchestrator/store";
import { GraphEditRejectionError, LocalApiStateError } from "./errors.js";

/**
 * Why one approval cannot be decided (or is already decided). UI vocabulary:
 * any non-empty list renders as 已失效 / a decided state badge — never as a
 * live approve affordance.
 */
export type ApprovalInvalidationCode =
  | "EXPIRED"
  | "CANDIDATE_CHANGED"
  | `STATUS_${ApprovalStatus}`;

/** The COMPLETE digest-bearing action essentials, presented verbatim. */
export interface ApprovalActionView {
  readonly runtime: string;
  /** The full argv INCLUDING argv[0], in order (order is semantic for the digest). */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly repo: {
    readonly root: string;
    readonly baseSha: string;
    readonly targetSha: string | null;
  };
  readonly profileRevision: string;
  readonly requiredPermissions: readonly string[];
  readonly grantedPermissions: readonly string[];
  readonly dimensions: readonly string[];
  readonly writeScope: string | null;
  readonly requiredCapabilities: readonly string[];
}

export interface RunApprovalItemView {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly status: ApprovalStatus;
  readonly riskGrade: RiskGrade;
  readonly requiresApproval: boolean;
  readonly riskReasons: readonly RiskReason[];
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly action: ApprovalActionView;
  /** Derived required-minus-granted set (the 权限增量 this approval would mint). */
  readonly permissionIncrements: readonly string[];
  readonly requestedBy: {
    readonly runId: string;
    readonly nodeId: string;
    readonly attempt: number;
  } | null;
  /** The waiting checkpoint this approval came from, when it has one. */
  readonly checkpoint: {
    readonly checkpointId: string;
    readonly nodeId: string;
    readonly attempt: number;
    readonly roleId: string;
    readonly proposalId: string;
    readonly status: string;
  } | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly consumedByExecutionId: string | null;
  readonly consumedAt: string | null;
  /** The node's CURRENT candidate SHA (integration record), when one exists. */
  readonly currentCandidateSha: string | null;
  /**
   * Why this approval must not (or cannot) be decided. Empty = a live
   * PENDING approval the user may approve or reject.
   */
  readonly invalidations: readonly ApprovalInvalidationCode[];
  readonly actionable: boolean;
}

export interface RunApprovalView {
  readonly runId: string;
  readonly approvals: readonly RunApprovalItemView[];
}

/** The invalidation codes for one record, against the node's current candidate. */
function invalidationsOf(
  db: DatabaseSync,
  record: ApprovalRecord,
  now: string
): {
  readonly invalidations: readonly ApprovalInvalidationCode[];
  readonly currentCandidateSha: string | null;
} {
  const invalidations: ApprovalInvalidationCode[] = [];
  if (record.status !== "PENDING") {
    invalidations.push(`STATUS_${record.status}` as ApprovalInvalidationCode);
  }
  if (isApprovalExpired(record, now)) {
    invalidations.push("EXPIRED");
  }
  let currentCandidateSha: string | null = null;
  const requestedBy = record.requestedBy;
  if (requestedBy.runId !== null && requestedBy.nodeId !== null && record.action.repo.targetSha !== null) {
    const integration = getIntegrationRecord(db, {
      runId: requestedBy.runId,
      nodeId: requestedBy.nodeId
    });
    currentCandidateSha = integration?.candidateSha ?? null;
    if (
      currentCandidateSha !== null &&
      currentCandidateSha !== record.action.repo.targetSha
    ) {
      // A17 presentation: the candidate moved on, so the bound action can
      // never be consumed again — the approval must not look approvable.
      invalidations.push("CANDIDATE_CHANGED");
    }
  }
  return { invalidations, currentCandidateSha };
}

function toActionView(record: ApprovalRecord): ApprovalActionView {
  return {
    runtime: record.action.runtime,
    argv: [...record.action.argv],
    cwd: record.action.cwd,
    repo: {
      root: record.action.repo.root,
      baseSha: record.action.repo.baseSha,
      targetSha: record.action.repo.targetSha
    },
    profileRevision: record.action.profileRevision,
    requiredPermissions: [...record.action.requiredPermissions],
    grantedPermissions: [...record.action.grantedPermissions],
    dimensions: [...record.action.dimensions],
    writeScope: record.action.writeScope,
    requiredCapabilities: [...record.action.requiredCapabilities]
  };
}

function toItemView(
  db: DatabaseSync,
  record: ApprovalRecord,
  checkpoints: ReadonlyMap<string, { checkpointId: string; nodeId: string; attempt: number; roleId: string; proposalId: string; status: string }>,
  now: string
): RunApprovalItemView {
  const { invalidations, currentCandidateSha } = invalidationsOf(db, record, now);
  const checkpoint = checkpoints.get(record.id) ?? null;
  return {
    approvalId: record.id,
    actionDigest: record.actionDigest,
    status: record.status,
    riskGrade: record.riskGrade,
    requiresApproval: record.requiresApproval,
    riskReasons: [...record.riskReasons],
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    action: toActionView(record),
    permissionIncrements: [...record.permissionIncrements],
    requestedBy:
      record.requestedBy.runId === null || record.requestedBy.nodeId === null || record.requestedBy.attempt === null
        ? null
        : {
            runId: record.requestedBy.runId,
            nodeId: record.requestedBy.nodeId,
            attempt: record.requestedBy.attempt
          },
    checkpoint,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt,
    rejectedBy: record.rejectedBy,
    rejectedAt: record.rejectedAt,
    rejectionReason: record.rejectionReason,
    consumedByExecutionId: record.consumedByExecutionId,
    consumedAt: record.consumedAt,
    currentCandidateSha,
    invalidations,
    actionable: invalidations.length === 0
  };
}

/**
 * The run's approval view, or `null` when the run id is unknown (served 404).
 * Approvals are listed oldest-first (the approval package's order).
 */
export function getRunApprovalView(db: DatabaseSync, runId: string): RunApprovalView | null {
  const run = getTaskRun(db, runId);
  if (run === null) return null;
  const now = new Date().toISOString();
  const checkpoints = new Map(
    listCheckpointsForRun(db, run.id).map((checkpoint) => [
      checkpoint.approvalId,
      {
        checkpointId: checkpoint.id,
        nodeId: checkpoint.nodeId,
        attempt: checkpoint.attempt,
        roleId: checkpoint.roleId,
        proposalId: checkpoint.proposalId,
        status: checkpoint.status
      }
    ])
  );
  const approvals = listApprovalsForRun(db, run.id).map((record) =>
    toItemView(db, record, checkpoints, now)
  );
  return { runId: run.id, approvals };
}

// ---------------------------------------------------------------------------
// The guarded decision
// ---------------------------------------------------------------------------

export interface ApprovalDecisionRequest {
  readonly decision: "approve" | "reject";
  /** Who pressed the button (recorded verbatim on the approval row). */
  readonly decidedBy: string;
  /** Required for reject (1..2000 chars), refused for approve. */
  readonly reason?: string | undefined;
}

export interface ApprovalDecisionResult {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly decision: "approve" | "reject";
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/**
 * Apply one decision through the approval package's guarded transitions.
 *
 * - approve: a candidate-changed PENDING approval is refused BEFORE the CAS
 *   (409 APPROVAL_INVALIDATED with `currentCandidateSha`) — approving a
 *   dead binding would mint a permission that can never be consumed. Expired
 *   and already-decided approvals are refused by the approval package itself
 *   (the expired PENDING row is materialized EXPIRED there first) and mapped
 *   to 409 here.
 * - reject: allowed for any PENDING row (rejecting a stale candidate is the
 *   safe direction and is recorded); the guarded state gate covers the rest.
 *
 * A decision NEVER consumes the approval and NEVER starts an execution.
 */
export function applyApprovalDecision(
  db: DatabaseSync,
  approvalId: string,
  request: ApprovalDecisionRequest
): ApprovalDecisionResult {
  try {
    return decide(db, approvalId, request);
  } catch (error) {
    throw mapDecisionError(error);
  }
}

function decide(
  db: DatabaseSync,
  approvalId: string,
  request: ApprovalDecisionRequest
): ApprovalDecisionResult {
  const now = new Date().toISOString();
  if (request.decision === "approve") {
    const record = requireApproval(db, approvalId);
    const { invalidations, currentCandidateSha } = invalidationsOf(db, record, now);
    if (invalidations.includes("CANDIDATE_CHANGED")) {
      throw new GraphEditRejectionError(
        409,
        "APPROVAL_INVALIDATED",
        "候选 SHA 已变化：该审批绑定的动作已无法消费（A17），不能批准。" +
          `审批绑定 targetSha ${record.action.repo.targetSha ?? "(none)"}，当前候选 ${currentCandidateSha ?? "(none)"}。` +
          "请让节点发起新的审批。",
        { details: { currentCandidateSha, invalidations: [...invalidations] } }
      );
    }
    const approved = approveApproval(db, { approvalId, approvedBy: request.decidedBy, now });
    return {
      approvalId: approved.id,
      status: approved.status,
      decision: "approve",
      decidedBy: request.decidedBy,
      decidedAt: approved.approvedAt ?? now
    };
  }
  // reject — reason presence is enforced by the server's strict body schema.
  const rejected = rejectApproval(db, {
    approvalId,
    rejectedBy: request.decidedBy,
    reason: request.reason ?? "(unspecified)",
    now
  });
  return {
    approvalId: rejected.id,
    status: rejected.status,
    decision: "reject",
    decidedBy: request.decidedBy,
    decidedAt: rejected.rejectedAt ?? now
  };
}

/** Typed approval failures -> explicit HTTP semantics (message stays human). */
export function mapApprovalDecisionError(error: unknown): GraphEditRejectionError | LocalApiStateError {
  return mapDecisionError(error);
}

function mapDecisionError(error: unknown): GraphEditRejectionError | LocalApiStateError {
  if (error instanceof GraphEditRejectionError) {
    return error;
  }
  if (error instanceof UnknownApprovalError) {
    return new GraphEditRejectionError(404, "NOT_FOUND", error.message, { cause: error });
  }
  if (error instanceof ApprovalExpiredError) {
    return new GraphEditRejectionError(
      409,
      "APPROVAL_EXPIRED",
      `该审批已过期（过期时间 ${error.expiredAt}），无法批准（过期审批不可消费，A17）`,
      { cause: error }
    );
  }
  if (error instanceof ApprovalStateError) {
    return new GraphEditRejectionError(
      409,
      "APPROVAL_INVALIDATED",
      `该审批当前状态为 ${error.actualState}（期望 ${error.expectedState}），不能重复决定`,
      { cause: error, details: { status: error.actualState } }
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LocalApiStateError(`approval decision failed unexpectedly: ${message}`, { cause: error });
}
