/**
 * M5-05 flow 2 — 并行流程 (parallel), browser end to end:
 *
 *   plan -> (fe || be) -> integrate, both branch nodes bound to the
 *   developer role — hence ONE profile in ONE credential group — while the
 *   unverified-credential cap is 1 (A33). The REAL scheduler serializes the
 *   two branches on the credential lock; the browser captures the
 *   serialization IN THE SVG (one branch RUNNING while the other has not
 *   started) and the pump's store-level evidence (the credential quota
 *   rejection + the disjoint wall-clock windows) is logged beside it.
 */
import { describe, expect, test } from "vitest";
import {
  openLocalPage,
  loadGraph,
  readCanvas,
  waitForCanvas,
  loadExecutionEvents
} from "../src/index.js";
import { runPump, createRunnableRun, workflowRaw, PAR_SPECS } from "../src/index.js";
import { startHarness, required } from "./helpers.js";

describe("M5-05 flow 2: 并行流程 + 凭据锁串行化 (browser e2e)", () => {
  test("parallel branches serialize on the credential lock; the UI shows it", async () => {
    const harness = await startHarness("flow-2-parallel");
    const { world, server, browser, evidence } = harness;
    try {
      const runId = "run-par-1";
      createRunnableRun(world, runId, workflowRaw("wf-par-1", "并行流程（浏览器端到端）", PAR_SPECS));

      const page = browser.page;
      await openLocalPage(page, { port: server.port, token: server.token }, runId);
      await loadGraph(page);
      const initial = await readCanvas(page);
      evidence.log(
        `initial canvas from DOM: ${initial.map((node) => `${node.nodeId}=${node.state}`).join(", ")}`
      );
      expect(initial.map((node) => node.nodeId)).toEqual(["be", "fe", "integ", "plan"]);
      // plan is READY (entry propagation); the branches start PENDING.
      expect(initial.map((node) => node.state)).toEqual(["PENDING", "PENDING", "PENDING", "READY"]);
      await evidence.screenshot(page, "initial-canvas-parallel-plan-ready");

      let capturedSerializedRound = false;
      const firstBranchTrace = { nodeId: "", startMs: 0 };
      const pump = await runPump({
        world,
        runId,
        baseSha: world.baseSha,
        specs: PAR_SPECS,
        onRoundStarted: async (round, dispatched) => {
          evidence.log(
            `round ${String(round)} dispatched: ${dispatched.map((outcome) => outcome.nodeId).join(", ")}`
          );
          // The contention round: exactly ONE branch node dispatched while
          // the OTHER waits on the credential lock.
          const dispatchedBranches = dispatched.filter(
            (outcome) => outcome.nodeId === "fe" || outcome.nodeId === "be"
          );
          if (dispatchedBranches.length !== 1 || capturedSerializedRound) return;
          const runningBranch = required(dispatchedBranches[0]?.nodeId, "running branch node");
          capturedSerializedRound = true;
          firstBranchTrace.nodeId = runningBranch;

          const midrun = await waitForCanvas(
            page,
            (nodes) => {
              const runner = nodes.find((node) => node.nodeId === runningBranch);
              const other = nodes.find(
                (node) => (node.nodeId === "fe" || node.nodeId === "be") && node.nodeId !== runningBranch
              );
              return runner?.state === "RUNNING" && other !== undefined && other.state !== "RUNNING";
            },
            `${runningBranch} RUNNING while the sibling branch has NOT started`
          );
          const other = midrun.find(
            (node) => (node.nodeId === "fe" || node.nodeId === "be") && node.nodeId !== runningBranch
          );
          evidence.log(
            `credential-lock serialization in the SVG: ${runningBranch}=RUNNING, ` +
              `${required(other, "sibling branch").nodeId}=${required(other, "sibling branch").state} ` +
              "(the sibling is still lock-blocked)"
          );
          await evidence.screenshot(page, "midrun-credential-lock-serialized-svg");
        }
      });
      expect(capturedSerializedRound).toBe(true);

      // ---- store-level serialization evidence ------------------------------
      const branchTraces = pump.trace.filter((entry) => entry.nodeId === "fe" || entry.nodeId === "be");
      expect(branchTraces).toHaveLength(2);
      const ordered = [...branchTraces].sort((a, b) => a.wallStartMs - b.wallStartMs);
      const first = required(ordered[0], "first branch trace");
      const second = required(ordered[1], "second branch trace");
      evidence.log(
        `wall windows: ${first.nodeId}=[${String(first.wallStartMs)}, ${String(first.wallEndMs)}] ` +
          `${second.nodeId}=[${String(second.wallStartMs)}, ${String(second.wallEndMs)}] ` +
          `(disjoint: ${String(first.wallEndMs <= second.wallStartMs)})`
      );
      expect(first.wallEndMs).toBeLessThanOrEqual(second.wallStartMs);
      const credentialRejections = pump.quotaRejections.filter(
        (rejection) => rejection.dimension === "credential"
      );
      evidence.log(
        `credential quota rejections: ${credentialRejections
          .map((rejection) => `${rejection.nodeId}@round${String(rejection.round)} ${rejection.resourceKey} ${String(rejection.liveCount)}/${String(rejection.max)}`)
          .join("; ")}`
      );
      expect(credentialRejections.length).toBeGreaterThanOrEqual(1);
      // The lock holder is the branch that ran FIRST; the rejected one queued.
      expect(credentialRejections.some((rejection) => rejection.nodeId === second.nodeId)).toBe(true);
      expect(first.nodeId).toBe(firstBranchTrace.nodeId);

      // ---- terminal presentation -------------------------------------------
      const final = await waitForCanvas(page, (nodes) => nodes.every((node) => node.state === "SUCCEEDED"), "all SUCCEEDED");
      expect(final).toHaveLength(4);
      await evidence.screenshot(page, "final-canvas-parallel-succeeded");

      for (const branch of branchTraces) {
        const view = await loadExecutionEvents(page, branch.executionId);
        evidence.log(
          `${branch.nodeId} execution ${branch.executionId} (DOM): ${view.runDetailText.slice(0, 100)} events=${String(view.events.length)}`
        );
        expect(view.runDetailText).toContain("SUCCEEDED");
        expect(view.events.length).toBeGreaterThan(0);
      }
      await evidence.screenshot(page, "terminal-branch-executions-and-events");

      await harness.close("flow 2 parallel: OK");
    } catch (error) {
      await harness.close(`flow 2 parallel FAILED: ${String(error)}`);
      throw error;
    }
  });
});
