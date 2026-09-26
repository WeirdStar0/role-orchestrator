/**
 * Typed error taxonomy for @role-orchestrator/review (M2-05).
 *
 * Three properties shape every class here (docs/GIT_AND_WORKSPACES.md 读者与
 * 测试 / 冲突与返工, ACCEPTANCE A12/A13):
 * - A13: any drift of the reviewed baseline is a FAILED review, not a
 *   warning. `ReviewBaselineDriftError` is thrown only AFTER the record has
 *   been persisted INVALID — the error is the signal, the record is the state.
 * - A12: a verdict is bound to one exact candidateSha. Evidence problems
 *   (`ReviewEvidenceError`) never mutate the session — a rejected payload
 *   leaves the session open so the caller can retry with a correct one.
 * - Guarded transitions: terminal records never move again
 *   (`ReviewSessionStateError`), the same optimistic discipline as the
 *   scheduler queue and the integration records.
 */
import type { BaselineDrift } from "./baseline.js";

export class ReviewError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReviewError";
  }
}

/** The pinned candidateSha does not resolve to a commit in the repository. */
export class ReviewCandidateMissingError extends ReviewError {
  readonly candidateSha: string;
  readonly repoPath: string;

  constructor(input: { readonly candidateSha: string; readonly repoPath: string }) {
    super(
      `candidateSha ${input.candidateSha} does not resolve to a commit in "${input.repoPath}"; ` +
        "a review session can only be opened on a fixed, existing candidate",
      { cause: input.candidateSha }
    );
    this.name = "ReviewCandidateMissingError";
    this.candidateSha = input.candidateSha;
    this.repoPath = input.repoPath;
  }
}

/**
 * A13: the reviewed baseline no longer matches the content pinned at session
 * open (per-file hashes and/or the worktree HEAD). The review is INVALID —
 * the error is thrown only after the record has been persisted INVALID.
 * `phase: "creation"` means the freshly checked-out worktree did not match
 * the candidate content (checkout integrity), `phase: "final"` means the
 * baseline drifted during the review session.
 */
export class ReviewBaselineDriftError extends ReviewError {
  readonly baselineWorktreePath: string;
  readonly candidateSha: string;
  readonly phase: "creation" | "final";
  readonly headSha: string | null;
  readonly drifts: readonly BaselineDrift[];

  constructor(input: {
    readonly baselineWorktreePath: string;
    readonly candidateSha: string;
    readonly phase: "creation" | "final";
    readonly headSha: string | null;
    readonly drifts: readonly BaselineDrift[];
  }) {
    const driftText =
      input.drifts.length === 0
        ? "no per-file content drift"
        : `${String(input.drifts.length)} drift(s): ` +
          input.drifts.map((drift) => `${drift.kind} ${drift.path}`).join(", ");
    super(
      `review baseline "${input.baselineWorktreePath}" (candidate ${input.candidateSha}, ` +
        `${input.phase} check) is no longer identical to the pinned content: ` +
        `${driftText}; HEAD is ${input.headSha ?? "(unresolvable)"}. ` +
        "The review is INVALID: test results produced in this session cannot be trusted",
      { cause: driftText }
    );
    this.name = "ReviewBaselineDriftError";
    this.baselineWorktreePath = input.baselineWorktreePath;
    this.candidateSha = input.candidateSha;
    this.phase = input.phase;
    this.headSha = input.headSha;
    this.drifts = [...input.drifts];
  }
}

/**
 * The validation workspace (or a validation command) failed operationally:
 * an unfaithful copy, a spawn failure, a guard refusal. No verdict was
 * recorded and the review record (if it exists) is untouched.
 */
export class ReviewWorkspaceError extends ReviewError {
  readonly workspacePath: string | null;
  readonly detail: string;

  constructor(input: {
    readonly workspacePath: string | null;
    readonly detail: string;
    readonly cause?: unknown;
  }) {
    super(
      `validation workspace error${input.workspacePath === null ? "" : ` (${input.workspacePath})`}: ${input.detail}`,
      { cause: input.cause ?? input.detail }
    );
    this.name = "ReviewWorkspaceError";
    this.workspacePath = input.workspacePath;
    this.detail = input.detail;
  }
}

/**
 * The verdict payload was rejected BEFORE anything was persisted: it binds a
 * foreign candidateSha, cites evidence the session never recorded, or claims
 * a pass/fail its recorded evidence does not support. The session stays open.
 */
export class ReviewEvidenceError extends ReviewError {
  readonly reviewId: string;
  readonly detail: string;

  constructor(input: { readonly reviewId: string; readonly detail: string }) {
    super(`review "${input.reviewId}" rejected the verdict payload: ${input.detail}`, {
      cause: input.detail
    });
    this.name = "ReviewEvidenceError";
    this.reviewId = input.reviewId;
    this.detail = input.detail;
  }
}

/** A guarded transition hit a record that already left the expected state. */
export class ReviewSessionStateError extends ReviewError {
  readonly reviewId: string;
  readonly expectedState: string;
  readonly actualState: string;

  constructor(input: {
    readonly reviewId: string;
    readonly expectedState: string;
    readonly actualState: string;
  }) {
    super(
      `review "${input.reviewId}" is ${input.actualState}, expected ${input.expectedState}; ` +
        "refusing to apply a guarded transition from the wrong state",
      { cause: `${input.actualState} != ${input.expectedState}` }
    );
    this.name = "ReviewSessionStateError";
    this.reviewId = input.reviewId;
    this.expectedState = input.expectedState;
    this.actualState = input.actualState;
  }
}

/** No review record exists for the requested identity. */
export class UnknownReviewRecordError extends ReviewError {
  readonly detail: string;

  constructor(detail: string) {
    super(`no review record: ${detail}`);
    this.name = "UnknownReviewRecordError";
    this.detail = detail;
  }
}

/**
 * A persisted review record failed strict re-validation on read (corrupt
 * JSON, manifest bound to another candidateSha, digest mismatch). Fail
 * closed — never answer a query from a record that cannot vouch for itself.
 */
export class ReviewRecordCorruptError extends ReviewError {
  readonly reviewId: string;
  readonly detail: string;

  constructor(input: { readonly reviewId: string; readonly detail: string }) {
    super(`review record "${input.reviewId}" failed validation: ${input.detail}`, {
      cause: input.detail
    });
    this.name = "ReviewRecordCorruptError";
    this.reviewId = input.reviewId;
    this.detail = input.detail;
  }
}

/**
 * The reviewed tree contains entries this reviewer cannot hash faithfully
 * (submodule gitlinks, symlinks). Fail closed instead of pretending the
 * invariance assertion covers them.
 */
export class ReviewBaselineUnsupportedError extends ReviewError {
  readonly entries: readonly string[];

  constructor(entries: readonly string[]) {
    super(
      `baseline contains ${String(entries.length)} unsupported entr(y/ies) ` +
        `(${entries.join(", ")}): only regular-file trees can be reviewed; ` +
        "submodules and symlinks are outside the M2-05 invariance assertion",
      { cause: entries.join(", ") }
    );
    this.name = "ReviewBaselineUnsupportedError";
    this.entries = [...entries];
  }
}
