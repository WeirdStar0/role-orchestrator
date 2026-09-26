import type { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  DEFAULT_MIGRATIONS,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult,
  type MigrationDefinition
} from "@role-orchestrator/store";

/**
 * Migration 0002 — Profile and role-binding tables (M1-02), named after
 * `docs/DOMAIN_MODEL.md` (ProfileRevision, RoleBinding) and D03 (the TaskRun
 * config snapshot):
 *
 * - `profiles`              — one local CLI runtime environment; authentication
 *                             stays with the CLI (R11), nothing here stores or
 *                             hashes credential material.
 * - `profile_revisions`     — IMMUTABLE, append-only revisions
 *                             (UNIQUE(profile_id, revision)) carrying the
 *                             model expectation and the external-config
 *                             baseline (hash + the explicit non-credential
 *                             file manifest).
 * - `role_bindings`         — the four fixed roles, at most one row per
 *                             (project, role) via UNIQUE; a binding points at
 *                             an EXISTING profile revision through the
 *                             composite foreign key, or is unbound (NULL).
 * - `run_profile_snapshots` — A34 immutable half: the role -> profile revision
 *                             resolution frozen at TaskRun creation. Service
 *                             reads go through these rows, never through
 *                             current bindings.
 *
 * FK NOTE: this migration assumes migration 001 (core tables) is applied —
 * `projects` and `task_runs` are referenced. Always apply
 * `RUNTIME_PROFILE_MIGRATIONS` (001 + 002); the store migration framework's
 * gap check makes partial history application fail loudly anyway.
 */
const PROFILE_SCHEMA_SQL = `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL CHECK (runtime IN ('claude', 'codex')),
  executable TEXT NOT NULL,
  execution_target TEXT NOT NULL CHECK (execution_target IN ('windows-native', 'wsl', 'linux-native', 'macos-native')),
  config_dir TEXT NOT NULL,
  credential_group TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency >= 1 AND max_concurrency <= 32),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds >= 30 AND timeout_seconds <= 86400),
  created_at TEXT NOT NULL
) STRICT;

-- Immutable revisions: append-only. There is deliberately no UPDATE/DELETE
-- path anywhere in this package. external_config_hash is the sha256 manifest
-- baseline over the EXPLICITLY declared non-credential files.
CREATE TABLE profile_revisions (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  model TEXT,
  external_config_hash TEXT NOT NULL,
  external_config_files TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, revision)
) STRICT;

CREATE INDEX ix_profile_revisions_profile ON profile_revisions(profile_id, revision);

-- DOMAIN_MODEL RoleBinding: projectId, roleId, profileId, permissionsRevision.
-- The CHECK pins role_id to the four built-in roles (A03); UNIQUE(project_id,
-- role_id) makes it exactly one binding per role (A01). profile_id/profile_
-- revision are both NULL while unbound; when set they must reference an
-- existing profile revision (composite FK).
CREATE TABLE role_bindings (
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT NOT NULL CHECK (role_id IN ('coordinator', 'architect', 'developer', 'reviewer')),
  profile_id TEXT REFERENCES profiles(id),
  profile_revision INTEGER,
  permissions_revision TEXT NOT NULL,
  can_create_subtasks INTEGER NOT NULL CHECK (can_create_subtasks IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, role_id),
  CHECK (
    (profile_id IS NULL AND profile_revision IS NULL)
    OR (profile_id IS NOT NULL AND profile_revision IS NOT NULL)
  ),
  FOREIGN KEY (profile_id, profile_revision) REFERENCES profile_revisions(profile_id, revision)
) STRICT;

CREATE INDEX ix_role_bindings_profile ON role_bindings(profile_id);

-- A34 immutable half: frozen at run creation, never updated afterwards.
CREATE TABLE run_profile_snapshots (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  role_id TEXT NOT NULL CHECK (role_id IN ('coordinator', 'architect', 'developer', 'reviewer')),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  snapshot_json TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, role_id),
  FOREIGN KEY (profile_id, profile_revision) REFERENCES profile_revisions(profile_id, revision)
) STRICT;

CREATE INDEX ix_run_profile_snapshots_profile
  ON run_profile_snapshots(run_id, profile_id, profile_revision);
`.trim();

export const PROFILE_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 2,
  name: "002-profiles-and-role-bindings",
  upSql: PROFILE_SCHEMA_SQL
};

/**
 * The migration list every consumer of this package must apply: store's core
 * tables (001) plus the profile tables (002). A database migrated ONLY with
 * the store package's `DEFAULT_MIGRATIONS` predates profiles and will fail
 * `verifyMigrations` against this list with `unknown-applied-version` only in
 * the downgrade direction — the framework refuses to operate on schemas it
 * does not know, which is the intended fail-closed behavior.
 */
export const RUNTIME_PROFILE_MIGRATIONS: readonly MigrationDefinition[] = [
  ...DEFAULT_MIGRATIONS,
  PROFILE_SCHEMA_MIGRATION
];

export interface ApplyRuntimeProfileMigrationsOptions extends ApplyMigrationsOptions {}

/**
 * `applyMigrations` with `RUNTIME_PROFILE_MIGRATIONS` as the default list.
 * Supports the same `now` / `backupPath` / `migrations` options.
 */
export async function applyRuntimeProfileMigrations(
  db: DatabaseSync,
  options: ApplyRuntimeProfileMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? RUNTIME_PROFILE_MIGRATIONS
  });
}
