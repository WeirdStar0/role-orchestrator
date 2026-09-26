/**
 * M5-05 flow 3 — 返工流程 (rework), browser end to end:
 *
 *   review fail (the real reviewer chain records a genuine, content-grounded
 *   fail verdict) -> the browser shows the expansion PROPOSAL with the
 *   findings -> the user submits the controlled expansion IN THE PAGE
 *   (A04 requester permission checked and audited server-side) -> the minted
 *   int-fix-2 / int-review-2 nodes APPEAR IN THE SVG CANVAS -> the repair
 *   and re-review run through the real chain and the re-review records a
 *   pass verdict bound to the new candidate (A12).
 */
import { describe, expect, test } from "vitest";
import { getReviewVerdict } from "@role-orchestrator/review";
import {
  openLocalPage,
  loadGraph,
  readCanvas,
  waitForCanvas,
  loadExpansions,
  submitExpansion
} from "../src/index.js";
import { runPump, createRunnableRun, workflowRaw, RW_SPECS, RW_FIX_ROUND2_SPECS, RW_A_FILE_CONTENT, RW_FIX_FILE_CONTENT } from "../src/index.js";
import { startHarness, required } from "./helpers.js";

describe("M5-05 flow 3: 返工流程 review fail -> 扩图 -> 复审 pass (browser e2e)", () => {
  test("fail verdict -> proposal in page -> expansion mints canvas nodes -> re-review pass", async () => {
    const harness = await startHarness("flow-3-rework");
    const { world, server, browser, evidence, db } = harness;
    try {
      const runId = "run-rw-1";
      createRunnableRun(world, runId, workflowRaw("wf-rw-1", "返工流程（浏览器端到端）", RW_SPECS));

      const page = browser.page;
      await openLocalPage(page, { port: server.port, token: server.token }, runId);
      await loadGraph(page);
      const initial = await readCanvas(page);
      expect(initial.map((node) => node.nodeId)).toEqual(["a", "int", "r"]);
      expect(initial.map((node) => node.state)).toEqual(["READY", "PENDING", "PENDING"]);
      await evidence.screenshot(page, "initial-canvas-before-rework");

      // ---- round 1: the real chain runs a -> int -> r, and r FAILS --------
      // The review expectation requires the repair file, which the round-1
      // candidate genuinely does not contain — a content-grounded fail.
      const round1 = await runPump({
        world,
        runId,
        baseSha: world.baseSha,
        specs: RW_SPECS,
        reviewExpectations: new Map([
          ["r", { "src/feature/app.txt": RW_A_FILE_CONTENT, "src/feature/fix.txt": RW_FIX_FILE_CONTENT }]
        ])
      });
      const reviewTrace = required(round1.trace.find((entry) => entry.nodeId === "r"), "r trace");
      expect(reviewTrace.reviewVerdict).toBe("fail");
      const failedCandidate = required(round1.candidates.get("int"), "int candidateSha");
      const failVerdict = getReviewVerdict(db(), { runId, nodeId: "r", candidateSha: failedCandidate });
      expect(failVerdict.kind).toBe("valid");
      expect(failVerdict.kind === "valid" && failVerdict.verdict).toBe("fail");
      evidence.log(
        `round 1 complete: r=FAIL on candidate ${failedCandidate} (real reviewer chain, verdict bound A12)`
      );

      // ---- the browser shows the fail-grounded Proposal --------------------
      const proposalView = await loadExpansions(page);
      evidence.log(
        `expansion panel (DOM): proposals=${String(proposalView.proposals.length)} ` +
          `budget="${proposalView.budgetText.slice(0, 80)}"`
      );
      expect(proposalView.proposals).toHaveLength(1);
      const proposal = required(proposalView.proposals[0], "expansion proposal");
      expect(proposal.reviewNodeId).toBe("r");
      expect(proposal.candidateSha).toBe(failedCandidate);
      expect(proposal.findings.length).toBeGreaterThan(0);
      expect(proposalView.budgetText).toContain("每链审查上限 3 轮");
      await evidence.screenshot(page, "expansion-proposal-with-fail-findings");

      // ---- the user submits the expansion IN THE PAGE ----------------------
      // A successful submit re-renders the panels quickly, so the status
      // text is opportunistic evidence; the minted canvas nodes + the
      // executed-expansion record below are the deterministic DOM proof.
      const expansionStatus = await submitExpansion(page, "coordinator");
      evidence.log(`expansion submit status (DOM, best-effort): ${expansionStatus ?? "(re-rendered before capture)"}`);
      if (expansionStatus !== null) {
        expect(expansionStatus).toContain("扩图完成");
        expect(expansionStatus).toContain("int-fix-2");
        expect(expansionStatus).toContain("int-review-2");
      }

      // ---- the minted nodes appear IN THE SVG CANVAS -----------------------
      const after = await waitForCanvas(
        page,
        (nodes) => nodes.some((node) => node.nodeId === "int-fix-2") && nodes.some((node) => node.nodeId === "int-review-2"),
        "minted nodes in canvas"
      );
      expect(after).toHaveLength(5);
      const minted = after.filter((node) => node.nodeId === "int-fix-2" || node.nodeId === "int-review-2");
      evidence.log(
        `canvas after expansion (DOM): ${after.map((node) => `${node.nodeId}=${node.state}`).join(", ")}`
      );
      // int-fix-2 lands READY immediately (its dep int already SUCCEEDED —
      // the expander's readiness transition); the re-review stays PENDING.
      expect(minted.map((node) => node.state)).toEqual(["READY", "PENDING"]);
      expect(
        after.find((node) => node.nodeId === "int-review-2")?.role === "reviewer"
      ).toBe(true);
      await evidence.screenshot(page, "canvas-with-minted-expansion-nodes");

      // ---- round 2: the repair + re-review run through the real chain ------
      const round2 = await runPump({
        world,
        runId,
        baseSha: world.baseSha,
        specs: RW_FIX_ROUND2_SPECS,
        // The minted nodes' baselines are round 1's accepted outputs (the
        // fix builds on int's candidate, the re-review reviews the fix).
        seedAcceptedOutputs: round1.acceptedOutputs,
        reviewExpectations: new Map([
          ["int-review-2", { "src/feature/app.txt": RW_A_FILE_CONTENT, "src/feature/fix.txt": RW_FIX_FILE_CONTENT }]
        ])
      });
      const reReviewTrace = required(round2.trace.find((entry) => entry.nodeId === "int-review-2"), "int-review-2 trace");
      expect(reReviewTrace.reviewVerdict).toBe("pass");
      // The re-reviewed candidate is the fix node's accepted output (the fix
      // commit the pump made on top of int's round-1 candidate).
      const repairedCandidate = required(
        round2.acceptedOutputs.get("int-fix-2")?.headSha,
        "repair candidateSha"
      );
      const passVerdict = getReviewVerdict(db(), { runId, nodeId: "int-review-2", candidateSha: repairedCandidate });
      expect(passVerdict.kind).toBe("valid");
      expect(passVerdict.kind === "valid" && passVerdict.verdict).toBe("pass");
      expect(passVerdict.kind === "valid" && passVerdict.candidateSha).toBe(repairedCandidate);
      evidence.log(
        `round 2 complete: int-review-2=PASS on new candidate ${repairedCandidate} (A12-bound, never the old candidate)`
      );
      // The binding answers per EXACT candidateSha (A12 semantics the UI
      // reuses): querying int-review-2 with the OLD failed candidate is
      // "invalidated" — whatever was recorded never applies to other content.
      const oldBinding = getReviewVerdict(db(), { runId, nodeId: "int-review-2", candidateSha: failedCandidate });
      expect(oldBinding.kind).toBe("invalidated");

      // ---- terminal presentation -------------------------------------------
      const final = await waitForCanvas(
        page,
        (nodes) => nodes.filter((node) => node.state === "SUCCEEDED").length === 5,
        "five nodes SUCCEEDED"
      );
      expect(final).toHaveLength(5);
      await evidence.screenshot(page, "canvas-rework-final-all-succeeded");

      const panelAfter = await loadExpansions(page);
      expect(panelAfter.proposals).toHaveLength(0); // the expanded trigger is consumed
      expect(panelAfter.records).toHaveLength(1);
      const record = required(panelAfter.records[0], "expansion record");
      evidence.log(`expansion record (DOM): ${record.expansionId} :: ${record.text.slice(0, 120)}`);
      expect(record.text).toContain("coordinator");
      expect(record.text).toContain("int-fix-2");
      await evidence.screenshot(page, "expansion-record-executed");

      await harness.close("flow 3 rework: OK");
    } catch (error) {
      await harness.close(`flow 3 rework FAILED: ${String(error)}`);
      throw error;
    }
  });
});
