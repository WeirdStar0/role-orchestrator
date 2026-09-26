/**
 * Typed error taxonomy for @role-orchestrator/expand (M4-03).
 *
 * Every rejection of an expansion request is its own class so callers (and
 * tests) can distinguish the defect precisely; nothing is ever reported as a
 * generic failure. All classes extend `ExpandError`; errors that wrap an
 * original keep it as `cause`.
 *
 * Budget shape (ACCEPTANCE A20, ORCHESTRATION.md section 5):
 * - `ExpandBudgetExceededError`  — the budget base (kind + limit + actual);
 * - `ReviewRoundsExhaustedError` — the fourth-round review expansion request:
 *   `maxReviewRounds=3` counts the FIRST review, so after a third-generation
 *   review fails, no repair/re-review pair may be minted. The run is held for
 *   user disposition (see `expansion_user_holds`) — it never auto-continues.
 *
 * Graph shape: an expansion that would make the composed graph illegal does
 * NOT get its own wrapper — the dag validator's typed errors
 * (`DependencyCycleError`, `GraphBudgetExceededError`, `DuplicateNodeIdError`,
 * `UnknownDependencyError`, ...) propagate unchanged, because the composed
 * graph is re-validated BEFORE any write and the caller must see exactly
 * which dag law would have been broken.
 */
export class ExpandError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExpandError";
  }
}

export type ExpansionBudgetKind = "review-rounds";

/**
 * Budget base for expansion limits. `limit` is the configured maximum,
 * `actual` the value the request would have needed to allow.
 */
export class ExpandBudgetExceededError extends ExpandError {
  readonly kind: ExpansionBudgetKind;
  readonly runId: string;
  readonly limit: number;
  readonly actual: number;

  constructor(input: {
    readonly kind: ExpansionBudgetKind;
    readonly runId: string;
    readonly limit: number;
    readonly actual: number;
  }) {
    super(
      `expansion budget exceeded (${input.kind}) for run "${input.runId}": ` +
        `limit ${String(input.limit)}, request would need ${String(input.actual)}; ` +
        "the run is held for user disposition instead of expanding further (A20)",
      { cause: `${input.limit} < ${input.actual}` }
    );
    this.name = "ExpandBudgetExceededError";
    this.kind = input.kind;
    this.runId = input.runId;
    this.limit = input.limit;
    this.actual = input.actual;
  }
}

/**
 * The A20 fourth-round refusal. `maxReviewRounds=3` INCLUDES the first review
 * (ORCHESTRATION.md section 5: "maxReviewRounds=3 包含首次审查"), so a failed
 * third-generation review can never mint a fourth generation. Carries the
 * failed review identity and the generation that was refused so the user-
 * facing hold row and the error tell the same story.
 */
export class ReviewRoundsExhaustedError extends ExpandBudgetExceededError {
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  readonly failedGeneration: number;

  constructor(input: {
    readonly runId: string;
    readonly reviewNodeId: string;
    readonly candidateSha: string;
    /** Generation of the review node whose fail triggered the refused request (== MAX_REVIEW_ROUNDS). */
    readonly failedGeneration: number;
  }) {
    super({
      kind: "review-rounds",
      runId: input.runId,
      limit: input.failedGeneration,
      actual: input.failedGeneration + 1
    });
    this.name = "ReviewRoundsExhaustedError";
    this.reviewNodeId = input.reviewNodeId;
    this.candidateSha = input.candidateSha;
    this.failedGeneration = input.failedGeneration;
  }
}

/**
 * The expansion trigger node exists but is not a reviewer node. Only a
 * reviewer node's fail verdict drives rework expansion; a failed developer or
 * coordinator node belongs to retry classification (M4-04), not to A20.
 */
export class NotReviewNodeError extends ExpandError {
  readonly runId: string;
  readonly nodeId: string;
  readonly actualRole: string;

  constructor(runId: string, nodeId: string, actualRole: string) {
    super(
      `node "${nodeId}" of run "${runId}" has role "${actualRole}", not "reviewer"; ` +
        "only a review node's fail verdict expands the graph with a repair/re-review pair",
      { cause: actualRole }
    );
    this.name = "NotReviewNodeError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.actualRole = actualRole;
  }
}

/**
 * No durable fail verdict exists for the requested (run, review node,
 * candidateSha) triple. The expander trusts ONLY the persisted review record
 * (A12 query semantics): a `valid` lookup with verdict `fail` is the sole
 * trigger. `none` / `invalidated` lookups — and `pass` / `blocked` verdicts —
 * refuse the expansion instead of minting rework from a claim nobody recorded.
 */
export class NoFailVerdictError extends ExpandError {
  readonly runId: string;
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  /** The A12 lookup result kind that answered the trigger check. */
  readonly lookupKind: "valid" | "invalidated" | "none";
  /** The recorded verdict when the lookup was `valid` (null otherwise). */
  readonly verdict: "pass" | "fail" | "blocked" | null;

  constructor(input: {
    readonly runId: string;
    readonly reviewNodeId: string;
    readonly candidateSha: string;
    readonly lookupKind: "valid" | "invalidated" | "none";
    readonly verdict: "pass" | "fail" | "blocked" | null;
  }) {
    super(
      `no durable fail verdict for run "${input.runId}", review node "${input.reviewNodeId}", ` +
        `candidate ${input.candidateSha}: the A12 lookup answered "${input.lookupKind}"` +
        (input.verdict === null ? "" : ` with verdict "${input.verdict}"`) +
        "; expansion is triggered only by a COMPLETED fail verdict for the EXACT candidateSha",
      { cause: input.lookupKind }
    );
    this.name = "NoFailVerdictError";
    this.runId = input.runId;
    this.reviewNodeId = input.reviewNodeId;
    this.candidateSha = input.candidateSha;
    this.lookupKind = input.lookupKind;
    this.verdict = input.verdict;
  }
}

/**
 * The run has an unresolved user hold (a fourth-round request was refused
 * earlier and nobody has disposed of it). The run waits for the user: no new
 * expansion is minted anywhere in the run until the hold is explicitly
 * resolved. Replaying an ALREADY-expanded fail still returns the existing
 * pair — idempotency is read-only and cannot "continue" anything.
 */
export class RunHeldForUserError extends ExpandError {
  readonly runId: string;
  readonly holdId: string;
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  readonly attemptedGeneration: number;

  constructor(input: {
    readonly runId: string;
    readonly holdId: string;
    readonly reviewNodeId: string;
    readonly candidateSha: string;
    readonly attemptedGeneration: number;
  }) {
    super(
      `run "${input.runId}" is held for user disposition (hold "${input.holdId}", ` +
        `refused generation ${String(input.attemptedGeneration)} for review node ` +
        `"${input.reviewNodeId}" at candidate ${input.candidateSha}); ` +
        "resolve the hold explicitly before requesting further expansion (A20: 不自动继续)",
      { cause: input.holdId }
    );
    this.name = "RunHeldForUserError";
    this.runId = input.runId;
    this.holdId = input.holdId;
    this.reviewNodeId = input.reviewNodeId;
    this.candidateSha = input.candidateSha;
    this.attemptedGeneration = input.attemptedGeneration;
  }
}

/**
 * The failed review node has zero or several direct dependencies and the
 * caller did not say which one the fix node should repair. The expander never
 * guesses a repair target: the default policy is "the review's single direct
 * dependency"; anything else is an explicit caller decision.
 */
export class AmbiguousRepairTargetError extends ExpandError {
  readonly runId: string;
  readonly reviewNodeId: string;
  readonly directDependencies: readonly string[];

  constructor(runId: string, reviewNodeId: string, directDependencies: readonly string[]) {
    super(
      `review node "${reviewNodeId}" of run "${runId}" has ${String(directDependencies.length)} ` +
        `direct dependencies (${directDependencies.join(", ") || "none"}); pass repairedNodeId ` +
        "explicitly — the expander does not guess which reviewed node a fix should repair",
      { cause: String(directDependencies.length) }
    );
    this.name = "AmbiguousRepairTargetError";
    this.runId = runId;
    this.reviewNodeId = reviewNodeId;
    this.directDependencies = [...directDependencies];
  }
}

/**
 * The caller-designated repair target is not among the failed review node's
 * direct dependencies. A fix node may only repair work the failed review
 * actually reviewed — repairing something outside the reviewed scope would
 * silently detach the rework chain from its evidence.
 */
export class RepairTargetNotReviewedError extends ExpandError {
  readonly runId: string;
  readonly reviewNodeId: string;
  readonly repairedNodeId: string;
  readonly directDependencies: readonly string[];

  constructor(input: {
    readonly runId: string;
    readonly reviewNodeId: string;
    readonly repairedNodeId: string;
    readonly directDependencies: readonly string[];
  }) {
    super(
      `repair target "${input.repairedNodeId}" is not a direct dependency of review node ` +
        `"${input.reviewNodeId}" (direct dependencies: ` +
        `${input.directDependencies.join(", ") || "none"}); a fix may only repair ` +
        "work the failed review actually reviewed",
      { cause: input.repairedNodeId }
    );
    this.name = "RepairTargetNotReviewedError";
    this.runId = input.runId;
    this.reviewNodeId = input.reviewNodeId;
    this.repairedNodeId = input.repairedNodeId;
    this.directDependencies = [...input.directDependencies];
  }
}

/**
 * The idempotency row or a minted node id appeared between the pre-write
 * validation and the insert — a concurrent expansion of the same fail. This
 * is the storage-layer backstop behind the composed-graph validation (which
 * already refuses deterministic collisions as dag `DuplicateNodeIdError`)
 * and behind the replay fast path: nothing is written, the whole transaction
 * rolls back.
 */
export class ExpansionConflictError extends ExpandError {
  readonly runId: string;
  readonly detail: string;

  constructor(input: { readonly runId: string; readonly detail: string; readonly cause?: unknown }) {
    super(`expansion conflict in run "${input.runId}": ${input.detail}`, {
      cause: input.cause ?? input.detail
    });
    this.name = "ExpansionConflictError";
    this.runId = input.runId;
    this.detail = input.detail;
  }
}

/** No unresolved user hold exists for the run (or the row is already resolved). */
export class UnknownExpansionHoldError extends ExpandError {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `no unresolved expansion hold for run "${runId}"; ` +
        "only an unresolved hold can be resolved",
      { cause: runId }
    );
    this.name = "UnknownExpansionHoldError";
    this.runId = runId;
  }
}
