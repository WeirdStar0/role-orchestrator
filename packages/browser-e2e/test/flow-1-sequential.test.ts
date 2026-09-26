/**
 * M5-05 flow 1 — 顺序流程 (sequential), browser end to end:
 *
 *   建图 (createRunnableRun) -> 顺序执行 (real pump: scheduler -> engine
 *   fake-cli subprocesses -> worktree -> writer commit) -> SVG 状态变化
 *   (captured LIVE in the browser mid-run) -> 终态展示 (canvas + the
 *   execution/event views, all read back out of the page DOM).
 *
 * It also pins, at the browser layer, the two M5 hard constraints that show
 * here: a RUNNING node presents NO edit form (A38 first half) and the edit
 * payload builder has no model/Profile surface (A02 UI layer).
 */
import { describe, expect, test } from "vitest";
import {
  openLocalPage,
  loadGraph,
  readCanvas,
  readStatus,
  readEditor,
  clickNode,
  waitForCanvas,
  loadExecutionEvents
} from "../src/index.js";
import { runPump, createRunnableRun, workflowRaw, SEQ_SPECS } from "../src/index.js";
import { startHarness, required } from "./helpers.js";

describe("M5-05 flow 1: 顺序流程 (browser e2e)", () => {
  test("build -> run -> live SVG state change -> terminal presentation", async () => {
    const harness = await startHarness("flow-1-sequential");
    const { world, server, browser, evidence } = harness;
    try {
      const runId = "run-seq-1";
      createRunnableRun(world, runId, workflowRaw("wf-seq-1", "顺序流程（浏览器端到端）", SEQ_SPECS));
      evidence.log(`run created: ${runId} (graph + revision baseline)`);

      const page = browser.page;
      await openLocalPage(page, { port: server.port, token: server.token }, runId);
      await loadGraph(page);
      const initial = await readCanvas(page);
      evidence.log(
        `initial canvas from DOM: ${initial.map((node) => `${node.nodeId}=${node.state}`).join(", ")}`
      );
      expect(initial.map((node) => node.nodeId)).toEqual(["s1", "s2", "s3"]);
      // The entry node lands READY at creation (dag propagation); the rest PENDING.
      expect(initial.map((node) => node.state)).toEqual(["READY", "PENDING", "PENDING"]);
      expect((await readStatus(page)).length).toBeGreaterThan(0);
      await evidence.screenshot(page, "initial-canvas-entry-ready-rest-pending");

      // ---- the real sequential run; the browser watches it happen ----------
      const pump = await runPump({
        world,
        runId,
        baseSha: world.baseSha,
        specs: SEQ_SPECS,
        onRoundStarted: async (round, dispatched) => {
          evidence.log(
            `round ${String(round)} dispatched: ${dispatched.map((outcome) => outcome.nodeId).join(", ")}`
          );
          if (!dispatched.some((outcome) => outcome.nodeId === "s2")) return;
          // s2's fake-codex subprocess is running (300ms x ~8 frames): load
          // the LIVE canvas until the SVG shows s2 RUNNING, then capture.
          const midrun = await waitForCanvas(
            page,
            (nodes) => nodes.find((node) => node.nodeId === "s2")?.state === "RUNNING",
            "s2 RUNNING in the SVG"
          );
          evidence.log(
            `midrun canvas from DOM: ${midrun.map((node) => `${node.nodeId}=${node.state}`).join(", ")}`
          );
          await evidence.screenshot(page, "midrun-s2-running-svg-live");

          // A38 (first half): a RUNNING node opens NO edit form.
          await clickNode(page, "s2");
          const editor = await readEditor(page);
          evidence.log(`editor on RUNNING node s2: kind=${editor.kind} text=${editor.text.slice(0, 80)}`);
          expect(editor.kind).toBe("locked");
          expect(editor.text).toContain("运行中或已结束的节点不可原地修改");

          // A02 (UI layer): the page's payload builder refuses model/Profile.
          const refusal = await page.evaluate(() => {
            const api = (globalThis as unknown as {
              __roleOrchestratorPage?: {
                buildNodeEditPayload: (nodeId: string, revision: number, fields: Record<string, string>) => unknown;
              };
            }).__roleOrchestratorPage;
            if (api === undefined) return "page api missing";
            try {
              api.buildNodeEditPayload("s2", 1, { model: "claude-opus-4" });
              return "ACCEPTED (must not happen)";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          });
          evidence.log(`A02 UI-layer refusal: ${refusal}`);
          expect(refusal).toContain("refused field");
          expect(refusal).toContain("A02");
          await evidence.screenshot(page, "running-node-locked-a38-a02");
        }
      });

      // ---- terminal presentation -------------------------------------------
      const final = await waitForCanvas(page, (nodes) => nodes.every((node) => node.state === "SUCCEEDED"), "all SUCCEEDED");
      evidence.log(
        `final canvas from DOM: ${final.map((node) => `${node.nodeId}=${node.state}`).join(", ")}`
      );
      expect(final.map((node) => node.state)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
      // The state classes really changed in the SVG (the 状态变化 evidence).
      const finalClasses = await page.evaluate(() =>
        [...document.querySelectorAll("#graph-canvas svg g.dag-node")].map((group) => group.getAttribute("class"))
      );
      evidence.log(`final SVG node classes: ${finalClasses.join(" | ")}`);
      for (const cssClass of finalClasses) {
        expect(required(cssClass, "node class")).toContain("node-state-SUCCEEDED");
      }
      await evidence.screenshot(page, "final-canvas-all-succeeded");

      // The terminal execution + its event log through the page UI.
      const s2Trace = required(
        pump.trace.find((entry) => entry.nodeId === "s2"),
        "s2 trace"
      );
      expect(s2Trace.finalPhase).toBe("SUCCEEDED");
      const view = await loadExecutionEvents(page, s2Trace.executionId);
      evidence.log(
        `execution view (DOM): ${view.runDetailText.slice(0, 120)}; events=${String(view.events.length)}`
      );
      expect(view.runDetailText).toContain(s2Trace.executionId);
      expect(view.runDetailText).toContain("SUCCEEDED");
      expect(view.events.length).toBeGreaterThan(0);
      await evidence.screenshot(page, "terminal-execution-and-events");

      evidence.log(`pump rounds=${String(pump.rounds)} quotaRejections=${String(pump.quotaRejections.length)}`);
      await harness.close("flow 1 sequential: OK");
    } catch (error) {
      await harness.close(`flow 1 sequential FAILED: ${String(error)}`);
      throw error;
    }
  });
});
