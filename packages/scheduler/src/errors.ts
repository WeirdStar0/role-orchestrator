/**
 * Typed error taxonomy for @role-orchestrator/scheduler.
 *
 * Rejections are their own classes so callers (and tests) can distinguish the
 * defect precisely. All classes extend `SchedulerError`; wrapping constructors
 * keep the original error as `cause`. Quota-full and gate-blocked are NOT
 * errors: they are ordinary, recorded scheduling outcomes (`pollQueue` result
 * payloads) — only genuinely unexpected states throw.
 */
export class SchedulerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SchedulerError";
  }
}

/**
 * The `concurrency` policy input failed the frozen contracts
 * `ConcurrencyPolicySchema` (strict: unknown fields, out-of-range maxima, an
 * `unverifiedCredentialGroupMax` other than the literal 1). The scheduler
 * refuses to run against a policy it could not fully validate — a partially
 * understood quota is a quota waiting to be oversubscribed.
 */
export class InvalidConcurrencyPolicyError extends SchedulerError {
  constructor(options?: { cause?: unknown }) {
    super(
      "concurrency policy rejected by the frozen contracts schema (expected strict " +
        "{ globalMax, projectMax, unverifiedCredentialGroupMax: 1 } with globalMax/projectMax in 1..64); " +
        "the scheduler never runs against an unvalidated quota",
      options
    );
    this.name = "InvalidConcurrencyPolicyError";
  }
}

/** A queue entry id was referenced (read/transition/complete) that does not exist. */
export class UnknownQueueEntryError extends SchedulerError {
  readonly entryId: string;

  constructor(entryId: string) {
    super(`scheduler queue entry "${entryId}" does not exist`);
    this.name = "UnknownQueueEntryError";
    this.entryId = entryId;
  }
}

/**
 * A queue entry was found in a state the operation does not allow (e.g.
 * completing an entry that was never DISPATCHED). Every state change is a
 * guarded UPDATE; zero affected rows land here, never in a silent overwrite.
 */
export class InvalidQueueEntryStateError extends SchedulerError {
  readonly entryId: string;
  readonly expected: readonly string[];
  readonly actual: string;

  constructor(entryId: string, expected: readonly string[], actual: string) {
    super(
      `queue entry "${entryId}" is in state "${actual}" but the operation requires one of ` +
        `[${expected.join(", ")}]`
    );
    this.name = "InvalidQueueEntryStateError";
    this.entryId = entryId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** The run referenced at enqueue/poll time has no task_runs row. */
export class UnknownRunError extends SchedulerError {
  readonly runId: string;

  constructor(runId: string) {
    super(`task run "${runId}" does not exist`);
    this.name = "UnknownRunError";
    this.runId = runId;
  }
}

/**
 * A queue entry's profile row disappeared between enqueue and dispatch.
 * Profile rows have no delete path in this repo, so this is a corruption
 * signal and fails closed instead of dispatching with guessed quota bounds.
 */
export class UnknownProfileError extends SchedulerError {
  readonly profileId: string;

  constructor(profileId: string) {
    super(`profile "${profileId}" referenced by a queue entry does not exist; refusing to guess its quota bounds`);
    this.name = "UnknownProfileError";
    this.profileId = profileId;
  }
}

/**
 * A quota grant row for (execution, dimension) already exists. The grant id is
 * derived deterministically, so this fires only when the same execution tries
 * to acquire the same dimension twice — a caller bug, refused instead of
 * double-counted.
 */
export class DuplicateGrantError extends SchedulerError {
  readonly executionId: string;
  readonly dimension: string;

  constructor(executionId: string, dimension: string, options?: { cause?: unknown }) {
    super(
      `execution "${executionId}" already holds a "${dimension}" quota grant; ` +
        "one acquisition per (execution, dimension) is enforced",
      options
    );
    this.name = "DuplicateGrantError";
    this.executionId = executionId;
    this.dimension = dimension;
  }
}

/**
 * The run is held for user disposition (an unresolved expansion_user_holds
 * row from a refused review round, or a scheduling-blocking budget hold such
 * as usage-undetermined). Held runs get NO new queue entries and their
 * already-WAITING entries are blocked at dispatch — nothing auto-continues.
 */
export class RunHeldError extends SchedulerError {
  readonly runId: string;
  readonly holds: readonly {
    readonly source: "expansion" | "budget";
    readonly reason: string;
    readonly holdId: string;
    readonly createdAt: string;
  }[];

  constructor(
    runId: string,
    holds: readonly {
      readonly source: "expansion" | "budget";
      readonly reason: string;
      readonly holdId: string;
      readonly createdAt: string;
    }[]
  ) {
    super(
      `run "${runId}" is held for user disposition ` +
        `(${holds.map((hold) => `${hold.source}:${hold.reason}`).join(", ")}); ` +
        "held runs enqueue nothing and dispatch nothing until a human resolves the hold"
    );
    this.name = "RunHeldError";
    this.runId = runId;
    this.holds = holds;
  }
}

/**
 * The node is not in FAILED, so there is nothing to requeue (only
 * FAILED -> RETRY_PENDING -> READY is a retry path). Every state change is a
 * guarded transition; a requeue against any other state is a caller bug,
 * refused instead of guessed around.
 */
export class RequeueNotAllowedError extends SchedulerError {
  readonly runId: string;
  readonly nodeId: string;
  readonly state: string;

  constructor(runId: string, nodeId: string, state: string) {
    super(
      `node "${nodeId}" in run "${runId}" is in state "${state}"; ` +
        "only a FAILED node can be requeued for a retry"
    );
    this.name = "RequeueNotAllowedError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.state = state;
  }
}

/**
 * The failure classification refuses an automatic retry (policy manual or
 * recovery — cancelled, approval-denied, credential-locked, interrupted or
 * observed processes, RECOVERY_REQUIRED unknown outcomes, A22). The node
 * stays FAILED; a human decides what happens next.
 */
export class NonRetryableFailureError extends SchedulerError {
  readonly runId: string;
  readonly nodeId: string;
  readonly policy: string;
  readonly reasons: readonly string[];

  constructor(
    runId: string,
    nodeId: string,
    policy: string,
    reasons: readonly string[]
  ) {
    super(
      `failure of node "${nodeId}" in run "${runId}" classified "${policy}" ` +
        `(reasons: ${reasons.join(", ")}); automatic retry is refused — the node waits for a user decision`
    );
    this.name = "NonRetryableFailureError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.policy = policy;
    this.reasons = reasons;
  }
}

/**
 * The node's A21 attempt budget is exhausted (three total attempts); the
 * run is held behind an `attempts-exhausted` hold and the fourth attempt
 * never happens.
 */
export class AttemptsExhaustedError extends SchedulerError {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempts: number;
  readonly holdId: string;

  constructor(runId: string, nodeId: string, attempts: number, holdId: string) {
    super(
      `node "${nodeId}" in run "${runId}" has consumed its ${String(attempts)} ` +
        `total attempts (A21); no automatic retry is created — hold "${holdId}" waits for the user`
    );
    this.name = "AttemptsExhaustedError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.attempts = attempts;
    this.holdId = holdId;
  }
}

/**
 * The node already consumed its single once-then-manual retry (protocol /
 * business-schema failures); the second occurrence needs a human.
 */
export class ConditionalRetryExhaustedError extends SchedulerError {
  readonly runId: string;
  readonly nodeId: string;
  readonly policy: string;

  constructor(runId: string, nodeId: string, policy: string) {
    super(
      `node "${nodeId}" in run "${runId}" already used its single "${policy}" retry; ` +
        "a second occurrence waits for a user decision"
    );
    this.name = "ConditionalRetryExhaustedError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.policy = policy;
  }
}
