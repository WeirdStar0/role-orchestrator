/**
 * M6-04 — the controlled dogfood chain test (A11/A17/A22).
 *
 * ONE run over the isolated A11 fixture repository (system temp, real git)
 * walks the FULL orchestration chain with three INJECTED failure points and
 * their recovery actions, and the assertions pin the RECORDED evidence:
 *
 *   1. review-fail injection  -> controlled expansion (A04/A38/A20)
 *   2. unscoped-write proposal (fake-cli `action-proposal`, persisted-event
 *      extraction) -> approval checkpoint -> A17 digest tamper refusal ->
 *      approve -> bounded continuation performs the write exactly once
 *   3. launch-window interrupt (real scheduler claim, no launch) ->
 *      reconcileStartup decides recovery-required -> A22: RECOVERY_REQUIRED
 *      waits, nothing auto re-runs -> operator resolution -> retry success
 *
 * The user repo must be byte-identical across the whole run (A11), the event
 * log must stay checksum-clean, and no active attempt may remain.
 */
import { describe, expect, test } from "vitest";
import {
  Evidence,
  createDogfoodWorld,
  createRunnableDogfoodRun,
  dogfoodWorkflowRaw,
  removeScratchTree,
  runDogfoodChain,
  DF_SPECS,
  DF_FIX_FILE_REL
} from "../src/index.js";

describe("M6-04 受控 dogfood：建图→调度→执行→集成→review→扩图返工→审批→中断→恢复→重试", () => {
  test("the full chain with injected failures recovers and records A11/A17/A22 evidence", async () => {
    const evidence = Evidence.start("dogfood-chain", {
      "node.js": process.version,
      platform: `${process.platform} ${process.arch}`,
      note: "M6-04 controlled dogfood: real chain, real fake-cli subprocesses, real git fixture; failures are INJECTED at named boundaries and every recovery action is recorded"
    });
    const world = await createDogfoodWorld("dogfood-chain");
    evidence.log(
      `world ready: db=${world.dbPath} repo=${world.repoPath} baseSha=${world.baseSha}`
    );
    evidence.log(`dogfood bins: claude=${world.claudeBin} codex=${world.codexBin}`);
    try {
      const runId = "run-dogfood-1";
      createRunnableDogfoodRun(world, runId, dogfoodWorkflowRaw(DF_SPECS));

      const result = await runDogfoodChain({ world, evidence, runId });

      // ---- the chain really converged --------------------------------------
      expect(result.allNodesSucceeded).toBe(true);
      expect(result.eventChecksumMismatches).toBe(0);
      const nodeIds = result.trace.map((entry) => entry.nodeId);
      expect(nodeIds).toContain("plan");
      expect(nodeIds).toContain("impl");
      expect(nodeIds).toContain("integrate");
      expect(nodeIds).toContain("review");
      expect(nodeIds).toContain("integrate-fix-2");
      expect(nodeIds).toContain("integrate-review-2");

      // ---- injection 1: the review fail grounded the expansion --------------
      expect(result.firstReviewVerdict).toBe("fail");
      expect(result.failedCandidateSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.expansion.requesterRoleId).toBe("coordinator");
      expect(result.expansion.triggerReviewNodeId).toBe("review");
      expect(result.expansion.triggerCandidateSha).toBe(result.failedCandidateSha);
      expect(result.expansion.fixNodeId).toBe("integrate-fix-2");
      expect(result.expansion.reReviewNodeId).toBe("integrate-review-2");
      expect(result.expansion.graphRevisionAfter).toBeGreaterThan(result.expansion.graphRevisionBefore);
      expect(result.expansion.mintedStatesAfter).toEqual(["READY", "PENDING"]);

      // ---- injection 2: A17 — the approval is bound to one actionDigest -----
      expect(result.a17.riskGrade).toBe("high");
      expect(result.a17.sideEffectBeforeApproval).toBe(false);
      expect(result.a17.sideEffectAfterContinuation).toBe(true);
      expect(result.a17.tamperRefusalError).toBe("ApprovalDigestMismatchError");
      expect(result.a17.tamperedWritePath).not.toBe(result.a17.proposedWritePath);
      expect(result.a17.checkpointStatusAfterTamper).toBe("WAITING");
      expect(result.a17.approvalStatusAfterTamper).toBe("APPROVED");
      expect(result.a17.approvalStatusAfterContinuation).toBe("CONSUMED");
      expect(result.a17.consumedByExecutionId).toBe("exec-integrate-fix-2-cont");
      expect(result.a17.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      // the proposed path really is the attempt-2 worktree's repair file
      expect(result.a17.proposedWritePath).toContain("integrate-fix-2");
      expect(result.a17.proposedWritePath.replace(/\\/g, "/")).toContain(DF_FIX_FILE_REL);

      // ---- injection 3: A22 — RECOVERY_REQUIRED waits, nothing auto re-runs -
      expect(result.a22.decisionOutcome).toBe("recovery-required");
      expect(result.a22.decisionReason).toBe("launch-window-undetermined");
      expect(result.a22.probeOsQueries).toBe(0);
      expect(result.a22.scannedAttempts).toBe(1);
      expect(result.a22.nodeStateAfterBridge).toBe("RECOVERY_REQUIRED");
      expect(result.a22.recoveryItemStatus).toBe("RECOVERY_REQUIRED");
      expect(result.a22.recoveryFollowUp).toBe("manual-recovery");
      expect(result.a22.secondAttemptRefusedError).toBe("ActiveAttemptConflictError");
      expect(result.a22.rescanApplied).toBe("already-applied");
      expect(result.a22.queueEntryState).toBe("DISPATCHED");
      expect(result.a22.pendingSchedulerDispatchMessages).toBe(1);
      expect(result.a22.quotaGrantsHeld).toBe(4);
      expect(result.a22.phaseAfterOperatorResolution).toBe("INTERRUPTED");
      expect(result.a22.retryFinalPhase).toBe("SUCCEEDED");
      expect(result.a22.attemptsInSlot).toBe(2);

      // ---- A11: the user repo is byte-identical across the whole run --------
      expect(result.a11.baseSha).toBe(world.baseSha);
      expect(result.a11.finalHeadSha).toBe(world.baseSha);
      expect(result.a11.finalBranch).toBe("main");
      expect(result.a11.dirtyEntryPaths).toEqual(["notes/scratch.txt"]);
      expect(result.a11.dirtyFileContent).toBe(world.fixture.readDirtyFile());
      const fingerprints = result.a11.worktreeFingerprints;
      expect(fingerprints.length).toBeGreaterThanOrEqual(6);
      expect(new Set(fingerprints).size).toBe(1);

      // ---- the timeline recorded every injection and recovery ---------------
      const boundaries = result.timeline.map((entry) => entry.boundary);
      for (const expected of [
        "graph-creation",
        "review-fail-injection",
        "controlled-expansion",
        "approval-proposal",
        "approval-checkpoint",
        "a17-digest-binding",
        "approval-continuation",
        "launch-window-interrupt",
        "a22-landing",
        "a22-no-auto-rerun",
        "operator-resolution",
        "retry-success",
        "a11-user-repo",
        "event-integrity"
      ]) {
        expect(boundaries).toContain(expected);
      }
      const injections = result.timeline.filter((entry) => entry.kind === "inject");
      expect(injections.map((entry) => entry.boundary)).toEqual([
        "review-fail-injection",
        "approval-proposal",
        "launch-window-interrupt"
      ]);

      // the first candidate's content really reached the fix candidate's chain
      expect(result.a11.dirtyFileContent.length).toBeGreaterThan(0);

      evidence.artifact(
        "dogfood-timeline.json",
        JSON.stringify(
          {
            runId: result.runId,
            timeline: result.timeline,
            trace: result.trace,
            expansion: result.expansion,
            a17: result.a17,
            a22: result.a22,
            a11: result.a11
          },
          null,
          2
        )
      );
      evidence.log("dogfood chain complete: all assertions passed against the recorded evidence");
      evidence.close("M6-04 dogfood chain: OK");
    } catch (error) {
      evidence.log(`dogfood chain FAILED: ${String(error)}`);
      evidence.close(`M6-04 dogfood chain FAILED: ${String(error)}`);
      world.close();
      await removeScratchTree(world.fixture.scratchDir);
      throw error;
    }
    world.close();
    await removeScratchTree(world.fixture.scratchDir);
  }, 240_000);
});
