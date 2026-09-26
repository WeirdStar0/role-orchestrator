import type { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult,
  type MigrationDefinition
} from "@role-orchestrator/store";
import { RUNTIME_PROFILE_MIGRATIONS } from "@role-orchestrator/runtime-profile";
import { NODE_STATES } from "./states.js";

/**
 * Migration 003 — `task_nodes` (M2-01), the node-level half of
 * `docs/DOMAIN_MODEL.md`'s TaskNode entity:
 *
 * - one row per (run, node): `UNIQUE(run_id, node_id)`;
 * - `role_id` CHECKed to the four built-in roles (A03 at the constraint
 *   level, mirroring `role_bindings`);
 * - `dependencies` is the FROZEN dependency snapshot taken at run-graph
 *   creation (JSON array of node ids; `json_type` CHECK rejects non-arrays
 *   and invalid JSON) — "运行定义不可原地改变";
 * - `state` CHECKed to exactly the eleven node states of the
 *   ORCHESTRATION.md section-3 machine (list interpolated from the same
 *   `NODE_STATES` constant the TypeScript layer validates against, so SQL
 *   and code cannot drift apart);
 * - `definition_revision` records which workflow definition revision the row
 *   was created from.
 *
 * FK NOTE: assumes migrations 001 (core tables) and 002 (profiles) are
 * applied — `task_runs` is referenced. Always apply via
 * `applyDagMigrations` / `DAG_MIGRATIONS`; the store migration framework's
 * gap check makes partial history application fail loudly anyway. No PRAGMA
 * statements live in migrations (connection concerns are `openDatabase`'s).
 */

const NODE_STATE_LIST_SQL = NODE_STATES.map((state) => `'${state}'`).join(", ");

const TASK_NODES_SQL = `
CREATE TABLE task_nodes (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  definition_revision TEXT NOT NULL,
  role_id TEXT NOT NULL CHECK (role_id IN ('coordinator', 'architect', 'developer', 'reviewer')),
  dependencies TEXT NOT NULL CHECK (json_type(dependencies) = 'array'),
  state TEXT NOT NULL CHECK (state IN (${NODE_STATE_LIST_SQL})),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, node_id)
) STRICT;

CREATE INDEX ix_task_nodes_run_state ON task_nodes(run_id, state);
`.trim();

export const TASK_NODES_MIGRATION: MigrationDefinition = {
  version: 3,
  name: "003-task-nodes",
  upSql: TASK_NODES_SQL
};

/**
 * The migration list every consumer of this package must apply: store core
 * tables (001) + profile tables (002) + task_nodes (003).
 */
export const DAG_MIGRATIONS: readonly MigrationDefinition[] = [
  ...RUNTIME_PROFILE_MIGRATIONS,
  TASK_NODES_MIGRATION
];

export interface ApplyDagMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `DAG_MIGRATIONS` as the default list. */
export async function applyDagMigrations(
  db: DatabaseSync,
  options: ApplyDagMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? DAG_MIGRATIONS
  });
}
