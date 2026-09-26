/**
 * M5-05 flow 4 — 审批流程 (approval), browser end to end:
 *
 *   检查点提案 (a real ended execution's structured proposal is graded and
 *   turned into a waiting checkpoint + approval; the node goes
 *   WAITING_APPROVAL) -> 审批视图显示完整动作详情 (EVERY digest constituent
 *   read back from the DOM before any decision; no global-grant vocabulary
 *   anywhere, A17) -> 批准 (through the page's per-actionDigest decision
 *   form) -> 续行 (continueAfterApproval consumes the approval and attempt 2
 *   really runs the fake-cli dogfood bin) -> diff 视图显示 candidateSha (the
 *   integration candidate the continuation produced, with the unified diff).
 */
import { describe, expect, test } from "vitest";
import { openApprovalCheckpoint, continueAfterApproval } from "@role-orchestrator/checkpoint";
import { requireApproval } from "@role-orchestrator/approval";
import { integrateParents } from "@role-orchestrator/integration";
import { propagateNodeStates, transitionNodeState } from "@role-orchestrator/dag";
import { branchNameFor, createWorktree, worktreePathFor } from "@role-orchestrator/worktree";
import { startExecution } from "@role-orchestrator/engine";
import { commitNodeOutput } from "@role-orchestrator/e2e-baseline";
import {
  openLocalPage,
  loadApprovals,
  decideApproval,
  loadDiff,
  pageBodyText,
  loadExecutionEvents,
  loadGraph,
  waitForCanvas
} from "../src/index.js";
import { createRunnableRun, workflowRaw, AP_SPECS, AP_FILE_REL, AP_FILE_CONTENT } from "../src/index.js";
import { approvalFlowProposal } from "../src/index.js";
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

describe.skipIf(!LAUNCHER_APPLIES)("M5-05 flow 4: 审批流程 检查点提案 -> 批准 -> 续行 -> diff (browser e2e)", () => {
  test("checkpoint proposal shows full action details; approval, continuation and diff view", async () => {
    const harness = await startHarness("flow-4-approval");
    const { world, server, browser, evidence, db } = harness;
    try {
      const runId = "run-appr-1";
      createRunnableRun(world, runId, workflowRaw("wf-appr-1", "审批流程（浏览器端到端）", AP_SPECS));
      const page = browser.page;
      await openLocalPage(page, { port: server.port, token: server.token }, runId);

      // ---- the checkpoint subject: a real execution that ENDED having asked
      //      for an unscoped write (attempt 1, real fake-cli dogfood spawn) --
      transitionNodeState(db(), { runId, nodeId: "a1", to: "RUNNING", whereStateIn: ["READY"], now: tick(1_000) });
      const worktree1 = worktreePathFor(world.worktreesRoot, runId, "a1", 1);
      await createWorktree(world.fixture.git, {
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        runId,
        nodeId: "a1",
        attempt: 1,
        baseSha: world.baseSha
      });
      const attempt1 = startExecution(db(), {
        executionId: "exec-a1-1",
        runId,
        roleId: "architect",
        nodeId: "a1",
        definitionRevision: "rev-browser-e2e-1",
        attempt: 1,
        dispatchToken: "dt-exec-a1-1",
        cwd: worktree1,
        prompt: "browser e2e approval flow: propose an unscoped write",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 120,
        now: tick(2_000)
      });
      const result1 = await attempt1.result;
      expect(result1.finalPhase).toBe("SUCCEEDED");
      evidence.log("attempt 1 (fake-claude dogfood) ended SUCCEEDED; the node asks for an unscoped write");

      // ---- 检查点提案: the ended execution's proposal -> waiting checkpoint --
      const opened = openApprovalCheckpoint(db(), {
        executionId: "exec-a1-1",
        proposal: approvalFlowProposal(),
        cwd: worktree1,
        grantedPermissions: ["repo.read"],
        // 30 days like the local-api view suite: the view reads expiry against
        // the real clock, so the approval must be safely unexpired on it.
        ttlSeconds: 2_592_000,
        now: tick(3_000)
      });
      expect(opened.nodeState).toBe("WAITING_APPROVAL");
      evidence.log(
        `checkpoint ${opened.checkpoint.id} WAITING; approval ${opened.approval.id} ` +
          `risk=${opened.approval.riskGrade} requiresApproval=${String(opened.approval.requiresApproval)}`
      );

      // ---- 审批视图显示完整动作详情 (read from the DOM, before any decision) --
      const cards = await loadApprovals(page);
      expect(cards).toHaveLength(1);
      const card = required(cards[0], "approval card");
      evidence.log(
        `approval card (DOM): id=${card.approvalId} digest=${card.actionDigest.slice(0, 16)}… ` +
          `badge=${card.badgeText} form=${String(card.hasDecisionForm)}`
      );
      expect(card.hasDecisionForm).toBe(true);
      expect(card.invalidated).toBe(false);
      const detail = card.detailText;
      // EVERY digest constituent is visible BEFORE the decision:
      expect(detail).toContain("fake-agent"); // complete argv, in order
      expect(detail).toContain("--path");
      expect(detail).toContain(worktree1); // cwd
      expect(detail).toContain(world.baseSha); // baseline baseSha
      expect(detail).toContain("repo.write"); // the permission increment
      expect(detail).toContain("unscoped"); // writeScope
      expect(detail).toContain("high"); // risk grade
      expect(detail).toContain("需用户批准"); // 高风险 marker
      expect(detail).toContain("过期时间"); // expiry row
      expect(card.actionDigest.length).toBeGreaterThanOrEqual(16);
      // A17: no global-grant vocabulary anywhere on the page.
      const bodyText = await pageBodyText(page);
      for (const phrase of ["全部允许", "信任此站点", "全部授权", "一键放行"]) {
        expect(bodyText).not.toContain(phrase);
      }
      evidence.log("A17 browser check: no 全局放权 vocabulary anywhere on the page");
      await evidence.screenshot(page, "approval-card-full-action-details");

      // ---- 批准 (per-actionDigest decision through the page) ----------------
      const decisionStatus = await decideApproval(page, card.approvalId, "operator-browser-e2e", "approve");
      evidence.log(`decision status (DOM, best-effort): ${decisionStatus ?? "(re-rendered before capture)"}`);
      if (decisionStatus !== null) {
        expect(decisionStatus).toContain("已批准");
      }
      await evidence.screenshot(page, "approval-decided-approved");

      // ---- 续行 (the bounded continuation consumes the approval) ------------
      const plan = continueAfterApproval(db(), {
        checkpointId: opened.checkpoint.id,
        newExecutionId: "exec-a1-2",
        now: tick(4_000)
      });
      expect(plan.execution.attempt).toBe(2);
      evidence.log(
        `continuation: attempt ${String(plan.execution.attempt)} authorized; approval consumed by exec-a1-2`
      );
      // The scheduler's explicit decisions resume the node, then the real
      // continuation execution runs the dogfood bin and commits the write.
      transitionNodeState(db(), { runId, nodeId: "a1", to: "READY", whereStateIn: ["WAITING_APPROVAL"], now: tick(5_000) });
      transitionNodeState(db(), { runId, nodeId: "a1", to: "RUNNING", whereStateIn: ["READY"], now: tick(5_100) });
      const worktree2 = worktreePathFor(world.worktreesRoot, runId, "a1", 2);
      await createWorktree(world.fixture.git, {
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        runId,
        nodeId: "a1",
        attempt: 2,
        baseSha: world.baseSha
      });
      // The continuation ALREADY created the attempt row (phase STARTING,
      // with its dispatch token) inside continueAfterApproval's transaction —
      // the engine VERIFIES and claims it instead of inserting a second one.
      const attempt2 = startExecution(db(), {
        executionId: "exec-a1-2",
        runId,
        roleId: "architect",
        nodeId: "a1",
        definitionRevision: "rev-browser-e2e-1",
        attempt: plan.execution.attempt,
        dispatchToken: plan.execution.dispatchToken,
        cwd: worktree2,
        prompt: "browser e2e approval flow: continuation performs the approved write",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 120,
        now: tick(5_200),
        claimedAttempt: true
      });
      const result2 = await attempt2.result;
      expect(result2.finalPhase).toBe("SUCCEEDED");
      transitionNodeState(db(), { runId, nodeId: "a1", to: "SUCCEEDED", whereStateIn: ["RUNNING"], now: tick(6_000) });

      const approvalRow = requireApproval(db(), card.approvalId);
      expect(approvalRow.consumedByExecutionId).toBe("exec-a1-2");
      evidence.log("approval consumed by exec-a1-2 (A17/A18: exactly once, exactly this action)");

      // The integration candidate the continuation produced.
      const outputSha = await commitNodeOutput(world.fixture.git, {
        worktreePath: worktree2,
        files: { [AP_FILE_REL]: AP_FILE_CONTENT },
        message: `${runId}/a1: approved continuation output`
      });
      propagateNodeStates(db(), { runId, now: tick(7_000) });
      const integrated = await integrateParents(
        { db: db(), git: world.fixture.git },
        {
          repoPath: world.repoPath,
          worktreesRoot: world.worktreesRoot,
          runId,
          nodeId: "i1",
          baseSha: world.baseSha,
          parents: [{ nodeId: "a1", branch: branchNameFor(runId, "a1", 2), headSha: outputSha }],
          now: tick(7_100)
        }
      );
      transitionNodeState(db(), { runId, nodeId: "i1", to: "RUNNING", whereStateIn: ["READY"], now: tick(7_200) });
      transitionNodeState(db(), { runId, nodeId: "i1", to: "SUCCEEDED", whereStateIn: ["RUNNING"], now: tick(7_300) });
      evidence.log(`i1 integrated; candidateSha=${integrated.candidateSha}`);

      // ---- diff 视图显示 candidateSha ----------------------------------------
      const diff = await loadDiff(page, "i1");
      evidence.log(
        `diff panel (DOM): node=${diff.nodeId} candidate=${String(diff.candidateSha)} files=${String(diff.fileRows.length)}`
      );
      expect(diff.nodeId).toBe("i1");
      expect(diff.candidateSha).toBe(integrated.candidateSha);
      expect(diff.fileRows.join("\n")).toContain(AP_FILE_REL);
      expect(diff.unifiedHead).toContain("+approval flow: continuation output");
      expect(diff.reviewText).toContain("没有审查记录");
      await evidence.screenshot(page, "diff-view-shows-candidateSha");

      // ---- terminal presentation --------------------------------------------
      await loadGraph(page);
      const final = await waitForCanvas(page, (nodes) => nodes.every((node) => node.state === "SUCCEEDED"), "all SUCCEEDED");
      expect(final).toHaveLength(2);
      await evidence.screenshot(page, "final-canvas-approval-flow");

      const consumedCards = await loadApprovals(page);
      const consumed = required(consumedCards[0], "consumed approval card");
      evidence.log(`approval card after consumption (DOM): badge=${consumed.badgeText} form=${String(consumed.hasDecisionForm)}`);
      expect(consumed.invalidated).toBe(true);
      expect(consumed.hasDecisionForm).toBe(false);
      const view = await loadExecutionEvents(page, "exec-a1-2");
      expect(view.runDetailText).toContain("SUCCEEDED");
      expect(view.events.length).toBeGreaterThan(0);
      await evidence.screenshot(page, "continuation-execution-and-events");

      await harness.close("flow 4 approval: OK");
    } catch (error) {
      await harness.close(`flow 4 approval FAILED: ${String(error)}`);
      throw error;
    }
  });
});
