/**
 * M10-02 M4 (node-driver) — the claimed-node settlement, carried over
 * VERBATIM from the former local-api orchestrator.ts.
 *
 * One scheduler-claimed dispatch runs: worktree (A11 isolation over the USER
 * repo, base = the run's frozen baseSha — production's single-node baseline,
 * mathematically the M5 resolver's answer for a dependency-less node) ->
 * engine.startExecution behind the cancel registry (claimed-attempt
 * composition, argv ARRAY, tree-kill budget) -> the claim's bookkeeping
 * (markQueueEntryCompleted -> releaseExecutionQuotaGrants) -> approval
 * proposal mining (a proposal PARKS the node before any terminal transition,
 * A19) -> the terminal node transition (SUCCEEDED/FAILED).
 */
import {
  getQueueEntry,
  markQueueEntryCompleted,
  releaseExecutionQuotaGrants
} from "@role-orchestrator/scheduler";
import { listAttemptsForSlot, getTaskRun } from "@role-orchestrator/store";
import { createWorktree } from "@role-orchestrator/worktree";
import { listRunNodes, transitionNodeState } from "@role-orchestrator/dag";
import { startExecution, type ExecutionRunResult } from "@role-orchestrator/engine";
import type { DriverContext } from "./context.js";
import { openCheckpointsForProposals } from "./approval-driver.js";
import {
  executionPrompt,
  objectiveOfRun,
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
  const worktree = await createWorktree(context.git, {
    repoPath: repoRootOf(db, run.projectId),
    worktreesRoot: context.worktreesRoot,
    runId,
    nodeId: entry.nodeId,
    attempt,
    // Production parity: the worktree base is ALWAYS the run's frozen base
    // commit (single-node graph — the M5 resolver's baseSha fallback).
    baseSha: run.baseSha
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
    objective: objectiveOfRun(db, runId)
  });

  // The claim's bookkeeping, exactly as the M6-05 driver performs it.
  markQueueEntryCompleted(db, { entryId: outcome.entryId, now: context.clock.nowIso() });
  releaseExecutionQuotaGrants(db, { executionId: outcome.executionId, now: context.clock.nowIso() });

  // A proposal surfaces BEFORE any terminal node transition: the checkpoint
  // moves the node to WAITING_APPROVAL and the run parks there (A19: an
  // unapproved side effect does not happen; the decision is the operator's).
  const parked = await openCheckpointsForProposals(
    context,
    outcome.executionId,
    worktree.worktreePath
  );
  if (parked) return;
  await settleNodeTerminal(context, runId, entry.nodeId, result);
}

/**
 * The terminal node transition after an execution settled — SUCCEEDED on the
 * engine's success formula, FAILED otherwise, only from RUNNING (the frozen
 * vocabulary's own transitions).
 */
export async function settleNodeTerminal(
  context: DriverContext,
  runId: string,
  nodeId: string,
  result: ExecutionRunResult
): Promise<void> {
  const to = result.finalPhase === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
  transitionNodeState(context.db, {
    runId,
    nodeId,
    to,
    whereStateIn: ["RUNNING"],
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
