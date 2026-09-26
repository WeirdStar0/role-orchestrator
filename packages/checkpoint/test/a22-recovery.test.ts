/**
 * A22 inside the checkpoint world (M4-02): side effects committed, outcome
 * unknown -> RECOVERY_REQUIRED, and NOTHING re-runs automatically.
 *
 * The indeterminate subject is a checkpoint CONTINUATION: its durable side
 * effects exist (the approval was consumed, the dispatch outbox message is
 * pending) but the launch outcome is unverified — no pid identity was ever
 * recorded (the A24 window between claim and spawn). The decision comes from
 * @role-orchestrator/reconcile exactly as in production composition
 * (decide -> applyReconcileMarker -> dag node bridge); this suite only feeds
 * it the stored evidence.
 */
import { describe, expect, test } from "vitest";
import { approveApproval } from "@role-orchestrator/approval";
import {
  ActiveAttemptConflictError,
  createActiveAttempt,
  getExecution,
  listAttemptsForSlot,
  listPendingOutboxMessages
} from "@role-orchestrator/store";
import {
  applyReconcileMarker,
  decideExecution,
  resolveRecoveryRequired
} from "@role-orchestrator/reconcile";
import { applyReconcileOutcomeToNode, propagateNodeStates, requireNodeState, transitionNodeState } from "@role-orchestrator/dag";
import {
  CheckpointStateError,
  continueAfterApproval
} from "../src/index.js";
import {
  T0,
  createCheckpointWorld,
  markNodeRunning,
  openWorldCheckpoint,
  sampleProposal,
  seedTerminalExecution
} from "./helpers.js";

describe("A22: continuation with committed side effects but unknown outcome", () => {
  test("recovery-required keeps the slot blocked, consumes nothing, re-runs nothing", async () => {
    const world = await createCheckpointWorld("a22");
    try {
      markNodeRunning(world.db, world.runId, world.nodeId);
      seedTerminalExecution(world.db, { executionId: "exec-1", runId: world.runId });
      const opened = openWorldCheckpoint(world, {
        executionId: "exec-1",
        proposal: sampleProposal(undefined, "propose-a22")
      });
      approveApproval(world.db, {
        approvalId: opened.approval.id,
        approvedBy: "user-1",
        now: T0
      });
      const plan = continueAfterApproval(world.db, {
        checkpointId: opened.checkpoint.id,
        newExecutionId: "exec-2",
        now: T0
      });
      expect(plan.execution.attempt).toBe(2);
      expect(plan.approval.consumedByExecutionId).toBe("exec-2");
      // The scheduler's explicit decisions put the node back to RUNNING.
      transitionNodeState(world.db, { runId: world.runId, nodeId: world.nodeId, to: "READY", whereStateIn: ["WAITING_APPROVAL"], now: T0 });
      transitionNodeState(world.db, { runId: world.runId, nodeId: world.nodeId, to: "RUNNING", whereStateIn: ["READY"], now: T0 });

      // Stored evidence: the continuation committed REAL side effects (the
      // pending dispatch message) but never recorded a pid (A24 window).
      const pending = listPendingOutboxMessages(world.db).filter(
        (message) => message.aggregateId === "exec-2"
      );
      expect(pending.length).toBeGreaterThan(0);
      const attemptRow = getExecution(world.db, "exec-2");
      expect(attemptRow?.phase).toBe("STARTING");

      // ---- reconcile decides from the stored evidence (A22: fail-closed) --
      const decision = decideExecution({
        phase: "STARTING",
        pidIdentity: null,
        probe: { kind: "indeterminate", reason: "not probed in this scenario" },
        sideEffects: {
          pendingDispatchIds: pending.map((message) => message.id),
          hasProtocolEvents: false
        },
        identityToleranceMs: 2000
      });
      expect(decision.outcome).toBe("recovery-required");
      expect(decision.detail.reason).toBe("launch-window-undetermined");

      // The marker is applied; the attempt row STAYS in its active phase, so
      // the A23 constraint keeps blocking new attempts (nothing auto re-runs).
      expect(
        applyReconcileMarker(
          world.db,
          {
            executionId: "exec-2",
            detail: decision.detail,
            fromPhase: "STARTING",
            sideEffects: {
              pendingDispatchIds: pending.map((message) => message.id),
              hasProtocolEvents: false
            },
            now: T0
          },
          "recovery-required"
        )
      ).toBe("applied");
      expect(getExecution(world.db, "exec-2")?.phase).toBe("STARTING");
      expect(() =>
        createActiveAttempt(world.db, {
          id: "exec-3",
          runId: world.runId,
          nodeId: world.nodeId,
          definitionRevision: "1",
          attempt: 3,
          dispatchToken: "dt-exec-3",
          phase: "PREPARING",
          now: T0
        })
      ).toThrow(ActiveAttemptConflictError);
      // The consumed checkpoint cannot mint another authorization either.
      expect(() =>
        continueAfterApproval(world.db, {
          checkpointId: opened.checkpoint.id,
          newExecutionId: "exec-3",
          now: T0
        })
      ).toThrow(CheckpointStateError);
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(2);

      // ---- operator resolution + the node-level A22 landing --------------
      expect(
        resolveRecoveryRequired(world.db, {
          executionId: "exec-2",
          note: "operator confirmed the launch never started",
          now: T0
        })
      ).toBe("applied");
      expect(getExecution(world.db, "exec-2")?.phase).toBe("INTERRUPTED");
      applyReconcileOutcomeToNode(world.db, {
        runId: world.runId,
        nodeId: world.nodeId,
        outcome: "interrupted",
        now: T0
      });
      const recovered = applyReconcileOutcomeToNode(world.db, {
        runId: world.runId,
        nodeId: world.nodeId,
        outcome: "recovery-required",
        now: T0
      });
      expect(recovered.state).toBe("RECOVERY_REQUIRED");
      // Propagation leaves the A22 state alone: recovery is a HUMAN decision,
      // never an automatic transition.
      expect(propagateNodeStates(world.db, { runId: world.runId, now: T0 })).toEqual([]);
      expect(requireNodeState(world.db, { runId: world.runId, nodeId: world.nodeId }).state).toBe(
        "RECOVERY_REQUIRED"
      );
      // Still no automatic attempt: the slot freed, but starting attempt 3 is
      // an explicit decision nobody made here.
      expect(listAttemptsForSlot(world.db, { runId: world.runId, nodeId: world.nodeId })).toHaveLength(2);
    } finally {
      world.close();
    }
  });
});
