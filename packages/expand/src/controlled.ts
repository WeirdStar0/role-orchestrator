/**
 * M5-02 — the CONTROLLED expansion entry (`requestControlledExpansion`).
 *
 * The M4-03 expander (`requestReviewExpansion`) stays exactly as shipped:
 * every one of its guards — grounded fail verdict, idempotent replay, user
 * hold, three-round cap, repair-target policy, composed-graph re-validation —
 * applies unchanged, because the controlled entry DELEGATES to it. What this
 * module adds is the two gates a UI/API-initiated expansion must pass BEFORE
 * that delegation, and the two records that make the result legible:
 *
 *   1. A04 permission gate — the request names the acting role
 *      (`requesterRoleId`); its `role_bindings` row of the run's project must
 *      exist and carry `canCreateSubtasks = true` (docs/ORCHESTRATION.md
 *      section 2: "动态扩图先由 Agent 提交 Proposal，系统检查其角色
 *      canCreateSubtasks 与剩余预算"). A denial is durably audited (migration
 *      017, `expansion_request_audit`) BEFORE the typed
 *      `ExpansionPermissionDeniedError` is thrown — the refusal never erases
 *      its own evidence.
 *   2. A38 staleness gate — the request carries the `expectedGraphRevision`
 *      the client saw; a stale request is refused with dag's
 *      `GraphRevisionConflictError` (which names the CURRENT revision, so the
 *      client can refresh and retry). Nothing is written, nothing is minted.
 *   3. Delegation to `requestReviewExpansion` (M4-03 protocol, guards intact).
 *   4. Provenance audit — a `granted` row records who requested the expansion
 *      (the UI's Proposal display reads the requester from it).
 *   5. Definition-history append — the composed post-expansion workflow is
 *      appended as a NEW `task_graph_revisions` row (source `'expansion'`,
 *      migration 016) under the same optimistic lock, so a LATER ui-node-edit
 *      rebuilds from a workflow that still contains the minted nodes and the
 *      bump invalidates every other client's revision (失效传播). Composition
 *      is convergent by construction: latest revision row + every
 *      `review_expansions` minted definition (deduped by node id) — pure
 *      appends only, so a retry on top of a concurrently bumped revision is
 *      lossless for both writers.
 *
 * Composition order note: budgets are re-checked here with the SAME defaults
 * the expander used, so a composed-history validation failure can only mean
 * the run's durable state diverged from its history — refuse loudly, write
 * nothing (the minted `task_nodes` rows remain, without a history row: an
 * honest, detectable inconsistency, never a silent one).
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId, WorkflowDefinition } from "@role-orchestrator/contracts";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import { CommitShaSchema } from "@role-orchestrator/integration";
import {
  DEFAULT_GRAPH_BUDGETS,
  GRAPH_REVISIONS_EXPANSION_SOURCE_MIGRATION,
  GRAPH_REVISIONS_MIGRATION,
  GraphRevisionConflictError,
  UnknownRunError,
  getLatestGraphRevision,
  listRunNodes,
  parseWorkflowDefinition,
  recordExpansionGraphRevision,
  validateWorkflowGraph
} from "@role-orchestrator/dag";
import { listReviewRecords } from "@role-orchestrator/review";
import { listRoleBindings } from "@role-orchestrator/runtime-profile";
import type {
  ApplyMigrationsOptions,
  ApplyMigrationsResult,
  MigrationDefinition
} from "@role-orchestrator/store";
import { applyMigrations, getTaskRun, TimestampSchema } from "@role-orchestrator/store";
import { ExpandError, ExpansionConflictError } from "./errors.js";
import {
  listRunExpansions,
  requestReviewExpansion,
  type MintedNodeView,
  type ReviewExpansionOutcome
} from "./expander.js";
import {
  MAX_REVIEW_ROUNDS,
  mintExpansionNodeIds,
  reviewNodeGeneration
} from "./lineage.js";
import {
  EXPANSION_REQUEST_AUDIT_MIGRATION,
  recordExpansionRequestAudit,
  type ExpansionDenialReason
} from "./audit.js";
import { EXPAND_MIGRATIONS } from "./migration.js";

/** The A04 refusal: a typed error whose reason is already durably audited. */
export class ExpansionPermissionDeniedError extends ExpandError {
  readonly runId: string;
  readonly projectId: string;
  readonly requesterRoleId: RoleId;
  readonly reason: ExpansionDenialReason;

  constructor(input: {
    readonly runId: string;
    readonly projectId: string;
    readonly requesterRoleId: RoleId;
    readonly reason: ExpansionDenialReason;
  }) {
    super(
      `expansion request denied for role "${input.requesterRoleId}" on run "${input.runId}" ` +
        `(${permissionReasonText(input.reason, input.requesterRoleId, input.projectId)}); ` +
        "the denial and its reason are recorded in the expansion request audit (A04)",
      { cause: input.reason }
    );
    this.name = "ExpansionPermissionDeniedError";
    this.runId = input.runId;
    this.projectId = input.projectId;
    this.requesterRoleId = input.requesterRoleId;
    this.reason = input.reason;
  }
}

export function permissionReasonText(
  reason: ExpansionDenialReason,
  requesterRoleId: RoleId,
  projectId: string
): string {
  return reason === "binding-missing"
    ? `role "${requesterRoleId}" of project "${projectId}" has no role_bindings row; ` +
        "an unresolvable role has no expansion permission (fail-closed)"
    : `the role binding of "${requesterRoleId}" in project "${projectId}" carries ` +
        "canCreateSubtasks = false; a role with disabled subtask permission cannot request " +
        "graph expansion";
}

// ---------------------------------------------------------------------------
// The composed post-expansion workflow (the definition-history payload)
// ---------------------------------------------------------------------------

/**
 * Compose the workflow definition that reflects the run's CURRENT durable
 * node set: the latest revision row plus every expansion's minted pair
 * (deduped by node id — earlier expansions may already be recorded there).
 * Re-validated BEFORE any write; see the module contract for why a failure
 * here is an honest loud refusal.
 */
export function composeExpandedWorkflow(db: DatabaseSync, runId: string): WorkflowDefinition {
  const latest = getLatestGraphRevision(db, runId);
  if (latest === null) {
    throw new ExpansionConflictError({
      runId,
      detail:
        "the run has no recorded graph-revision baseline; an expansion cannot be appended to definition history"
    });
  }
  const byId = new Map<string, WorkflowDefinition["nodes"][number]>(
    latest.workflow.nodes.map((node) => [node.id, node])
  );
  for (const expansion of listRunExpansions(db, runId)) {
    byId.set(expansion.mintedDefinitions.fix.id, expansion.mintedDefinitions.fix);
    byId.set(expansion.mintedDefinitions.review.id, expansion.mintedDefinitions.review);
  }
  const composed: WorkflowDefinition = {
    id: latest.workflow.id,
    name: latest.workflow.name,
    nodes: [...byId.values()]
  };
  validateWorkflowGraph(parseWorkflowDefinition(composed), {
    budgets: { maxNodes: DEFAULT_GRAPH_BUDGETS.maxNodes, maxDepth: DEFAULT_GRAPH_BUDGETS.maxDepth }
  });
  return composed;
}

/**
 * Bounded retry for the definition-history append: between the staleness gate
 * and the append a concurrent ui-node-edit may bump the revision. Expansions
 * are pure appends, so recomposing on top of the newer revision is lossless
 * for both writers; the loop re-reads and retries, and only a persistent
 * conflict (pathological contention) escalates to an ExpansionConflictError.
 */
const MAX_REVISION_APPEND_ATTEMPTS = 4;

function appendExpansionRevision(db: DatabaseSync, runId: string, now: string): number {
  let lastConflict: GraphRevisionConflictError | null = null;
  for (let attempt = 0; attempt < MAX_REVISION_APPEND_ATTEMPTS; attempt++) {
    const run = getTaskRun(db, runId);
    if (run === null) {
      throw new UnknownRunError(runId);
    }
    try {
      const recorded = recordExpansionGraphRevision(db, {
        runId,
        workflow: composeExpandedWorkflow(db, runId),
        expectedGraphRevision: run.graphRevision,
        now
      });
      return recorded.revision;
    } catch (error) {
      if (error instanceof GraphRevisionConflictError) {
        lastConflict = error;
        continue;
      }
      throw error;
    }
  }
  throw new ExpansionConflictError({
    runId,
    detail: "the graph revision kept moving while the expansion revision row was appended",
    cause: lastConflict
  });
}

// ---------------------------------------------------------------------------
// The controlled request
// ---------------------------------------------------------------------------

const ControlledRequestSchema = z.strictObject({
  runId: IdSchema,
  /** The review node whose durable fail verdict triggers the expansion. */
  reviewNodeId: IdSchema,
  /** The EXACT failed candidateSha the fail verdict is bound to (A12). */
  candidateSha: CommitShaSchema,
  /** The acting role; its project role binding must hold canCreateSubtasks (A04). */
  requesterRoleId: RoleIdSchema,
  /** Optional explicit repair target (same policy as the M4-03 expander). */
  repairedNodeId: IdSchema.optional(),
  /** Optimistic lock (A38): the graph revision the client saw. */
  expectedGraphRevision: z.number().int().min(0),
  now: TimestampSchema
});

export type RequestControlledExpansionInput = z.input<typeof ControlledRequestSchema>;

export interface ControlledExpansionOutcome {
  /** False for an idempotent replay: the SAME pair, nothing minted. */
  readonly created: boolean;
  readonly expansionId: string;
  readonly runId: string;
  /** The acting role, echoed for the UI's Proposal display ("谁请求"). */
  readonly requesterRoleId: RoleId;
  readonly triggerReviewNodeId: string;
  readonly triggerCandidateSha: string;
  readonly triggerGeneration: number;
  readonly generation: number;
  readonly repairedNodeId: string;
  readonly fixNode: MintedNodeView;
  readonly reviewNode: MintedNodeView;
  readonly readinessTransitions: ReviewExpansionOutcome["readinessTransitions"];
  /** The run's graphRevision AFTER the request (bumped when created). */
  readonly revision: number;
}

/**
 * The controlled expansion request (M5-02): A04 permission gate with durable
 * denial audit -> A38 optimistic staleness gate -> the untouched M4-03
 * protocol -> provenance audit -> append-only definition-history row. See the
 * module contract for the full order and the failure semantics.
 */
export function requestControlledExpansion(
  db: DatabaseSync,
  input: RequestControlledExpansionInput
): ControlledExpansionOutcome {
  const request = ControlledRequestSchema.parse(input);
  const { runId, reviewNodeId, candidateSha, requesterRoleId, expectedGraphRevision, now } = request;

  const run = getTaskRun(db, runId);
  if (run === null) {
    throw new UnknownRunError(runId);
  }

  // ---- 1. A04 permission gate (denial is audited durably BEFORE the throw) --
  const binding =
    listRoleBindings(db, run.projectId).find((row) => row.roleId === requesterRoleId) ?? null;
  const denialReason: ExpansionDenialReason | null =
    binding === null
      ? "binding-missing"
      : binding.canCreateSubtasks
        ? null
        : "can-create-subtasks-disabled";
  if (denialReason !== null) {
    recordExpansionRequestAudit(db, {
      runId,
      requesterRoleId,
      reviewNodeId,
      candidateSha,
      expectedGraphRevision,
      outcome: "denied-permission",
      reason: permissionReasonText(denialReason, requesterRoleId, run.projectId),
      now
    });
    throw new ExpansionPermissionDeniedError({
      runId,
      projectId: run.projectId,
      requesterRoleId,
      reason: denialReason
    });
  }

  // ---- 2. A38 staleness gate (read-only; the error names the current revision)
  if (run.graphRevision !== expectedGraphRevision) {
    throw new GraphRevisionConflictError(runId, expectedGraphRevision, run.graphRevision);
  }

  // ---- 3. The M4-03 protocol — every guard preserved (A20 included) ---------
  const outcome = requestReviewExpansion(
    db,
    {
      runId,
      reviewNodeId,
      candidateSha,
      now,
      ...(request.repairedNodeId !== undefined ? { repairedNodeId: request.repairedNodeId } : {})
    }
  );

  // ---- 4. Provenance audit: who requested it, under which permission --------
  recordExpansionRequestAudit(db, {
    runId,
    requesterRoleId,
    reviewNodeId,
    candidateSha,
    expectedGraphRevision,
    outcome: "granted",
    reason:
      `role "${requesterRoleId}" holds canCreateSubtasks = true; expansion "${outcome.expansionId}" ` +
      `${outcome.created ? "minted" : "replayed"} for review node "${reviewNodeId}" at candidate ${candidateSha}`,
    now
  });

  if (!outcome.created) {
    const replayRun = getTaskRun(db, runId);
    if (replayRun === null) {
      // Unreachable (the run existed a few lines ago); kept so the narrowed
      // type is honest instead of a non-null assertion.
      throw new UnknownRunError(runId);
    }
    return { ...outcome, requesterRoleId, revision: replayRun.graphRevision };
  }

  // ---- 5. Append the expansion to the definition history (A38 失效传播) -----
  const revision = appendExpansionRevision(db, runId, now);
  return { ...outcome, requesterRoleId, revision };
}

// ---------------------------------------------------------------------------
// Read side: the pending expansion PROPOSALS of a run (the UI's Proposal
// display — who may request it, why it failed, what would be minted, and the
// round budget state). Pure reads over the durable review records, the
// expansion rows and the task_nodes mirror; nothing here decides anything.
// ---------------------------------------------------------------------------

export interface ExpansionProposalView {
  /** The failed review node whose durable fail verdict grounds the proposal. */
  readonly reviewNodeId: string;
  /** The EXACT candidateSha the fail verdict is bound to (A12). */
  readonly candidateSha: string;
  /** Generation of the failed review node (1 = an original plan review). */
  readonly triggerGeneration: number;
  /** The generation an accepted proposal would mint (trigger + 1). */
  readonly nextGeneration: number;
  /** True when the trigger's generation has already reached MAX_REVIEW_ROUNDS: the next request is refused and the run is held for the user (A20). */
  readonly roundsExhausted: boolean;
  /** Default repair target: the review's single direct dependency, else null. */
  readonly repairedNodeId: string | null;
  /** True when the review has zero or several direct dependencies: the caller must name the repair target explicitly. */
  readonly repairTargetAmbiguous: boolean;
  readonly directDependencies: readonly string[];
  /** Deterministic ids the accepted proposal would mint (null when ambiguous or rounds-exhausted). */
  readonly proposedFixNodeId: string | null;
  readonly proposedReviewNodeId: string | null;
  /** The repaired node's pinned role — the minted fix node's role (null when ambiguous). */
  readonly proposedFixRole: string | null;
  /** The failed review's findings — the durable "为什么 fail" of the display. */
  readonly findings: readonly string[];
}

/**
 * Every reviewer-node fail verdict of the run that has NOT been expanded yet
 * (a replayed fail is idempotent, so an expanded trigger stops being a
 * pending proposal). Ordered by review node id for deterministic rendering.
 */
export function listRunExpansionProposals(
  db: DatabaseSync,
  runId: string
): readonly ExpansionProposalView[] {
  const parsedRunId = IdSchema.parse(runId);
  const expandedTriggers = new Set(
    listRunExpansions(db, parsedRunId).map(
      (expansion) => `${expansion.triggerReviewNodeId}\u0000${expansion.triggerCandidateSha}`
    )
  );
  const rows = listRunNodes(db, parsedRunId);
  const depsByNodeId = new Map<string, readonly string[]>(
    rows.map((row) => [row.nodeId, row.dependencies])
  );
  const proposals: ExpansionProposalView[] = [];
  for (const record of listReviewRecords(db, parsedRunId)) {
    if (record.state !== "COMPLETED" || record.verdict !== "fail") continue;
    if (expandedTriggers.has(`${record.nodeId}\u0000${record.candidateSha}`)) continue;
    // Only a reviewer node's fail verdict can ground an expansion (the same
    // guard the expander enforces); non-reviewer fails belong to retry
    // classification (M4-04), not to the Proposal display.
    const row = rows.find((candidate) => candidate.nodeId === record.nodeId);
    if (row === undefined || row.roleId !== "reviewer") continue;

    const triggerGeneration = reviewNodeGeneration(db, parsedRunId, record.nodeId);
    const directDependencies = [...new Set(depsByNodeId.get(record.nodeId) ?? [])];
    const only = directDependencies.length === 1 ? (directDependencies[0] ?? null) : null;
    const nextGeneration = triggerGeneration + 1;
    const roundsExhausted = triggerGeneration >= MAX_REVIEW_ROUNDS;
    const mintedIds =
      !roundsExhausted && only !== null
        ? mintExpansionNodeIds(parsedRunId, only, nextGeneration)
        : null;
    const repairedRole =
      only === null
        ? null
        : (rows.find((candidate) => candidate.nodeId === only)?.roleId ?? null);
    proposals.push({
      reviewNodeId: record.nodeId,
      candidateSha: record.candidateSha,
      triggerGeneration,
      nextGeneration,
      roundsExhausted,
      repairedNodeId: only,
      repairTargetAmbiguous: only === null,
      directDependencies,
      proposedFixNodeId: mintedIds?.fixNodeId ?? null,
      proposedReviewNodeId: mintedIds?.reviewNodeId ?? null,
      proposedFixRole: repairedRole,
      findings: record.findings ?? []
    });
  }
  return proposals.sort((a, b) => (a.reviewNodeId < b.reviewNodeId ? -1 : a.reviewNodeId > b.reviewNodeId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The M5-02 migration chain: the 013 expansion schema + the 015/016 revision
// history (with the widened 'expansion' source) + the 017 request audit.
// ---------------------------------------------------------------------------

/**
 * Everything a CONTROLLED-expansion consumer must apply:
 * 001..013 (the EXPAND_MIGRATIONS chain, review expansions + user holds)
 * + 015 (task_graph_revisions) + 016 (widened 'expansion' source)
 * + 017 (expansion_request_audit). Version 014 stays with the budget
 * package's own chain; version 015 was already claimed by dag's M5-01 —
 * hence 016/017 for the two NEW M5-02 migrations.
 *
 * Shipped as a NEW composed list: `EXPAND_MIGRATIONS` itself is untouched, so
 * every existing consumer chain keeps its pinned applied-version postcondition.
 */
export const CONTROLLED_EXPANSION_MIGRATIONS: readonly MigrationDefinition[] = [
  ...EXPAND_MIGRATIONS,
  GRAPH_REVISIONS_MIGRATION,
  GRAPH_REVISIONS_EXPANSION_SOURCE_MIGRATION,
  EXPANSION_REQUEST_AUDIT_MIGRATION
];

export interface ApplyControlledExpansionMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `CONTROLLED_EXPANSION_MIGRATIONS` as the default list. */
export async function applyControlledExpansionMigrations(
  db: DatabaseSync,
  options: ApplyControlledExpansionMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? CONTROLLED_EXPANSION_MIGRATIONS
  });
}
