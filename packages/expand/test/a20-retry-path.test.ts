/**
 * RETRY_PENDING wiring for expansion nodes (M4-03): a minted fix node is an
 * ordinary task_nodes row, so it schedules through the EXISTING scheduler
 * claim (enqueue -> poll -> dispatch -> engine execute on the fake-cli dist
 * bin) and the dag state machine's FAILED -> RETRY_PENDING -> READY edges
 * apply to it unchanged. This test deliberately drives attempt 2 through the
 * ENGINE-OWNED entry path (a direct READY -> RUNNING decision plus
 * startExecution) to prove that path composes with claimed attempt 1; the
 * scheduler's own guarded requeue-to-WAITING — classification-gated and
 * capped at three total attempts — is M4-04 (`requeueForRetry` in
 * @role-orchestrator/scheduler) and is exercised by its own suite.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IllegalNodeTransitionError, propagateNodeStates, transitionNodeState } from "@role-orchestrator/dag";
import {
  enqueueReadyNodes,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants
} from "@role-orchestrator/scheduler";
import { startExecution } from "@role-orchestrator/engine";
import { requestReviewExpansion } from "../src/index.js";
import {
  createExpandedDb,
  expectError,
  fakeBinPath,
  fakeSha,
  iso,
  rawNode,
  recordVerdict,
  seedExpansionRun,
  T0,
  type TestDb
} from "./helpers.js";

/**
 * The cells below execute through the engine launcher, which is implemented
 * for the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError); they are therefore win32-gated.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[expand] non-Windows platform — launcher-driven cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


const POLL_INPUT = {
  leaseMs: 3_600_000,
  retryWindowMs: 60_000,
  starvationMs: 3_600_000,
  limit: 8,
  concurrency: { globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 1 }
};

describe.skipIf(!LAUNCHER_APPLIES)("expansion nodes schedule and retry through the existing chain", () => {
  let testDb: TestDb;
  let workDir: string;
  const runId = "run-retry";
  let now = T0;

  function tick(): string {
    now = iso(Date.parse(now) - Date.parse(T0) + 60_000);
    return now;
  }

  beforeEach(async () => {
    testDb = createExpandedDb("a20-retry");
    workDir = mkdtempSync(path.join(tmpdir(), "ro-expand-retry-cwd-"));
    now = T0;
    await seedExpansionRun(testDb.db, {
      runId,
      executable: fakeBinPath(),
      nodes: [rawNode({ id: "dev_a", role: "developer" }), rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })]
    });
  });

  afterEach(() => {
    testDb.close();
  });

  function succeedNode(nodeId: string): void {
    transitionNodeState(testDb.db, {
      runId,
      nodeId,
      to: "SUCCEEDED",
      whereStateIn: ["RUNNING"],
      now: tick()
    });
    propagateNodeStates(testDb.db, { runId, now: tick() });
  }

  /** Claim through the scheduler, execute on fake-cli, return the outcome. */
  function dispatchAndExecute(
    nodeId: string,
    roleId: "developer" | "reviewer",
    scenario: "success" | "error-result"
  ) {
    const stamp = tick();
    enqueueReadyNodes(testDb.db, { runId, now: stamp });
    const poll = pollQueue(testDb.db, { ...POLL_INPUT, now: stamp });
    const dispatched = poll.dispatched.find((entry) => entry.nodeId === nodeId);
    if (dispatched === undefined) {
      throw new Error(`test: node "${nodeId}" was not dispatched`);
    }
    const execution = startExecution(testDb.db, {
      executionId: dispatched.executionId,
      runId,
      roleId,
      nodeId,
      definitionRevision: "1",
      attempt: 1,
      dispatchToken: dispatched.dispatchToken,
      cwd: workDir,
      prompt: `synthetic retry-path prompt for ${nodeId} (fake-cli dogfood)`,
      invocationArgs: ["--scenario", scenario],
      timeoutSeconds: 120,
      now: stamp,
      claimedAttempt: true
    });
    return { dispatched, execution };
  }

  it("fix node dispatches, fails, walks FAILED -> RETRY_PENDING -> READY, and its second attempt succeeds", async () => {
    const { db } = testDb;

    // dev_a succeeds; review_0 fails its verdict; the expansion mints the fix.
    const stamp0 = tick();
    enqueueReadyNodes(db, { runId, now: stamp0 });
    {
      const poll = pollQueue(db, { ...POLL_INPUT, now: stamp0 });
      const dispatched = poll.dispatched.find((entry) => entry.nodeId === "dev_a");
      if (dispatched === undefined) throw new Error("test: dev_a was not dispatched");
      const execution = startExecution(db, {
        executionId: dispatched.executionId,
        runId,
        roleId: "developer",
        nodeId: "dev_a",
        definitionRevision: "1",
        attempt: 1,
        dispatchToken: dispatched.dispatchToken,
        cwd: workDir,
        prompt: "synthetic dev_a prompt (fake-cli dogfood)",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 120,
        now: stamp0,
        claimedAttempt: true
      });
      expect((await execution.result).finalPhase).toBe("SUCCEEDED");
      markQueueEntryCompleted(db, { entryId: dispatched.entryId, now: tick() });
      releaseExecutionQuotaGrants(db, { executionId: dispatched.executionId, now: tick() });
      succeedNode("dev_a");
    }

    const candidateSha = fakeSha("retry-candidate");
    recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: tick() });
    const outcome = requestReviewExpansion(db, {
      runId,
      reviewNodeId: "review_0",
      candidateSha,
      now: tick()
    });
    const fixNodeId = outcome.fixNode.nodeId;
    expect(fixNodeId).toBe("dev_a-fix-2");

    // Attempt 1 of the fix: dispatched through the normal queue claim and
    // executed on fake-cli — the process ends with a failed result.
    const attempt1 = dispatchAndExecute(fixNodeId, "developer", "error-result");
    const failedResult = await attempt1.execution.result;
    expect(failedResult.finalPhase).toBe("FAILED");
    markQueueEntryCompleted(db, { entryId: attempt1.dispatched.entryId, now: tick() });
    releaseExecutionQuotaGrants(db, { executionId: attempt1.dispatched.executionId, now: tick() });

    // The dag state machine's retry edges, applied to the expansion node
    // exactly as to any other node (guarded transitions, typed rejections).
    transitionNodeState(db, { runId, nodeId: fixNodeId, to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });
    transitionNodeState(db, { runId, nodeId: fixNodeId, to: "RETRY_PENDING", now: tick() });
    transitionNodeState(db, { runId, nodeId: fixNodeId, to: "READY", now: tick() });

    // The edges are NOT freely composable: an illegal jump is typed-rejected.
    expectError(
      () =>
        transitionNodeState(db, {
          runId,
          nodeId: fixNodeId,
          to: "RUNNING",
          whereStateIn: ["RETRY_PENDING"],
          now: tick()
        }),
      IllegalNodeTransitionError
    );

    // Attempt 2: the engine-owned entry path (the scheduler's requeue is
    // M4-04); the READY -> RUNNING decision is explicit, then the engine
    // inserts and runs the second attempt on the fake-cli bin.
    transitionNodeState(db, { runId, nodeId: fixNodeId, to: "RUNNING", whereStateIn: ["READY"], now: tick() });
    const attempt2ExecutionId = `exec-attempt-2-${fixNodeId}`;
    const attempt2 = startExecution(db, {
      executionId: attempt2ExecutionId,
      runId,
      roleId: "developer",
      nodeId: fixNodeId,
      definitionRevision: "1",
      attempt: 2,
      dispatchToken: `dt-attempt-2-${fixNodeId}`,
      cwd: workDir,
      prompt: "synthetic retry prompt (fake-cli dogfood)",
      invocationArgs: ["--scenario", "success"],
      timeoutSeconds: 120,
      now: tick()
    });
    expect((await attempt2.result).finalPhase).toBe("SUCCEEDED");
    succeedNode(fixNodeId);

    // Two executions for the expansion node: attempt 1 (claimed) and
    // attempt 2 (engine-owned) — the expansion node never skipped a phase.
    const rows = db
      .prepare("SELECT id, attempt, phase FROM executions WHERE run_id = ? AND node_id = ? ORDER BY attempt ASC")
      .all(runId, fixNodeId) as { id: string; attempt: number; phase: string }[];
    expect(rows.map((row) => [row.attempt, row.phase])).toEqual([
      [1, "FAILED"],
      [2, "SUCCEEDED"]
    ]);

    // The re-review node became READY — the chain proceeds after the retry.
    expect(db.prepare("SELECT state FROM task_nodes WHERE node_id = 'dev_a-review-2'").get()).toEqual({
      state: "READY"
    });
  });
});
