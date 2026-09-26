/**
 * M5-05 flow 5 — 恢复流程 (recovery), browser end to end:
 *
 *   执行中断 (an attempt sits in STARTING with a pending dispatch message
 *   and no pid identity — the A24 launch window) -> the REAL reconcile chain
 *   decides recovery-required and the node lands RECOVERY_REQUIRED ->
 *   RECOVERY_REQUIRED 显示 (read from the SVG in the browser; nothing auto
 *   re-runs: the slot stays blocked, A22) -> 人工解决 (resolveRecoveryRequired,
 *   the operator step) -> 重试成功 (attempt 2 runs the fake-cli dogfood bin
 *   to SUCCEEDED; the browser reads the recovered terminal canvas).
 */
import { describe, expect, test } from "vitest";
import {
  createActiveAttempt,
  getExecution,
  enqueueOutboxMessage,
  listPendingOutboxMessages
} from "@role-orchestrator/store";
import { ActiveAttemptConflictError } from "@role-orchestrator/store";
import { decideExecution, applyReconcileMarker, resolveRecoveryRequired } from "@role-orchestrator/reconcile";
import { applyReconcileOutcomeToNode, propagateNodeStates, transitionNodeState } from "@role-orchestrator/dag";
import { createWorktree, worktreePathFor } from "@role-orchestrator/worktree";
import { startExecution, lifecycleOutboxId } from "@role-orchestrator/engine";
import { commitNodeOutput } from "@role-orchestrator/e2e-baseline";
import {
  openLocalPage,
  waitForCanvas,
  loadExecutionEvents
} from "../src/index.js";
import { createRunnableRun, workflowRaw, REC_SPECS, REC_FILE_REL, REC_FILE_CONTENT } from "../src/index.js";
import { startHarness, required, WORLD_T0 } from "./helpers.js";

/**
 * The cells below execute through the engine launcher, which is implemented
 * for the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError); they are therefore win32-gated.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[browser-e2e] non-Windows platform — launcher-driven cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


function tick(offsetMs: number): string {
  return new Date(Date.parse(WORLD_T0) + offsetMs).toISOString();
}

describe.skipIf(!LAUNCHER_APPLIES)("M5-05 flow 5: 恢复流程 中断 -> RECOVERY_REQUIRED -> 人工解决 -> 重试成功 (browser e2e)", () => {
  test("interrupted launch shows RECOVERY_REQUIRED in the browser; resolve + retry succeeds", async () => {
    const harness = await startHarness("flow-5-recovery");
    const { world, browser, evidence, db } = harness;
    try {
      const runId = "run-rec-1";
      const [r1Spec, r2Spec] = [required(REC_SPECS[0], "r1 spec"), required(REC_SPECS[1], "r2 spec")];
      createRunnableRun(world, runId, workflowRaw("wf-rec-1", "恢复流程（浏览器端到端）", REC_SPECS));
      const page = browser.page;
      await openLocalPage(page, { port: harness.server.port, token: harness.server.token }, runId);

      // ---- r1 runs to SUCCEEDED through the real engine (dogfood) ----------
      transitionNodeState(db(), { runId, nodeId: "r1", to: "RUNNING", whereStateIn: ["READY"], now: tick(1_000) });
      const wt1 = worktreePathFor(world.worktreesRoot, runId, "r1", 1);
      await createWorktree(world.fixture.git, {
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        runId, nodeId: "r1", attempt: 1, baseSha: world.baseSha
      });
      const run1 = startExecution(db(), {
        executionId: "exec-r1-1",
        runId,
        roleId: r1Spec.role,
        nodeId: "r1",
        definitionRevision: "rev-browser-e2e-1",
        attempt: 1,
        dispatchToken: "dt-exec-r1-1",
        cwd: wt1,
        prompt: "browser e2e recovery flow: predecessor",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 120,
        now: tick(2_000)
      });
      expect((await run1.result).finalPhase).toBe("SUCCEEDED");
      await commitNodeOutput(world.fixture.git, {
        worktreePath: wt1,
        files: required(r1Spec.files, "r1 files"),
        message: `${runId}/r1: predecessor output`
      });
      transitionNodeState(db(), { runId, nodeId: "r1", to: "SUCCEEDED", whereStateIn: ["RUNNING"], now: tick(3_000) });
      propagateNodeStates(db(), { runId, now: tick(3_100) });
      evidence.log("r1 SUCCEEDED; r2 is READY (propagated)");

      // ---- 执行中断: the A24 launch window on r2 ---------------------------
      // The attempt row is durably STARTING, the dispatch message pending,
      // and NO pid identity was ever recorded: whether the process started
      // is unknown. r2 goes RUNNING (the operator dispatched it).
      transitionNodeState(db(), { runId, nodeId: "r2", to: "RUNNING", whereStateIn: ["READY"], now: tick(4_000) });
      createActiveAttempt(db(), {
        id: "exec-r2-1",
        runId,
        nodeId: "r2",
        definitionRevision: "rev-browser-e2e-1",
        attempt: 1,
        dispatchToken: "dt-exec-r2-1",
        phase: "STARTING",
        now: tick(4_100)
      });
      const outboxId = lifecycleOutboxId("exec-r2-1", 1, "dispatched");
      expect(
        enqueueOutboxMessage(db(), {
          id: outboxId,
          aggregateId: "exec-r2-1",
          type: "dispatch",
          payload: { executionId: "exec-r2-1", runId, nodeId: "r2", attempt: 1 },
          now: tick(4_200)
        })
      ).toBe("stored");

      // ---- the REAL reconcile chain decides from the stored evidence --------
      const pending = listPendingOutboxMessages(db()).filter((message) => message.aggregateId === "exec-r2-1");
      expect(pending.length).toBeGreaterThan(0);
      const decision = decideExecution({
        phase: "STARTING",
        pidIdentity: null,
        probe: { kind: "indeterminate", reason: "not probed in this scenario" },
        sideEffects: {
          pendingDispatchIds: pending.map((message) => message.id),
          hasProtocolEvents: false
        },
        identityToleranceMs: 2_000
      });
      expect(decision.outcome).toBe("recovery-required");
      expect(
        applyReconcileMarker(
          db(),
          {
            executionId: "exec-r2-1",
            detail: decision.detail,
            fromPhase: "STARTING",
            sideEffects: {
              pendingDispatchIds: pending.map((message) => message.id),
              hasProtocolEvents: false
            },
            now: tick(4_300)
          },
          "recovery-required"
        )
      ).toBe("applied");
      // The node lands RECOVERY_REQUIRED through the dag bridge (A22 landing).
      expect(
        applyReconcileOutcomeToNode(db(), { runId, nodeId: "r2", outcome: "interrupted", now: tick(4_400) }).state
      ).toBe("INTERRUPTED");
      expect(
        applyReconcileOutcomeToNode(db(), { runId, nodeId: "r2", outcome: "recovery-required", now: tick(4_500) }).state
      ).toBe("RECOVERY_REQUIRED");
      evidence.log("reconcile decided recovery-required; node r2 = RECOVERY_REQUIRED (A22)");

      // Nothing auto re-runs: the slot is still blocked by the active attempt.
      expect(getExecution(db(), "exec-r2-1")?.phase).toBe("STARTING");
      expect(() =>
        createActiveAttempt(db(), {
          id: "exec-r2-2",
          runId,
          nodeId: "r2",
          definitionRevision: "rev-browser-e2e-1",
          attempt: 2,
          dispatchToken: "dt-exec-r2-2",
          phase: "PREPARING",
          now: tick(4_600)
        })
      ).toThrow(ActiveAttemptConflictError);
      evidence.log("A22: attempt stays in STARTING, a second attempt is refused — nothing auto re-runs");

      // ---- RECOVERY_REQUIRED 显示 (browser, SVG from the DOM) ---------------
      const recoveryCanvas = await waitForCanvas(
        page,
        (nodes) => nodes.find((node) => node.nodeId === "r2")?.state === "RECOVERY_REQUIRED",
        "r2 RECOVERY_REQUIRED in the SVG"
      );
      const r2 = required(recoveryCanvas.find((node) => node.nodeId === "r2"), "r2 node");
      expect(r2.editable).toBe(false);
      expect(r2.lockedLabel).toBe(true);
      await evidence.screenshot(page, "recovery-required-shown-in-svg");

      const interruptedView = await loadExecutionEvents(page, "exec-r2-1");
      evidence.log(
        `interrupted execution (DOM): ${interruptedView.runDetailText.slice(0, 120)}`
      );
      expect(interruptedView.runDetailText).toContain("exec-r2-1");
      expect(interruptedView.runDetailText).toContain("STARTING");
      await evidence.screenshot(page, "interrupted-execution-still-starting");

      // ---- 人工解决 (the operator step; a human decision, never automatic) --
      expect(
        resolveRecoveryRequired(db(), {
          executionId: "exec-r2-1",
          note: "operator confirmed the launch never started (browser-e2e recovery flow)",
          now: tick(5_000)
        })
      ).toBe("applied");
      expect(getExecution(db(), "exec-r2-1")?.phase).toBe("INTERRUPTED");
      evidence.log("operator resolved the recovery item; exec-r2-1 = INTERRUPTED");

      // ---- 重试成功 (explicit retry: attempt 2 through the real engine) -----
      transitionNodeState(db(), { runId, nodeId: "r2", to: "READY", whereStateIn: ["RECOVERY_REQUIRED"], now: tick(5_100) });
      transitionNodeState(db(), { runId, nodeId: "r2", to: "RUNNING", whereStateIn: ["READY"], now: tick(5_150) });
      const wt2 = worktreePathFor(world.worktreesRoot, runId, "r2", 2);
      await createWorktree(world.fixture.git, {
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        runId, nodeId: "r2", attempt: 2, baseSha: world.baseSha
      });
      const run2 = startExecution(db(), {
        executionId: "exec-r2-2",
        runId,
        roleId: r2Spec.role,
        nodeId: "r2",
        definitionRevision: "rev-browser-e2e-1",
        attempt: 2,
        dispatchToken: "dt-exec-r2-2",
        cwd: wt2,
        prompt: "browser e2e recovery flow: retry after human resolution",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 120,
        now: tick(5_200)
      });
      expect((await run2.result).finalPhase).toBe("SUCCEEDED");
      const retryOutput = await commitNodeOutput(world.fixture.git, {
        worktreePath: wt2,
        files: { [REC_FILE_REL]: REC_FILE_CONTENT },
        message: `${runId}/r2: retry output after recovery`
      });
      transitionNodeState(db(), { runId, nodeId: "r2", to: "SUCCEEDED", whereStateIn: ["RUNNING"], now: tick(6_000) });
      evidence.log(`retry succeeded: exec-r2-2 SUCCEEDED, output ${retryOutput}`);

      // ---- 终态展示 in the browser ------------------------------------------
      const final = await waitForCanvas(
        page,
        (nodes) => nodes.every((node) => node.state === "SUCCEEDED"),
        "r1 and r2 both SUCCEEDED"
      );
      expect(final.map((node) => `${node.nodeId}=${node.state}`)).toEqual(["r1=SUCCEEDED", "r2=SUCCEEDED"]);
      await evidence.screenshot(page, "recovered-final-canvas-succeeded");

      const retryView = await loadExecutionEvents(page, "exec-r2-2");
      expect(retryView.runDetailText).toContain("exec-r2-2");
      expect(retryView.runDetailText).toContain("SUCCEEDED");
      expect(retryView.events.length).toBeGreaterThan(0);
      await evidence.screenshot(page, "retry-execution-terminal-events");

      await harness.close("flow 5 recovery: OK");
    } catch (error) {
      await harness.close(`flow 5 recovery FAILED: ${String(error)}`);
      throw error;
    }
  });
});
