import type { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult,
  type MigrationDefinition
} from "@role-orchestrator/store";
import { DAG_MIGRATIONS } from "@role-orchestrator/dag";

/**
 * Migration 004 — scheduler quota grants + fair queue (M2-02).
 *
 * - `quota_grants` — counted multi-holder extension of the store lease
 *   semantics (DOMAIN_MODEL `ResourceLease`): one row per (execution,
 *   dimension) acquisition, hierarchical `resource_key`
 *   (`global` / `project:<id>` / `profile:<id>` / `credential:<id>`),
 *   per-key monotonic `fencing_token` derived as `MAX+1` inside the claim
 *   transaction. `ux_quota_grants_key_token` makes a duplicate fencing token
 *   per key impossible at the CONSTRAINT level — the A07 "fencing 无重复授
 *   予" property holds even across processes. Unlike `leases` (one live
 *   holder per resource), grants are COUNTED: the limit lives in policy, the
 *   table counts live rows per key. An expired grant is NOT stolen
 *   automatically ("超时只代表需 reconcile"): it still counts until
 *   `releaseExpiredQuotaGrants` explicitly frees it.
 *
 * - `scheduler_queue` — the fair READY queue. One row per (run, node) via
 *   `UNIQUE(run_id, node_id)`, so a re-enqueue is absorbed instead of
 *   duplicated. `state` covers WAITING -> DISPATCHED -> COMPLETED with the
 *   recorded rejections GATE_BLOCKED and the explicit CANCELLED. `priority`
 *   then `enqueued_at` is the fair order (ORCHESTRATION.md section 4), with
 *   `attempts` + `not_before` forming the retry window after a quota
 *   rejection — entries are never dropped or reordered away.
 *
 * FK NOTE: assumes migrations 001 (core tables: `executions`, `task_runs`,
 * `projects`), 002 (profiles) and 003 (task_nodes) are applied. Always apply
 * via `applySchedulerMigrations` / `SCHEDULER_MIGRATIONS`; the store
 * framework's gap check makes partial history fail loudly. No PRAGMA
 * statements live in migrations (connection concerns are `openDatabase`'s).
 */

const SCHEDULER_SCHEMA_SQL = `
CREATE TABLE quota_grants (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  dimension TEXT NOT NULL CHECK (dimension IN ('global', 'project', 'profile', 'credential')),
  resource_key TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  granted_at TEXT NOT NULL
) STRICT;

-- A07 backstop: per key, fencing tokens are unique across ALL grants (live or
-- released). The claim transaction derives MAX+1 under BEGIN IMMEDIATE; this
-- index turns "no duplicate grant" into a constraint, not a convention.
CREATE UNIQUE INDEX ux_quota_grants_key_token ON quota_grants(resource_key, fencing_token);

CREATE INDEX ix_quota_grants_live ON quota_grants(resource_key, released_at);
CREATE INDEX ix_quota_grants_execution ON quota_grants(execution_id, released_at);

CREATE TABLE scheduler_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  credential_group TEXT NOT NULL,
  required_capability TEXT,
  priority INTEGER NOT NULL CHECK (priority >= 0 AND priority <= 1000),
  state TEXT NOT NULL CHECK (state IN ('WAITING', 'DISPATCHED', 'COMPLETED', 'GATE_BLOCKED', 'CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  not_before TEXT NOT NULL,
  execution_id TEXT REFERENCES executions(id),
  last_reason TEXT,
  enqueued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, node_id)
) STRICT;

CREATE INDEX ix_scheduler_queue_poll ON scheduler_queue(state, priority, enqueued_at, id);
CREATE INDEX ix_scheduler_queue_run ON scheduler_queue(run_id, node_id);
`.trim();

export const SCHEDULER_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 4,
  name: "004-quota-grants-and-scheduler-queue",
  upSql: SCHEDULER_SCHEMA_SQL
};

/**
 * The migration list every consumer of this package must apply: store core
 * tables (001) + profile tables (002) + task_nodes (003) + scheduler tables
 * (004).
 */
export const SCHEDULER_MIGRATIONS: readonly MigrationDefinition[] = [
  ...DAG_MIGRATIONS,
  SCHEDULER_SCHEMA_MIGRATION
];

export interface ApplySchedulerMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `SCHEDULER_MIGRATIONS` as the default list. */
export async function applySchedulerMigrations(
  db: DatabaseSync,
  options: ApplySchedulerMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? SCHEDULER_MIGRATIONS
  });
}
