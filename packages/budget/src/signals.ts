import type { BudgetBlockReason } from "./entities/run-budget.js";

/**
 * Signals for the budget domain — the `QuotaFullSignal` shape of the quota
 * grants, reused for budget limits. Thrown INSIDE the scheduler's dispatch
 * claim transaction: the throw rolls back every write of the claim, which is
 * exactly the all-or-nothing property the claim needs. They are ordinary,
 * recorded scheduling outcomes at the caller level, never crashes.
 */
export class BudgetExceededSignal extends Error {
  readonly reason: BudgetBlockReason;
  readonly detail: string;

  constructor(reason: BudgetBlockReason, detail: string) {
    super(`budget exceeded (${reason}): ${detail}`);
    this.name = "BudgetExceededSignal";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * The dispatch would create an attempt beyond `MAX_NODE_ATTEMPTS` (A21).
 * Thrown inside the claim transaction (the attempt count is re-read under
 * `BEGIN IMMEDIATE`, so the check is race-free); the scheduler records the
 * refusal on the queue row instead of ever creating the attempt.
 */
export class AttemptCapExceededSignal extends Error {
  readonly entryId: string;
  readonly observedAttempts: number;

  constructor(entryId: string, observedAttempts: number) {
    super(
      `attempt cap exceeded for queue entry "${entryId}": ` +
        `${String(observedAttempts)} attempts already recorded for the slot`
    );
    this.name = "AttemptCapExceededSignal";
    this.entryId = entryId;
    this.observedAttempts = observedAttempts;
  }
}
