/**
 * M10-02 M9 (approval-driver) — the approval surface of the pump, carried
 * over VERBATIM from the former local-api orchestrator.ts.
 *
 * RED LINE (unchanged, strategy ⑥): the driver NEVER approves. The only
 * approval-consuming path is a checkpoint whose approval a human APPROVED
 * through the guarded decision endpoint — surfaced here by the M3 pump's
 * round loop (and by onApprovalDecided). Proposals PARK the node
 * (WAITING_APPROVAL, A19: an unapproved side effect does not happen); an
 * APPROVED checkpoint continues into exactly the ONE digest-bound
 * continuation execution (A17), launched with the engine's claimed-attempt
 * composition like every scheduler claim.
 *
 * M12 note: the continuation launcher is injected (the M4 node-driver owns
 * it) so this module has no runtime edge back into node mechanics.
 */
import { RoleIdSchema } from "@role-orchestrator/contracts";
import { getApproval } from "@role-orchestrator/approval";
import { getTaskRun } from "@role-orchestrator/store";
import {
  continueAfterApproval,
  extractActionProposals,
  listCheckpointsForRun,
  openApprovalCheckpoint
} from "@role-orchestrator/checkpoint";
import { branchNameFor, createWorktree } from "@role-orchestrator/worktree";
import { listRunNodes, transitionNodeState } from "@role-orchestrator/dag";
import { derivedId, releaseExecutionQuotaGrants } from "@role-orchestrator/scheduler";
import type { ExecutionRunResult } from "@role-orchestrator/engine";
import type { DriverContext } from "./context.js";
import { APPROVAL_TTL_SECONDS } from "./constants.js";
import { baselineFor } from "./dependency-resolver.js";
import {
  nodePromptObjective,
  repoRootOf,
  storedEventViews,
  type ExecutionLaunchInput
} from "./execution-input.js";

/** The M4 launch edge, injected to keep module dependencies one-directional. */
export type LaunchExecution = (input: ExecutionLaunchInput) => Promise<ExecutionRunResult>;

/**
 * M10-03: the kind-aware post-continuation settlement (accepted output /
 * review verdict + rework), injected by the M3 pump (which owns the node
 * mechanics) so THIS module keeps no runtime edge back into the node driver —
 * the same one-directionality the launch edge establishes. Absent -> the
 * frozen single-node transitions apply (v0.2.1 parity).
 */
export type SettleMultiNodeContinuation = (input: {
  readonly runId: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly kind: "agent" | "review";
  readonly result: ExecutionRunResult;
  readonly branch: string;
  readonly baselineSha: string;
  readonly attempt: number;
  readonly worktreePath: string;
}) => Promise<void>;

/**
 * Mine the persisted (already redacted) event stream for structured action
 * proposals and open one real checkpoint per proposal. Returns true when at
 * least one checkpoint is now WAITING (the node left RUNNING).
 */
export async function openCheckpointsForProposals(
  context: DriverContext,
  executionId: string,
  cwd: string
): Promise<boolean> {
  const extraction = extractActionProposals(storedEventViews(context.db, executionId));
  let parked = false;
  for (const { proposal } of extraction.proposals) {
    const opened = openApprovalCheckpoint(context.db, {
      executionId,
      proposal,
      cwd,
      grantedPermissions: ["repo.read"],
      ttlSeconds: APPROVAL_TTL_SECONDS,
      now: context.clock.nowIso()
    });
    parked = parked || opened.nodeState === "WAITING_APPROVAL";
  }
  return parked;
}

/**
 * Consume exactly the checkpoints whose approval a human APPROVED through
 * the guarded decision endpoint: continueAfterApproval mints the ONE
 * digest-bound continuation execution (A17), which the pump launches with
 * the engine's claimed-attempt composition — the same dispatch pipeline
 * every scheduler claim uses.
 */
export async function continueApprovedCheckpoints(
  context: DriverContext,
  runId: string,
  launch: LaunchExecution,
  settleMultiNode?: SettleMultiNodeContinuation | undefined
): Promise<void> {
  for (const checkpoint of listCheckpointsForRun(context.db, runId)) {
    if (context.isClosed()) return;
    if (checkpoint.status !== "WAITING") continue;
    const approval = getApproval(context.db, checkpoint.approvalId);
    if (approval === null || approval.status !== "APPROVED") continue;
    const run = getTaskRun(context.db, runId);
    if (run === null) return;
    const continuationExecutionId = derivedId(
      "exec",
      checkpoint.id,
      "cont",
      String(checkpoint.attempt)
    );
    const plan = continueAfterApproval(context.db, {
      checkpointId: checkpoint.id,
      newExecutionId: continuationExecutionId,
      now: context.clock.nowIso()
    });
    transitionNodeState(context.db, {
      runId,
      nodeId: checkpoint.nodeId,
      to: "READY",
      whereStateIn: ["WAITING_APPROVAL"],
      now: context.clock.nowIso()
    });
    transitionNodeState(context.db, {
      runId,
      nodeId: checkpoint.nodeId,
      to: "RUNNING",
      whereStateIn: ["READY"],
      now: context.clock.nowIso()
    });
    const book = context.multiNodeRuns.get(runId) ?? null;
    const nodeRow = listRunNodes(context.db, runId).find(
      (node) => node.nodeId === checkpoint.nodeId
    );
    const dependencies = nodeRow?.dependencies ?? [];
    const attempt = plan.attempt;
    const branch = branchNameFor(runId, checkpoint.nodeId, attempt);
    // Single-node parity: the run's frozen base commit. Multi-node: the M5
    // dependency baseline (the dogfood approval phase's rule).
    const baselineSha =
      book !== null ? baselineFor(dependencies, book.acceptedOutputs, run.baseSha) : run.baseSha;
    const worktree = await createWorktree(context.git, {
      repoPath: repoRootOf(context.db, run.projectId),
      worktreesRoot: context.worktreesRoot,
      runId,
      nodeId: checkpoint.nodeId,
      attempt,
      baseSha: baselineSha
    });
    const roleId = RoleIdSchema.parse(checkpoint.roleId);
    const result = await launch({
      executionId: continuationExecutionId,
      runId,
      roleId,
      nodeId: checkpoint.nodeId,
      definitionRevision: plan.execution.definitionRevision,
      attempt,
      dispatchToken: plan.execution.dispatchToken,
      cwd: worktree.worktreePath,
      profileId: plan.frozen.snapshot.id,
      objective: nodePromptObjective(
        context.db,
        context.multiNodeRuns,
        runId,
        checkpoint.nodeId,
        roleId,
        dependencies
      )
    });
    // The continuation is an engine-owned attempt (no queue entry); only
    // the (no-op) grant-release bookkeeping applies, as in the M6-05 driver.
    releaseExecutionQuotaGrants(context.db, {
      executionId: continuationExecutionId,
      now: context.clock.nowIso()
    });
    const parked = await openCheckpointsForProposals(
      context,
      continuationExecutionId,
      worktree.worktreePath
    );
    if (parked) continue;
    if (book === null) {
      if (result.finalPhase === "SUCCEEDED") {
        transitionNodeState(context.db, {
          runId,
          nodeId: checkpoint.nodeId,
          to: "SUCCEEDED",
          whereStateIn: ["RUNNING"],
          now: context.clock.nowIso()
        });
      } else {
        transitionNodeState(context.db, {
          runId,
          nodeId: checkpoint.nodeId,
          to: "FAILED",
          whereStateIn: ["RUNNING"],
          now: context.clock.nowIso()
        });
      }
      continue;
    }
    // Multi-node: the SAME kind-aware settlement the dispatch path applies
    // (accepted output / review verdict + rework), against the continuation's
    // own worktree and attempt. The settlement edge is INJECTED (the M3 pump
    // owns the node mechanics) — absent, the frozen single-node transitions
    // above apply unchanged.
    const kind = book.kinds.get(checkpoint.nodeId) ?? null;
    if (kind === null || kind === "integration" || settleMultiNode === undefined) {
      throw new Error(
        `approved checkpoint on node "${checkpoint.nodeId}" of run "${runId}" resolves no ` +
          "agent/review dispatch kind; refusing the continuation settlement fail-closed"
      );
    }
    await settleMultiNode({
      runId,
      nodeId: checkpoint.nodeId,
      executionId: continuationExecutionId,
      kind,
      result,
      branch,
      baselineSha,
      attempt,
      worktreePath: worktree.worktreePath
    });
  }
}
