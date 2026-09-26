/**
 * Review session orchestration (M2-05) — ties the three pieces together:
 * the fixed-SHA baseline (A13), the one-shot validation workspace (A13) and
 * the candidateSha-bound verdict record (A12).
 *
 * Protocol per docs/GIT_AND_WORKSPACES.md and ACCEPTANCE A12/A13:
 *
 *   openReviewSession      — resolve candidateSha -> detached read-only
 *                            worktree -> per-file baseline manifest bound to
 *                            the commit's tracked tree -> faithful one-shot
 *                            workspace copy -> IN_PROGRESS record
 *   runValidationCommand / recordValidationArtifact
 *                          — test processes write ONLY in the workspace;
 *                            every run is registered as session evidence
 *   assertBaselineInvariance
 *                          — per-file hashes of the reviewed source must
 *                            still equal the pinned candidate content
 *   completeReview         — payload checks (contracts ReviewSchema, sha
 *                            binding, evidence closure, pass/fail evidence
 *                            rules) -> invariance assertion -> guarded
 *                            COMPLETED transition -> workspace disposed
 *   invalidateReviewSession— explicit IN_PROGRESS -> INVALID end
 *
 * A12 hard rule: `getReviewVerdict` (record.ts) answers with a verdict ONLY
 * for the exact candidateSha it was recorded against — see the a12 test
 * suite for the acceptance scenarios.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IdSchema, ReviewSchema } from "@role-orchestrator/contracts";
import type { Review } from "@role-orchestrator/contracts";
import { derivedId } from "@role-orchestrator/scheduler";
import { CommitShaSchema } from "@role-orchestrator/integration";
import { GitRunner, WorktreePathConflictError } from "@role-orchestrator/worktree";
import type { DatabaseSync } from "node:sqlite";
import {
  assertBaselineMatches,
  buildBaselineManifest,
  createReviewWorktree,
  diffManifests,
  manifestFromDirectory,
  type BaselineDrift,
  type BaselineManifest
} from "./baseline.js";
import {
  createValidationWorkspace,
  disposeValidationWorkspace,
  runWorkspaceCommand,
  type ValidationCommandInput,
  type ValidationCommandResult
} from "./workspace.js";
import {
  completeReviewRecord,
  createReviewRecord,
  invalidateReviewRecord,
  reviewIdFor,
  ValidationArtifactSchema,
  type ReviewRecord,
  type SessionArtifactKind,
  type ValidationArtifact
} from "./record.js";
import {
  ReviewBaselineDriftError,
  ReviewCandidateMissingError,
  ReviewEvidenceError,
  ReviewWorkspaceError
} from "./errors.js";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

export interface ReviewDeps {
  readonly db: DatabaseSync;
  readonly git: GitRunner;
}

const OpenReviewSessionInputSchema = z.strictObject({
  /** The USER repository (the candidateSha's object-database owner). */
  repoPath: AbsolutePathSchema,
  /** Engine-managed worktrees root; review baselines live under `_review/`. */
  worktreesRoot: AbsolutePathSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  candidateSha: CommitShaSchema,
  now: z.string().min(1).max(64)
});

export type OpenReviewSessionInput = z.input<typeof OpenReviewSessionInputSchema>;

export interface ReviewSession {
  readonly reviewId: string;
  readonly runId: string;
  readonly nodeId: string;
  /** The immutable candidate this session reviews — the A12 binding key. */
  readonly candidateSha: string;
  readonly repoPath: string;
  readonly baselineWorktreePath: string;
  readonly validationWorkspacePath: string;
  readonly validationTempRoot: string;
  readonly baseline: BaselineManifest;
  /**
   * Session-local evidence registry, persisted with the verdict. Mutable BY
   * DESIGN while the session is open (each validation run appends); a crash
   * before completion loses it — the IN_PROGRESS record has no verdict to
   * answer queries with, so the session is simply re-run (documented
   * boundary, README).
   */
  readonly artifacts: ValidationArtifact[];
}

/** `<worktreesRoot>/_review/<run-id>/<node-id>/<review-id>` — no collisions. */
export function reviewWorktreePathFor(
  worktreesRoot: string,
  runId: string,
  nodeId: string,
  reviewId: string
): string {
  return path.join(worktreesRoot, "_review", runId, nodeId, reviewId);
}

/**
 * Open a review session on a fixed candidateSha. Never touches the user
 * working tree; the single mutation against the repository is the detached
 * worktree registration.
 */
export async function openReviewSession(
  deps: ReviewDeps,
  input: OpenReviewSessionInput
): Promise<ReviewSession> {
  const { db, git } = deps;
  const value = OpenReviewSessionInputSchema.parse(input);
  await git.assertAvailable();

  // ---- the pinned candidate must exist — fail before anything is created --
  const resolves = await git.tryRun(value.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${value.candidateSha}^{commit}`
  ]);
  if (resolves.exitCode !== 0) {
    throw new ReviewCandidateMissingError({
      candidateSha: value.candidateSha,
      repoPath: value.repoPath
    });
  }

  const reviewId = reviewIdFor(value.runId, value.nodeId, value.candidateSha, value.now);
  const baselineWorktreePath = reviewWorktreePathFor(
    value.worktreesRoot,
    value.runId,
    value.nodeId,
    reviewId
  );
  if (existsSync(baselineWorktreePath)) {
    throw new WorktreePathConflictError(baselineWorktreePath);
  }

  await createReviewWorktree(git, {
    repoPath: value.repoPath,
    worktreePath: baselineWorktreePath,
    candidateSha: value.candidateSha
  });

  // ---- bind the manifest to the candidate CONTENT (creation-phase check) --
  const baseline = await buildBaselineManifest(git, baselineWorktreePath, value.candidateSha);

  // ---- one-shot validation workspace: a verified copy of the baseline -----
  const workspace = createValidationWorkspace(baselineWorktreePath);
  const copied = manifestFromDirectory(workspace.workspacePath);
  const copyDrift = diffManifests(baseline.files, copied);
  if (copyDrift.length > 0) {
    disposeValidationWorkspace(workspace);
    throw new ReviewWorkspaceError({
      workspacePath: workspace.workspacePath,
      detail: `the workspace copy does not match the baseline manifest (${describeDrifts(copyDrift)})`
    });
  }

  try {
    createReviewRecord(db, {
      reviewId,
      runId: value.runId,
      nodeId: value.nodeId,
      candidateSha: value.candidateSha,
      repoPath: value.repoPath,
      baselineWorktreePath,
      validationWorkspacePath: workspace.workspacePath,
      validationTempRoot: workspace.tempRoot,
      baseline,
      now: value.now
    });
  } catch (error) {
    disposeValidationWorkspace(workspace);
    throw error;
  }

  return {
    reviewId,
    runId: value.runId,
    nodeId: value.nodeId,
    candidateSha: value.candidateSha,
    repoPath: value.repoPath,
    baselineWorktreePath,
    validationWorkspacePath: workspace.workspacePath,
    validationTempRoot: workspace.tempRoot,
    baseline,
    artifacts: []
  };
}

const RecordArtifactInputSchema = z.strictObject({
  kind: z.enum(["test-result", "report"] as const satisfies readonly SessionArtifactKind[]),
  summary: z.string().min(1).max(2000),
  exitCode: z.number().int().min(0).max(255).nullable().default(null),
  artifactId: IdSchema.optional(),
  recordedAt: z.string().min(1).max(64).optional()
});

export type RecordValidationArtifactInput = z.input<typeof RecordArtifactInputSchema>;

/**
 * Register one artifact as this session's evidence. The id defaults to a
 * deterministic derived id from the session and the artifact's registry
 * position. Callers that run tests through the engine (a later milestone)
 * register their engine-produced results here.
 */
export function recordValidationArtifact(
  session: ReviewSession,
  input: RecordValidationArtifactInput
): ValidationArtifact {
  const value = RecordArtifactInputSchema.parse(input);
  const artifact: ValidationArtifact = ValidationArtifactSchema.parse({
    artifactRef: {
      id: value.artifactId ?? derivedId("rvpart", session.reviewId, String(session.artifacts.length)),
      kind: value.kind
    },
    summary: value.summary,
    exitCode: value.exitCode,
    recordedAt: value.recordedAt ?? new Date().toISOString()
  });
  session.artifacts.push(artifact);
  return artifact;
}

/**
 * Run one validation command inside the workspace and register its result as
 * a `test-result` artifact. The raw facts (exit code, timeout, output tails)
 * are evidence; nothing here decides pass or fail.
 */
export async function runValidationCommand(
  session: ReviewSession,
  input: ValidationCommandInput
): Promise<ValidationCommandResult & { readonly artifactRef: ValidationArtifact["artifactRef"] }> {
  const result = await runWorkspaceCommand(session.validationWorkspacePath, input);
  const summary = result.timedOut
    ? `validation command timed out after ${String(result.durationMs)}ms: ${result.argv.join(" ")}`
    : `validation command finished with exit code ${String(result.exitCode)}: ${result.argv.join(" ")}`;
  const artifact = recordValidationArtifact(session, {
    kind: "test-result",
    summary,
    exitCode: result.exitCode
  });
  return { ...result, artifactRef: artifact.artifactRef };
}

export interface BaselineInvarianceReport {
  readonly checkedFiles: number;
  readonly digest: string;
}

/**
 * The A13 assertion: the reviewed baseline must STILL be byte-identical to
 * the pinned candidate content (per-file sha256 over every file, plus the
 * worktree HEAD still at the candidateSha). Throws `ReviewBaselineDriftError`
 * on any drift — callers that persist the invalidation do so through
 * `completeReview`/`invalidateReviewSession`.
 */
export async function assertBaselineInvariance(
  deps: ReviewDeps,
  session: ReviewSession
): Promise<BaselineInvarianceReport> {
  const checked = await assertBaselineMatches(deps.git, {
    worktreePath: session.baselineWorktreePath,
    manifest: session.baseline
  });
  return { checkedFiles: checked.checkedFiles, digest: checked.digest };
}

const CompleteReviewInputSchema = z.strictObject({
  /** The verdict payload, in contracts' ReviewSchema shape (reused, not redefined). */
  review: ReviewSchema,
  now: z.string().min(1).max(64)
});

export type CompleteReviewInput = z.input<typeof CompleteReviewInputSchema>;

export interface CompleteReviewResult {
  readonly record: ReviewRecord;
  readonly validationWorkspaceRemoved: boolean;
  readonly checkedFiles: number;
}

/**
 * Record the verdict for THIS session's candidateSha, then end the session.
 *
 * Evidence rules (mirroring ExecutionResultSchema's "review.evidenceRefs may
 * only cite artifacts this result actually reports", applied at session
 * scope):
 *  - the payload's candidateSha must BE the session's candidateSha — a
 *    verdict for other content can never land in this session (A12);
 *  - every evidenceRef must cite an artifact recorded in this session;
 *  - `pass` requires machine-verified test evidence: at least one recorded
 *    test-result with exit 0, and no recorded test-result that exited
 *    nonzero (a reviewer cannot pass what its own evidence saw fail);
 *  - `fail` requires at least one finding (repair nodes need something to
 *    repair; ORCHESTRATION.md section 5).
 *
 * Order matters: payload rejections leave the session OPEN (retryable);
 * a baseline drift persists INVALID first, THEN throws (A13: the error is
 * the signal, the record is the state).
 */
export async function completeReview(
  deps: ReviewDeps,
  session: ReviewSession,
  input: CompleteReviewInput
): Promise<CompleteReviewResult> {
  const { db } = deps;
  const value = CompleteReviewInputSchema.parse(input);
  const review: Review = value.review;

  // ---- payload checks: session stays open on rejection --------------------
  if (review.candidateSha !== session.candidateSha) {
    throw new ReviewEvidenceError({
      reviewId: session.reviewId,
      detail: `the verdict binds candidateSha ${review.candidateSha}, but this session reviews ${session.candidateSha}; a verdict can only be recorded for the candidate under review`
    });
  }
  const recordedIds = new Set(session.artifacts.map((artifact) => artifact.artifactRef.id));
  const unknownRefs = review.evidenceRefs.filter((ref) => !recordedIds.has(ref));
  if (unknownRefs.length > 0) {
    throw new ReviewEvidenceError({
      reviewId: session.reviewId,
      detail: `review.evidenceRefs cite artifacts this session never recorded: ${unknownRefs.join(", ")}`
    });
  }
  const testResults = session.artifacts.filter((artifact) => artifact.artifactRef.kind === "test-result");
  if (review.verdict === "pass") {
    const failing = testResults.filter(
      (artifact) => artifact.exitCode !== null && artifact.exitCode !== 0
    );
    if (failing.length > 0) {
      throw new ReviewEvidenceError({
        reviewId: session.reviewId,
        detail: `cannot record a pass: recorded test evidence exited nonzero (${failing.map((artifact) => `${artifact.artifactRef.id}: exit ${String(artifact.exitCode)}`).join(", ")})`
      });
    }
    if (!testResults.some((artifact) => artifact.exitCode === 0)) {
      throw new ReviewEvidenceError({
        reviewId: session.reviewId,
        detail: "cannot record a pass: no machine-verified test evidence with exit 0 was recorded in this session"
      });
    }
  }
  if (review.verdict === "fail" && review.findings.length < 1) {
    throw new ReviewEvidenceError({
      reviewId: session.reviewId,
      detail: "cannot record a fail without at least one finding; the repair loop has nothing to repair"
    });
  }

  // ---- A13 gate: drift persists INVALID first, then throws ----------------
  let checkedFiles: number;
  try {
    const report = await assertBaselineInvariance(deps, session);
    checkedFiles = report.checkedFiles;
  } catch (error) {
    if (error instanceof ReviewBaselineDriftError) {
      invalidateReviewRecord(db, {
        reviewId: session.reviewId,
        reason: `baseline drift during review: ${describeDrifts(error.drifts)}`,
        now: value.now
      });
      disposeValidationWorkspace({
        workspacePath: session.validationWorkspacePath,
        tempRoot: session.validationTempRoot
      });
    }
    throw error;
  }

  // ---- guarded completion + workspace disposal ----------------------------
  const record = completeReviewRecord(db, {
    reviewId: session.reviewId,
    review,
    evidence: session.artifacts,
    now: value.now
  });
  const disposed = disposeValidationWorkspace({
    workspacePath: session.validationWorkspacePath,
    tempRoot: session.validationTempRoot
  });
  return { record, validationWorkspaceRemoved: disposed.removed, checkedFiles };
}

const InvalidateSessionInputSchema = z.strictObject({
  reason: z.string().min(1).max(2000),
  now: z.string().min(1).max(64)
});

export type InvalidateReviewSessionInput = z.input<typeof InvalidateSessionInputSchema>;

export interface InvalidateReviewSessionResult {
  readonly record: ReviewRecord;
  readonly validationWorkspaceRemoved: boolean;
}

/** End the session without a verdict (harness failure, cancellation). */
export function invalidateReviewSession(
  deps: ReviewDeps,
  session: ReviewSession,
  input: InvalidateReviewSessionInput
): InvalidateReviewSessionResult {
  const value = InvalidateSessionInputSchema.parse(input);
  const record = invalidateReviewRecord(deps.db, {
    reviewId: session.reviewId,
    reason: value.reason,
    now: value.now
  });
  const disposed = disposeValidationWorkspace({
    workspacePath: session.validationWorkspacePath,
    tempRoot: session.validationTempRoot
  });
  return { record, validationWorkspaceRemoved: disposed.removed };
}

function describeDrifts(drifts: readonly BaselineDrift[]): string {
  if (drifts.length === 0) return "no per-file drift";
  return `${String(drifts.length)} drift(s): ${drifts.map((drift) => `${drift.kind} ${drift.path}`).join(", ")}`;
}
