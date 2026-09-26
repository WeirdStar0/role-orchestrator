/**
 * @role-orchestrator/budget — public entry point (M4-04).
 *
 * Retry classification and resource/cost budgets (A21/A22/A37):
 *  - `classifyFailureReason` / `aggregateRetryPolicy` / `evaluateRetryEligibility`
 *    — the CLOSED failure-reason -> retry-policy table: auto (A21-capped),
 *    once-then-manual (protocol/schema failures retry exactly once), and
 *    manual/recovery (cancellation, approval denial, credential lock,
 *    interrupted/observed processes, RECOVERY_REQUIRED unknown outcomes —
 *    NEVER auto re-run, A22);
 *  - `MAX_NODE_ATTEMPTS = 3` — the per-node TOTAL attempt cap; the
 *    scheduler's dispatch claim refuses a fourth attempt for any reason;
 *  - `node_retry_state` (migration 014) — the classification mirror whose
 *    CHECKs pin the A21 cap and the single conditional retry at the
 *    constraint level;
 *  - `run_budgets` + `evaluateDispatchBudgetGate` + `recordDispatchConsumption`
 *    — per-run node/execution/duration budgets, consumed INSIDE the
 *    scheduler's dispatch transaction (`BudgetExceededSignal` rolls the
 *    claim back, the `QuotaFullSignal` shape);
 *  - `execution_usage` — A37: missing usage is recorded `unavailable` with
 *    NULL numerics (a 0-fill is a constraint violation, not a value);
 *    crossing the run's undetermined-usage threshold pauses the run;
 *  - `budget_run_holds` — the "wait for the user" markers; only an explicit
 *    human resolution lifts them, and only `usage-undetermined` resolution
 *    has a scheduling effect (acceptance of unknown cost, never a re-pricing).
 *
 * Migration 014 assumes the core tables are applied: apply standalone via
 * `applyBudgetMigrations` / `BUDGET_MIGRATIONS`, or compose
 * `BUDGET_SCHEMA_MIGRATION` after a full chain (see README).
 */
export * from "./errors.js";
export * from "./ids.js";
export * from "./retry.js";
export * from "./signals.js";
export * from "./tables.js";
export * from "./migration.js";
export * from "./entities/retry-state.js";
export * from "./entities/run-budget.js";
export * from "./entities/usage.js";
export * from "./entities/holds.js";
