/**
 * `integration_records` (migration 005, M2-04) — the durable integration
 * state per (run, successor node).
 *
 * Persistence selection (the ask offered store-migration vs. package-local
 * JSON): the structured inputSha set and the manifest are persisted in the
 * STORE as migration 005, because docs/GIT_AND_WORKSPACES.md makes them
 * TaskRun-scoped records ("每个 Execution 提交后记录 outputSha、inputSha…
 * 保存集成记录与新 candidateSha -> 触发 Reviewer") that later milestones
 * (review binding, recovery) must QUERY across processes — a package-local
 * JSON file inside a managed worktree would be deleted with the worktree
 * (A40 lifecycle) and could not anchor the A25 crash discussion, which is
 * precisely "git done, DB unknown".
 *
 * Record state machine (guarded transitions, optimistic like the rest of the
 * repo — an UPDATE lands only from the exact recorded state):
 *
 *   IN_PROGRESS -> COMPLETED        (integration or reconcile recorded candidateSha)
 *   IN_PROGRESS -> PAUSED_CONFLICT  (A10; terminal in M2-04, recovery is a later task)
 *
 * COMPLETED and PAUSED_CONFLICT are terminal: a COMPLETED record is verified
 * (candidateSha remains an ancestor of the branch head), a paused one is only
 * ever queried. Re-entry into IN_PROGRESS state happens ONLY through the
 * reconcile verdicts, never by overwriting.
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { MigrationDefinition } from "@role-orchestrator/store";
import { isUniqueViolation } from "@role-orchestrator/store";
import { IdSchema } from "@role-orchestrator/contracts";
import { SCHEDULER_MIGRATIONS } from "@role-orchestrator/scheduler";
import {
  applyMigrations,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import {
  CommitShaSchema,
  IntegrationManifestSchema,
  ParentCommitSchema,
  type IntegrationManifest,
  type ParentCommit
} from "./manifest.js";
import {
  IntegrationManifestIntegrityError,
  UnknownIntegrationRecordError
} from "./errors.js";

const INTEGRATION_SCHEMA_SQL = `
CREATE TABLE integration_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'PAUSED_CONFLICT')),
  integration_branch TEXT NOT NULL,
  integration_worktree_path TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  input_sha_set TEXT NOT NULL CHECK (json_type(input_sha_set) = 'array'),
  manifest TEXT NOT NULL CHECK (json_type(manifest) = 'object'),
  candidate_sha TEXT,
  conflict_files TEXT CHECK (conflict_files IS NULL OR json_type(conflict_files) = 'array'),
  conflict_parent_node_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, node_id)
) STRICT;

CREATE INDEX ix_integration_records_run ON integration_records(run_id, state);
`.trim();

export const INTEGRATION_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 5,
  name: "005-integration-records",
  upSql: INTEGRATION_SCHEMA_SQL
};

/** 001 core + 002 profiles + 003 task_nodes + 004 scheduler + 005 integration. */
export const INTEGRATION_MIGRATIONS: readonly MigrationDefinition[] = [
  ...SCHEDULER_MIGRATIONS,
  INTEGRATION_SCHEMA_MIGRATION
];

export interface ApplyIntegrationMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `INTEGRATION_MIGRATIONS` as the default list. */
export async function applyIntegrationMigrations(
  db: DatabaseSync,
  options: ApplyIntegrationMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? INTEGRATION_MIGRATIONS
  });
}

// ---------------------------------------------------------------------------
// Record rows
// ---------------------------------------------------------------------------

export const INTEGRATION_RECORD_STATES = ["IN_PROGRESS", "COMPLETED", "PAUSED_CONFLICT"] as const;
export type IntegrationRecordState = (typeof INTEGRATION_RECORD_STATES)[number];
export const IntegrationRecordStateSchema = z.enum(INTEGRATION_RECORD_STATES);

export interface IntegrationRecord {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly integrationId: string;
  readonly state: IntegrationRecordState;
  readonly integrationBranch: string;
  readonly integrationWorktreePath: string;
  readonly baseSha: string;
  /** The structured inputSha set (ordered parent outputs). */
  readonly inputShaSet: readonly ParentCommit[];
  readonly manifest: IntegrationManifest;
  readonly candidateSha: string | null;
  readonly conflictFiles: readonly string[] | null;
  readonly conflictParentNodeId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const ManifestJsonSchema = IntegrationManifestSchema;

interface RawRowShape {
  [key: string]: unknown;
}

function parseJsonField(raw: string, runId: string, nodeId: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new IntegrationManifestIntegrityError({
      runId,
      nodeId,
      detail: `${field} column is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    });
  }
}

function mapRecordRow(row: RawRowShape): IntegrationRecord {
  const runId = z.string().parse(row.run_id);
  const nodeId = z.string().parse(row.node_id);
  const manifest = ManifestJsonSchema.parse(
    parseJsonField(String(row.manifest), runId, nodeId, "manifest")
  );
  const inputShaSet = z.array(ParentCommitSchema).parse(
    parseJsonField(String(row.input_sha_set), runId, nodeId, "input_sha_set")
  );
  const conflictRaw = row.conflict_files;
  const conflictFiles =
    typeof conflictRaw === "string"
      ? (z.array(z.string().min(1)).parse(
          parseJsonField(conflictRaw, runId, nodeId, "conflict_files")
        ) as string[])
      : null;
  return {
    id: String(row.id),
    runId,
    nodeId,
    integrationId: IdSchema.parse(row.integration_id),
    state: IntegrationRecordStateSchema.parse(row.state),
    integrationBranch: String(row.integration_branch),
    integrationWorktreePath: String(row.integration_worktree_path),
    baseSha: CommitShaSchema.parse(row.base_sha),
    inputShaSet,
    manifest,
    candidateSha: typeof row.candidate_sha === "string" ? CommitShaSchema.parse(row.candidate_sha) : null,
    conflictFiles,
    conflictParentNodeId:
      typeof row.conflict_parent_node_id === "string" ? String(row.conflict_parent_node_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function getIntegrationRecord(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): IntegrationRecord | null {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const row = db
    .prepare("SELECT * FROM integration_records WHERE run_id = ? AND node_id = ?")
    .get(runId, nodeId) as RawRowShape | undefined;
  return row === undefined ? null : mapRecordRow(row);
}

export function requireIntegrationRecord(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): IntegrationRecord {
  const record = getIntegrationRecord(db, input);
  if (record === null) {
    throw new UnknownIntegrationRecordError(IdSchema.parse(input.runId), IdSchema.parse(input.nodeId));
  }
  return record;
}

export function listIntegrationRecords(
  db: DatabaseSync,
  runId: string
): readonly IntegrationRecord[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare("SELECT * FROM integration_records WHERE run_id = ? ORDER BY created_at ASC, node_id ASC")
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapRecordRow);
}

// ---------------------------------------------------------------------------
// Creation + guarded transitions
// ---------------------------------------------------------------------------

export interface CreateIntegrationRecordInput {
  readonly id: string;
  readonly manifest: IntegrationManifest;
  readonly now: string;
}

/**
 * Insert the IN_PROGRESS record for one assembly. `UNIQUE(run_id, node_id)`
 * absorbs a re-entry race the same way the scheduler queue does: a duplicate
 * insert is a caller bug (check `getIntegrationRecord` first) and is rejected
 * loudly instead of silently duplicated.
 */
export function createIntegrationRecord(
  db: DatabaseSync,
  input: CreateIntegrationRecordInput
): IntegrationRecord {
  const manifest = IntegrationManifestSchema.parse(input.manifest);
  try {
    db.prepare(
      "INSERT INTO integration_records(id, run_id, node_id, integration_id, state, integration_branch, " +
        "integration_worktree_path, base_sha, input_sha_set, manifest, candidate_sha, conflict_files, " +
        "conflict_parent_node_id, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)"
    ).run(
      input.id,
      manifest.runId,
      manifest.nodeId,
      manifest.integrationId,
      manifest.integrationBranch,
      manifest.integrationWorktreePath,
      manifest.baseSha,
      JSON.stringify(manifest.parents),
      JSON.stringify(manifest),
      input.now,
      input.now
    );
  } catch (error) {
    if (isUniqueViolation(error, "integration_records.run_id, integration_records.node_id")) {
      // Re-entry on an existing assembly must go through the state machine
      // (read + reconcile/integrate), never a second row.
      throw new Error(
        `integration record already exists for run "${manifest.runId}" node "${manifest.nodeId}"`,
        { cause: error }
      );
    }
    throw error;
  }
  return requireIntegrationRecord(db, { runId: manifest.runId, nodeId: manifest.nodeId });
}

export interface UpdateIntegrationManifestInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly manifest: IntegrationManifest;
  readonly now: string;
}

/**
 * Persist an updated manifest while the record stays IN_PROGRESS (the A25
 * step between "merge produced candidateSha" and "record completed"). The
 * optimistic guard `state = 'IN_PROGRESS'` means a record that meanwhile
 * became COMPLETED/PAUSED cannot be demoted by a late writer.
 */
export function updateIntegrationManifest(
  db: DatabaseSync,
  input: UpdateIntegrationManifestInput
): IntegrationRecord {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const manifest = IntegrationManifestSchema.parse(input.manifest);
  const result = db
    .prepare(
      "UPDATE integration_records SET manifest = ?, updated_at = ? " +
        "WHERE run_id = ? AND node_id = ? AND state = 'IN_PROGRESS'"
    )
    .run(JSON.stringify(manifest), input.now, runId, nodeId);
  if (Number(result.changes) !== 1) {
    throw noRowOrMoved(db, runId, nodeId, "IN_PROGRESS");
  }
  return requireIntegrationRecord(db, { runId, nodeId });
}

export interface CompleteIntegrationInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly candidateSha: string;
  readonly now: string;
}

/** IN_PROGRESS -> COMPLETED, guarded; this is the exact "DB 更新" of A25. */
export function completeIntegrationRecord(
  db: DatabaseSync,
  input: CompleteIntegrationInput
): IntegrationRecord {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const candidateSha = CommitShaSchema.parse(input.candidateSha);
  const result = db
    .prepare(
      "UPDATE integration_records SET state = 'COMPLETED', candidate_sha = ?, updated_at = ? " +
        "WHERE run_id = ? AND node_id = ? AND state = 'IN_PROGRESS'"
    )
    .run(candidateSha, input.now, runId, nodeId);
  if (Number(result.changes) !== 1) {
    throw noRowOrMoved(db, runId, nodeId, "IN_PROGRESS");
  }
  return requireIntegrationRecord(db, { runId, nodeId });
}

export interface PauseIntegrationInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly conflictFiles: readonly string[];
  readonly conflictParentNodeId: string;
  readonly now: string;
}

/** IN_PROGRESS -> PAUSED_CONFLICT (A10). The scene outside the DB is untouched. */
export function pauseIntegrationRecord(
  db: DatabaseSync,
  input: PauseIntegrationInput
): IntegrationRecord {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const conflictFiles = z.array(z.string().min(1).max(1024)).min(1).max(1024).parse(input.conflictFiles);
  const result = db
    .prepare(
      "UPDATE integration_records SET state = 'PAUSED_CONFLICT', conflict_files = ?, " +
        "conflict_parent_node_id = ?, updated_at = ? " +
        "WHERE run_id = ? AND node_id = ? AND state = 'IN_PROGRESS'"
    )
    .run(JSON.stringify([...conflictFiles].sort()), input.conflictParentNodeId, input.now, runId, nodeId);
  if (Number(result.changes) !== 1) {
    throw noRowOrMoved(db, runId, nodeId, "IN_PROGRESS");
  }
  return requireIntegrationRecord(db, { runId, nodeId });
}

function noRowOrMoved(
  db: DatabaseSync,
  runId: string,
  nodeId: string,
  expectedState: IntegrationRecordState
): Error {
  const record = getIntegrationRecord(db, { runId, nodeId });
  if (record === null) {
    return new UnknownIntegrationRecordError(runId, nodeId);
  }
  return new Error(
    `integration record for run "${runId}" node "${nodeId}" is ${record.state}, expected ${expectedState}; ` +
      "refusing to apply a guarded transition from the wrong state"
  );
}
