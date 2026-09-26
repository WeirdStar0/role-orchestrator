/**
 * The M4-03 expander — bounded repair + re-review graph expansion (A20).
 *
 * Trigger (grounded, never taken on faith): `getReviewVerdict` (the M2-05 A12
 * query) must answer `valid` with verdict `fail` for the EXACT
 * (run, review node, candidateSha) triple. `none`/`invalidated` lookups and
 * `pass`/`blocked` verdicts refuse with `NoFailVerdictError`.
 *
 * Effect: TWO new rows are appended to the run's node set —
 *
 *   <repaired>-fix-<g>   (role = repaired node's role, dependencies = [repaired])
 *   <repaired>-review-<g> (role = reviewer,            dependencies = [fix])
 *
 * where `g` is the new review generation (2 for the first expansion). The
 * failed review node is deliberately NOT a dependency of the fix node: FAILED
 * is a blocking dependency state (dag's BLOCKING_DEP_STATES), so depending on
 * it would block the very node meant to heal the branch — the failed review's
 * candidate context (node id, candidateSha, findings) is instead attached as
 * DURABLE DATA (the expansion row + the fix node's objective). The old
 * downstream of the failed review stays blocked by the dag's own propagation:
 * expansion adds healing nodes, it never rewires or unblocks history.
 *
 * Acyclicity (A20 "无图回边"): the expander only appends; no existing row's
 * dependency snapshot is ever rewritten, so a back edge cannot be created by
 * construction. BEFORE any write, the FULL composed graph (all stored nodes +
 * the two minted definitions) is re-validated with dag's own validator
 * (`parseWorkflowDefinition` + `validateWorkflowGraph`): a duplicate id, a
 * cycle, an unknown dependency or a blown node/depth budget is a typed dag
 * rejection with zero rows written.
 *
 * Budget (A20): generations per review chain <= MAX_REVIEW_ROUNDS = 3,
 * counting the first review. A fourth-round request throws
 * `ReviewRoundsExhaustedError` and durably holds the run for user disposition
 * (`expansion_user_holds`); nothing is minted and nothing auto-continues.
 *
 * Idempotency: one expansion per (run, failed review node, failed
 * candidateSha) — a replayed fail returns the SAME pair with `created: false`
 * and mints nothing (the UNIQUE indexes + deterministic ids make the storage
 * layer agree even under a race).
 *
 * Downstream: minted nodes are ordinary `task_nodes` rows, so the existing
 * scheduler path (`enqueueReadyNodes` -> `pollQueue` -> engine) and the dag
 * state machine (FAILED -> RETRY_PENDING -> READY) apply unchanged; the
 * re-review node consumes the NEW candidateSha through the M2-05 protocol, to
 * which the old fail never applies (A12).
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId, TaskNodeDefinition } from "@role-orchestrator/contracts";
import { IdSchema, TaskNodeSchema } from "@role-orchestrator/contracts";
import {
  DEFAULT_GRAPH_BUDGETS,
  listRunNodes,
  parseWorkflowDefinition,
  propagateNodeStates,
  requireNodeState,
  validateWorkflowGraph,
  UnknownRunError
} from "@role-orchestrator/dag";
import type { GraphBudgets, NodeState, NodeStateTransition } from "@role-orchestrator/dag";
import { CommitShaSchema } from "@role-orchestrator/integration";
import { getReviewVerdict } from "@role-orchestrator/review";
import { getTaskRun, isUniqueViolation, TimestampSchema, withTransaction } from "@role-orchestrator/store";
import {
  AmbiguousRepairTargetError,
  ExpansionConflictError,
  NoFailVerdictError,
  NotReviewNodeError,
  RepairTargetNotReviewedError,
  ReviewRoundsExhaustedError,
  RunHeldForUserError,
  UnknownExpansionHoldError
} from "./errors.js";
import {
  expansionHoldIdFor,
  expansionIdFor,
  MAX_REVIEW_ROUNDS,
  mintExpansionNodeIds,
  reviewNodeGeneration
} from "./lineage.js";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const FixRoleSchema = z.enum(["coordinator", "architect", "developer", "reviewer"]);

export const MintedDefinitionsSchema = z.strictObject({
  fix: TaskNodeSchema,
  review: TaskNodeSchema
});
export type MintedDefinitions = z.output<typeof MintedDefinitionsSchema>;

export interface ReviewExpansionRow {
  readonly id: string;
  readonly runId: string;
  readonly triggerReviewNodeId: string;
  readonly triggerCandidateSha: string;
  readonly triggerGeneration: number;
  readonly generation: number;
  readonly repairedNodeId: string;
  readonly fixNodeId: string;
  readonly fixRole: RoleId;
  readonly reviewNodeId: string;
  readonly definitionRevision: string;
  readonly verdict: "fail";
  readonly findings: readonly string[];
  readonly mintedDefinitions: MintedDefinitions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExpansionHoldRow {
  readonly id: string;
  readonly runId: string;
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  readonly attemptedGeneration: number;
  readonly reason: "review-rounds-exhausted";
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
}

interface RawRowShape {
  [key: string]: unknown;
}

function reqString(row: RawRowShape, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expansion row is missing required string column "${column}"`);
  }
  return value;
}

function reqNumber(row: RawRowShape, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`expansion row is missing required integer column "${column}"`);
  }
  return value;
}

function parseJsonField(raw: string, expansionId: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `expansion row "${expansionId}" column "${field}" is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }
}

function mapExpansionRow(row: RawRowShape): ReviewExpansionRow {
  const id = reqString(row, "id");
  const role = FixRoleSchema.parse(reqString(row, "fix_role"));
  const verdict = reqString(row, "verdict");
  if (verdict !== "fail") {
    // The CHECK constraint should make this unreachable; a row that carries
    // anything else must never answer an expansion query.
    throw new Error(`expansion row "${id}" carries impossible verdict "${verdict}"`);
  }
  const findings = z.array(z.string().min(1).max(10_000)).max(100).parse(
    parseJsonField(reqString(row, "findings"), id, "findings")
  );
  const mintedDefinitions = MintedDefinitionsSchema.parse(
    parseJsonField(reqString(row, "minted_definitions"), id, "minted_definitions")
  );
  return {
    id,
    runId: IdSchema.parse(reqString(row, "run_id")),
    triggerReviewNodeId: IdSchema.parse(reqString(row, "trigger_review_node_id")),
    triggerCandidateSha: CommitShaSchema.parse(reqString(row, "trigger_candidate_sha")),
    triggerGeneration: reqNumber(row, "trigger_generation"),
    generation: reqNumber(row, "new_generation"),
    repairedNodeId: IdSchema.parse(reqString(row, "repaired_node_id")),
    fixNodeId: IdSchema.parse(reqString(row, "fix_node_id")),
    fixRole: role,
    reviewNodeId: IdSchema.parse(reqString(row, "review_node_id")),
    definitionRevision: reqString(row, "definition_revision"),
    verdict,
    findings,
    mintedDefinitions,
    createdAt: reqString(row, "created_at"),
    updatedAt: reqString(row, "updated_at")
  };
}

function mapHoldRow(row: RawRowShape): ExpansionHoldRow {
  const resolvedAt = row["resolved_at"];
  const resolutionNote = row["resolution_note"];
  return {
    id: reqString(row, "id"),
    runId: IdSchema.parse(reqString(row, "run_id")),
    reviewNodeId: IdSchema.parse(reqString(row, "review_node_id")),
    candidateSha: CommitShaSchema.parse(reqString(row, "candidate_sha")),
    attemptedGeneration: reqNumber(row, "attempted_generation"),
    reason: "review-rounds-exhausted",
    createdAt: reqString(row, "created_at"),
    resolvedAt: typeof resolvedAt === "string" ? resolvedAt : null,
    resolutionNote: typeof resolutionNote === "string" ? resolutionNote : null
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getRunExpansionById(db: DatabaseSync, expansionId: string): ReviewExpansionRow | null {
  const id = IdSchema.parse(expansionId);
  const row = db.prepare("SELECT * FROM review_expansions WHERE id = ?").get(id) as
    | RawRowShape
    | undefined;
  return row === undefined ? null : mapExpansionRow(row);
}

export function listRunExpansions(db: DatabaseSync, runId: string): readonly ReviewExpansionRow[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare(
      "SELECT * FROM review_expansions WHERE run_id = ? ORDER BY new_generation ASC, created_at ASC, id ASC"
    )
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapExpansionRow);
}

/** The run's unresolved user hold, or null when the run is not held. */
export function getRunUserHold(db: DatabaseSync, runId: string): ExpansionHoldRow | null {
  const parsedRunId = IdSchema.parse(runId);
  const row = db
    .prepare(
      "SELECT * FROM expansion_user_holds WHERE run_id = ? AND resolved_at IS NULL " +
        "ORDER BY created_at ASC, id ASC LIMIT 1"
    )
    .get(parsedRunId) as RawRowShape | undefined;
  return row === undefined ? null : mapHoldRow(row);
}

export interface RunReviewExpansionState {
  readonly runId: string;
  /** Pinned review-round budget per chain, INCLUDING the first review (A20). */
  readonly maxReviewRounds: number;
  readonly expansions: readonly ReviewExpansionRow[];
  /** The unresolved fourth-round refusal, if the run is currently waiting for the user. */
  readonly unresolvedHold: ExpansionHoldRow | null;
}

/** Read-side view for supervisors/UIs: rounds used per chain + hold state. */
export function getRunReviewExpansionState(db: DatabaseSync, runId: string): RunReviewExpansionState {
  const parsedRunId = IdSchema.parse(runId);
  return {
    runId: parsedRunId,
    maxReviewRounds: MAX_REVIEW_ROUNDS,
    expansions: listRunExpansions(db, parsedRunId),
    unresolvedHold: getRunUserHold(db, parsedRunId)
  };
}

// ---------------------------------------------------------------------------
// The expansion request
// ---------------------------------------------------------------------------

const RequestSchema = z.strictObject({
  runId: IdSchema,
  /** The review node whose durable fail verdict triggers the expansion. */
  reviewNodeId: IdSchema,
  /** The EXACT failed candidateSha the fail verdict is bound to (A12). */
  candidateSha: CommitShaSchema,
  /**
   * Which reviewed node the fix repairs. Optional ONLY when the failed review
   * node has exactly one direct dependency (the default policy); when given,
   * it must be one of the review node's direct dependencies.
   */
  repairedNodeId: IdSchema.optional(),
  now: TimestampSchema
});

export type RequestReviewExpansionInput = z.input<typeof RequestSchema>;

const ExpandOptionsSchema = z.strictObject({
  budgets: z
    .strictObject({
      maxNodes: z.number().int().min(1).max(256),
      maxDepth: z.number().int().min(1).max(1024)
    })
    .partial()
    .optional()
});

export type RequestReviewExpansionOptions = z.input<typeof ExpandOptionsSchema>;

export interface MintedNodeView {
  readonly nodeId: string;
  readonly roleId: RoleId;
  readonly dependencies: readonly string[];
  /** Node state AFTER the post-insert readiness propagation ran. */
  readonly state: NodeState;
}

export interface ReviewExpansionOutcome {
  /** False for an idempotent replay: the SAME pair was returned, nothing minted. */
  readonly created: boolean;
  readonly expansionId: string;
  readonly runId: string;
  readonly triggerReviewNodeId: string;
  readonly triggerCandidateSha: string;
  /** Generation of the failed review node (1 = original plan review). */
  readonly triggerGeneration: number;
  /** Generation of the minted re-review node (triggerGeneration + 1). */
  readonly generation: number;
  readonly repairedNodeId: string;
  readonly fixNode: MintedNodeView;
  readonly reviewNode: MintedNodeView;
  /** Readiness transitions the post-insert propagation applied (empty on replay). */
  readonly readinessTransitions: readonly NodeStateTransition[];
}

const OBJECTIVE_BUDGET = 9_000;

/** Deterministic truncation so a huge findings list can never break the schema. */
function truncate(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  return `${text.slice(0, budget)}… [truncated ${String(text.length - budget)} chars]`;
}

function buildRepairObjective(input: {
  readonly triggerReviewNodeId: string;
  readonly candidateSha: string;
  readonly findings: readonly string[];
  readonly reviewNodeId: string;
}): string {
  const findingsText =
    input.findings.length === 0
      ? "(no structured findings recorded)"
      : input.findings.map((finding, index) => `${String(index + 1)}. ${finding}`).join(" ");
  return truncate(
    `Repair the work that review node "${input.triggerReviewNodeId}" failed at candidate ` +
      `${input.candidateSha}. The fail verdict's findings follow; they are also recorded ` +
      `durably in the review expansion row. Findings: ${findingsText} The successor re-review ` +
      `node "${input.reviewNodeId}" must return verdict pass for the NEW candidate before ` +
      "the reworked chain can proceed.",
    OBJECTIVE_BUDGET
  );
}

function buildRereviewObjective(input: {
  readonly fixNodeId: string;
  readonly triggerReviewNodeId: string;
  readonly candidateSha: string;
}): string {
  return (
    `Re-review the repaired candidate produced by fix node "${input.fixNodeId}", consuming it ` +
    "through the fixed-SHA review protocol (M2-05) bound to the NEW candidateSha. The fail " +
    `recorded by "${input.triggerReviewNodeId}" at candidate ${input.candidateSha} is bound to ` +
    "that exact candidate and never applies to the new one (A12)."
  );
}

function placeholderDefinition(row: {
  readonly nodeId: string;
  readonly roleId: RoleId;
  readonly dependencies: readonly string[];
}): TaskNodeDefinition {
  // task_nodes stores graph STRUCTURE (id/role/dependency snapshot) only; the
  // definitional fields live in the plan revision. For the composed-graph
  // re-validation they are placeholders — the structural checks (duplicates,
  // unknown dependencies, cycles, budgets) are exactly what re-validation is
  // for, and the minted definitions carry their REAL fields (schema-checked
  // by the same parse).
  return {
    id: row.nodeId,
    role: row.roleId,
    title: `stored node ${row.nodeId}`,
    objective:
      "Structural placeholder for expansion re-validation: this row's definitional fields " +
      "live in the run's plan revision; only id/role/dependency structure is re-checked here.",
    dependencies: [...row.dependencies],
    capabilityTags: [],
    acceptanceCriteria: ["structural placeholder for expansion re-validation"]
  };
}

/**
 * Request one bounded repair/re-review expansion (A20). See the module
 * contract for the full semantics; the fail-closed order:
 *
 *   run -> trigger node role -> durable fail verdict -> idempotent replay ->
 *   user hold -> round budget -> repair target -> composed-graph re-validation
 *   (pure, typed dag rejections) -> ONE transaction (insert pair + expansion
 *   row + readiness propagation)
 */
export function requestReviewExpansion(
  db: DatabaseSync,
  input: RequestReviewExpansionInput,
  options: RequestReviewExpansionOptions = {}
): ReviewExpansionOutcome {
  const request = RequestSchema.parse(input);
  const budgets = ExpandOptionsSchema.parse(options);
  const { runId, reviewNodeId, candidateSha, now } = request;

  if (getTaskRun(db, runId) === null) {
    throw new UnknownRunError(runId);
  }
  const trigger = requireNodeState(db, { runId, nodeId: reviewNodeId });
  if (trigger.roleId !== "reviewer") {
    throw new NotReviewNodeError(runId, reviewNodeId, trigger.roleId);
  }

  // Grounded trigger: the durable verdict, read through the M2-05 A12 query.
  const verdict = getReviewVerdict(db, { runId, nodeId: reviewNodeId, candidateSha });
  if (verdict.kind !== "valid" || verdict.verdict !== "fail") {
    throw new NoFailVerdictError({
      runId,
      reviewNodeId,
      candidateSha,
      lookupKind: verdict.kind,
      verdict: verdict.kind === "valid" ? verdict.verdict : null
    });
  }
  const findings = verdict.findings;
  const triggerGeneration = reviewNodeGeneration(db, runId, reviewNodeId);

  // Idempotent replay FIRST: a repeated fail resolves to the SAME pair and
  // mints nothing — even while the run is held for the user, answering an
  // already-expanded request is read-only and cannot "continue" anything.
  const expansionId = expansionIdFor(runId, reviewNodeId, candidateSha);
  const existing = getRunExpansionById(db, expansionId);
  if (existing !== null) {
    return replayOutcome(db, existing);
  }

  // A20 pause: an unresolved fourth-round refusal holds the whole run.
  const hold = getRunUserHold(db, runId);
  if (hold !== null) {
    throw new RunHeldForUserError({
      runId,
      holdId: hold.id,
      reviewNodeId: hold.reviewNodeId,
      candidateSha: hold.candidateSha,
      attemptedGeneration: hold.attemptedGeneration
    });
  }

  // Budget: the failed review's generation must be below MAX_REVIEW_ROUNDS to
  // mint generation +1. A third-generation fail refuses the fourth round.
  if (triggerGeneration >= MAX_REVIEW_ROUNDS) {
    holdRunForUser(db, {
      runId,
      reviewNodeId,
      candidateSha,
      attemptedGeneration: triggerGeneration + 1,
      now
    });
    throw new ReviewRoundsExhaustedError({
      runId,
      reviewNodeId,
      candidateSha,
      failedGeneration: triggerGeneration
    });
  }
  const generation = triggerGeneration + 1;

  // Repair target: explicit and reviewed, or the review's single direct dep.
  const directDependencies = [...new Set(trigger.dependencies)];
  let repairedNodeId: string;
  if (request.repairedNodeId !== undefined) {
    if (!directDependencies.includes(request.repairedNodeId)) {
      throw new RepairTargetNotReviewedError({
        runId,
        reviewNodeId,
        repairedNodeId: request.repairedNodeId,
        directDependencies
      });
    }
    repairedNodeId = request.repairedNodeId;
  } else if (directDependencies.length === 1) {
    const only = directDependencies[0];
    if (only === undefined) {
      // Unreachable (length === 1) — kept so the narrowed type is honest.
      throw new AmbiguousRepairTargetError(runId, reviewNodeId, directDependencies);
    }
    repairedNodeId = only;
  } else {
    throw new AmbiguousRepairTargetError(runId, reviewNodeId, directDependencies);
  }
  const repaired = requireNodeState(db, { runId, nodeId: repairedNodeId });

  const mintedIds = mintExpansionNodeIds(runId, repairedNodeId, generation);
  const fixDefinition: TaskNodeDefinition = {
    id: mintedIds.fixNodeId,
    role: repaired.roleId,
    title: truncate(`fix ${repairedNodeId} (round ${String(generation)})`, 200),
    objective: buildRepairObjective({
      triggerReviewNodeId: reviewNodeId,
      candidateSha,
      findings,
      reviewNodeId: mintedIds.reviewNodeId
    }),
    dependencies: [repairedNodeId],
    capabilityTags: [],
    acceptanceCriteria: [
      `re-review node ${mintedIds.reviewNodeId} records verdict pass for the new candidateSha`
    ]
  };
  const reviewDefinition: TaskNodeDefinition = {
    id: mintedIds.reviewNodeId,
    role: "reviewer",
    title: truncate(`re-review ${repairedNodeId} (round ${String(generation)})`, 200),
    objective: buildRereviewObjective({
      fixNodeId: mintedIds.fixNodeId,
      triggerReviewNodeId: reviewNodeId,
      candidateSha
    }),
    dependencies: [mintedIds.fixNodeId],
    capabilityTags: [],
    acceptanceCriteria: ["review verdict recorded for the exact new candidateSha"]
  };

  // ACYCLICITY + BUDGET re-validation (A20 "用 dag 校验器复验扩图后的图"):
  // the FULL composed graph — every stored node plus the two minted
  // definitions — is parsed and graph-checked BEFORE any write. A rejection
  // here is a typed dag error and leaves zero rows behind.
  const storedNodes = listRunNodes(db, runId);
  const composed = {
    id: runId,
    name: truncate(`expanded-${runId}`, 200),
    nodes: [
      ...storedNodes.map((row) =>
        placeholderDefinition({ nodeId: row.nodeId, roleId: row.roleId, dependencies: row.dependencies })
      ),
      fixDefinition,
      reviewDefinition
    ]
  };
  const plan = validateWorkflowGraph(parseWorkflowDefinition(composed), {
    budgets: {
      maxNodes: budgets.budgets?.maxNodes ?? DEFAULT_GRAPH_BUDGETS.maxNodes,
      maxDepth: budgets.budgets?.maxDepth ?? DEFAULT_GRAPH_BUDGETS.maxDepth
    } satisfies GraphBudgets
  });
  if (plan.nodes.length !== storedNodes.length + 2) {
    // Defense-in-depth: the minted pair must be plain appends at the end of
    // the topological order (they depend only on pre-existing nodes).
    throw new ExpansionConflictError({
      runId,
      detail: "the minted pair is not a pure append of the stored graph"
    });
  }

  return withTransaction(db, () => {
    const insertNode = db.prepare(
      "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)"
    );
    try {
      insertNode.run(
        runId,
        fixDefinition.id,
        trigger.definitionRevision,
        fixDefinition.role,
        JSON.stringify(fixDefinition.dependencies),
        now,
        now
      );
      insertNode.run(
        runId,
        reviewDefinition.id,
        trigger.definitionRevision,
        reviewDefinition.role,
        JSON.stringify(reviewDefinition.dependencies),
        now,
        now
      );
    } catch (error) {
      if (isUniqueViolation(error, "task_nodes.run_id, task_nodes.node_id")) {
        throw new ExpansionConflictError({
          runId,
          detail:
            "a minted node id already exists in the run (a plan node literally named like the " +
            "minted id, or a concurrent expansion of the same fail)",
          cause: error
        });
      }
      throw error;
    }
    try {
      db.prepare(
        "INSERT INTO review_expansions(id, run_id, trigger_review_node_id, trigger_candidate_sha, " +
          "trigger_generation, new_generation, repaired_node_id, fix_node_id, fix_role, " +
          "review_node_id, definition_revision, verdict, findings, minted_definitions, " +
          "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fail', ?, ?, ?, ?)"
      ).run(
        expansionId,
        runId,
        reviewNodeId,
        candidateSha,
        triggerGeneration,
        generation,
        repairedNodeId,
        fixDefinition.id,
        fixDefinition.role,
        reviewDefinition.id,
        trigger.definitionRevision,
        JSON.stringify(findings),
        JSON.stringify({ fix: fixDefinition, review: reviewDefinition }),
        now,
        now
      );
    } catch (error) {
      if (
        isUniqueViolation(error, "ux_review_expansions_trigger") ||
        isUniqueViolation(error, "ux_review_expansions_fix_node") ||
        isUniqueViolation(error, "ux_review_expansions_review_node")
      ) {
        throw new ExpansionConflictError({
          runId,
          detail: "an equivalent expansion row already exists (concurrent expansion of the same fail)",
          cause: error
        });
      }
      throw error;
    }
    // PENDING fix (all deps SUCCEEDED) -> READY; the re-review stays PENDING
    // until the fix succeeds. Pure dag propagation — no new rules.
    const readinessTransitions = propagateNodeStates(db, { runId, now });
    const fixState = requireNodeState(db, { runId, nodeId: fixDefinition.id });
    const reviewState = requireNodeState(db, { runId, nodeId: reviewDefinition.id });
    return {
      created: true,
      expansionId,
      runId,
      triggerReviewNodeId: reviewNodeId,
      triggerCandidateSha: candidateSha,
      triggerGeneration,
      generation,
      repairedNodeId,
      fixNode: {
        nodeId: fixDefinition.id,
        roleId: fixDefinition.role,
        dependencies: [...fixDefinition.dependencies],
        state: fixState.state
      },
      reviewNode: {
        nodeId: reviewDefinition.id,
        roleId: reviewDefinition.role,
        dependencies: [...reviewDefinition.dependencies],
        state: reviewState.state
      },
      readinessTransitions
    };
  });
}

function replayOutcome(db: DatabaseSync, row: ReviewExpansionRow): ReviewExpansionOutcome {
  const fixState = requireNodeState(db, { runId: row.runId, nodeId: row.fixNodeId });
  const reviewState = requireNodeState(db, { runId: row.runId, nodeId: row.reviewNodeId });
  return {
    created: false,
    expansionId: row.id,
    runId: row.runId,
    triggerReviewNodeId: row.triggerReviewNodeId,
    triggerCandidateSha: row.triggerCandidateSha,
    triggerGeneration: row.triggerGeneration,
    generation: row.generation,
    repairedNodeId: row.repairedNodeId,
    fixNode: {
      nodeId: fixState.nodeId,
      roleId: fixState.roleId,
      dependencies: [...fixState.dependencies],
      state: fixState.state
    },
    reviewNode: {
      nodeId: reviewState.nodeId,
      roleId: reviewState.roleId,
      dependencies: [...reviewState.dependencies],
      state: reviewState.state
    },
    readinessTransitions: []
  };
}

// ---------------------------------------------------------------------------
// User holds
// ---------------------------------------------------------------------------

const HoldInputSchema = z.strictObject({
  runId: IdSchema,
  reviewNodeId: IdSchema,
  candidateSha: CommitShaSchema,
  attemptedGeneration: z.number().int().min(MAX_REVIEW_ROUNDS + 1).max(16),
  now: TimestampSchema
});

/**
 * Durably hold the run for user disposition (A20 "超限等待用户"). Idempotent:
 * a repeated refusal for the same trigger is absorbed into the same row. The
 * expander never resolves a hold — only `resolveRunHold` (the user's explicit
 * disposition) does.
 */
function holdRunForUser(db: DatabaseSync, input: z.output<typeof HoldInputSchema>): ExpansionHoldRow {
  const value = HoldInputSchema.parse(input);
  const id = expansionHoldIdFor(value.runId, value.reviewNodeId, value.candidateSha);
  db.prepare(
    "INSERT OR IGNORE INTO expansion_user_holds(id, run_id, review_node_id, candidate_sha, " +
      "attempted_generation, reason, created_at, resolved_at, resolution_note) " +
      "VALUES (?, ?, ?, ?, ?, 'review-rounds-exhausted', ?, NULL, NULL)"
  ).run(id, value.runId, value.reviewNodeId, value.candidateSha, value.attemptedGeneration, value.now);
  const row = db.prepare("SELECT * FROM expansion_user_holds WHERE id = ?").get(id) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    throw new Error(`expansion hold row "${id}" vanished immediately after insert`);
  }
  return mapHoldRow(row);
}

const ResolveHoldInputSchema = z.strictObject({
  runId: IdSchema,
  /** The user's disposition note (why the run may proceed / how it was decided). */
  note: z.string().min(1).max(2000),
  now: TimestampSchema
});

export type ResolveRunHoldInput = z.input<typeof ResolveHoldInputSchema>;

/**
 * Explicit user disposition of the run's unresolved hold (guarded UPDATE).
 * This is the ONLY exit from the A20 pause — and it unblocks nothing by
 * itself: the budget stays exhausted (the same fourth-round request refuses
 * again with `ReviewRoundsExhaustedError`), so resuming always requires a
 * human decision about the run, never an automatic continuation.
 */
export function resolveRunHold(db: DatabaseSync, input: ResolveRunHoldInput): ExpansionHoldRow {
  const value = ResolveHoldInputSchema.parse(input);
  const result = db
    .prepare(
      "UPDATE expansion_user_holds SET resolved_at = ?, resolution_note = ? " +
        "WHERE run_id = ? AND resolved_at IS NULL"
    )
    .run(value.now, value.note, value.runId);
  if (Number(result.changes) !== 1) {
    throw new UnknownExpansionHoldError(value.runId);
  }
  const hold = getRunUserHold(db, value.runId);
  if (hold !== null) {
    throw new Error(`hold for run "${value.runId}" still reads unresolved after resolution`);
  }
  const row = db
    .prepare(
      "SELECT * FROM expansion_user_holds WHERE run_id = ? ORDER BY resolved_at DESC, id ASC LIMIT 1"
    )
    .get(value.runId) as RawRowShape | undefined;
  if (row === undefined) {
    throw new UnknownExpansionHoldError(value.runId);
  }
  return mapHoldRow(row);
}
