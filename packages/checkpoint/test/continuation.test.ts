/**
 * continueAfterApproval (M4-02) — the bounded continuation. Pins:
 * - 未批准 / 过期 / 已消费 approvals each refuse with their own typed error;
 * - the presented action must digest-match the approved one (A17) — including
 *   when the CHECKPOINT row itself is rewritten;
 * - success creates ONE fresh attempt (A23 slot constraint), transitions the
 *   checkpoint WAITING -> CONTINUED, consumes the approval bound to the NEW
 *   execution, and emits the dispatch outbox message — all atomic;
 * - a second continuation (or an A23 slot conflict) is refused and consumes
 *   nothing;
 * - the continuation runs from the FROZEN snapshot (A34): a profile revision
 *   disagreement is a typed refusal.
 */
import { describe, expect, test } from "vitest";
import {
  ActionDescriptorSchema,
  ApprovalAlreadyConsumedError,
  ApprovalDigestMismatchError,
  actionDigest,
  approveApproval,
  consumeApproval,
  rejectApproval
} from "@role-orchestrator/approval";
import {
  ActiveAttemptConflictError,
  createActiveAttempt,
  listAttemptsForSlot,
  listPendingOutboxMessages
} from "@role-orchestrator/store";
import {
  CheckpointRecordCorruptError,
  CheckpointStateError,
  ContinuationApprovalAlreadyConsumedError,
  ContinuationApprovalExpiredError,
  ContinuationNotApprovedError,
  ContinuationProfileMismatchError,
  continueAfterApproval,
  descriptorFromProposal,
  getCheckpoint,
  openApprovalCheckpoint
} from "../src/index.js";
import {
  createCheckpointWorld,
  iso,
  markNodeRunning,
  openWorldCheckpoint,
  sampleProposal,
  seedTerminalExecution,
  type World
} from "./helpers.js";

async function waitingCheckpointWorld(label: string): Promise<{
  world: World;
  executionId: string;
  checkpointId: string;
  approvalId: string;
}> {
  const world = await createCheckpointWorld(label);
  markNodeRunning(world.db, world.runId, world.nodeId);
  seedTerminalExecution(world.db, { executionId: "exec-1", runId: world.runId });
  const opened = openWorldCheckpoint(world, {
    executionId: "exec-1",
    proposal: sampleProposal(undefined, "propose-cont")
  });
  return {
    world,
    executionId: "exec-1",
    checkpointId: opened.checkpoint.id,
    approvalId: opened.approval.id
  };
}

describe("continueAfterApproval refusals", () => {
  test("a PENDING approval refuses the continuation (审批未批准)", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-pending");
    try {
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-2",
          now: iso(2000)
        })
      ).toThrow(ContinuationNotApprovedError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(1);
      const approval = world.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as {
        status: string;
      };
      expect(approval.status).toBe("PENDING");
    } finally {
      world.close();
    }
  });

  test("a REJECTED approval refuses the continuation", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-rejected");
    try {
      rejectApproval(world.db, {
        approvalId,
        rejectedBy: "user-1",
        reason: "not this path",
        now: iso(1500)
      });
      expect(() =>
        continueAfterApproval(world.db, { checkpointId, newExecutionId: "exec-2", now: iso(2000) })
      ).toThrow(ContinuationNotApprovedError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(1);
    } finally {
      world.close();
    }
  });

  test("an APPROVED-but-expired approval refuses the continuation (过期)", async () => {
    const world = await createCheckpointWorld("cont-expired");
    try {
      markNodeRunning(world.db, world.runId, world.nodeId);
      seedTerminalExecution(world.db, { executionId: "exec-1", runId: world.runId });
      // 1 second TTL: the approval dies at T0+1s.
      const opened = openApprovalCheckpoint(world.db, {
        executionId: "exec-1",
        proposal: sampleProposal(undefined, "propose-exp"),
        cwd: world.scratchDir,
        grantedPermissions: ["repo.read"],
        ttlSeconds: 1,
        now: iso(0)
      });
      approveApproval(world.db, { approvalId: opened.approval.id, approvedBy: "user-1", now: iso(0) });
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId: opened.checkpoint.id,
          newExecutionId: "exec-2",
          now: iso(5000)
        })
      ).toThrow(ContinuationApprovalExpiredError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(1);
      const approval = world.db.prepare("SELECT status FROM approvals WHERE id = ?").get(opened.approval.id) as {
        status: string;
      };
      expect(approval.status).toBe("APPROVED"); // evidence kept, refused at use
    } finally {
      world.close();
    }
  });

  test("an already-consumed approval refuses a second continuation (已消费, A18)", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-consumed");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      const first = continueAfterApproval(world.db, {
        checkpointId,
        newExecutionId: "exec-2",
        now: iso(2000)
      });
      expect(first.approval.status).toBe("CONSUMED");
      expect(first.approval.consumedByExecutionId).toBe("exec-2");
      // The checkpoint itself refuses a second continuation (有限续行)...
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-3",
          now: iso(3000)
        })
      ).toThrow(CheckpointStateError);
      // ...and the approval layer refuses a direct replay for the SAME action
      // even if a checkpoint state were reconstructed (A18).
      expect(() =>
        consumeApproval(world.db, {
          approvalId,
          action: first.checkpoint.action,
          consumedByExecutionId: "exec-3",
          now: iso(3000)
        })
      ).toThrow(ApprovalAlreadyConsumedError);
      // Surgery: reset the checkpoint row to WAITING behind the service's
      // back. The continuation now reaches the CONSUMED approval and refuses
      // with its own typed error — no second attempt either way.
      world.db
        .prepare(
          "UPDATE approval_checkpoints SET status = 'WAITING', continuation_execution_id = NULL, continued_at = NULL WHERE id = ?"
        )
        .run(checkpointId);
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-3",
          now: iso(3000)
        })
      ).toThrow(ContinuationApprovalAlreadyConsumedError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(2);
    } finally {
      world.close();
    }
  });

  test("a presented action that differs from the approved one is a digest refusal (A17)", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-mismatch");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      const sneaky = sampleProposal(undefined, "propose-cont");
      const sneakyAction = {
        ...sneaky.action,
        argv: ["fake-agent", "write", "--path", "h:/worktrees/demo/OTHER.txt"]
      };
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-2",
          presentedAction: sneakyAction,
          now: iso(2000)
        })
      ).toThrow(ApprovalDigestMismatchError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(1);
      const approval = world.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as {
        status: string;
      };
      expect(approval.status).toBe("APPROVED"); // failed attempt never burns it
    } finally {
      world.close();
    }
  });

  test("a rewritten checkpoint row cannot smuggle a changed action past the approval (A17)", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-rewrite");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      // Rewrite the checkpoint's stored action + digest CONSISTENTLY (so the
      // row still self-validates) but to a DIFFERENT argv than approved.
      const original = getCheckpoint(world.db, checkpointId);
      if (original === null) throw new Error("checkpoint missing");
      const forged = descriptorFromProposal(
        {
          ...original.proposal,
          action: {
            ...original.proposal.action,
            argv: ["fake-agent", "write", "--path", "h:/worktrees/demo/FORGED.txt"]
          }
        },
        {
          runtime: original.action.runtime,
          cwd: original.action.cwd,
          repoRoot: original.action.repo.root,
          baseSha: original.action.repo.baseSha,
          profileRevision: original.action.profileRevision,
          grantedPermissions: original.action.grantedPermissions
        }
      );
      world.db
        .prepare("UPDATE approval_checkpoints SET action = ?, action_digest = ? WHERE id = ?")
        .run(JSON.stringify(forged), actionDigest(forged), checkpointId);
      // The row self-validates, but the continuation presents it against the
      // APPROVAL's digest — and fails closed with a typed refusal.
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-2",
          now: iso(2000)
        })
      ).toThrow(ApprovalDigestMismatchError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(1);
    } finally {
      world.close();
    }
  });

  test("a self-inconsistent checkpoint row fails closed on read", async () => {
    const { world, checkpointId } = await waitingCheckpointWorld("cont-corrupt");
    try {
      world.db
        .prepare("UPDATE approval_checkpoints SET action_digest = 'deadbeef' WHERE id = ?")
        .run(checkpointId);
      expect(() => getCheckpoint(world.db, checkpointId)).toThrow(CheckpointRecordCorruptError);
    } finally {
      world.close();
    }
  });
});

describe("continueAfterApproval success", () => {
  test("creates ONE fresh attempt under the A23 constraint, consumes the approval, emits dispatch", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-success");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      const plan = continueAfterApproval(world.db, {
        checkpointId,
        newExecutionId: "exec-2",
        now: iso(2000)
      });

      // New execution: fresh attempt number, STARTING (the engine's claimed
      // composition expects exactly this), own dispatch token.
      expect(plan.execution.attempt).toBe(2);
      expect(plan.execution.phase).toBe("STARTING");
      expect(plan.execution.id).toBe("exec-2");
      expect(plan.dispatchToken).toBe(plan.execution.dispatchToken);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(2);

      // The approval is consumed EXACTLY by the new execution (A18).
      expect(plan.approval.status).toBe("CONSUMED");
      expect(plan.approval.consumedByExecutionId).toBe("exec-2");

      // The checkpoint is CONTINUED with continuation evidence (有限续行).
      expect(plan.checkpoint.status).toBe("CONTINUED");
      expect(plan.checkpoint.continuationExecutionId).toBe("exec-2");
      expect(plan.checkpoint.continuedAt).toBe(iso(2000));

      // A34: the continuation froze onto the SAME snapshot revision the
      // approval bound.
      expect(String(plan.frozen.snapshot.revision)).toBe(plan.approval.action.profileRevision);

      // The dispatch pipeline sees the continuation message.
      const pending = listPendingOutboxMessages(world.db);
      const continuationMsg = pending.find((message) => message.aggregateId === "exec-2");
      expect(continuationMsg).toBeDefined();
      expect(continuationMsg?.type).toBe("checkpoint.continuation-requested");
      const payload = JSON.parse(continuationMsg?.payload ?? "{}") as Record<string, unknown>;
      expect(payload["approvalId"]).toBe(approvalId);
      expect(payload["actionDigest"]).toBe(plan.checkpoint.actionDigest);
      expect(payload["sourceExecutionId"]).toBe("exec-1");
    } finally {
      world.close();
    }
  });

  test("the A23 slot conflict rolls the whole continuation back — the approval is NOT consumed", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-a23");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      // A racing scheduler claim already holds the slot with attempt 2.
      createActiveAttempt(world.db, {
        id: "exec-race",
        runId: world.runId,
        nodeId: world.nodeId,
        definitionRevision: "1",
        attempt: 2,
        dispatchToken: "dt-race",
        phase: "STARTING",
        now: iso(1600)
      });
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-2",
          now: iso(2000)
        })
      ).toThrow(ActiveAttemptConflictError);
      // Rollback proof: no attempt 3, approval still APPROVED, checkpoint
      // still WAITING.
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(2);
      const approval = world.db.prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as {
        status: string;
      };
      expect(approval.status).toBe("APPROVED");
      expect(getCheckpoint(world.db, checkpointId)?.status).toBe("WAITING");
    } finally {
      world.close();
    }
  });

  test("the checkpoint continues at most once (有限续行)", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-once");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      continueAfterApproval(world.db, { checkpointId, newExecutionId: "exec-2", now: iso(2000) });
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-3",
          now: iso(3000)
        })
      ).toThrow(CheckpointStateError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(2);
    } finally {
      world.close();
    }
  });

  test("a frozen snapshot revision that disagrees with the approval is a typed refusal (A34)", async () => {
    const { world, checkpointId, approvalId } = await waitingCheckpointWorld("cont-profile");
    try {
      approveApproval(world.db, { approvalId, approvedBy: "user-1", now: iso(1500) });
      // Consistently rewrite the approval's bound profile revision to 9 (with
      // a matching digest so the row self-validates): the guard must catch
      // the disagreement with the run's frozen snapshot (revision 1).
      const approvalRow = world.db
        .prepare("SELECT action FROM approvals WHERE id = ?")
        .get(approvalId) as { action: string };
      const action = JSON.parse(approvalRow.action) as Record<string, unknown>;
      action["profileRevision"] = "9";
      const rewritten = ActionDescriptorSchema.parse(action);
      world.db
        .prepare("UPDATE approvals SET action = ?, action_digest = ? WHERE id = ?")
        .run(JSON.stringify(rewritten), actionDigest(rewritten), approvalId);
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId,
          newExecutionId: "exec-2",
          now: iso(2000)
        })
      ).toThrow(ContinuationProfileMismatchError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(1);
    } finally {
      world.close();
    }
  });
});
