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
 *
 * M10-03 — the PRODUCTION settlement for review-kind nodes lives here too
 * (`settleAgentReviewClaim`): it injects NO command. The machine evidence is
 * the reviewer agent's OWN engine-executed run (its exit code, recorded as
 * the session's test-result artifact — the door `recordValidationArtifact`
 * documents for engine-produced results), and the verdict/findings are the
 * reviewer's STRUCTURED final result (the frozen contracts
 * ExecutionResultSchema.review field the engine already validates). The A12
 * binding is the SESSION's fixed candidateSha — the agent's claimed
 * candidateSha is informational and deliberately not trusted. A reviewer run
 * without a machine-readable verdict settles no session at all (the caller
 * fails the node closed).
 */
import type { DatabaseSync } from "node:sqlite";
import type { GitRunner } from "@role-orchestrator/worktree";
import { ExecutionResultSchema } from "@role-orchestrator/contracts";
import {
  completeReview,
  openReviewSession,
  recordValidationArtifact,
  runValidationCommand
} from "@role-orchestrator/review";
import { storedEventViews } from "./execution-input.js";

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

// ---------------------------------------------------------------------------
// M10-03 — the PRODUCTION review settlement (no injected command)
// ---------------------------------------------------------------------------

/** The machine-readable review verdict a reviewer agent reported. */
export interface AgentReviewClaim {
  readonly verdict: "pass" | "fail" | "blocked";
  readonly findings: readonly string[];
}

/**
 * Read the reviewer agent's structured verdict from the PERSISTED (already
 * engine-redacted) event stream: the last result_reported event's business
 * result, validated through the frozen ExecutionResultSchema; its optional
 * `review` field is the verdict channel the frozen contracts define. Answers
 * null when the stream carries no parsable structured review.
 */
export function parseAgentReviewVerdict(
  db: DatabaseSync,
  executionId: string
): AgentReviewClaim | null {
  const finalResult = [...storedEventViews(db, executionId)]
    .reverse()
    .find((event) => event.type === "result_reported");
  if (finalResult === undefined) return null;
  const parsed = ExecutionResultSchema.safeParse(finalResult.payload["businessResult"]);
  if (!parsed.success || parsed.data.review === undefined) return null;
  return { verdict: parsed.data.review.verdict, findings: parsed.data.review.findings };
}

export interface AgentReviewSettlementInput {
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly runId: string;
  readonly nodeId: string;
  /** The reviewed candidate — the SESSION's fixed A12 binding SHA. */
  readonly candidateSha: string;
  /** The reviewer agent's execution (its engine result grounds the evidence). */
  readonly executionId: string;
  /** The reviewer run's process exit code (null when it never exited cleanly). */
  readonly agentExitCode: number | null;
  readonly now: string;
}

export interface AgentReviewSettlement {
  readonly reviewId: string;
  readonly verdict: "pass" | "fail";
  readonly candidateSha: string;
  readonly evidenceRefId: string;
}

/**
 * Settle ONE production review-kind claim: open the fixed-SHA session on the
 * reviewed candidate, record the reviewer agent's own engine run as the
 * machine evidence (a test-result artifact with the run's exit code), and
 * complete the session with the agent's structured verdict — pass requires
 * the agent's exit 0 (the session's own evidence rule), fail requires at
 * least one finding (the agent's findings; a fail without findings is refused
 * by the caller BEFORE any session is opened).
 *
 * `blocked` never reaches here: the caller fails the node closed instead of
 * recording a verdict the review package cannot represent.
 */
export async function settleAgentReviewClaim(
  deps: { readonly db: DatabaseSync; readonly git: GitRunner },
  input: AgentReviewSettlementInput
): Promise<AgentReviewSettlement> {
  const claim = parseAgentReviewVerdict(deps.db, input.executionId);
  if (claim === null) {
    throw new Error(
      `review execution "${input.executionId}" carries no machine-readable structured review; ` +
        "no session was opened (fail-closed)"
    );
  }
  if (claim.verdict === "fail" && claim.findings.length < 1) {
    throw new Error(
      `review execution "${input.executionId}" reported verdict fail without findings; ` +
        "no session was opened (a fail needs something to repair)"
    );
  }
  const session = await openReviewSession(deps, {
    repoPath: input.repoPath,
    worktreesRoot: input.worktreesRoot,
    runId: input.runId,
    nodeId: input.nodeId,
    candidateSha: input.candidateSha,
    now: input.now
  });
  const artifact = recordValidationArtifact(session, {
    kind: "test-result",
    summary:
      `reviewer execution ${input.executionId} finished with exit code ` +
      `${String(input.agentExitCode ?? -1)}; structured verdict: ${claim.verdict}`,
    exitCode: input.agentExitCode
  });
  const verdict = claim.verdict === "pass" ? "pass" : "fail";
  await completeReview(deps, session, {
    review: {
      verdict,
      candidateSha: session.candidateSha,
      evidenceRefs: [artifact.artifactRef.id],
      findings: claim.findings.slice()
    },
    now: input.now
  });
  return {
    reviewId: session.reviewId,
    verdict,
    candidateSha: session.candidateSha,
    evidenceRefId: artifact.artifactRef.id
  };
}
