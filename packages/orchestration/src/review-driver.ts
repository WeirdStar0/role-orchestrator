/**
 * M10-02 M8 (review-driver) — the OPTIONAL review phase for multi-node
 * graphs, extracted from the dogfood driver's review branch and de-dogfooded
 * (M10-02 step 3). A composition root whose graph carries review-kind nodes
 * settles them through HERE: the fixed-SHA review session over the reviewed
 * candidate, the machine-evidence validation command, and the
 * candidateSha-bound verdict (A12).
 *
 * GUARD (strategy ③/task-3): the validation command is injectable by TEST
 * composition roots ONLY — it is a parameter of this function, and the
 * RunDriver surface (createRunDriver/RunDriverConfig/RunDriverPorts) carries
 * no such field, so the production driver has no way to review (and the
 * production single-node graph has no review-kind node to review: the phase
 * stays DORMANT).
 */
import type { DatabaseSync } from "node:sqlite";
import type { GitRunner } from "@role-orchestrator/worktree";
import {
  completeReview,
  openReviewSession,
  runValidationCommand
} from "@role-orchestrator/review";

export interface ReviewClaimInput {
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly runId: string;
  readonly nodeId: string;
  /** The reviewed candidate this verdict binds to (A12). */
  readonly candidateSha: string;
  readonly now: string;
  /**
   * Test composition roots ONLY: the reviewer's machine-evidence script,
   * executed with the host node binary inside the one-shot workspace copy of
   * the candidate (A13: the validation directory is writable while the
   * reviewed source is not).
   */
  readonly validationScript: string;
  /** Validation budget; the benchmark composition roots use 60_000. */
  readonly validationTimeoutMs?: number;
  /**
   * Findings recorded on a FAIL verdict. Omitted -> empty findings (the
   * verdict itself is the durable record). The exit code is null when the
   * validation command timed out.
   */
  readonly failureFindings?: (validationExitCode: number | null) => readonly string[];
}

export interface ReviewSettlement {
  readonly reviewId: string;
  /** The candidateSha-bound verdict (A12): pass | fail. */
  readonly verdict: "pass" | "fail";
  /** Null when the validation command timed out (a fail either way). */
  readonly validationExitCode: number | null;
  readonly evidenceRefId: string;
  readonly candidateSha: string;
}

/**
 * Settle ONE review-kind claim: fixed-SHA session -> validation command ->
 * candidateSha-bound verdict. A "fail" verdict is DATA that grounds the
 * rework phase (M10) — the reviewer's run itself succeeded.
 */
export async function settleReviewClaim(
  deps: { readonly db: DatabaseSync; readonly git: GitRunner },
  input: ReviewClaimInput
): Promise<ReviewSettlement> {
  const session = await openReviewSession(deps, {
    repoPath: input.repoPath,
    worktreesRoot: input.worktreesRoot,
    runId: input.runId,
    nodeId: input.nodeId,
    candidateSha: input.candidateSha,
    now: input.now
  });
  const validation = await runValidationCommand(
    session,
    input.validationTimeoutMs !== undefined
      ? {
          argv: [process.execPath, "-e", input.validationScript],
          timeoutMs: input.validationTimeoutMs
        }
      : { argv: [process.execPath, "-e", input.validationScript] }
  );
  const verdict = validation.exitCode === 0 ? "pass" : "fail";
  await completeReview(deps, session, {
    review: {
      verdict,
      candidateSha: session.candidateSha,
      evidenceRefs: [validation.artifactRef.id],
      findings:
        verdict === "pass" ? [] : (input.failureFindings?.(validation.exitCode).slice() ?? [])
    },
    now: input.now
  });
  return {
    reviewId: session.reviewId,
    verdict,
    validationExitCode: validation.exitCode,
    evidenceRefId: validation.artifactRef.id,
    candidateSha: session.candidateSha
  };
}
