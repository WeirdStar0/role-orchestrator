/**
 * Migration 008 — shared memory (M3-02), the store side of
 * `docs/MEMORY_AND_CONTEXT.md` sections 2/3/6:
 *
 * - `memories`          — one row per memory entry, project-scoped
 *   (`scope = 'project'` is a CHECK; M3-03 adds the authorization layer on
 *   top of the same column). Status/version/content/content_hash live here;
 *   CHECK constraints pin the semantics:
 *     * temporary memories MUST carry `expires_at` (执行范围，过期清理),
 *       every other type MUST NOT;
 *     * `active` exists only for `project_rule` (promotion is the only way
 *       in, and it is user-only at the API layer);
 *     * the promotion audit trio (promoted_by/promoted_via/promoted_at) is
 *       present EXACTLY when status = 'active' — an active rule without its
 *       human-promotion audit trail cannot exist;
 *     * verified/disputed actor+timestamp columns are paired.
 *   The partial unique index `ux_memories_live_content` enforces content
 *   addressing among LIVE entries: re-proposing identical content absorbs
 *   into the existing row (idempotent retries never duplicate history), the
 *   same absorb property context_bundles and the scheduler queue have.
 *
 * - `memory_revisions`  — append-only history: every lifecycle transition
 *   writes the resulting (version, status, content, content_hash). Old values
 *   are RETAINED (docs section 3: 所有更新增加 revision，保留旧值), and the
 *   in-place superseded relation is `memories.supersedes_version` pointing at
 *   the previous version.
 *
 * - `memory_events`     — AUDIT SELECTION: memory audit lands in this
 *   dedicated table, NOT in the migration-001 `events` table. Reason: `events`
 *   is per-execution (NOT NULL execution_id FK + UNIQUE(execution_id, seq)),
 *   but the decisive memory transitions are USER-initiated promotions that
 *   happen OUTSIDE any execution — there is no execution id to hang them on.
 *   The dedicated table keeps the full trail (proposed/verified/promoted/
 *   disputed/updated/expired plus the REFUSALS: promotion-rejected and
 *   cas-conflict) queryable per memory, in the same transaction as the write
 *   it audits.
 *
 * FK NOTE: assumes migrations 001..007 are applied (`projects` is
 * referenced). Always apply via `applyMemoryMigrations` / `MEMORY_MIGRATIONS`
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
import { CONTEXT_MIGRATIONS } from "@role-orchestrator/context";

const MEMORY_SCHEMA_SQL = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  scope TEXT NOT NULL CHECK (scope = 'project'),
  type TEXT NOT NULL CHECK (type IN ('temporary', 'fact', 'discovery', 'decision', 'project_rule')),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'verified', 'active', 'disputed', 'superseded', 'expired')),
  version INTEGER NOT NULL CHECK (version >= 1),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  content_hash TEXT NOT NULL,
  evidence_refs TEXT NOT NULL CHECK (json_type(evidence_refs) = 'array'),
  author_execution_id TEXT,
  proposed_by TEXT NOT NULL,
  proposed_by_role TEXT NOT NULL CHECK (proposed_by_role IN ('coordinator', 'architect', 'developer', 'reviewer')),
  expires_at TEXT,
  verified_by TEXT,
  verified_at TEXT,
  disputed_by TEXT,
  disputed_at TEXT,
  promoted_by TEXT,
  promoted_via TEXT,
  promoted_at TEXT,
  supersedes_version INTEGER CHECK (supersedes_version IS NULL OR supersedes_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
  CHECK ((disputed_by IS NULL) = (disputed_at IS NULL)),
  -- temporary is execution-scoped and must expire; other types must not carry
  -- a hidden auto-expiry semantic.
  CHECK ((type = 'temporary') = (expires_at IS NOT NULL)),
  -- active is reachable only by project_rule (user promotion is the only path in).
  CHECK (status <> 'active' OR type = 'project_rule'),
  -- the promotion audit trail exists exactly when the rule is active.
  CHECK (
    (status = 'active' AND promoted_by IS NOT NULL AND promoted_via IS NOT NULL AND promoted_at IS NOT NULL)
    OR
    (status <> 'active' AND promoted_by IS NULL AND promoted_via IS NULL AND promoted_at IS NULL)
  )
) STRICT;

-- Content addressing among LIVE entries: an identical (project, type,
-- content) re-proposal absorbs into the existing row instead of duplicating
-- it. Disputed/superseded/expired rows do not participate, so a fresh
-- proposal of previously-challenged content is a NEW memory, not a revival.
CREATE UNIQUE INDEX ux_memories_live_content
  ON memories(project_id, type, content_hash)
  WHERE status IN ('proposed', 'verified', 'active');

CREATE INDEX ix_memories_project ON memories(project_id, type, status, created_at);

CREATE TABLE memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'verified', 'active', 'disputed', 'superseded', 'expired')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  content_hash TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('propose', 'verify', 'promote', 'dispute', 'update', 'expire')),
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, version)
) STRICT;

CREATE TABLE memory_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  type TEXT NOT NULL CHECK (type IN (
    'proposed', 'verified', 'promoted', 'disputed', 'updated', 'expired',
    'promotion-rejected', 'cas-conflict'
  )),
  actor TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_type(payload) = 'object'),
  occurred_at TEXT NOT NULL,
  UNIQUE (memory_id, seq)
) STRICT;

CREATE INDEX ix_memory_events_memory ON memory_events(memory_id, seq);
`.trim();

export const MEMORY_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 8,
  name: "008-memories",
  upSql: MEMORY_SCHEMA_SQL
};

/** 001 core + 002 profiles + 003 task_nodes + 004 scheduler + 005 integration + 006 review + 007 context + 008 memories. */
export const MEMORY_MIGRATIONS: readonly MigrationDefinition[] = [
  ...CONTEXT_MIGRATIONS,
  MEMORY_SCHEMA_MIGRATION
];

export interface ApplyMemoryMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `MEMORY_MIGRATIONS` as the default list. */
export async function applyMemoryMigrations(
  db: DatabaseSync,
  options: ApplyMemoryMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? MEMORY_MIGRATIONS
  });
}
