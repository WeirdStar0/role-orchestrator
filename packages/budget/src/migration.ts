import type { DatabaseSync } from "node:sqlite";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { DAG_MIGRATIONS } from "@role-orchestrator/dag";
import { MAX_CONDITIONAL_RETRIES, MAX_NODE_ATTEMPTS } from "./retry.js";

/**
 * Migration 014 — retry state, run budgets, usage records and budget holds
 * (M4-04), the durable side of docs/ORCHESTRATION.md section 6 (重试分类)
 * and docs/ACCEPTANCE.md A21/A22/A37.
 *
 * `node_retry_state` — the per-node retry mirror. The SOURCE OF TRUTH for
 * attempt counting is the `executions` table (the A23 slot rows, one per
 * process attempt); this mirror records the classification context of the
 * latest failure so the controlled requeue can decide without re-deriving
 * policy. Constraint-level backstops: `total_attempts <=
 * ${MAX_NODE_ATTEMPTS}` (A21 — even a writer that bypassed every typed check
 * cannot persist a fourth attempt) and `conditional_retries_used <=
 * ${MAX_CONDITIONAL_RETRIES}` (once-then-manual is one retry, then human).
 *
 * `run_budgets` — per-run resource budget (LimitsPolicy vocabulary: nodes,
 * executions, plus a duration ceiling), enrolled once per run. The
 * consumption counters are written INSIDE the scheduler's dispatch
 * transaction; the CHECKs `nodes_used <= max_nodes` /
 * `executions_used <= max_executions` make an oversubscribed row
 * structurally impossible even across processes.
 *
 * `execution_usage` — A37 usage records. `usage_status='unavailable'` is the
 * ONLY representation of missing usage and carries NULL numerics — the
 * pairing CHECKs make a 0-fill ("记录为 0 美元") structurally impossible.
 * `price_status='unknown'` records a priced-out-of-band usage (missingPrice
 * vocabulary of UsagePolicy) with no invented cost.
 *
 * `budget_run_holds` — the "wait for the user" state of a paused run
 * (attempts exhausted, a budget ceiling reached, usage undeterminable).
 * One row per (run, reason), UNIQUE-indexed so a repeated pause is absorbed.
 * `resolved_at`/`resolution_note` are written ONLY by the explicit human
 * disposition (`resolveBudgetRunHold`); nothing in this package resolves a
 * hold on its own.
 *
 * FK NOTE: assumes migrations 001 (core tables: `executions`, `task_runs`)
 * — and therefore the composed chains that include them — are applied. The
 * standalone chain here is 001+002+003+014 (`DAG_MIGRATIONS` + this
 * migration); full-chain consumers compose `BUDGET_SCHEMA_MIGRATION` after
 * their own list (e.g. `[...EXPAND_MIGRATIONS, BUDGET_SCHEMA_MIGRATION]`).
 * The store framework's gap/downgrade checks make partial history fail
 * loudly. No PRAGMA statements live in migrations (connection concerns are
 * `openDatabase`'s).
 */

const BUDGET_SCHEMA_SQL = `
CREATE TABLE node_retry_state (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  total_attempts INTEGER NOT NULL CHECK (
    total_attempts >= 0 AND total_attempts <= ${MAX_NODE_ATTEMPTS}
  ),
  conditional_retries_used INTEGER NOT NULL CHECK (
    conditional_retries_used >= 0 AND conditional_retries_used <= ${MAX_CONDITIONAL_RETRIES}
  ),
  last_failure_reasons TEXT CHECK (
    last_failure_reasons IS NULL OR json_type(last_failure_reasons) = 'array'
  ),
  last_retry_policy TEXT CHECK (
    last_retry_policy IS NULL OR
    last_retry_policy IN ('auto', 'once-then-manual', 'manual', 'recovery')
  ),
  exhausted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, node_id)
) STRICT;

CREATE TABLE run_budgets (
  run_id TEXT PRIMARY KEY REFERENCES task_runs(id),
  max_nodes INTEGER NOT NULL CHECK (max_nodes BETWEEN 1 AND 256),
  max_executions INTEGER NOT NULL CHECK (max_executions BETWEEN 1 AND 1024),
  max_duration_ms INTEGER NOT NULL CHECK (max_duration_ms BETWEEN 1 AND 2147483647),
  undetermined_usage_limit INTEGER NOT NULL CHECK (undetermined_usage_limit BETWEEN 1 AND 1024),
  nodes_used INTEGER NOT NULL CHECK (nodes_used >= 0),
  executions_used INTEGER NOT NULL CHECK (executions_used >= 0),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (nodes_used <= max_nodes),
  CHECK (executions_used <= max_executions)
) STRICT;

CREATE TABLE execution_usage (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  usage_status TEXT NOT NULL CHECK (usage_status IN ('recorded', 'unavailable')),
  price_status TEXT NOT NULL CHECK (price_status IN ('known', 'unknown')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  usd_cost_micros INTEGER CHECK (usd_cost_micros IS NULL OR usd_cost_micros >= 0),
  recorded_at TEXT NOT NULL,
  -- A37: an unavailable record has NO numerics at all — never zeros. The
  -- pairing makes "record usage as 0" a constraint violation, not a value.
  CHECK (
    (usage_status = 'recorded') =
      (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
  ),
  CHECK ((price_status = 'known') = (usd_cost_micros IS NOT NULL))
) STRICT;

CREATE INDEX ix_execution_usage_run ON execution_usage(run_id, usage_status);

CREATE TABLE budget_run_holds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  reason TEXT NOT NULL CHECK (reason IN (
    'attempts-exhausted',
    'node-budget-exhausted',
    'execution-budget-exhausted',
    'duration-budget-exhausted',
    'usage-undetermined'
  )),
  detail TEXT NOT NULL CHECK (json_type(detail) = 'object'),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) BETWEEN 1 AND 2000),
  -- resolution evidence exists exactly when the hold is resolved
  CHECK ((resolved_at IS NULL) = (resolution_note IS NULL)),
  UNIQUE (run_id, reason)
) STRICT;

CREATE INDEX ix_budget_holds_run ON budget_run_holds(run_id, resolved_at);
`.trim();

export const BUDGET_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 14,
  name: "014-retry-state-and-run-budgets",
  upSql: BUDGET_SCHEMA_SQL
};

/**
 * The standalone migration list for consumers that need ONLY the core +
 * profile + node tables and the budget domain: 001 core + 002 profiles +
 * 003 task_nodes + 014 budget. Full-chain consumers (scheduler/expand and
 * beyond) compose `BUDGET_SCHEMA_MIGRATION` after their own list instead.
 */
export const BUDGET_MIGRATIONS: readonly MigrationDefinition[] = [
  ...DAG_MIGRATIONS,
  BUDGET_SCHEMA_MIGRATION
];

export interface ApplyBudgetMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `BUDGET_MIGRATIONS` as the default list. */
export async function applyBudgetMigrations(
  db: DatabaseSync,
  options: ApplyBudgetMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? BUDGET_MIGRATIONS
  });
}
