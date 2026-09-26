/**
 * A20 happy path (M4-03): review fail -> expansion mints fix + re-review ->
 * the pair schedules/executes through the EXISTING scheduler/engine chain
 * (dogfood: the built fake-cli dist bin, never a real CLI) -> the re-review
 * consumes the NEW candidateSha through the real M2-05 protocol and passes ->
 * the chain proceeds, while the old fail never answers for the new candidate
 * (A12) and no existing node was touched.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyMigrations } from "@role-orchestrator/store";
import {
  enqueueReadyNodes,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants
} from "@role-orchestrator/scheduler";
import { propagateNodeStates, transitionNodeState } from "@role-orchestrator/dag";
import {
  completeReview,
  getReviewVerdict,
  openReviewSession,
  runValidationCommand
} from "@role-orchestrator/review";
import { startExecution } from "@role-orchestrator/engine";
import { EXPAND_MIGRATIONS, listRunExpansions, requestReviewExpansion } from "../src/index.js";
import {
  createExpandedDb,
  createGitFixture,
  fakeBinPath,
  iso,
  rawNode,
  recordVerdict,
  removeTreeRobust,
  seedExpansionRun,
  T0,
  type GitFixture,
  type TestDb
} from "./helpers.js";

const POLL_INPUT = {
  leaseMs: 3_600_000,
  retryWindowMs: 60_000,
  starvationMs: 3_600_000,
  limit: 8,
  concurrency: { globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 1 }
};

describe("A20 expansion happy path (fail -> fix + re-review -> pass)", () => {
  let fixture: GitFixture;
  let testDb: TestDb;
  let workDir: string;
  const runId = "run-a20";
  let now = T0;

  function tick(): string {
    now = iso(Date.parse(now) - Date.parse(T0) + 60_000);
    return now;
  }

  beforeEach(async () => {
    fixture = await createGitFixture("a20-e2e");
    testDb = createExpandedDb("a20-e2e");
    workDir = mkdtempSync(path.join(tmpdir(), "ro-expand-cwd-"));
    now = T0;
  });

  afterEach(() => {
    testDb.close();
    removeTreeRobust(fixture.scratchDir);
  });

  /** Enqueue READY nodes, dispatch one, execute it on fake-cli, succeed it. */
  async function runNodeToSuccess(nodeId: string, roleId: "developer" | "reviewer"): Promise<void> {
    const stamp = tick();
    enqueueReadyNodes(testDb.db, { runId, now: stamp });
    const poll = pollQueue(testDb.db, { ...POLL_INPUT, now: stamp });
    const dispatched = poll.dispatched.find((entry) => entry.nodeId === nodeId);
    if (dispatched === undefined) {
      throw new Error(`test helper: node "${nodeId}" was not dispatched (poll: ${JSON.stringify(poll)})`);
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
      prompt: `synthetic expansion prompt for ${nodeId} (fake-cli dogfood)`,
      invocationArgs: ["--scenario", "success"],
      timeoutSeconds: 120,
      now: stamp,
      claimedAttempt: true
    });
    const result = await execution.result;
    expect(result.finalPhase).toBe("SUCCEEDED");
    markQueueEntryCompleted(testDb.db, { entryId: dispatched.entryId, now: tick() });
    releaseExecutionQuotaGrants(testDb.db, { executionId: dispatched.executionId, now: tick() });
    // The supervisor's explicit node-state decision (the engine owns phases,
    // not node states); propagation then readies dependents.
    transitionNodeState(testDb.db, {
      runId,
      nodeId,
      to: "SUCCEEDED",
      whereStateIn: ["RUNNING"],
      now: tick()
    });
    propagateNodeStates(testDb.db, { runId, now: tick() });
  }

  it("applies migrations 001..013 and verifies their checksums", () => {
    const verified = verifyMigrations(testDb.db, { migrations: EXPAND_MIGRATIONS });
    expect(verified.ok).toBe(true);
    expect(verified.versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("expands on a durable fail, schedules the pair, and the re-review passes the NEW candidate", async () => {
    const { db } = testDb;
    await seedExpansionRun(db, {
      runId,
      executable: fakeBinPath(),
      nodes: [rawNode({ id: "dev_a", role: "developer" }), rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })]
    });

    // dev_a runs and succeeds; review_0 becomes READY by propagation.
    await runNodeToSuccess("dev_a", "developer");
    expect(db.prepare("SELECT state FROM task_nodes WHERE node_id = 'review_0'").get()).toEqual({
      state: "READY"
    });

    // The candidate the first review looked at — genuinely failed work.
    const failedCandidate = await fixture.createCandidate({
      fileName: "src/feature.ts",
      content: "export const feature = broken;\n"
    });
    await runNodeToSuccess("review_0", "reviewer");
    recordVerdict(db, {
      runId,
      nodeId: "review_0",
      candidateSha: failedCandidate,
      verdict: "fail",
      findings: ["feature references an undefined binding", "tests do not cover the failure mode"],
      repoPath: fixture.repoPath,
      now: tick()
    });

    // THE EXPANSION: grounded on the durable fail verdict for that candidate.
    const outcome = requestReviewExpansion(db, {
      runId,
      reviewNodeId: "review_0",
      candidateSha: failedCandidate,
      now: tick()
    });

    expect(outcome.created).toBe(true);
    expect(outcome.generation).toBe(2);
    expect(outcome.triggerGeneration).toBe(1);
    expect(outcome.repairedNodeId).toBe("dev_a");
    expect(outcome.fixNode).toEqual({
      nodeId: "dev_a-fix-2",
      roleId: "developer",
      dependencies: ["dev_a"],
      state: "READY"
    });
    expect(outcome.reviewNode).toEqual({
      nodeId: "dev_a-review-2",
      roleId: "reviewer",
      dependencies: ["dev_a-fix-2"],
      state: "PENDING"
    });
    // The readiness propagation made ONLY the fix READY (the re-review waits
    // for it); the readiness transitions are the ordinary dag ones.
    expect(outcome.readinessTransitions).toEqual([
      { nodeId: "dev_a-fix-2", from: "PENDING", to: "READY" }
    ]);

    // The expansion row is queryable with its durable candidate context.
    const rows = listRunExpansions(db, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.triggerCandidateSha).toBe(failedCandidate);
    expect(rows[0]?.findings).toEqual([
      "feature references an undefined binding",
      "tests do not cover the failure mode"
    ]);
    expect(rows[0]?.mintedDefinitions.fix.id).toBe("dev_a-fix-2");

    // The fix runs through the EXISTING scheduler/engine chain (fake-cli).
    await runNodeToSuccess("dev_a-fix-2", "developer");
    expect(db.prepare("SELECT state FROM task_nodes WHERE node_id = 'dev_a-fix-2'").get()).toEqual({
      state: "SUCCEEDED"
    });
    // The re-review node is READY now — the chain proceeds.
    expect(db.prepare("SELECT state FROM task_nodes WHERE node_id = 'dev_a-review-2'").get()).toEqual({
      state: "READY"
    });

    // The repaired candidate the fix would have produced (integration's
    // outputSha is M2-04 land; the fixture stands in for it).
    const repairedCandidate = await fixture.createCandidate({
      fileName: "src/feature.ts",
      content: "export const feature = fixed;\n"
    });

    // The re-review consumes the NEW candidate through the REAL M2-05
    // protocol: baseline worktree at the new candidateSha, one-shot
    // validation workspace, machine-verified evidence, then verdict.
    const deps = { db, git: fixture.git };
    const session = await openReviewSession(deps, {
      repoPath: fixture.repoPath,
      worktreesRoot: fixture.worktreesRoot,
      runId,
      nodeId: "dev_a-review-2",
      candidateSha: repairedCandidate,
      now: tick()
    });
    const validation = await runValidationCommand(session, {
      argv: [process.execPath, "-e", "process.exit(0)"],
      timeoutMs: 60_000
    });
    expect(validation.exitCode).toBe(0);
    const completed = await completeReview(deps, session, {
      review: {
        verdict: "pass",
        candidateSha: repairedCandidate,
        evidenceRefs: [validation.artifactRef.id],
        findings: []
      },
      now: tick()
    });
    expect(completed.record.verdict).toBe("pass");

    // A12 semantics, both directions:
    // - the NEW review node answers for the NEW candidate with a valid pass;
    const newVerdict = getReviewVerdict(db, {
      runId,
      nodeId: "dev_a-review-2",
      candidateSha: repairedCandidate
    });
    expect(newVerdict.kind).toBe("valid");
    if (newVerdict.kind === "valid") {
      expect(newVerdict.verdict).toBe("pass");
    }
    // - the OLD fail is bound to ITS candidate: valid there...
    const oldFail = getReviewVerdict(db, {
      runId,
      nodeId: "review_0",
      candidateSha: failedCandidate
    });
    expect(oldFail.kind).toBe("valid");
    if (oldFail.kind === "valid") {
      expect(oldFail.verdict).toBe("fail");
    }
    // - ...and it NEVER answers for the new candidate (invalidated, no verdict).
    const stale = getReviewVerdict(db, {
      runId,
      nodeId: "review_0",
      candidateSha: repairedCandidate
    });
    expect(stale.kind).toBe("invalidated");
    if (stale.kind === "invalidated") {
      expect(stale.recordedCandidateShas).toEqual([failedCandidate]);
    }

    // The re-review node itself still schedules normally (dispatch claim).
    const stamp = tick();
    const enqueued = enqueueReadyNodes(db, { runId, now: stamp });
    expect(enqueued.enqueued.map((entry) => entry.nodeId)).toEqual(["dev_a-review-2"]);
    const poll = pollQueue(db, { ...POLL_INPUT, now: stamp });
    expect(poll.dispatched.map((entry) => entry.nodeId)).toEqual(["dev_a-review-2"]);

    // No existing node's dependency snapshot was rewritten (append-only).
    const devA = db
      .prepare("SELECT dependencies FROM task_nodes WHERE node_id = 'dev_a'")
      .get() as { dependencies: string };
    const review0 = db
      .prepare("SELECT dependencies FROM task_nodes WHERE node_id = 'review_0'")
      .get() as { dependencies: string };
    expect(JSON.parse(devA.dependencies)).toEqual([]);
    expect(JSON.parse(review0.dependencies)).toEqual(["dev_a"]);
  });
});
