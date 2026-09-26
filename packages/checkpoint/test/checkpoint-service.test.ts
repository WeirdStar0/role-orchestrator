/**
 * openApprovalCheckpoint (M4-02): the A19 node checkpoint over a real
 * migrated store. Pins:
 * - checkpoints open ONLY against terminal attempts (no faked mid-run pause);
 * - the proposal becomes a PENDING one-shot approval bound to the frozen
 *   profile revision (A17 digest inputs);
 * - the node lands WAITING_APPROVAL through the dag state machine;
 * - refusal dispositions write NOTHING;
 * - the whole open is idempotent per (execution, proposal).
 */
import { describe, expect, test } from "vitest";
import { actionDigest, requireApproval } from "@role-orchestrator/approval";
import { requireNodeState, transitionNodeState } from "@role-orchestrator/dag";
import { setAttemptPhase } from "@role-orchestrator/store";
import {
  CheckpointExecutionNotEndedError,
  CheckpointNodeStateError,
  UnverifiedApprovalChannelError,
  descriptorFromProposal,
  getCheckpoint,
  getWaitingCheckpointForNode,
  listCheckpointsForRun
} from "../src/index.js";
import {
  SHA_A,
  T0,
  createCheckpointWorld,
  markNodeRunning,
  openWorldCheckpoint,
  sampleProposal,
  seedTerminalExecution,
  type World
} from "./helpers.js";

async function worldWithEndedExecution(label: string): Promise<{ world: World; executionId: string }> {
  const world = await createCheckpointWorld(label);
  markNodeRunning(world.db, world.runId, world.nodeId);
  seedTerminalExecution(world.db, {
    executionId: "exec-1",
    runId: world.runId,
    nodeId: world.nodeId
  });
  return { world, executionId: "exec-1" };
}

describe("openApprovalCheckpoint", () => {
  test("converts an ended execution's proposal into approval + WAITING_APPROVAL", async () => {
    const { world, executionId } = await worldWithEndedExecution("open-basic");
    try {
      const result = openWorldCheckpoint(world, {
        executionId,
        proposal: sampleProposal(undefined, "propose-open-1")
      });
      expect(result.created).toBe(true);
      expect(result.nodeState).toBe("WAITING_APPROVAL");
      expect(requireNodeState(world.db, { runId: world.runId, nodeId: world.nodeId }).state).toBe(
        "WAITING_APPROVAL"
      );

      // The checkpoint row re-verifies its own digest on read.
      expect(result.checkpoint.actionDigest).toBe(actionDigest(result.checkpoint.action));
      expect(result.checkpoint.status).toBe("WAITING");
      expect(result.checkpoint.executionId).toBe(executionId);
      expect(result.checkpoint.attempt).toBe(1);
      expect(result.checkpoint.roleId).toBe("developer");

      // The approval is the checkpoint's authorization credential: PENDING,
      // bound to the requester and to the frozen profile revision.
      const approval = requireApproval(world.db, result.checkpoint.approvalId);
      expect(approval.status).toBe("PENDING");
      expect(approval.requiresApproval).toBe(true);
      expect(approval.action.profileRevision).toBe("1");
      expect(approval.action.repo.baseSha).toBe(SHA_A);
      expect(approval.requestedBy).toEqual({
        runId: world.runId,
        nodeId: world.nodeId,
        attempt: 1
      });
      expect(approval.actionDigest).toBe(result.checkpoint.actionDigest);
    } finally {
      world.close();
    }
  });

  test("refuses an ACTIVE attempt: a checkpoint is never a faked mid-run pause", async () => {
    const world = await createCheckpointWorld("open-active");
    try {
      markNodeRunning(world.db, world.runId, world.nodeId);
      // attempt 1 created but walked only to RUNNING — the CLI has NOT ended.
      seedTerminalExecution(world.db, { executionId: "exec-live", runId: world.runId });
      setAttemptPhase(world.db, {
        id: "exec-live",
        phase: "RUNNING",
        wherePhaseIn: ["FAILED"],
        now: T0
      });
      expect(() =>
        openWorldCheckpoint(world, {
          executionId: "exec-live",
          proposal: sampleProposal(undefined, "propose-live")
        })
      ).toThrow(CheckpointExecutionNotEndedError);
      expect(listCheckpointsForRun(world.db, world.runId)).toHaveLength(0);
      expect(requireNodeState(world.db, { runId: world.runId, nodeId: world.nodeId }).state).toBe(
        "RUNNING"
      );
    } finally {
      world.close();
    }
  });

  test("a proposal relying on the unverified interactive channel is refused with ZERO writes", async () => {
    const { world, executionId } = await worldWithEndedExecution("open-unverified");
    try {
      expect(() =>
        openWorldCheckpoint(world, {
          executionId,
          proposal: sampleProposal({ requiresInteractiveApproval: true }, "propose-ch")
        })
      ).toThrow(UnverifiedApprovalChannelError);
      expect(listCheckpointsForRun(world.db, world.runId)).toHaveLength(0);
      expect(requireNodeState(world.db, { runId: world.runId, nodeId: world.nodeId }).state).toBe(
        "RUNNING"
      );
      // No approval was minted either: the refusal predates any write.
      const rows = world.db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as {
        n: number;
      };
      expect(Number(rows.n)).toBe(0);
    } finally {
      world.close();
    }
  });

  test("a proposal landing on a SUCCEEDED node is a typed state refusal (rollback)", async () => {
    const { world, executionId } = await worldWithEndedExecution("open-node-state");
    try {
      // Simulate the orchestrator having already finished the branch.
      transitionNodeState(world.db, {
        runId: world.runId,
        nodeId: world.nodeId,
        to: "SUCCEEDED",
        whereStateIn: ["RUNNING"],
        now: T0
      });
      expect(() =>
        openWorldCheckpoint(world, {
          executionId,
          proposal: sampleProposal(undefined, "propose-done")
        })
      ).toThrow(CheckpointNodeStateError);
      expect(listCheckpointsForRun(world.db, world.runId)).toHaveLength(0);
      const rows = world.db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number };
      expect(Number(rows.n)).toBe(0);
    } finally {
      world.close();
    }
  });

  test("replaying the same (execution, proposal) returns the SAME checkpoint and approval", async () => {
    const { world, executionId } = await worldWithEndedExecution("open-replay");
    try {
      // The SAME proposal object both times: replay semantics key on the
      // (execution, proposalId) pair with an IDENTICAL action.
      const replayed = sampleProposal(undefined, "propose-replay-1");
      const first = openWorldCheckpoint(world, {
        executionId,
        proposal: replayed
      });
      const second = openWorldCheckpoint(world, {
        executionId,
        proposal: replayed
      });
      expect(second.created).toBe(false);
      expect(second.checkpoint.id).toBe(first.checkpoint.id);
      expect(second.approval.id).toBe(first.approval.id);
      expect(listCheckpointsForRun(world.db, world.runId)).toHaveLength(1);
      // A different proposal of the same execution is its OWN checkpoint; the
      // node is already waiting and stays waiting.
      const third = openWorldCheckpoint(world, {
        executionId,
        proposal: sampleProposal(undefined, "propose-replay-2")
      });
      expect(third.created).toBe(true);
      expect(third.checkpoint.id).not.toBe(first.checkpoint.id);
      expect(third.nodeState).toBe("WAITING_APPROVAL");
      expect(getWaitingCheckpointForNode(world.db, { runId: world.runId, nodeId: world.nodeId })).not.toBeNull();
    } finally {
      world.close();
    }
  });

  test("descriptorFromProposal binds the frozen context; a changed element changes the digest", async () => {
    const world = await createCheckpointWorld("descriptor");
    try {
      const proposal = sampleProposal(undefined, "propose-desc");
      const context = {
        runtime: "claude",
        cwd: "h:/worktrees/demo",
        repoRoot: "h:/repos/proj-1",
        baseSha: SHA_A,
        profileRevision: "1",
        grantedPermissions: ["repo.read"]
      } as const;
      const descriptor = descriptorFromProposal(proposal, context);
      expect(descriptor.runtime).toBe("claude");
      expect(descriptor.argv).toEqual(proposal.action.argv);
      expect(descriptor.profileRevision).toBe("1");
      expect(descriptor.repo).toEqual({ root: "h:/repos/proj-1", baseSha: SHA_A, targetSha: null });
      // Changing ONE argv element produces a different digest (A17 input).
      const changed = descriptorFromProposal(
        {
          ...proposal,
          action: { ...proposal.action, argv: [...proposal.action.argv.slice(0, -1), "other.txt"] }
        },
        context
      );
      expect(actionDigest(changed)).not.toBe(actionDigest(descriptor));
      expect(getCheckpoint(world.db, "does-not-exist")).toBeNull();
    } finally {
      world.close();
    }
  });
});
