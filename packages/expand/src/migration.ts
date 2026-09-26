/**
 * Migration 013 — review expansions + user holds (M4-03), the durable side of
 * docs/ORCHESTRATION.md section 5 (返工不是有环图) and docs/ACCEPTANCE.md A20.
 *
 * `review_expansions` — one row per minted repair/re-review pair:
 * - the idempotency anchor is the TRIGGER triple (run, failed review node,
 *   failed candidateSha), UNIQUE-indexed: a replayed fail resolves to the SAME
 *   row instead of minting a second pair (the deterministic derived id absorbs
 *   duplicates, the same pattern as approvals' idempotency key, A18);
 * - `trigger_generation` / `new_generation` freeze the review-round lineage
 *   at expansion time (gen1 = an original plan review node, gen n+1 = the
 *   review minted by the n-th expansion); the CHECK pins `new_generation <= 3`
 *   — `maxReviewRounds=3` INCLUDING the first review — so even a writer that
 *   bypassed the typed budget check cannot persist a fourth generation;
 * - `verdict` CHECK pins the only trigger vocabulary this table records:
 *   exactly `fail` (a `blocked` review is not an automatic rework trigger);
 * - `findings` — the failed review's findings, the fix node's durable input
 *   context; `minted_definitions` — the two complete TaskNodeDefinition
 *   payloads (strict JSON, re-validated on every read) for traceability and
 *   future executor consumption.
 *
 * `expansion_user_holds` — the "wait for user" state of a run whose fourth
 * round was refused (A20: 三轮总审查后暂停，不自动继续). One row per refused
 * (run, review node, candidateSha); UNIQUE-indexed so a repeated refusal is
 * absorbed. `resolved_at`/`resolution_note` are written ONLY by the explicit
 * user disposition (`resolveRunHold`); the expander never resolves a hold.
 *
 * FK NOTE: assumes migrations 001..012 are applied (`task_runs` is
 * referenced). Always apply via `applyExpandMigrations` / `EXPAND_MIGRATIONS`
 * — the migration framework's gap/downgrade checks make partial chains fail
 * loudly. No PRAGMA statements live in migrations.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { CHECKPOINT_MIGRATIONS } from "@role-orchestrator/checkpoint";

const EXPANSION_SCHEMA_SQL = `
CREATE TABLE review_expansions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  trigger_review_node_id TEXT NOT NULL,
  trigger_candidate_sha TEXT NOT NULL,
  trigger_generation INTEGER NOT NULL CHECK (trigger_generation >= 1),
  new_generation INTEGER NOT NULL CHECK (
    new_generation >= 2 AND new_generation = trigger_generation + 1 AND new_generation <= 3
  ),
  repaired_node_id TEXT NOT NULL,
  fix_node_id TEXT NOT NULL,
  fix_role TEXT NOT NULL CHECK (fix_role IN ('coordinator', 'architect', 'developer', 'reviewer')),
  review_node_id TEXT NOT NULL,
  definition_revision TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict = 'fail'),
  findings TEXT NOT NULL CHECK (json_type(findings) = 'array'),
  minted_definitions TEXT NOT NULL CHECK (json_type(minted_definitions) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- A20 idempotency: one expansion per (run, failed review node, failed
-- candidateSha); a replayed fail resolves to the SAME row.
CREATE UNIQUE INDEX ux_review_expansions_trigger
  ON review_expansions(run_id, trigger_review_node_id, trigger_candidate_sha);

-- The minted pair is unique inside the run even if a caller-supplied plan
-- already contains a node literally named like a minted id.
CREATE UNIQUE INDEX ux_review_expansions_fix_node ON review_expansions(run_id, fix_node_id);
CREATE UNIQUE INDEX ux_review_expansions_review_node ON review_expansions(run_id, review_node_id);

CREATE INDEX ix_review_expansions_run ON review_expansions(run_id, new_generation);

CREATE TABLE expansion_user_holds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  review_node_id TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  attempted_generation INTEGER NOT NULL CHECK (attempted_generation >= 4),
  reason TEXT NOT NULL CHECK (reason = 'review-rounds-exhausted'),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) BETWEEN 1 AND 2000),
  -- resolution evidence exists exactly when the hold is resolved
  CHECK ((resolved_at IS NULL) = (resolution_note IS NULL))
) STRICT;

-- A repeated fourth-round refusal for the same trigger is absorbed into the
-- SAME hold row (deterministic id + unique index).
CREATE UNIQUE INDEX ux_expansion_holds_trigger
  ON expansion_user_holds(run_id, review_node_id, candidate_sha);

CREATE INDEX ix_expansion_holds_run ON expansion_user_holds(run_id, resolved_at);
`.trim();

export const EXPANSION_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 13,
  name: "013-review-expansions",
  upSql: EXPANSION_SCHEMA_SQL
};

/**
 * 001 core + 002 profiles + 003 task_nodes + 004 scheduler + 005 integration
 * + 006 review + 007 context + 008 memories + 009 source/staleness
 * + 010 rebuild + 011 approvals (M4-01) + 012 approval checkpoints (M4-02)
 * + 013 review expansions (M4-03).
 */
export const EXPAND_MIGRATIONS: readonly MigrationDefinition[] = [
  ...CHECKPOINT_MIGRATIONS,
  EXPANSION_SCHEMA_MIGRATION
];

export interface ApplyExpandMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `EXPAND_MIGRATIONS` as the default list. */
export async function applyExpandMigrations(
  db: DatabaseSync,
  options: ApplyExpandMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? EXPAND_MIGRATIONS
  });
}
