import type { MigrationDefinition } from "./migrations.js";
import { ACTIVE_ATTEMPT_PHASES } from "./entities/executions.js";

/**
 * Migration 001 — the minimal M1-01 core tables, named after
 * `docs/DOMAIN_MODEL.md` (Project, TaskRun, Execution, ResourceLease,
 * ExecutionEvent, Outbox):
 *
 * - `projects`     — canonical repo root, one project per root.
 * - `task_runs`    — one frozen-config execution of a task.
 * - `executions`   — one process attempt; carries the A23 constraint.
 * - `leases`       — resource leases with per-resource monotonic fencing.
 * - `events`       — per-execution durable events, replay-idempotent by id.
 * - `outbox`       — messages committed in the SAME transaction as the
 *                    business write; dispatch uses lease semantics.
 *
 * Interpretations pinned here (kept minimal for M1-01):
 * - Task run statuses are the aggregate states named in `docs/ORCHESTRATION.md`
 *   section 3 (PLANNED/RUNNING/READY_FOR_DELIVERY/DELIVERED/CANCELLED).
 * - Execution phases are the phases from the same section; the partial unique
 *   index treats PREPARING/STARTING/RUNNING/FINALIZING as "active".
 * - `task_runs.task_id` has no FK because the `tasks` table is not part of the
 *   M1-01 minimal table set (it arrives with later milestones).
 *
 * The phase list in the partial index is interpolated from the same
 * `ACTIVE_ATTEMPT_PHASES` constant the TypeScript layer validates against, so
 * SQL and code cannot drift apart. No PRAGMA statements live in migrations:
 * journal mode and friends are connection concerns handled by `openDatabase`.
 */
const ACTIVE_PHASE_LIST_SQL = ACTIVE_ATTEMPT_PHASES.map((phase) => `'${phase}'`).join(", ");

const INITIAL_SCHEMA_SQL = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('windows-native', 'wsl', 'linux-native', 'macos-native')),
  trust_status TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- DOMAIN_MODEL: "canonical repoRoot" — one project per canonical repository root.
CREATE UNIQUE INDEX ux_projects_repo_root ON projects(repo_root);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  graph_revision INTEGER NOT NULL CHECK (graph_revision >= 0),
  config_snapshot_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'RUNNING', 'READY_FOR_DELIVERY', 'DELIVERED', 'CANCELLED')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  definition_revision TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('PREPARING', 'STARTING', 'RUNNING', 'FINALIZING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED')),
  dispatch_token TEXT NOT NULL,
  session_id TEXT,
  pid_identity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, node_id, definition_revision, attempt)
) STRICT;

CREATE UNIQUE INDEX ux_executions_dispatch_token ON executions(dispatch_token);

-- A23: at most one ACTIVE attempt per (run, node) slot. This is the
-- constraint-level guarantee that after "DB commit, crash before process
-- start", reconcile can free the slot but no second dispatch can be created
-- while the first attempt is still active.
CREATE UNIQUE INDEX ux_executions_one_active_per_slot
  ON executions(run_id, node_id)
  WHERE phase IN (${ACTIVE_PHASE_LIST_SQL});

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  resource_key TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  expires_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- DOMAIN_MODEL: "同一节点同一 revision 最多一个有效 writer lease".
CREATE UNIQUE INDEX ux_leases_one_live_per_resource
  ON leases(resource_key)
  WHERE released_at IS NULL;

CREATE INDEX ix_leases_resource_history ON leases(resource_key, fencing_token);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  checksum TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (execution_id, seq)
) STRICT;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_token TEXT,
  claim_expires_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- Dispatch scan: pending messages in FIFO order; partial keeps it small.
CREATE INDEX ix_outbox_dispatch ON outbox(created_at, id) WHERE published_at IS NULL;
`.trim();

export const INITIAL_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 1,
  name: "001-initial-core-tables",
  upSql: INITIAL_SCHEMA_SQL
};

export const DEFAULT_MIGRATIONS: readonly MigrationDefinition[] = [INITIAL_SCHEMA_MIGRATION];
