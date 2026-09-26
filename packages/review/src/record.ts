/**
 * `review_records` (migration 006, M2-05) — the durable verdict/evidence of
 * one review session, bound to one exact candidateSha (A12).
 *
 * Persistence selection (the ask offered a store migration vs. reusing the
 * integration manifest mechanism): migration 006, mirroring M2-04's choice.
 * docs/GIT_AND_WORKSPACES.md 冲突与返工 makes the review report a TaskRun-
 * scoped, cross-process queryable record ("审查报告必须绑定 candidateSha，
 * 候选代码变化后旧通过结果失效"): the repair/review rounds of M4-03 and the
 * approval/diff UI of M5-03 must ask "is there a valid verdict for THIS
 * candidateSha" without any worktree alive. A JSON file inside a managed
 * worktree would disappear with the A40 lifecycle and could not answer.
 * The migration chain composes the existing one:
 * `REVIEW_MIGRATIONS = INTEGRATION_MIGRATIONS + 006` (001..005 + 006).
 *
 * Reuse over redefinition: the verdict payload is contracts'
 * `ReviewSchema` (`verdict` / `candidateSha` / `evidenceRefs` / `findings`)
 * validated on write AND re-validated on every read; the recorded evidence
 * entries reuse the `ArtifactRefSchema` id vocabulary with a narrowed kind
 * set (test results and reports — the artifacts a review can cite). The
 * session-level rule mirrors ExecutionResultSchema's bundle rule:
 * review.evidenceRefs may only cite artifacts this session actually recorded.
 *
 * State machine (guarded transitions, optimistic like the rest of the repo):
 *
 *   IN_PROGRESS -> COMPLETED  (verdict + evidence persisted, guarded UPDATE)
 *   IN_PROGRESS -> INVALID    (baseline drift — A13 — or explicit invalidation)
 *
 * COMPLETED and INVALID are terminal. Only a COMPLETED record whose
 * candidateSha equals the queried one can ever answer `getReviewVerdict`
 * with a verdict; any other query for that run+node is answered
 * `invalidated` — an old pass never applies to a new candidate (A12).
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdSchema, ReviewSchema } from "@role-orchestrator/contracts";
import type { Review } from "@role-orchestrator/contracts";
import type { MigrationDefinition } from "@role-orchestrator/store";
import { applyMigrations, type ApplyMigrationsOptions, type ApplyMigrationsResult } from "@role-orchestrator/store";
import { CommitShaSchema, INTEGRATION_MIGRATIONS } from "@role-orchestrator/integration";
import { derivedId } from "@role-orchestrator/scheduler";
import {
  BaselineManifestSchema,
  manifestDigest,
  type BaselineManifest
} from "./baseline.js";
import {
  ReviewRecordCorruptError,
  ReviewSessionStateError,
  UnknownReviewRecordError
} from "./errors.js";

const REVIEW_SCHEMA_SQL = `
CREATE TABLE review_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  node_id TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED', 'INVALID')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'blocked')),
  findings TEXT CHECK (findings IS NULL OR json_type(findings) = 'array'),
  evidence_refs TEXT CHECK (evidence_refs IS NULL OR json_type(evidence_refs) = 'array'),
  evidence TEXT NOT NULL CHECK (json_type(evidence) = 'array'),
  repo_path TEXT NOT NULL,
  baseline_worktree_path TEXT NOT NULL,
  validation_workspace_path TEXT NOT NULL,
  validation_temp_root TEXT NOT NULL,
  baseline_file_count INTEGER NOT NULL,
  baseline_digest TEXT NOT NULL,
  baseline_manifest TEXT NOT NULL CHECK (json_type(baseline_manifest) = 'object'),
  invalidated_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_review_records_lookup ON review_records(run_id, node_id, candidate_sha, state);
`.trim();

export const REVIEW_SCHEMA_MIGRATION: MigrationDefinition = {
  version: 6,
  name: "006-review-records",
  upSql: REVIEW_SCHEMA_SQL
};

/** 001 core + 002 profiles + 003 task_nodes + 004 scheduler + 005 integration + 006 review. */
export const REVIEW_MIGRATIONS: readonly MigrationDefinition[] = [
  ...INTEGRATION_MIGRATIONS,
  REVIEW_SCHEMA_MIGRATION
];

export interface ApplyReviewMigrationsOptions extends ApplyMigrationsOptions {}

/** `applyMigrations` with `REVIEW_MIGRATIONS` as the default list. */
export async function applyReviewMigrations(
  db: DatabaseSync,
  options: ApplyReviewMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  return applyMigrations(db, {
    ...options,
    migrations: options.migrations ?? REVIEW_MIGRATIONS
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const REVIEW_RECORD_STATES = ["IN_PROGRESS", "COMPLETED", "INVALID"] as const;
export type ReviewRecordState = (typeof REVIEW_RECORD_STATES)[number];
export const ReviewRecordStateSchema = z.enum(REVIEW_RECORD_STATES);

/**
 * The verdict vocabulary is DERIVED from contracts' ReviewSchema (never
 * redefined); the literal tuple is compile-checked against it and only feeds
 * the SQL CHECK constraint and the state enum below.
 */
export type ReviewVerdict = Review["verdict"];
export const REVIEW_VERDICTS = ["pass", "fail", "blocked"] as const satisfies readonly ReviewVerdict[];

/**
 * Review evidence may only be a test result or a report — a subset of
 * contracts' ArtifactRefSchema kinds (a review never cites a patch or a
 * context manifest as its verdict's evidence).
 */
export const SessionArtifactKindSchema = z.enum(["test-result", "report"]);
export type SessionArtifactKind = z.output<typeof SessionArtifactKindSchema>;

export const ValidationArtifactSchema = z.strictObject({
  artifactRef: z.strictObject({
    id: IdSchema,
    kind: SessionArtifactKindSchema
  }),
  summary: z.string().min(1).max(2000),
  /** Process exit code when machine-verified, null for externally produced results. */
  exitCode: z.number().int().min(0).max(255).nullable(),
  recordedAt: z.string().min(1).max(64)
});
export type ValidationArtifact = z.output<typeof ValidationArtifactSchema>;

export interface ReviewRecord {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly candidateSha: string;
  readonly state: ReviewRecordState;
  readonly verdict: ReviewVerdict | null;
  readonly evidenceRefs: readonly string[] | null;
  readonly findings: readonly string[] | null;
  readonly evidence: readonly ValidationArtifact[];
  readonly repoPath: string;
  readonly baselineWorktreePath: string;
  readonly validationWorkspacePath: string;
  readonly validationTempRoot: string;
  readonly baselineFileCount: number;
  readonly baselineDigest: string;
  readonly baselineManifest: BaselineManifest;
  readonly invalidatedReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawRowShape {
  [key: string]: unknown;
}

function parseJsonField(raw: string, reviewId: string, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ReviewRecordCorruptError({
      reviewId,
      detail: `column ${field} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    });
  }
}

function mapReviewRow(row: RawRowShape): ReviewRecord {
  const reviewId = String(row.id);
  const state = ReviewRecordStateSchema.parse(row.state);
  const candidateSha = CommitShaSchema.parse(row.candidate_sha);
  const verdict =
    row.verdict === null || row.verdict === undefined
      ? null
      : (ReviewSchema.shape.verdict.parse(row.verdict) as ReviewVerdict);
  const findings =
    row.findings === null || row.findings === undefined
      ? null
      : (z.array(z.string().min(1).max(10000)).parse(
          parseJsonField(String(row.findings), reviewId, "findings")
        ) as string[]);
  const evidenceRefs =
    row.evidence_refs === null || row.evidence_refs === undefined
      ? null
      : (z.array(IdSchema).parse(
          parseJsonField(String(row.evidence_refs), reviewId, "evidence_refs")
        ) as string[]);
  const evidence = z.array(ValidationArtifactSchema).parse(
    parseJsonField(String(row.evidence), reviewId, "evidence")
  );
  const baselineManifest = BaselineManifestSchema.parse(
    parseJsonField(String(row.baseline_manifest), reviewId, "baseline_manifest")
  );
  if (baselineManifest.candidateSha !== candidateSha) {
    throw new ReviewRecordCorruptError({
      reviewId,
      detail: `baseline manifest is bound to ${baselineManifest.candidateSha}, the record to ${candidateSha}`
    });
  }
  if (manifestDigest(baselineManifest.files) !== baselineManifest.digest) {
    throw new ReviewRecordCorruptError({
      reviewId,
      detail: "baseline manifest digest does not match its file list"
    });
  }
  return {
    id: reviewId,
    runId: IdSchema.parse(row.run_id),
    nodeId: IdSchema.parse(row.node_id),
    candidateSha,
    state,
    verdict,
    evidenceRefs,
    findings,
    evidence,
    repoPath: String(row.repo_path),
    baselineWorktreePath: String(row.baseline_worktree_path),
    validationWorkspacePath: String(row.validation_workspace_path),
    validationTempRoot: String(row.validation_temp_root),
    baselineFileCount: Number(row.baseline_file_count),
    baselineDigest: String(row.baseline_digest),
    baselineManifest,
    invalidatedReason:
      row.invalidated_reason === null || row.invalidated_reason === undefined
        ? null
        : String(row.invalidated_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function getReviewRecord(db: DatabaseSync, reviewId: string): ReviewRecord | null {
  const id = z.string().min(1).max(128).parse(reviewId);
  const row = db.prepare("SELECT * FROM review_records WHERE id = ?").get(id) as RawRowShape | undefined;
  return row === undefined ? null : mapReviewRow(row);
}

export function requireReviewRecord(db: DatabaseSync, reviewId: string): ReviewRecord {
  const record = getReviewRecord(db, reviewId);
  if (record === null) {
    throw new UnknownReviewRecordError(`review id "${reviewId}"`);
  }
  return record;
}

export function listReviewRecords(db: DatabaseSync, runId: string): readonly ReviewRecord[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare("SELECT * FROM review_records WHERE run_id = ? ORDER BY created_at ASC, id ASC")
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapReviewRow);
}

// ---------------------------------------------------------------------------
// Creation + guarded transitions
// ---------------------------------------------------------------------------

export interface CreateReviewRecordInput {
  readonly reviewId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly candidateSha: string;
  readonly repoPath: string;
  readonly baselineWorktreePath: string;
  readonly validationWorkspacePath: string;
  readonly validationTempRoot: string;
  readonly baseline: BaselineManifest;
  readonly now: string;
}

/** Insert the IN_PROGRESS row for one review session. */
export function createReviewRecord(db: DatabaseSync, input: CreateReviewRecordInput): ReviewRecord {
  const baseline = BaselineManifestSchema.parse(input.baseline);
  const candidateSha = CommitShaSchema.parse(input.candidateSha);
  if (baseline.candidateSha !== candidateSha) {
    throw new Error(
      `review record for candidate ${candidateSha} cannot carry a baseline manifest bound to ${baseline.candidateSha}`
    );
  }
  db.prepare(
    "INSERT INTO review_records(id, run_id, node_id, candidate_sha, state, verdict, findings, " +
      "evidence_refs, evidence, repo_path, baseline_worktree_path, validation_workspace_path, " +
      "validation_temp_root, baseline_file_count, baseline_digest, baseline_manifest, " +
      "invalidated_reason, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'IN_PROGRESS', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)"
  ).run(
    input.reviewId,
    IdSchema.parse(input.runId),
    IdSchema.parse(input.nodeId),
    candidateSha,
    "[]",
    z.string().min(1).max(2048).parse(input.repoPath),
    z.string().min(1).max(2048).parse(input.baselineWorktreePath),
    z.string().min(1).max(2048).parse(input.validationWorkspacePath),
    z.string().min(1).max(2048).parse(input.validationTempRoot),
    baseline.fileCount,
    baseline.digest,
    JSON.stringify(baseline),
    input.now,
    input.now
  );
  return requireReviewRecord(db, input.reviewId);
}

export interface CompleteReviewRecordInput {
  readonly reviewId: string;
  /** The contracts-shaped verdict payload (already strictly validated). */
  readonly review: Review;
  readonly evidence: readonly ValidationArtifact[];
  readonly now: string;
}

/**
 * IN_PROGRESS -> COMPLETED, guarded. This is the exact durable answer of
 * A12: the verdict lands ONLY with its candidateSha, its evidence refs and
 * the full evidence registry of the session.
 */
export function completeReviewRecord(db: DatabaseSync, input: CompleteReviewRecordInput): ReviewRecord {
  const review = ReviewSchema.parse(input.review);
  const evidence = z.array(ValidationArtifactSchema).parse([...input.evidence]);
  const result = db
    .prepare(
      "UPDATE review_records SET state = 'COMPLETED', verdict = ?, findings = ?, " +
        "evidence_refs = ?, evidence = ?, updated_at = ? " +
        "WHERE id = ? AND state = 'IN_PROGRESS'"
    )
    .run(
      review.verdict,
      JSON.stringify(review.findings),
      JSON.stringify(review.evidenceRefs),
      JSON.stringify(evidence),
      input.now,
      input.reviewId
    );
  if (Number(result.changes) !== 1) {
    throw noRowOrMoved(db, input.reviewId, "IN_PROGRESS");
  }
  return requireReviewRecord(db, input.reviewId);
}

export interface InvalidateReviewRecordInput {
  readonly reviewId: string;
  readonly reason: string;
  readonly now: string;
}

/**
 * IN_PROGRESS -> INVALID, guarded. Drift (A13) and explicit invalidation
 * both end here: an INVALID record never carries a verdict, forever.
 */
export function invalidateReviewRecord(db: DatabaseSync, input: InvalidateReviewRecordInput): ReviewRecord {
  const reason = z.string().min(1).max(2000).parse(input.reason);
  const result = db
    .prepare(
      "UPDATE review_records SET state = 'INVALID', invalidated_reason = ?, updated_at = ? " +
        "WHERE id = ? AND state = 'IN_PROGRESS'"
    )
    .run(reason, input.now, input.reviewId);
  if (Number(result.changes) !== 1) {
    throw noRowOrMoved(db, input.reviewId, "IN_PROGRESS");
  }
  return requireReviewRecord(db, input.reviewId);
}

function noRowOrMoved(db: DatabaseSync, reviewId: string, expectedState: ReviewRecordState): Error {
  const record = getReviewRecord(db, reviewId);
  if (record === null) {
    return new UnknownReviewRecordError(`review id "${reviewId}"`);
  }
  return new ReviewSessionStateError({
    reviewId,
    expectedState,
    actualState: record.state
  });
}

// ---------------------------------------------------------------------------
// A12 query semantics
// ---------------------------------------------------------------------------

/**
 * The ONLY verdict query. Binding semantics (A12): a verdict answers for its
 * own exact (run, node, candidateSha) triple and for nothing else.
 *  - `valid` — a COMPLETED record exists with EXACTLY this candidateSha;
 *  - `invalidated` — records exist for this run+node but none with this
 *    candidateSha: whatever was recorded before belongs to older content
 *    and NEVER applies to the queried candidate;
 *  - `none` — no review record exists for this run+node at all.
 */
export type ReviewVerdictLookup =
  | {
      readonly kind: "valid";
      readonly reviewId: string;
      readonly candidateSha: string;
      readonly verdict: ReviewVerdict;
      readonly evidenceRefs: readonly string[];
      readonly findings: readonly string[];
      readonly completedAt: string;
    }
  | {
      readonly kind: "invalidated";
      readonly runId: string;
      readonly nodeId: string;
      readonly queriedCandidateSha: string;
      readonly recordedCandidateShas: readonly string[];
    }
  | {
      readonly kind: "none";
      readonly runId: string;
      readonly nodeId: string;
      readonly queriedCandidateSha: string;
    };

export function getReviewVerdict(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string; readonly candidateSha: string }
): ReviewVerdictLookup {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const candidateSha = CommitShaSchema.parse(input.candidateSha);
  const rows = db
    .prepare(
      "SELECT * FROM review_records WHERE run_id = ? AND node_id = ? " +
        "ORDER BY created_at DESC, id DESC"
    )
    .all(runId, nodeId) as RawRowShape[];
  const matching = rows.filter(
    (row) => row.candidate_sha === candidateSha && row.state === "COMPLETED"
  );
  const newestMatch = matching[0];
  if (newestMatch !== undefined) {
    const record = mapReviewRow(newestMatch);
    if (record.verdict === null || record.evidenceRefs === null) {
      throw new ReviewRecordCorruptError({
        reviewId: record.id,
        detail: "record is COMPLETED but carries no verdict or evidence refs"
      });
    }
    return {
      kind: "valid",
      reviewId: record.id,
      candidateSha: record.candidateSha,
      verdict: record.verdict,
      evidenceRefs: record.evidenceRefs,
      findings: record.findings ?? [],
      completedAt: record.updatedAt
    };
  }
  if (rows.length > 0) {
    const recordedCandidateShas = [
      ...new Set(rows.map((row) => CommitShaSchema.parse(row.candidate_sha)))
    ].sort();
    return {
      kind: "invalidated",
      runId,
      nodeId,
      queriedCandidateSha: candidateSha,
      recordedCandidateShas
    };
  }
  return { kind: "none", runId, nodeId, queriedCandidateSha: candidateSha };
}

/**
 * Map a persisted record onto contracts' Review shape (the payload an
 * execution result would carry in its `review` field). Only a COMPLETED
 * record maps; anything else has no verdict to give.
 */
export function toContractsReview(record: ReviewRecord): Review | null {
  if (record.state !== "COMPLETED" || record.verdict === null || record.evidenceRefs === null) {
    return null;
  }
  return ReviewSchema.parse({
    verdict: record.verdict,
    candidateSha: record.candidateSha,
    evidenceRefs: record.evidenceRefs,
    findings: record.findings ?? []
  });
}

/** Deterministic review-session id: one row per session attempt. */
export function reviewIdFor(runId: string, nodeId: string, candidateSha: string, now: string): string {
  return derivedId("review", runId, nodeId, candidateSha, now);
}
