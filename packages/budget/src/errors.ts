/**
 * Typed error taxonomy for @role-orchestrator/budget.
 *
 * Rejections are their own classes so callers (and tests) can distinguish
 * the defect precisely; all extend `BudgetError`. Wrapping constructors keep
 * the original error as `cause`. A blocked dispatch or a refused requeue is
 * NOT an error at the scheduling layer — it is a recorded outcome — but the
 * budget package's own integrity violations (unusable rows, duplicate
 * records, attempts beyond the cap) are typed failures, never silent no-ops.
 */
export class BudgetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BudgetError";
  }
}

/**
 * A stored budget-domain row (retry state, budget, usage, hold) does not
 * match the schema it was written with. Reads re-validate strictly, so a
 * tampered or corrupted row fails closed instead of feeding a budget
 * decision with guessed numbers.
 */
export class BudgetRowIntegrityError extends BudgetError {
  readonly table: string;
  readonly rowId: string;

  constructor(table: string, rowId: string, detail: string, options?: { cause?: unknown }) {
    super(`${table} row "${rowId}" failed strict re-validation: ${detail}`, options);
    this.name = "BudgetRowIntegrityError";
    this.table = table;
    this.rowId = rowId;
  }
}

/** A second usage record was attempted for an execution that already has one. */
export class UsageAlreadyRecordedError extends BudgetError {
  readonly executionId: string;

  constructor(executionId: string, options?: { cause?: unknown }) {
    super(
      `execution "${executionId}" already has a usage record; usage is written exactly once per attempt`,
      options
    );
    this.name = "UsageAlreadyRecordedError";
    this.executionId = executionId;
  }
}

/** A usage/attempt reference to an execution id that has no executions row. */
export class UnknownExecutionError extends BudgetError {
  readonly executionId: string;

  constructor(executionId: string) {
    super(`execution "${executionId}" does not exist`);
    this.name = "UnknownExecutionError";
    this.executionId = executionId;
  }
}

/** The run already has a budget row; enrollment happens exactly once. */
export class BudgetAlreadyEnrolledError extends BudgetError {
  readonly runId: string;

  constructor(runId: string, options?: { cause?: unknown }) {
    super(
      `run "${runId}" already has an enrolled budget; limits are frozen at enrollment ` +
        "(re-scoping a budget mid-run would let a run outrun its approved bounds — create a new run instead)",
      options
    );
    this.name = "BudgetAlreadyEnrolledError";
    this.runId = runId;
  }
}

import { MAX_NODE_ATTEMPTS } from "./retry.js";

/**
 * A retry-state mirror update would record more than MAX_NODE_ATTEMPTS
 * attempts (or more than the single conditional retry). The dispatch-side
 * A21 cap makes this unreachable through the scheduler; the typed refusal
 * keeps direct callers honest too.
 */
export class AttemptBeyondCapError extends BudgetError {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;

  constructor(runId: string, nodeId: string, attempt: number, options?: { cause?: unknown }) {
    super(
      `node "${nodeId}" in run "${runId}" cannot record attempt ${String(attempt)}: ` +
        `the A21 cap allows at most ${String(MAX_NODE_ATTEMPTS)} total attempts per node`,
      options
    );
    this.name = "AttemptBeyondCapError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.attempt = attempt;
  }
}

/** A retry-state operation hit a state the mirror cannot represent. */
export class InvalidRetryStateError extends BudgetError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(runId: string, nodeId: string, detail: string, options?: { cause?: unknown }) {
    super(`retry state for "${nodeId}" in run "${runId}" is invalid: ${detail}`, options);
    this.name = "InvalidRetryStateError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/** The run has no unresolved hold with the given reason to resolve. */
export class UnknownBudgetHoldError extends BudgetError {
  readonly runId: string;
  readonly reason: string;

  constructor(runId: string, reason: string) {
    super(`run "${runId}" has no unresolved "${reason}" hold to resolve`);
    this.name = "UnknownBudgetHoldError";
    this.runId = runId;
    this.reason = reason;
  }
}
