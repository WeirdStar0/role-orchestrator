/**
 * Migration 011 — approvals (M4-01), the store side of
 * docs/SECURITY_MODEL.md 人工审批 and docs/DOMAIN_MODEL.md Approval.
 *
 * One row per requested action approval, keyed by the caller's idempotency
 * key (A18: a replayed key MUST resolve to the SAME row — the unique index
 * plus the deterministic derived id absorb duplicates instead of minting a
 * second approval).
 *
 * - `action` / `action_digest` — the exact action (strict descriptor JSON,
 *   re-validated on every read) and its canonical sha256. A17: consumption
 *   recomputes the digest from the presented action and compares.
 * - `status` CHECK — the whole lifecycle: PENDING -> APPROVED -> CONSUMED,
 *   plus PENDING -> REJECTED / EXPIRED. Pairing CHECKs make the audit
 *   columns exist EXACTLY when the state demands them (an APPROVED row
 *   without an approver cannot exist; same for consumed/rejected).
 * - `risk_grade` / `requires_approval` / `risk_reasons` — the assessment
 *   frozen at creation time (the grader is deterministic; reads recompute
 *   and compare, so a drifted grade reads as corruption).
 * - `expires_at` — approval expiry; consumption and approval guard on it
 *   (过期审批不可消费).
 * - requester identity: run/node/attempt all-or-nothing (pairing CHECKs),
 *   with the run FK-enforced when present.
 * - consumption record: `consumed_by_execution_id` + `consumed_at`, written
 *   only by the guarded CAS UPDATE in `consumeApproval`.
 *
 * FK NOTE: assumes migrations 001..010 are applied (`task_runs` is
 * referenced). Always apply via `applyApprovalMigrations` /
 * `APPROVAL_MIGRATIONS` — the migration framework's gap/downgrade checks
 * make partial chains fail loudly. No PRAGMA statements live in migrations.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { MEMORY_SEARCH_MIGRATIONS } from "@role-orchestrator/memory-search";

const APPROVAL_SCHEMA_SQL = `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  action TEXT NOT NULL CHECK (json_type(action) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'CONSUMED', 'REJECTED', 'EXPIRED')),
  risk_grade TEXT NOT NULL CHECK (risk_grade IN ('low', 'medium', 'high')),
  requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
  risk_reasons TEXT NOT NULL CHECK (json_type(risk_reasons) = 'array'),
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex')),
  argv TEXT NOT NULL CHECK (json_type(argv) = 'array'),
  cwd TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  target_sha TEXT,
  profile_revision TEXT NOT NULL,
  permission_increments TEXT NOT NULL CHECK (json_type(permission_increments) = 'array'),
  requested_by_run_id TEXT REFERENCES task_runs(id),
  requested_by_node_id TEXT,
  requested_by_attempt INTEGER CHECK (requested_by_attempt IS NULL OR requested_by_attempt >= 1),
  approved_by TEXT,
  approved_at TEXT,
  consumed_by_execution_id TEXT,
  consumed_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  rejection_reason TEXT CHECK (rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 2000),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- audit columns exist exactly when the state demands them
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((rejected_by IS NULL) = (rejected_at IS NULL)),
  CHECK ((consumed_by_execution_id IS NULL) = (consumed_at IS NULL)),
  CHECK (status <> 'APPROVED' OR approved_by IS NOT NULL),
  CHECK (status <> 'CONSUMED' OR consumed_by_execution_id IS NOT NULL),
  CHECK (status <> 'REJECTED' OR rejected_by IS NOT NULL),
  CHECK (rejection_reason IS NULL OR rejected_by IS NOT NULL),
  -- requester identity is all-or-nothing
  CHECK ((requested_by_run_id IS NULL) = (requested_by_node_id IS NULL)),
  CHECK ((requested_by_run_id IS NULL) = (requested_by_attempt IS NULL))
) STRICT;

-- A18: a replayed idempotency key resolves to the SAME approval row.
CREATE UNIQUE INDEX ux_approvals_idempotency_key ON approvals(idempotency_key);

-- A17 consumption lookup: find live approvals for one exact digest.
CREATE INDEX ix_approvals_digest ON approvals(action_digest, status);

CREATE INDEX ix_approvals_run ON approvals(requested_by_run_id, status);
`.trim();

export const APPROVAL_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 11,
  name: "011-approvals",
  upSql: APPROVAL_SCHEMA_SQL
};

/** 001 core + 002 profiles + 003 task_nodes + 004 scheduler + 005 integration + 006 review + 007 context + 008 memories + 009 source/staleness + 010 rebuild + 011 approvals. */
export const APPROVAL_MIGRATIONS: readonly MigrationDefinition[] = [
  ...MEMORY_SEARCH_MIGRATIONS,
  APPROVAL_SCHEMA_MIGRATION
];

export interface ApplyApprovalMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `APPROVAL_MIGRATIONS` as the default list. */
export async function applyApprovalMigrations(
  db: DatabaseSync,
  options: ApplyApprovalMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? APPROVAL_MIGRATIONS
  });
}
