/**
 * Migration 012 — approval checkpoints (M4-02), the durable side of
 * docs/CLI_ADAPTERS.md 审批能力不可假定一致 (node checkpoint) and
 * docs/ACCEPTANCE.md A19/A22.
 *
 * One row per (execution, proposal) that was mediated through a checkpoint:
 * the CLI ended safely, the proposal became an approval request, and the node
 * waits (WAITING_APPROVAL in the dag state machine) for the authorization
 * decision.
 *
 * - `proposal` — the STRICT action proposal exactly as extracted from the
 *   protocol event (JSON, re-validated on every read). Traceability: this is
 *   what the CLI emitted, not what the system decided.
 * - `action` / `action_digest` — the full ActionDescriptor the system built
 *   from the proposal + run context, and its canonical sha256. The digest is
 *   the SAME value the approval binds (A17); reads recompute and compare, so
 *   a tampered proposal/descriptor pair fails closed. Continuation presents
 *   this stored action for consumption unless the caller presents one
 *   explicitly (which must then digest-match).
 * - `status` CHECK — WAITING -> CONTINUED | CANCELLED. CONTINUED carries the
 *   continuation execution id + timestamp (pairing CHECKs); the guarded CAS
 *   in `continueAfterApproval` makes the continuation single-shot (有限续行).
 * - `approval_id` UNIQUE — a 1:1 checkpoint/approval pair: the checkpoint
 *   CREATES the approval, and every continuation consumes THAT approval.
 *
 * FK NOTE: assumes migrations 001..011 are applied (`executions`, `task_runs`
 * and `approvals` are referenced). Always apply via `applyCheckpointMigrations`
 * / `CHECKPOINT_MIGRATIONS` — the migration framework's gap/downgrade checks
 * make partial chains fail loudly. No PRAGMA statements live in migrations.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { APPROVAL_MIGRATIONS } from "@role-orchestrator/approval";

const CHECKPOINT_SCHEMA_SQL = `
CREATE TABLE approval_checkpoints (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  role_id TEXT NOT NULL,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  proposal_id TEXT NOT NULL,
  proposal TEXT NOT NULL CHECK (json_type(proposal) = 'object'),
  action TEXT NOT NULL CHECK (json_type(action) = 'object'),
  action_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING', 'CONTINUED', 'CANCELLED')),
  continuation_execution_id TEXT,
  continued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- continuation evidence exists exactly when the status demands it
  CHECK ((status = 'CONTINUED') = (continuation_execution_id IS NOT NULL)),
  CHECK ((status = 'CONTINUED') = (continued_at IS NOT NULL))
) STRICT;

-- A checkpoint is opened at most once per (ended execution, proposal); a
-- replayed open returns the SAME row instead of minting a second approval.
CREATE UNIQUE INDEX ux_checkpoints_execution_proposal
  ON approval_checkpoints(execution_id, proposal_id);

CREATE INDEX ix_checkpoints_run ON approval_checkpoints(run_id, status);
CREATE INDEX ix_checkpoints_node ON approval_checkpoints(run_id, node_id, status);
`.trim();

export const CHECKPOINT_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 12,
  name: "012-approval-checkpoints",
  upSql: CHECKPOINT_SCHEMA_SQL
};

/** 001..010 core chain + 011 approvals (M4-01) + 012 approval checkpoints (M4-02). */
export const CHECKPOINT_MIGRATIONS: readonly MigrationDefinition[] = [
  ...APPROVAL_MIGRATIONS,
  CHECKPOINT_SCHEMA_MIGRATION
];

export interface ApplyCheckpointMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `CHECKPOINT_MIGRATIONS` as the default list. */
export async function applyCheckpointMigrations(
  db: DatabaseSync,
  options: ApplyCheckpointMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? CHECKPOINT_MIGRATIONS
  });
}
