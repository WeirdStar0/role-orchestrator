/**
 * M10-02 M4 (node-driver) — the claimed-node settlement, carried over
 * VERBATIM from the former local-api orchestrator.ts, extended by M10-03 with
 * the multi-node dispatch:
 *
 *  - v0.2.1 PARITY (the red line): a run without a multi-node book dispatches
 *    exactly as before — worktree at the run's frozen baseSha, prompt = the
 *    bare objective, no output commit, no integration/review phase (the
 *    single-node graph has no such node, and resolveNodeKind refuses any
 *    other unregistered shape).
 *  - MULTI-NODE: the node's declared kind decides the settlement.
 *      agent       — the CLI execution shape above, with the node's baseline
 *                    from the M5 dependency rule (baselineFor over the run's
 *                    accepted outputs, falling back to run.baseSha) and the
 *                    M6 role-context prompt. When the composition root
 *                    injected an OutputCommitter, a SUCCEEDED run's output is
 *                    committed through the port and becomes the node's
 *                    accepted output; without a committer the doctrine's
 *                    "没有代码修改的节点沿用 inputSha" applies (accepted
 *                    output = the node's inputSha).
 *      integration — M7 settleIntegrationClaim (no CLI execution): the
 *                    parents' accepted outputs single-writer-merge into the
 *                    run's task branch; the candidateSha enters the run's
 *                    candidates table and IS the successor baseline.
 *      review      — the reviewer CLI runs, then M8 settleAgentReviewClaim
 *                    settles the fixed-SHA session over the reviewed
 *                    candidate; verdict pass/fail lands durably (A12), the
 *                    node itself settles SUCCEEDED either way (a fail verdict
 *                    is DATA grounding the controlled rework expansion), and
 *                    a fail triggers M10 requestReworkExpansion with the
 *                    coordinator as the A04 requester — the A38 revision lock
 *                    is read by the rework driver at the call instant. A
 *                    reviewer run without a machine-readable verdict fails
 *                    the node closed (no session, no invented verdict).
 *  - everything else (worktree isolation A11, claimed-attempt launch,
 *    settlement bookkeeping, approval proposal mining A19) is the shared
 *    sequence, unchanged.
 */
import { getQueueEntry } from "@role-orchestrator/scheduler";
import { listAttemptsForSlot, getTaskRun } from "@role-orchestrator/store";
import { branchNameFor, createWorktree } from "@role-orchestrator/worktree";
import { listRunNodes } from "@role-orchestrator/dag";
import { startExecution, type ExecutionRunResult } from "@role-orchestrator/engine";
import type { DriverContext } from "./context.js";
import { settleClaimBookkeeping, transitionNodeTerminal } from "./pump-primitives.js";
import { openCheckpointsForProposals } from "./approval-driver.js";
import { settleIntegrationClaim } from "./integration-driver.js";
import { parseAgentReviewVerdict, settleAgentReviewClaim } from "./review-driver.js";
import { requestReworkExpansion } from "./rework-driver.js";
import { baselineFor } from "./dependency-resolver.js";
import { resolveNodeKind } from "./multi-node.js";
import {
  executionPrompt,
  nodePromptObjective,
  repoRootOf,
  resolveExecutionSettings,
  type ExecutionLaunchInput
} from "./execution-input.js";

/** One scheduler-claimed dispatch outcome (the pollQueue shape). */
export interface ClaimedDispatch {
  readonly executionId: string;
  readonly entryId: string;
  readonly dispatchToken: string;
}

/**
 * Settle ONE claimed dispatch to a terminal node state (or park it on an
 * approval checkpoint). The M3 pump calls this serially per dispatched
 * outcome — exactly the former behavior.
 */
export async function runClaimedDispatch(
  context: DriverContext,
  runId: string,
  outcome: ClaimedDispatch
): Promise<void> {
  const { db } = context;
  const run = getTaskRun(db, runId);
  const entry = getQueueEntry(db, outcome.entryId);
  if (run === null || entry === null) return;
  const node = listRunNodes(db, runId).find((candidate) => candidate.nodeId === entry.nodeId);
  if (node === undefined) return;
  const attempt = listAttemptsForSlot(db, { runId, nodeId: entry.nodeId }).length;
  // The dispatch kind (fail-closed on unknown multi-node shapes — see
  // resolveNodeKind; the v0.2.1 single-node shape answers "agent").
  const kind = resolveNodeKind(db, context.multiNodeRuns, runId, node.nodeId, node.roleId);
  const book = context.multiNodeRuns.get(runId) ?? null;
  const dependencies = node.dependencies;

  // The M5 dependency rule for MULTI-node runs: the last dependency with an
  // accepted output, else the run's frozen base commit. Single-node runs keep
  // the literal run.baseSha (production parity).
  const baselineSha =
    book !== null ? baselineFor(dependencies, book.acceptedOutputs, run.baseSha) : run.baseSha;
  const branch = branchNameFor(runId, node.nodeId, attempt);

  // ---- integration nodes: the M7 integration-driver, THEN the node's CLI ---
  // The dogfood mother launches the integration node's own CLI after the
  // single-writer merge (the architect's supervising run); skipping it would
  // leave the scheduler's claimed attempt row STARTING forever — the engine
  // owns attempt settlement, so the merge is followed by the same launch and
  // shared settlement every claimed node goes through.
  if (kind === "integration") {
    if (book === null) {
      // Unreachable (integration kinds exist only on registered runs) — kept
      // so the narrowed type is honest.
      throw new Error(`integration node "${node.nodeId}" of run "${runId}" has no multi-node book`);
    }
    await settleIntegrationClaim(
      { db, git: context.git },
      {
        repoPath: repoRootOf(db, run.projectId),
        worktreesRoot: context.worktreesRoot,
        runId,
        nodeId: node.nodeId,
        baseSha: run.baseSha,
        dependencies,
        acceptedOutputs: book.acceptedOutputs,
        candidates: book.candidates,
        now: context.clock.nowIso()
      }
    );
  }

  const worktree = await createWorktree(context.git, {
    repoPath: repoRootOf(db, run.projectId),
    worktreesRoot: context.worktreesRoot,
    runId,
    nodeId: entry.nodeId,
    attempt,
    // Single-node parity: the run's frozen base commit. Multi-node: the M5
    // dependency baseline computed above.
    baseSha: baselineSha
  });

  const result = await launchExecution(context, {
    executionId: outcome.executionId,
    runId,
    roleId: node.roleId,
    nodeId: entry.nodeId,
    definitionRevision: node.definitionRevision,
    attempt,
    dispatchToken: outcome.dispatchToken,
    cwd: worktree.worktreePath,
    profileId: entry.profileId,
    objective: nodePromptObjective(context.db, context.multiNodeRuns, runId, node.nodeId, node.roleId, dependencies)
  });

  // The claim's bookkeeping, exactly as the M6-05 driver performs it — the
  // SHARED settlement sequence's two-entry half (M10-02 step 2); the terminal
  // transition follows only when no proposal parked the node.
  settleClaimBookkeeping(db, {
    entryId: outcome.entryId,
    executionId: outcome.executionId,
    now: context.clock.nowIso()
  });

  // A proposal surfaces BEFORE any terminal node transition: the checkpoint
  // moves the node to WAITING_APPROVAL and the run parks there (A19: an
  // unapproved side effect does not happen; the decision is the operator's).
  const parked = await openCheckpointsForProposals(
    context,
    outcome.executionId,
    worktree.worktreePath
  );
  if (parked) return;
  if (book === null) {
    await settleNodeTerminal(context, runId, entry.nodeId, result);
    return;
  }
  const committer = context.outputCommitter;
  await settleMultiNodeTerminal(context, {
    runId,
    nodeId: entry.nodeId,
    executionId: outcome.executionId,
    kind,
    result,
    branch,
    baselineSha,
    attempt,
    // The node-output commit closure: the port runs against THIS settlement's
    // worktree (dispatch or continuation), only for SUCCEEDED agent runs.
    commitOutput:
      kind === "agent" && committer !== null
        ? () =>
            committer.commitNodeOutput({
              runId,
              nodeId: entry.nodeId,
              executionId: outcome.executionId,
              attempt,
              worktreePath: worktree.worktreePath,
              baselineSha
            })
        : null
  });
}

/**
 * The multi-node post-execution settlement: land the accepted output (agent),
 * the fixed-SHA verdict and the possible rework expansion (review), then the
 * terminal transition. Shared by the pump's dispatch path and the M9
 * approval-continuation path so both apply the same kind semantics.
 */
export async function settleMultiNodeTerminal(
  context: DriverContext,
  input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly executionId: string;
    readonly kind: "agent" | "integration" | "review";
    readonly result: ExecutionRunResult;
    readonly branch: string;
    readonly baselineSha: string;
    readonly attempt: number;
    /** The port-backed commit for SUCCEEDED agent runs; null when not applicable. */
    readonly commitOutput: (() => Promise<string | null>) | null;
  }
): Promise<void> {
  const { db } = context;
  const book = context.multiNodeRuns.get(input.runId);
  if (book === undefined) {
    // Unreachable for callers that resolved the kind through the book.
    await settleNodeTerminal(context, input.runId, input.nodeId, input.result);
    return;
  }

  // ---- integration nodes: the candidate IS the accepted output -------------
  if (input.kind === "integration") {
    const candidateSha = book.candidates.get(input.nodeId);
    if (input.result.finalPhase === "SUCCEEDED" && candidateSha !== undefined) {
      book.acceptedOutputs.set(input.nodeId, { branch: input.branch, headSha: candidateSha });
    }
    transitionNodeTerminal(db, {
      runId: input.runId,
      nodeId: input.nodeId,
      to: input.result.finalPhase === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      now: context.clock.nowIso()
    });
    return;
  }

  // ---- review nodes: the verdict decides the node's terminal state --------
  if (input.kind === "review") {
    if (input.result.finalPhase !== "SUCCEEDED") {
      await settleNodeTerminal(context, input.runId, input.nodeId, input.result);
      return;
    }
    const claim = parseAgentReviewVerdict(db, input.executionId);
    if (
      claim === null ||
      claim.verdict === "blocked" ||
      (claim.verdict === "fail" && claim.findings.length < 1)
    ) {
      // No machine-readable verdict (or an unusable fail): fail-closed — no
      // session is opened, nothing verdict-shaped is invented. The CLI run
      // itself was protocol-clean; the node still lands FAILED (the review
      // did not complete).
      transitionNodeTerminal(db, {
        runId: input.runId,
        nodeId: input.nodeId,
        to: "FAILED",
        now: context.clock.nowIso()
      });
      return;
    }
    const run = getTaskRun(db, input.runId);
    if (run === null) return;
    const dependencies =
      listRunNodes(db, input.runId).find((candidate) => candidate.nodeId === input.nodeId)
        ?.dependencies ?? [];
    const reviewedNodeId = dependencies[dependencies.length - 1];
    const reviewedOutput =
      reviewedNodeId === undefined ? undefined : book.acceptedOutputs.get(reviewedNodeId);
    if (reviewedOutput === undefined) {
      throw new Error(
        `review node "${input.nodeId}" of run "${input.runId}" has no accepted output to review ` +
          "(pump-contract violation: the node became READY without its dependency settling)"
      );
    }
    const settlement = await settleAgentReviewClaim(
      { db, git: context.git },
      {
        repoPath: repoRootOf(db, run.projectId),
        worktreesRoot: context.worktreesRoot,
        runId: input.runId,
        nodeId: input.nodeId,
        candidateSha: reviewedOutput.headSha,
        executionId: input.executionId,
        agentExitCode: input.result.exitCode,
        now: context.clock.nowIso()
      }
    );
    // The reviewer's run succeeded and the verdict is durable: the node
    // SUCCEEDS either way — a fail verdict is DATA that grounds the rework
    // expansion (the M8/M10 decoupling).
    transitionNodeTerminal(db, {
      runId: input.runId,
      nodeId: input.nodeId,
      to: "SUCCEEDED",
      now: context.clock.nowIso()
    });
    book.acceptedOutputs.set(input.nodeId, { branch: input.branch, headSha: input.baselineSha });
    if (settlement.verdict === "fail") {
      const expansion = requestReworkExpansion(db, {
        runId: input.runId,
        reviewNodeId: input.nodeId,
        candidateSha: settlement.candidateSha,
        // The M9 binding convention: only the coordinator carries
        // canCreateSubtasks (A04) — the expansion requester.
        requesterRoleId: "coordinator",
        now: context.clock.nowIso()
      });
      if (expansion.created) {
        // Register the minted pair's dispatch kinds so the pump drives the
        // repair like any other node (fix = CLI agent, re-review = review).
        book.kinds.set(expansion.fixNode.nodeId, "agent");
        book.kinds.set(expansion.reviewNode.nodeId, "review");
      }
      context.log.log(
        `[orchestrator] review "${input.nodeId}" verdict fail on ${settlement.candidateSha.slice(0, 12)}…; ` +
          `rework expansion ${expansion.expansionId} ` +
          (expansion.created
            ? `minted ${expansion.fixNode.nodeId} + ${expansion.reviewNode.nodeId} at revision ${String(expansion.revision)}`
            : "was an idempotent replay")
      );
    }
    return;
  }

  // ---- agent nodes: the accepted output, then the terminal transition -----
  if (input.result.finalPhase === "SUCCEEDED") {
    let headSha = input.baselineSha;
    if (input.commitOutput !== null) {
      const committed = await input.commitOutput();
      if (committed !== null) headSha = committed;
    }
    book.acceptedOutputs.set(input.nodeId, { branch: input.branch, headSha });
  }
  transitionNodeTerminal(db, {
    runId: input.runId,
    nodeId: input.nodeId,
    to: input.result.finalPhase === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
    now: context.clock.nowIso()
  });
}

/**
 * The terminal node transition after an execution settled — SUCCEEDED on the
 * engine's success formula, FAILED otherwise, only from RUNNING (the frozen
 * vocabulary's own transitions; the SHARED transition half, M10-02 step 2).
 */
export async function settleNodeTerminal(
  context: DriverContext,
  runId: string,
  nodeId: string,
  result: ExecutionRunResult
): Promise<void> {
  transitionNodeTerminal(context.db, {
    runId,
    nodeId,
    to: result.finalPhase === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
    now: context.clock.nowIso()
  });
}

/**
 * engine.startExecution behind the cancel registry — the launch edge the M9
 * approval-driver borrows for its continuation executions.
 */
export async function launchExecution(
  context: DriverContext,
  input: ExecutionLaunchInput
): Promise<ExecutionRunResult> {
  const { timeoutSeconds, invocationArgs } = resolveExecutionSettings(
    context.profilesById,
    input.profileId
  );
  const execution = startExecution(context.db, {
    executionId: input.executionId,
    runId: input.runId,
    roleId: input.roleId,
    nodeId: input.nodeId,
    definitionRevision: input.definitionRevision,
    attempt: input.attempt,
    dispatchToken: input.dispatchToken,
    cwd: input.cwd,
    prompt: executionPrompt(input),
    invocationArgs,
    timeoutSeconds,
    now: context.clock.nowIso(),
    claimedAttempt: true
  });
  context.activeCancels.set(input.executionId, (reason: string) => execution.cancel(reason));
  try {
    return await execution.result;
  } finally {
    context.activeCancels.delete(input.executionId);
  }
}
