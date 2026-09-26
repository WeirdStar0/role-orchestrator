/**
 * Migrations 009 + 010 — the store side of M3-03, composed as
 * `MEMORY_SEARCH_MIGRATIONS = MEMORY_MIGRATIONS + 009 + 010`.
 *
 * 009 — memory source references and staleness (docs/MEMORY_AND_CONTEXT.md
 * section 6: 基线 SHA 改变时，引用旧文件位置的记忆标记可能过期):
 * - `memories.source_sha`     — the cited source artifact/commit SHA (NULL =
 *   the memory carries no source reference and cannot go stale). Validated
 *   at the API layer (40-hex CommitShaSchema) like every other SHA column.
 * - `memories.stale_since` / `stale_reason` — the PERSISTED explicit stale
 *   mark written by `checkSources`. Freshness is metadata, not lifecycle:
 *   it deliberately does NOT bump `version` and does NOT enter
 *   `memory_revisions`, so the M3-02 CAS/history semantics are untouched.
 *   The (stale_since ⇔ stale_reason) pairing is enforced at the API layer
 *   and verified on read (a half-marked row reads as an integrity error).
 * - `memory_source_checks`    — append-only audit of every reference check
 *   (id, project, memory, cited sha, outcome, observed baseline, time), so
 *   "why is this stale" is always answerable from the store.
 *
 * 010 — forward-only REBUILD of `bundle_fragments` (M3-01's table): the
 * memory layer of the context package needs `layer = 'memory'` /
 * `source_kind = 'memory_entry'` rows to persist injected retrieval hits
 * with full provenance. SQLite cannot widen a CHECK constraint in place,
 * and rewriting the SHIPPED migration 007 is forbidden (its sha256 is
 * recorded in `schema_migrations` and must keep verifying). So 010 follows
 * the standard SQLite rebuild pattern: create shadow table with the widened
 * CHECKs, copy every row, drop, rename, recreate the index. Columns and
 * existing row content are preserved byte-for-byte; M3-01 rows stay valid.
 *
 * FK NOTE: assumes 001..008 are applied. Always apply via
 * `applyMemorySearchMigrations` / `MEMORY_SEARCH_MIGRATIONS`. No PRAGMA
 * statements live in migrations.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { MEMORY_MIGRATIONS } from "@role-orchestrator/memory";

const MEMORY_SOURCE_SQL = `
ALTER TABLE memories ADD COLUMN source_sha TEXT;
ALTER TABLE memories ADD COLUMN stale_since TEXT;
ALTER TABLE memories ADD COLUMN stale_reason TEXT CHECK (stale_reason IS NULL OR stale_reason IN ('missing', 'superseded'));

CREATE INDEX ix_memories_project_source ON memories(project_id, source_sha) WHERE source_sha IS NOT NULL;

CREATE TABLE memory_source_checks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  source_sha TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('current', 'missing', 'superseded')),
  observed_sha TEXT,
  checked_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_memory_source_checks_memory ON memory_source_checks(memory_id, checked_at);
`.trim();

export const MEMORY_SOURCE_MIGRATION: MigrationDefinition = {
  version: 9,
  name: "009-memory-source-sha",
  upSql: MEMORY_SOURCE_SQL
};

/**
 * The rebuilt bundle_fragments table: IDENTICAL columns to migration 007,
 * with the layer/source-kind/provenance CHECKs widened for the memory layer
 * (revision = memory version is required; profile_id must stay NULL;
 * commit_sha optionally carries the memory's sourceSha).
 */
const BUNDLE_FRAGMENTS_WIDENED_SQL = `
CREATE TABLE bundle_fragments_widened (
  bundle_id TEXT NOT NULL REFERENCES context_bundles(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  layer TEXT NOT NULL CHECK (layer IN ('project_rule', 'role', 'task', 'dependency', 'memory')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('project_rule', 'role_binding', 'task_node', 'dependency_output', 'memory_entry')),
  source_id TEXT NOT NULL,
  source_revision TEXT CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 128),
  source_profile_id TEXT,
  source_commit_sha TEXT,
  source_artifact_id TEXT,
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  omitted_reason TEXT CHECK (omitted_reason IS NULL OR length(omitted_reason) BETWEEN 1 AND 256),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_bytes INTEGER NOT NULL CHECK (content_bytes >= 1),
  PRIMARY KEY (bundle_id, sequence),
  -- Truncation mark: a kept fragment has no omission reason; a dropped one
  -- always records why it is absent from what the agent sees.
  CHECK ((included = 1 AND omitted_reason IS NULL) OR (included = 0 AND omitted_reason IS NOT NULL)),
  -- Layer-specific provenance: exactly the columns each source kind carries.
  CHECK (
    (source_kind = 'project_rule' AND source_revision IS NOT NULL AND source_profile_id IS NULL AND source_commit_sha IS NULL)
    OR
    (source_kind = 'role_binding' AND source_revision IS NOT NULL AND source_profile_id IS NOT NULL AND source_commit_sha IS NULL)
    OR
    (source_kind = 'task_node' AND source_revision IS NOT NULL AND source_profile_id IS NULL AND source_commit_sha IS NULL)
    OR
    (source_kind = 'dependency_output' AND source_commit_sha IS NOT NULL AND source_profile_id IS NULL)
    OR
    (source_kind = 'memory_entry' AND source_revision IS NOT NULL AND source_profile_id IS NULL)
  )
) STRICT;

INSERT INTO bundle_fragments_widened (
  bundle_id, sequence, layer, source_kind, source_id, source_revision,
  source_profile_id, source_commit_sha, source_artifact_id, included,
  omitted_reason, content, content_hash, content_bytes
)
SELECT
  bundle_id, sequence, layer, source_kind, source_id, source_revision,
  source_profile_id, source_commit_sha, source_artifact_id, included,
  omitted_reason, content, content_hash, content_bytes
FROM bundle_fragments;

DROP TABLE bundle_fragments;

ALTER TABLE bundle_fragments_widened RENAME TO bundle_fragments;

CREATE INDEX ix_bundle_fragments_source
  ON bundle_fragments(source_kind, source_id, source_commit_sha);
`.trim();

export const BUNDLE_FRAGMENTS_WIDENED_MIGRATION: MigrationDefinition = {
  version: 10,
  name: "010-bundle-fragments-memory-layer",
  upSql: BUNDLE_FRAGMENTS_WIDENED_SQL
};

/** 001..007 core chain + 008 memories + 009 source/staleness + 010 rebuild. */
export const MEMORY_SEARCH_MIGRATIONS: readonly MigrationDefinition[] = [
  ...MEMORY_MIGRATIONS,
  MEMORY_SOURCE_MIGRATION,
  BUNDLE_FRAGMENTS_WIDENED_MIGRATION
];

export interface ApplyMemorySearchMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `MEMORY_SEARCH_MIGRATIONS` as the default list. */
export async function applyMemorySearchMigrations(
  db: DatabaseSync,
  options: ApplyMemorySearchMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? MEMORY_SEARCH_MIGRATIONS
  });
}
