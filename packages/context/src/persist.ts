/**
 * Context bundle persistence (migration 007, M3-01).
 *
 * docs/MEMORY_AND_CONTEXT.md section 5 makes the context manifest a durable,
 * user-queryable record ("用户可以查看这个 Agent 看到了什么"), and the M3-04
 * cross-CLI baseline plus the recovery milestones must answer "what exactly
 * did this node's execution see, from where" across processes. Like the
 * integration and review records before it (M2-04/M2-05), that is a TaskRun-
 * scoped STORE record, not a worktree-local file: the migration chain
 * composes the existing one — `CONTEXT_MIGRATIONS = REVIEW_MIGRATIONS + 007`.
 *
 * - `context_bundles`    — one row per assembled bundle, content-addressed:
 *   the bundle id derives from (project, run, node, manifest digest), and
 *   UNIQUE(run_id, node_id, manifest_hash) makes re-persisting an identical
 *   assembly ABSORB into the existing row instead of duplicating history.
 *   A rule change or truncation change produces a different digest and thus
 *   a new row — history is kept, never overwritten.
 * - `bundle_fragments`   — every fragment of the bundle (kept AND dropped),
 *   ordered by sequence, with layer, full source references, content hash,
 *   content, and the truncation mark (`included` + `omitted_reason`).
 *   CHECK constraints pin which provenance columns each layer's source must
 *   and must not set, so a row without its SHA/revision reference cannot
 *   exist (M3-01 完成标准: 任意片段能追溯到 artifact/SHA/revision).
 *
 * Queries are project-scoped (A15 data-plane baseline): every listing
 * requires the project id, and rows always carry it, so M3-03's
 * authorization layer can enforce scope without re-deriving it.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import type { MigrationDefinition } from "@role-orchestrator/store";
import {
  TimestampSchema,
  applyMigrations,
  isUniqueViolation,
  withTransaction,
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult
} from "@role-orchestrator/store";
import { REVIEW_MIGRATIONS } from "@role-orchestrator/review";
import { CommitShaSchema } from "@role-orchestrator/integration";
import {
  ContextLayerSchema,
  ContextSourceSchema,
  ContextTrustSchema,
  Hex64Schema
} from "./fragments.js";
import type { ContextLayer, ContextSource } from "./fragments.js";
import {
  CONTEXT_MANIFEST_SCHEMA_VERSION,
  ContextBundleManifestSchema,
  type AssembledFragment,
  type ContextBundle,
  bundleContentHash,
  contentHashOf,
  manifestDigest
} from "./manifest.js";
import {
  ContextManifestIntegrityError,
  UnknownContextBundleError,
  UnknownContextFragmentError
} from "./errors.js";

const CONTEXT_SCHEMA_SQL = `
CREATE TABLE context_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK (json_type(manifest) = 'object'),
  manifest_hash TEXT NOT NULL,
  fragment_count INTEGER NOT NULL CHECK (fragment_count >= 0),
  included_count INTEGER NOT NULL CHECK (included_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  budget_bytes INTEGER CHECK (budget_bytes IS NULL OR budget_bytes >= 1),
  budget_exceeded INTEGER NOT NULL CHECK (budget_exceeded IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, node_id, manifest_hash)
) STRICT;

CREATE INDEX ix_context_bundles_project ON context_bundles(project_id, created_at);

CREATE TABLE bundle_fragments (
  bundle_id TEXT NOT NULL REFERENCES context_bundles(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  layer TEXT NOT NULL CHECK (layer IN ('project_rule', 'role', 'task', 'dependency')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('project_rule', 'role_binding', 'task_node', 'dependency_output')),
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
  )
) STRICT;

CREATE INDEX ix_bundle_fragments_source
  ON bundle_fragments(source_kind, source_id, source_commit_sha);
`.trim();

export const CONTEXT_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 7,
  name: "007-context-bundles",
  upSql: CONTEXT_SCHEMA_SQL
};

/** 001 core + 002 profiles + 003 task_nodes + 004 scheduler + 005 integration + 006 review + 007 context. */
export const CONTEXT_MIGRATIONS: readonly MigrationDefinition[] = [
  ...REVIEW_MIGRATIONS,
  CONTEXT_SCHEMA_MIGRATION
];

export interface ApplyContextMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `CONTEXT_MIGRATIONS` as the default list. */
export async function applyContextMigrations(
  db: DatabaseSync,
  options: ApplyContextMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? CONTEXT_MIGRATIONS
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A persisted bundle: identity/counters row + parsed manifest + fragments. */
export interface ContextBundleRecord {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly contentHash: string;
  readonly manifest: z.output<typeof ContextBundleManifestSchema>;
  readonly manifestHash: string;
  readonly fragmentCount: number;
  readonly includedCount: number;
  readonly byteCount: number;
  readonly budgetBytes: number | null;
  readonly budgetExceeded: boolean;
  readonly createdAt: string;
  readonly fragments: readonly PersistedFragment[];
}

export interface PersistedFragment {
  readonly bundleId: string;
  readonly sequence: number;
  readonly layer: ContextLayer;
  readonly source: ContextSource;
  readonly included: boolean;
  readonly omittedReason: string | null;
  readonly content: string;
  readonly contentHash: string;
  readonly contentBytes: number;
}

interface RawRowShape {
  [key: string]: unknown;
}

function optStr(row: RawRowShape, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function reqStr(row: RawRowShape, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new ContextManifestIntegrityError({
      bundleId: String(row["bundle_id"] ?? String(row["id"] ?? "?")),
      kind: "fragment-manifest-mismatch",
      detail: `column "${column}" is not TEXT`
    });
  }
  return value;
}

function reqInt(row: RawRowShape, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ContextManifestIntegrityError({
      bundleId: String(row["bundle_id"] ?? String(row["id"] ?? "?")),
      kind: "fragment-manifest-mismatch",
      detail: `column "${column}" is not INTEGER`
    });
  }
  return value;
}

function mapFragmentRow(row: RawRowShape): PersistedFragment {
  const layer = ContextLayerSchema.parse(reqStr(row, "layer"));
  const source = ContextSourceSchema.parse({
    kind: reqStr(row, "source_kind"),
    id: IdSchema.parse(reqStr(row, "source_id")),
    revision: optStr(row, "source_revision"),
    profileId: optStr(row, "source_profile_id"),
    commitSha: optStr(row, "source_commit_sha"),
    artifactId: optStr(row, "source_artifact_id")
  });
  const content = reqStr(row, "content");
  const contentHash = Hex64Schema.parse(reqStr(row, "content_hash"));
  // Recompute on read: a tampered content column never maps cleanly.
  if (contentHashOf(content) !== contentHash) {
    throw new ContextManifestIntegrityError({
      bundleId: reqStr(row, "bundle_id"),
      kind: "fragment-hash",
      detail: `fragment ${String(reqInt(row, "sequence"))} content does not hash to its recorded content_hash`
    });
  }
  const included = reqInt(row, "included") === 1;
  const omittedReason = optStr(row, "omitted_reason");
  if (included === (omittedReason !== null)) {
    throw new ContextManifestIntegrityError({
      bundleId: reqStr(row, "bundle_id"),
      kind: "fragment-manifest-mismatch",
      detail: `fragment ${String(reqInt(row, "sequence"))} has included=${String(included)} with omitted_reason=${String(omittedReason)}`
    });
  }
  return {
    bundleId: reqStr(row, "bundle_id"),
    sequence: reqInt(row, "sequence"),
    layer,
    source,
    included,
    omittedReason,
    content,
    contentHash,
    contentBytes: reqInt(row, "content_bytes")
  };
}

function parseManifestJson(raw: string, bundleId: string): z.output<typeof ContextBundleManifestSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ContextManifestIntegrityError({
      bundleId,
      kind: "manifest-hash",
      detail: `manifest column is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    });
  }
  const manifest = ContextBundleManifestSchema.parse(parsed);
  if (manifest.bundleId !== bundleId) {
    throw new ContextManifestIntegrityError({
      bundleId,
      kind: "manifest-hash",
      detail: `manifest is bound to bundle "${manifest.bundleId}"`
    });
  }
  return manifest;
}

function mapBundleRow(row: RawRowShape, fragments: readonly PersistedFragment[]): ContextBundleRecord {
  const id = reqStr(row, "id");
  const manifest = parseManifestJson(reqStr(row, "manifest"), id);
  const manifestHash = Hex64Schema.parse(reqStr(row, "manifest_hash"));
  if (manifestDigest(manifest) !== manifestHash) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "manifest-hash",
      detail: "stored manifest does not hash to the recorded manifest_hash"
    });
  }
  // A fragment row deleted by hand leaves the manifest pointing at content
  // that no longer exists — refuse the read instead of serving a blind spot.
  if (manifest.fragments.length + manifest.omitted.length !== fragments.length) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "count-mismatch",
      detail: `manifest lists ${String(manifest.fragments.length + manifest.omitted.length)} fragments, ${String(fragments.length)} rows exist`
    });
  }
  const budgetBytes = row["budget_bytes"] === null || row["budget_bytes"] === undefined
    ? null
    : reqInt(row, "budget_bytes");
  if (manifest.budgetBytes !== budgetBytes) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "manifest-hash",
      detail: "manifest budgetBytes does not match the row column"
    });
  }
  if (manifest.contentHash !== Hex64Schema.parse(reqStr(row, "content_hash"))) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "bundle-hash",
      detail: "manifest contentHash does not match the row column"
    });
  }
  return {
    id,
    projectId: IdSchema.parse(reqStr(row, "project_id")),
    runId: IdSchema.parse(reqStr(row, "run_id")),
    nodeId: IdSchema.parse(reqStr(row, "node_id")),
    contentHash: Hex64Schema.parse(reqStr(row, "content_hash")),
    manifest,
    manifestHash,
    fragmentCount: reqInt(row, "fragment_count"),
    includedCount: reqInt(row, "included_count"),
    byteCount: reqInt(row, "byte_count"),
    budgetBytes,
    budgetExceeded: reqInt(row, "budget_exceeded") === 1,
    createdAt: TimestampSchema.parse(reqStr(row, "created_at")),
    fragments
  };
}

const FRAGMENT_COLUMNS =
  "bundle_id, sequence, layer, source_kind, source_id, source_revision, source_profile_id, " +
  "source_commit_sha, source_artifact_id, included, omitted_reason, content, content_hash, content_bytes";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist an assembled bundle in ONE transaction (bundle row + all fragment
 * rows). Re-persisting an identical assembly absorbs into the existing row
 * and returns it — the same property the scheduler queue and integration
 * records have, so retries never duplicate history. Before writing, the
 * bundle is re-validated and its content hash recomputed: a tampered
 * in-memory object (post-freeze mutation attempt, JSON smuggling) fails here
 * instead of poisoning the store.
 */
export function persistContextBundle(
  db: DatabaseSync,
  bundle: ContextBundle,
  now: string
): ContextBundleRecord {
  const createdAt = TimestampSchema.parse(now);
  const manifest = ContextBundleManifestSchema.parse(bundle.manifest);
  const fragments = z.array(FragmentContentRowSchema).parse(
    bundle.fragments.map((fragment) => ({
      sequence: fragment.sequence,
      layer: fragment.layer,
      trust: fragment.trust,
      source: fragment.source,
      included: fragment.included,
      omittedReason: fragment.omittedReason,
      content: fragment.content,
      contentHash: fragment.contentHash,
      contentBytes: fragment.contentBytes
    }))
  );

  // Recheck integrity of the object being persisted (defense in depth).
  const kept = fragments.filter((fragment) => fragment.included);
  const recomputed = bundleContentHash(
    kept.map((fragment) => ({
      sequence: fragment.sequence,
      layer: fragment.layer,
      source: { kind: fragment.source.kind, id: fragment.source.id },
      contentHash: fragment.contentHash,
      content: fragment.content
    }))
  );
  if (recomputed !== manifest.contentHash) {
    throw new ContextManifestIntegrityError({
      bundleId: manifest.bundleId,
      kind: "bundle-hash",
      detail: "refusing to persist: fragment content does not reproduce the manifest contentHash"
    });
  }

  const manifestJson = JSON.stringify(manifest);
  const manifestHash = manifestDigest(manifest);
  const fragmentCount = fragments.length;
  const includedCount = kept.length;
  const byteCount = kept.reduce((sum, fragment) => sum + fragment.contentBytes, 0);
  if (byteCount !== manifest.byteCount) {
    throw new ContextManifestIntegrityError({
      bundleId: manifest.bundleId,
      kind: "bundle-hash",
      detail: "refusing to persist: kept byte count does not match the manifest byteCount"
    });
  }

  return withTransaction(db, () => {
    try {
      db.prepare(
        "INSERT INTO context_bundles(id, project_id, run_id, node_id, content_hash, manifest, " +
          "manifest_hash, fragment_count, included_count, byte_count, budget_bytes, budget_exceeded, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        manifest.bundleId,
        manifest.projectId,
        manifest.runId,
        manifest.nodeId,
        manifest.contentHash,
        manifestJson,
        manifestHash,
        fragmentCount,
        includedCount,
        byteCount,
        manifest.budgetBytes,
        manifest.budgetExceeded ? 1 : 0,
        createdAt
      );
    } catch (error) {
      if (
        isUniqueViolation(
          error,
          "context_bundles.run_id, context_bundles.node_id, context_bundles.manifest_hash"
        )
      ) {
        // Identical assembly already stored — absorb, never duplicate.
        return requireExistingBundle(db, manifest.runId, manifest.nodeId, manifestHash);
      }
      throw error;
    }

    const insertFragment = db.prepare(
      `INSERT INTO bundle_fragments(${FRAGMENT_COLUMNS}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const fragment of fragments) {
      insertFragment.run(
        manifest.bundleId,
        fragment.sequence,
        fragment.layer,
        fragment.source.kind,
        fragment.source.id,
        fragment.source.revision,
        fragment.source.profileId,
        fragment.source.commitSha,
        fragment.source.artifactId,
        fragment.included ? 1 : 0,
        fragment.omittedReason,
        fragment.content,
        fragment.contentHash,
        fragment.contentBytes
      );
    }
    return requireContextBundle(db, manifest.bundleId);
  });
}

const FragmentContentRowSchema = z.strictObject({
  sequence: z.number().int().min(0),
  layer: ContextLayerSchema,
  trust: ContextTrustSchema,
  source: ContextSourceSchema,
  included: z.boolean(),
  omittedReason: z.string().min(1).max(256).nullable(),
  content: z.string().min(1),
  contentHash: Hex64Schema,
  contentBytes: z.number().int().min(1)
});

function loadFragments(db: DatabaseSync, bundleId: string): readonly PersistedFragment[] {
  const rows = db
    .prepare(`SELECT * FROM bundle_fragments WHERE bundle_id = ? ORDER BY sequence ASC`)
    .all(bundleId) as RawRowShape[];
  return rows.map(mapFragmentRow);
}

function requireExistingBundle(
  db: DatabaseSync,
  runId: string,
  nodeId: string,
  manifestHash: string
): ContextBundleRecord {
  const row = db
    .prepare(
      "SELECT * FROM context_bundles WHERE run_id = ? AND node_id = ? AND manifest_hash = ?"
    )
    .get(runId, nodeId, manifestHash) as RawRowShape | undefined;
  if (row === undefined) {
    throw new ContextManifestIntegrityError({
      bundleId: "(unresolved)",
      kind: "missing-fragment",
      detail: "unique-violation absorb failed: the conflicting bundle row cannot be read back"
    });
  }
  return mapBundleRow(row, loadFragments(db, reqStr(row, "id")));
}

// ---------------------------------------------------------------------------
// Queries (project-scoped: A15 data-plane baseline)
// ---------------------------------------------------------------------------

/** Read one bundle by id, re-verifying the manifest hash on every read. */
export function getContextBundle(
  db: DatabaseSync,
  bundleId: string
): ContextBundleRecord | null {
  const id = z.string().min(1).max(128).parse(bundleId);
  const row = db.prepare("SELECT * FROM context_bundles WHERE id = ?").get(id) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    return null;
  }
  return mapBundleRow(row, loadFragments(db, id));
}

export function requireContextBundle(db: DatabaseSync, bundleId: string): ContextBundleRecord {
  const record = getContextBundle(db, bundleId);
  if (record === null) {
    throw new UnknownContextBundleError(bundleId);
  }
  return record;
}

export interface ContextBundleSummary {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly fragmentCount: number;
  readonly includedCount: number;
  readonly byteCount: number;
  readonly budgetExceeded: boolean;
  readonly createdAt: string;
}

/**
 * List a project's bundles, oldest first. The project id is REQUIRED —
 * bundle listings are always scoped to one project (M3-03 puts the
 * authorization layer on top; the data layer never offers an unscoped scan).
 */
export function listContextBundles(
  db: DatabaseSync,
  input: { readonly projectId: string }
): readonly ContextBundleSummary[] {
  const projectId = IdSchema.parse(input.projectId);
  const rows = db
    .prepare(
      "SELECT id, project_id, run_id, node_id, content_hash, manifest_hash, fragment_count, " +
        "included_count, byte_count, budget_exceeded, created_at " +
        "FROM context_bundles WHERE project_id = ? ORDER BY created_at ASC, id ASC"
    )
    .all(projectId) as RawRowShape[];
  return rows.map((row) => ({
    id: IdSchema.parse(reqStr(row, "id")),
    projectId: IdSchema.parse(reqStr(row, "project_id")),
    runId: IdSchema.parse(reqStr(row, "run_id")),
    nodeId: IdSchema.parse(reqStr(row, "node_id")),
    contentHash: Hex64Schema.parse(reqStr(row, "content_hash")),
    manifestHash: Hex64Schema.parse(reqStr(row, "manifest_hash")),
    fragmentCount: reqInt(row, "fragment_count"),
    includedCount: reqInt(row, "included_count"),
    byteCount: reqInt(row, "byte_count"),
    budgetExceeded: reqInt(row, "budget_exceeded") === 1,
    createdAt: TimestampSchema.parse(reqStr(row, "created_at"))
  }));
}

/** One fragment's full provenance: the reverse trace to artifact/SHA/revision. */
export interface FragmentTrace {
  readonly bundleId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly sequence: number;
  readonly layer: ContextLayer;
  readonly source: ContextSource;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly included: boolean;
  readonly omittedReason: string | null;
}

/**
 * Trace ONE fragment of ONE bundle back to its artifact/SHA/revision
 * reference. Throws when the bundle or the sequence does not exist — a trace
 * is either complete and exact or it fails.
 */
export function traceFragment(
  db: DatabaseSync,
  input: { readonly bundleId: string; readonly sequence: number }
): FragmentTrace {
  const bundleId = z.string().min(1).max(128).parse(input.bundleId);
  const sequence = z.number().int().min(0).parse(input.sequence);
  const bundle = requireContextBundle(db, bundleId);
  const fragment = bundle.fragments.find((candidate) => candidate.sequence === sequence);
  if (fragment === undefined) {
    throw new UnknownContextFragmentError({ bundleId, sequence });
  }
  return {
    bundleId,
    projectId: bundle.projectId,
    runId: bundle.runId,
    nodeId: bundle.nodeId,
    sequence: fragment.sequence,
    layer: fragment.layer,
    source: fragment.source,
    contentHash: fragment.contentHash,
    contentBytes: fragment.contentBytes,
    included: fragment.included,
    omittedReason: fragment.omittedReason
  };
}

/**
 * Reverse lookup: which bundles/fragments cited this source (rule id, role,
 * node id) and optionally this exact commit SHA — from an artifact/SHA back
 * to every bundle that carried it. Results never cross the optional project
 * scope.
 */
export function findFragmentsBySource(
  db: DatabaseSync,
  input: {
    readonly sourceId: string;
    readonly sourceKind?: z.output<typeof ContextSourceSchema>["kind"];
    readonly commitSha?: string;
    readonly projectId?: string;
  }
): readonly {
  readonly bundleId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly sequence: number;
  readonly layer: ContextLayer;
  readonly source: ContextSource;
  readonly contentHash: string;
  readonly included: boolean;
  readonly omittedReason: string | null;
}[] {
  const sourceId = IdSchema.parse(input.sourceId);
  const sourceKind =
    input.sourceKind === undefined ? null : ContextSourceSchema.shape.kind.parse(input.sourceKind);
  const commitSha =
    input.commitSha === undefined ? null : CommitShaSchema.parse(input.commitSha);
  const projectId = input.projectId === undefined ? null : IdSchema.parse(input.projectId);

  const rows = db
    .prepare(
      "SELECT f.bundle_id, b.project_id, b.run_id, b.node_id, f.sequence, f.layer, " +
        "f.source_kind, f.source_id, f.source_revision, f.source_profile_id, f.source_commit_sha, " +
        "f.source_artifact_id, f.content_hash, f.included, f.omitted_reason " +
        "FROM bundle_fragments f JOIN context_bundles b ON b.id = f.bundle_id " +
        "WHERE f.source_id = ? " +
        "ORDER BY b.created_at ASC, f.bundle_id ASC, f.sequence ASC"
    )
    .all(sourceId) as RawRowShape[];

  return rows
    .map((row) => ({
      bundleId: reqStr(row, "bundle_id"),
      projectId: IdSchema.parse(reqStr(row, "project_id")),
      runId: IdSchema.parse(reqStr(row, "run_id")),
      nodeId: IdSchema.parse(reqStr(row, "node_id")),
      sequence: reqInt(row, "sequence"),
      layer: ContextLayerSchema.parse(reqStr(row, "layer")),
      source: ContextSourceSchema.parse({
        kind: reqStr(row, "source_kind"),
        id: reqStr(row, "source_id"),
        revision: optStr(row, "source_revision"),
        profileId: optStr(row, "source_profile_id"),
        commitSha: optStr(row, "source_commit_sha"),
        artifactId: optStr(row, "source_artifact_id")
      }),
      contentHash: Hex64Schema.parse(reqStr(row, "content_hash")),
      included: reqInt(row, "included") === 1,
      omittedReason: optStr(row, "omitted_reason")
    }))
    .filter(
      (hit) =>
        (sourceKind === null || hit.source.kind === sourceKind) &&
        (commitSha === null || hit.source.commitSha === commitSha) &&
        (projectId === null || hit.projectId === projectId)
    );
}

// ---------------------------------------------------------------------------
// Verification (recompute every hash — tampering/omission is loud)
// ---------------------------------------------------------------------------

export interface VerifyContextBundleResult {
  readonly ok: true;
  readonly bundleId: string;
  readonly checkedFragments: number;
  readonly contentHash: string;
  readonly manifestHash: string;
}

/**
 * Full integrity check of one stored bundle:
 * - every fragment row's content hashes to its content_hash (tamper);
 * - kept byte sizes match (tamper);
 * - the bundle content hash recomputes from the kept fragments (truncation);
 * - the manifest digest recomputes (manifest tampering);
 * - the manifest's fragment/omitted lists match the stored rows exactly
 *   (missing fragment rows — deletion leaves the manifest pointing at a
 *   fragment that no longer exists).
 */
export function verifyContextBundle(
  db: DatabaseSync,
  bundleId: string
): VerifyContextBundleResult {
  const id = z.string().min(1).max(128).parse(bundleId);
  const row = db.prepare("SELECT * FROM context_bundles WHERE id = ?").get(id) as
    | RawRowShape
    | undefined;
  if (row === undefined) {
    throw new UnknownContextBundleError(id);
  }
  const bundle = mapBundleRow(row, loadFragments(db, id));
  const manifest = bundle.manifest;

  const bySequence = new Map(bundle.fragments.map((fragment) => [fragment.sequence, fragment]));
  const manifestSequences = [
    ...manifest.fragments.map((fragment) => fragment.sequence),
    ...manifest.omitted.map((fragment) => fragment.sequence)
  ].sort((a, b) => a - b);
  const rowSequences = [...bySequence.keys()].sort((a, b) => a - b);
  if (
    manifestSequences.length !== rowSequences.length ||
    manifestSequences.some((sequence, index) => sequence !== rowSequences[index])
  ) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "count-mismatch",
      detail: `manifest lists ${String(manifestSequences.length)} fragments, the table stores ${String(rowSequences.length)}`
    });
  }
  for (const entry of [...manifest.fragments, ...manifest.omitted]) {
    const fragment = bySequence.get(entry.sequence);
    if (fragment === undefined) {
      throw new ContextManifestIntegrityError({
        bundleId: id,
        kind: "missing-fragment",
        detail: `manifest references fragment ${String(entry.sequence)} which has no row`
      });
    }
    if (fragment.contentHash !== entry.contentHash || fragment.layer !== entry.layer) {
      throw new ContextManifestIntegrityError({
        bundleId: id,
        kind: "fragment-manifest-mismatch",
        detail: `fragment ${String(entry.sequence)} row contradicts its manifest entry`
      });
    }
  }

  const kept = bundle.fragments.filter((fragment) => fragment.included);
  const recomputedContentHash = bundleContentHash(
    kept.map((fragment) => ({
      sequence: fragment.sequence,
      layer: fragment.layer,
      source: { kind: fragment.source.kind, id: fragment.source.id },
      contentHash: fragment.contentHash,
      content: fragment.content
    }))
  );
  if (recomputedContentHash !== bundle.contentHash) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "bundle-hash",
      detail: "kept fragments do not reproduce the stored content_hash"
    });
  }
  const includedCount = bundle.fragments.filter((fragment) => fragment.included).length;
  if (
    bundle.fragmentCount !== bundle.fragments.length ||
    bundle.includedCount !== includedCount
  ) {
    throw new ContextManifestIntegrityError({
      bundleId: id,
      kind: "count-mismatch",
      detail: "row counters do not match the stored fragment rows"
    });
  }
  return {
    ok: true,
    bundleId: id,
    checkedFragments: bundle.fragments.length,
    contentHash: bundle.contentHash,
    manifestHash: bundle.manifestHash
  };
}

/** Re-export for callers that need the schema version constant alongside. */
export { CONTEXT_MANIFEST_SCHEMA_VERSION };

/** Shape a bundle fragment must have to cross the persistence boundary. */
export type { AssembledFragment };
