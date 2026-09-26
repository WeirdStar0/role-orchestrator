/**
 * End-to-end (M4-02) over the BUILT fake-cli dist bin — the full checkpoint
 * story of docs/CLI_ADAPTERS.md 审批能力不可假定一致:
 *
 *   execution 1 emits a control_request-class action proposal (and exits 0
 *   without a final result: the CLI ended safely) ->
 *   extraction from the persisted event stream ->
 *   openApprovalCheckpoint (approval PENDING, node WAITING_APPROVAL,
 *   original execution terminal state untouched) ->
 *   NO side effect has happened: the proposed sentinel file does not exist
 *   and the proposing process is gone ->
 *   user approves -> continueAfterApproval mints ONE new execution from the
 *   FROZEN profile snapshot and consumes the approval ->
 *   only THAT execution's process performs the proposed write.
 *
 * A34 is additionally pinned live: the role binding is moved to a NEW profile
 * revision between approval and continuation, and the continuation still runs
 * on the frozen revision.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { JsonValue } from "@role-orchestrator/contracts";
import { listEventsForExecution } from "@role-orchestrator/store";
import { startExecution } from "@role-orchestrator/engine";
import { approveApproval } from "@role-orchestrator/approval";
import {
  createProfileRevision,
  readRunRoleProfile,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { transitionNodeState } from "@role-orchestrator/dag";
import {
  continueAfterApproval,
  extractActionProposals,
  getCheckpoint,
  type ProtocolEventView
} from "../src/index.js";
import {
  T0,
  createCheckpointWorld,
  expectPidDead,
  makeWorkDir,
  markNodeRunning,
  openWorldCheckpoint
} from "./helpers.js";

function storedEvents(db: Parameters<typeof listEventsForExecution>[0], executionId: string): readonly ProtocolEventView[] {
  return listEventsForExecution(db, executionId).map((row) => ({
    type: row.type,
    sourceType: null,
    seq: row.seq,
    payload: JSON.parse(row.payload) as Record<string, JsonValue>
  }));
}

describe("checkpoint E2E (fake-cli control_request proposal)", () => {
  test("proposal -> checkpoint -> approval -> bounded continuation performs the action", async () => {
    const world = await createCheckpointWorld("e2e-full", { forSpawn: true, dialect: "claude" });
    try {
      markNodeRunning(world.db, world.runId, world.nodeId);
      const sentinel = join(world.scratchDir, "side-effect.txt");
      const workDir1 = makeWorkDir("e2e-1");

      // ---- attempt 1: the proposing execution (dogfood fake-cli) ----------
      const run1 = startExecution(world.db, {
        executionId: "exec-1",
        runId: world.runId,
        roleId: "developer",
        nodeId: world.nodeId,
        definitionRevision: "1",
        attempt: 1,
        dispatchToken: "dt-exec-1",
        cwd: workDir1,
        prompt: "synthetic checkpoint e2e (attempt 1)",
        invocationArgs: ["--scenario", "action-proposal", "--propose-write", sentinel],
        timeoutSeconds: 120,
        now: T0
      });
      const result1 = await run1.result;
      // 原执行终态正确: the CLI ended safely mid-task (exit 0, no final
      // result), so the protocol verdict is an honest FAILED — never a fake
      // "still waiting" state.
      expect(result1.finalPhase).toBe("FAILED");
      expect(result1.exitCode).toBe(0);
      expect(result1.reasons).toContain("missing-final-result");
      await expectPidDead(result1.pidIdentity.pid);

      // 未审批的副作用不发生: the proposal described writing the sentinel;
      // nothing has written it, and the approval does not even exist yet.
      expect(existsSync(sentinel)).toBe(false);

      // ---- extraction from the PERSISTED event stream ---------------------
      const extraction = extractActionProposals(storedEvents(world.db, "exec-1"));
      expect(extraction.proposals).toHaveLength(1);
      const proposal = extraction.proposals[0]?.proposal;
      expect(proposal).toBeDefined();
      expect(proposal?.action.argv).toContain(sentinel);
      expect(proposal?.action.dimensions).toEqual(["write"]);
      expect(extraction.unparsable).toHaveLength(0);

      // ---- the A19 node checkpoint ---------------------------------------
      const opened = openWorldCheckpoint(world, {
        executionId: "exec-1",
        proposal: proposal as NonNullable<typeof proposal>,
        cwd: workDir1,
        now: T0
      });
      expect(opened.nodeState).toBe("WAITING_APPROVAL");
      expect(opened.approval.status).toBe("PENDING");
      expect(opened.approval.requiresApproval).toBe(true);
      expect(opened.checkpoint.action.argv).toContain(sentinel);
      // The original execution's terminal state is untouched by the checkpoint.
      const exec1Row = world.db
        .prepare("SELECT phase FROM executions WHERE id = 'exec-1'")
        .get() as { phase: string };
      expect(exec1Row.phase).toBe("FAILED");
      expect(existsSync(sentinel)).toBe(false);

      // ---- the user approves ---------------------------------------------
      approveApproval(world.db, {
        approvalId: opened.approval.id,
        approvedBy: "user-1",
        now: T0
      });

      // ---- A34 live drift: the binding moves to a NEW revision; the frozen
      // snapshot must not follow.
      await createProfileRevision(world.db, {
        profileId: world.profileId,
        model: null,
        externalConfigFiles: ["settings.json", "mcp.json"],
        now: T0
      });
      setRoleBinding(world.db, {
        projectId: world.projectId,
        roleId: "developer",
        profileId: world.profileId,
        canCreateSubtasks: false,
        now: T0
      });

      // ---- the bounded continuation --------------------------------------
      const plan = continueAfterApproval(world.db, {
        checkpointId: opened.checkpoint.id,
        newExecutionId: "exec-2",
        now: T0
      });
      expect(plan.execution.attempt).toBe(2);
      expect(plan.execution.phase).toBe("STARTING");
      // A34: frozen revision 1, NOT the re-bound revision 2.
      expect(plan.frozen.snapshot.revision).toBe(1);
      expect(String(readRunRoleProfile(world.db, { runId: world.runId, roleId: "developer" }).snapshot.revision)).toBe("1");
      expect(plan.approval.status).toBe("CONSUMED");
      expect(plan.approval.consumedByExecutionId).toBe("exec-2");

      // Node semantics via the dag state machine: the wait ends and the
      // scheduler's explicit READY -> RUNNING decision applies.
      transitionNodeState(world.db, {
        runId: world.runId,
        nodeId: world.nodeId,
        to: "READY",
        whereStateIn: ["WAITING_APPROVAL"],
        now: T0
      });
      transitionNodeState(world.db, {
        runId: world.runId,
        nodeId: world.nodeId,
        to: "RUNNING",
        whereStateIn: ["READY"],
        now: T0
      });

      // ---- attempt 2: the ONLY process that may perform the action --------
      const workDir2 = makeWorkDir("e2e-2");
      const run2 = startExecution(world.db, {
        executionId: "exec-2",
        runId: world.runId,
        roleId: "developer",
        nodeId: world.nodeId,
        definitionRevision: "1",
        attempt: 2,
        dispatchToken: plan.dispatchToken,
        cwd: workDir2,
        prompt: "synthetic checkpoint e2e (attempt 2, approved action)",
        invocationArgs: ["--scenario", "success", "--write-file", sentinel],
        timeoutSeconds: 120,
        now: T0,
        claimedAttempt: true
      });
      const result2 = await run2.result;
      expect(result2.finalPhase).toBe("SUCCEEDED");

      // The side effect exists NOW — performed by the continuation's own
      // process, never by the checkpoint path.
      expect(existsSync(sentinel)).toBe(true);
      const checkpoint = getCheckpoint(world.db, opened.checkpoint.id);
      expect(checkpoint?.status).toBe("CONTINUED");
      expect(checkpoint?.continuationExecutionId).toBe("exec-2");
    } finally {
      world.close();
    }
  }, 120_000);
});
