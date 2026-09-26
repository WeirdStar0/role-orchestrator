/**
 * DB-boundary fault injections (M4-05).
 *
 * Every case kills the process EXACTLY at one injected DB statement (fixed
 * injection point + ordinal, deterministic across reruns — the M2-04
 * proxy pattern generalized in `crash-db.ts`) and then asserts the recovery
 * semantics: no duplicate writer/commit, evidence preserved, recovery waits
 * for the user where the outcome is unknown, and the chain continues with a
 * CORRECT result after recovery.
 */
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  getExecution,
  listAttemptsForSlot,
  listEventsForExecution,
  listPendingOutboxMessages,
  verifyEventChecksums
} from "@role-orchestrator/store";
import {
  transitionNodeState,
  requireNodeState
} from "@role-orchestrator/dag";
import { startExecution } from "@role-orchestrator/engine";
import { reconcileStartup } from "@role-orchestrator/reconcile";
import {
  IntegrationMergeStateLeftError,
  getIntegrationRecord,
  integrateParents,
  reconcileIntegration,
  type ParentCommit
} from "@role-orchestrator/integration";
import { getCheckpoint, openApprovalCheckpoint } from "@role-orchestrator/checkpoint";
import { listApprovalsForRun } from "@role-orchestrator/approval";
import { derivedId } from "@role-orchestrator/scheduler";
import type { MatrixWorld } from "../world.js";
import { DIRTY_FILE_CONTENT, createMatrixRun, createMatrixWorld, iso, makeLaunchDir } from "../world.js";
import { MatrixCrashInjectionError } from "../errors.js";
import { crashOnSqlFragment } from "../crash-db.js";
import { expectRejection, expectThrow, extractSingleProposal } from "./support.js";
import { CHAIN_DEFINITION_REVISION, singleNodeSpec, type ParentBranch } from "./chain-specs.js";
import { planGraph } from "../pipeline.js";

async function createParentBranch(
  world: MatrixWorld,
  runId: string,
  nodeId: string,
  fileName: string,
  content: string
): Promise<ParentBranch> {
  const attempt = 1;
  const branch = `exec/${runId}/${nodeId}/${String(attempt)}`;
  const worktreePath = join(world.worktreesRoot, runId, nodeId, String(attempt));
  await world.git.run(world.repoPath, ["worktree", "add", "-b", branch, worktreePath, world.baseSha]);
  const absolute = join(worktreePath, ...fileName.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  await world.git.run(worktreePath, ["add", fileName]);
  await world.git.run(worktreePath, ["commit", "-m", `output ${nodeId}`]);
  const headSha = (await world.git.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  return { nodeId, branch, worktreePath, headSha };
}

function parentsOf(...branches: readonly ParentBranch[]): ParentCommit[] {
  return branches.map((branch) => ({ nodeId: branch.nodeId, branch: branch.branch, headSha: branch.headSha }));
}

function pendingDispatchIds(db: MatrixWorld["db"], executionId: string): readonly string[] {
  return listPendingOutboxMessages(db)
    .filter((message) => message.aggregateId === executionId && message.publishedAt === null)
    .map((message) => message.id);
}

// ---------------------------------------------------------------------------
// FM-DB-01 (A23): crash inside the attempt-row INSERT transaction
// ---------------------------------------------------------------------------

export async function runDbExecutionInsertCrash(): Promise<void> {
  const world = await createMatrixWorld("fm-db01");
  try {
    const { runId } = createMatrixRun(world, "run-fm-db01", "task-fm-db01");

    // The attempt-row INSERT dies inside the engine's PREPARING transaction.
    const crashingDb = crashOnSqlFragment(world.db, "fm-db01-execution-insert", "INSERT INTO executions");
    const first = startExecution(crashingDb, {
      executionId: "exec-fm-db01",
      runId,
      roleId: "developer",
      nodeId: "node-alpha",
      definitionRevision: CHAIN_DEFINITION_REVISION,
      attempt: 1,
      dispatchToken: "dt-fm-db01-1",
      cwd: makeLaunchDir(world, "fm-db01-a"),
      prompt: "fault matrix FM-DB-01 (crashing launch)",
      invocationArgs: ["--scenario", "success"],
      timeoutSeconds: 120,
      now: iso(1_000)
    });
    const crash = await expectRejection(first.result, MatrixCrashInjectionError);
    assert.match(crash.message, /fm-db01-execution-insert/);

    // The whole transaction rolled back: no attempt row, no dispatch outbox,
    // and startup reconcile has nothing active to scan.
    assert.equal(getExecution(world.db, "exec-fm-db01"), null, "attempt row must not exist after rollback");
    assert.equal(pendingDispatchIds(world.db, "exec-fm-db01").length, 0, "dispatch outbox must be empty");
    assert.equal(listAttemptsForSlot(world.db, { runId, nodeId: "node-alpha" }).length, 0);
    const scan = await reconcileStartup(world.db, {});
    assert.equal(scan.scanned, 0, "no active attempt may exist after the rolled-back insert");

    // Recovery: the SAME launch order re-runs (a NEW transaction, not a
    // re-dispatch of a half-open one) and completes correctly.
    const second = startExecution(world.db, {
      executionId: "exec-fm-db01",
      runId,
      roleId: "developer",
      nodeId: "node-alpha",
      definitionRevision: CHAIN_DEFINITION_REVISION,
      attempt: 1,
      dispatchToken: "dt-fm-db01-2",
      cwd: makeLaunchDir(world, "fm-db01-b"),
      prompt: "fault matrix FM-DB-01 (recovered launch)",
      invocationArgs: ["--scenario", "success"],
      timeoutSeconds: 120,
      now: iso(2_000)
    });
    const recovered = await second.result;
    assert.equal(recovered.finalPhase, "SUCCEEDED");
    assert.deepEqual(recovered.reasons, []);

    // Invariants: exactly ONE attempt in the slot (A23), terminal, checksums
    // intact, the user's uncommitted file untouched.
    const slot = listAttemptsForSlot(world.db, { runId, nodeId: "node-alpha" });
    assert.equal(slot.length, 1, "reconcile/recovery must leave at most one valid attempt");
    assert.equal(slot[0]?.phase, "SUCCEEDED");
    assert.equal(
      listPendingOutboxMessages(world.db).filter(
        (message) =>
          message.aggregateId === "exec-fm-db01" &&
          message.type === "execution.dispatch-requested" &&
          message.publishedAt === null
      ).length,
      1,
      "exactly one dispatch-requested message (the finished message is separate)"
    );
    assert.deepEqual(verifyEventChecksums(world.db), [], "event checksums must verify");
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-DB-02 (A25 window 1): crash before the integration completion UPDATE
// ---------------------------------------------------------------------------

export async function runDbIntegrationCompletionCrash(): Promise<void> {
  const world = await createMatrixWorld("fm-db02");
  try {
    const { runId } = createMatrixRun(world, "run-fm-db02", "task-fm-db02");
    const a = await createParentBranch(world, runId, "n-a", "a.txt", "alpha-from-a\n");
    const b = await createParentBranch(world, runId, "n-b", "b.txt", "beta-from-b\n");
    const input = {
      repoPath: world.repoPath,
      worktreesRoot: world.worktreesRoot,
      runId,
      nodeId: "n-succ",
      baseSha: world.baseSha,
      parents: parentsOf(a, b),
      now: iso(1_000)
    };

    const crashingDb = crashOnSqlFragment(
      world.db,
      "fm-db02-integration-completed",
      "UPDATE integration_records SET state = 'COMPLETED'"
    );
    await expectRejection(integrateParents({ db: crashingDb, git: world.git }, input), MatrixCrashInjectionError);

    // Git half done, DB behind: the commit LANDED, the record is IN_PROGRESS.
    const branch = `task/${runId}`;
    const branchHead = await world.branchHead(branch);
    assert.ok(branchHead !== null, "integration commit must have landed");
    const commitsAfterCrash = await world.branchCommits(branch);
    const crashed = getIntegrationRecord(world.db, { runId, nodeId: "n-succ" });
    assert.equal(crashed?.state, "IN_PROGRESS");
    assert.equal(crashed?.candidateSha, null);
    assert.equal(crashed?.manifest.candidateSha, branchHead, "manifest recorded the expected SHA first");

    // Reconcile: verify manifest against git, backfill the DB, never touch git.
    const result = await reconcileIntegration(
      { db: world.db, git: world.git },
      { runId, nodeId: "n-succ", now: iso(2_000) }
    );
    assert.equal(result.verdict.kind, "committed");
    assert.ok(result.verdict.kind === "committed" && result.verdict.candidateSha === branchHead);
    assert.equal(result.record.state, "COMPLETED");
    assert.deepEqual(await world.branchCommits(branch), commitsAfterCrash, "no duplicate commit");

    // Idempotent forever after.
    const second = await reconcileIntegration(
      { db: world.db, git: world.git },
      { runId, nodeId: "n-succ", now: iso(3_000) }
    );
    assert.equal(second.verdict.kind, "already-recorded");
    const third = await integrateParents({ db: world.db, git: world.git }, input);
    assert.equal(third.kind, "already-integrated");
    assert.deepEqual(await world.branchCommits(branch), commitsAfterCrash);
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-DB-03 (A25 window 2): crash before the manifest write -> safe-to-retry
// ---------------------------------------------------------------------------

export async function runDbIntegrationManifestCrash(): Promise<void> {
  const world = await createMatrixWorld("fm-db03");
  try {
    const { runId } = createMatrixRun(world, "run-fm-db03", "task-fm-db03");
    const a = await createParentBranch(world, runId, "n-a", "a.txt", "alpha-from-a\n");
    const b = await createParentBranch(world, runId, "n-b", "b.txt", "beta-from-b\n");
    const input = {
      repoPath: world.repoPath,
      worktreesRoot: world.worktreesRoot,
      runId,
      nodeId: "n-succ",
      baseSha: world.baseSha,
      parents: parentsOf(a, b),
      now: iso(1_000)
    };

    const crashingDb = crashOnSqlFragment(
      world.db,
      "fm-db03-integration-manifest",
      "UPDATE integration_records SET manifest"
    );
    await expectRejection(integrateParents({ db: crashingDb, git: world.git }, input), MatrixCrashInjectionError);

    const branch = `task/${runId}`;
    const branchHead = await world.branchHead(branch);
    assert.ok(branchHead !== null);
    const commitsAfterCrash = await world.branchCommits(branch);
    const crashed = getIntegrationRecord(world.db, { runId, nodeId: "n-succ" });
    assert.equal(crashed?.state, "IN_PROGRESS");
    assert.equal(crashed?.manifest.candidateSha, null);

    const result = await reconcileIntegration(
      { db: world.db, git: world.git },
      { runId, nodeId: "n-succ", now: iso(2_000) }
    );
    assert.equal(result.verdict.kind, "safe-to-retry");
    assert.ok(result.verdict.kind === "safe-to-retry" && result.verdict.safeToRetry === true);

    // The retry re-merges already-ancestor parents (git no-ops) and lands on
    // the SAME candidateSha — never a duplicate commit.
    const retried = await integrateParents({ db: world.db, git: world.git }, input);
    assert.equal(retried.kind, "integrated");
    assert.ok(retried.kind === "integrated" && retried.candidateSha === branchHead);
    assert.deepEqual(await world.branchCommits(branch), commitsAfterCrash);
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-DB-04 (A25 window 3 + A10): crash before the PAUSED_CONFLICT write
// ---------------------------------------------------------------------------

export async function runDbIntegrationPauseCrash(): Promise<void> {
  const world = await createMatrixWorld("fm-db04");
  try {
    const { runId } = createMatrixRun(world, "run-fm-db04", "task-fm-db04");
    // Same-line conflict parents: the merge WILL conflict.
    const a = await createParentBranch(world, runId, "n-a", "shared.txt", "line1-A\nline2\n");
    const b = await createParentBranch(world, runId, "n-b", "shared.txt", "line1-B\nline2\n");
    const input = {
      repoPath: world.repoPath,
      worktreesRoot: world.worktreesRoot,
      runId,
      nodeId: "n-succ",
      baseSha: world.baseSha,
      parents: parentsOf(a, b),
      now: iso(1_000)
    };

    const crashingDb = crashOnSqlFragment(
      world.db,
      "fm-db04-integration-pause",
      "SET state = 'PAUSED_CONFLICT'"
    );
    await expectRejection(integrateParents({ db: crashingDb, git: world.git }, input), MatrixCrashInjectionError);

    // The conflict scene exists in git but the pause write never happened.
    assert.equal(getIntegrationRecord(world.db, { runId, nodeId: "n-succ" })?.state, "IN_PROGRESS");

    const result = await reconcileIntegration(
      { db: world.db, git: world.git },
      { runId, nodeId: "n-succ", now: iso(2_000) }
    );
    assert.deepEqual(result.verdict, {
      kind: "merge-in-progress",
      safeToRetry: false,
      conflictFiles: ["shared.txt"]
    });

    // Re-integrating refuses instead of auto-resolving the conflict (A10).
    await expectRejection(
      integrateParents({ db: world.db, git: world.git }, input),
      IntegrationMergeStateLeftError
    );
    // Nothing lost: both branches still at their accepted tips.
    assert.equal(await world.branchHead(a.branch), a.headSha);
    assert.equal(await world.branchHead(b.branch), b.headSha);
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-DB-05 (approval open crash): the checkpoint open rolls back atomically
// ---------------------------------------------------------------------------

export async function runDbApprovalOpenCrash(): Promise<void> {
  const world = await createMatrixWorld("fm-db05");
  try {
    const { runId } = createMatrixRun(world, "run-fm-db05", "task-fm-db05");
    // The coordinator binds the claude profile: its control_request shape
    // carries the structured proposal payload the extraction requires.
    const spec = singleNodeSpec("node-fm", "coordinator");
    planGraph(world, runId, [spec], CHAIN_DEFINITION_REVISION);
    transitionNodeState(world.db, {
      runId,
      nodeId: spec.id,
      to: "RUNNING",
      whereStateIn: ["READY"],
      now: iso(500)
    });

    // Attempt 1: a real fake-cli run that PROPOSES a write and ends safely.
    const sentinel = join(world.scratchDir, "fm-db05-sentinel.txt");
    const run = startExecution(world.db, {
      executionId: "exec-fm-db05",
      runId,
      roleId: "coordinator",
      nodeId: spec.id,
      definitionRevision: CHAIN_DEFINITION_REVISION,
      attempt: 1,
      dispatchToken: "dt-fm-db05",
      cwd: makeLaunchDir(world, "fm-db05"),
      prompt: "fault matrix FM-DB-05 (action proposal)",
      invocationArgs: ["--scenario", "action-proposal", "--propose-write", sentinel],
      timeoutSeconds: 120,
      now: iso(1_000)
    });
    const result = await run.result;
    assert.equal(result.finalPhase, "FAILED");
    assert.equal(result.exitCode, 0);
    assert.ok(result.reasons.includes("missing-final-result"));
    const proposal = extractSingleProposal(world.db, "exec-fm-db05");

    // The checkpoint open dies at the checkpoint INSERT: the WHOLE open —
    // approval row, checkpoint row, node transition — rolls back together.
    const crashingDb = crashOnSqlFragment(
      world.db,
      "fm-db05-checkpoint-insert",
      "INSERT INTO approval_checkpoints"
    );
    expectThrow(
      () =>
        openApprovalCheckpoint(crashingDb, {
          executionId: "exec-fm-db05",
          proposal,
          cwd: makeLaunchDir(world, "fm-db05"),
          grantedPermissions: ["repo.read"],
          ttlSeconds: 3_600,
          now: iso(2_000)
        }),
      MatrixCrashInjectionError
    );
    assert.equal(listApprovalsForRun(world.db, runId).length, 0, "no approval may survive the rollback");
    assert.equal(
      getCheckpoint(world.db, derivedId("ckpt", "exec-fm-db05", proposal.proposalId)),
      null,
      "no checkpoint row may survive the rollback"
    );
    assert.equal(
      getExecution(world.db, "exec-fm-db05")?.phase,
      "FAILED",
      "the proposal execution's terminal state is untouched"
    );
    assert.equal(requireNodeState(world.db, { runId, nodeId: spec.id }).state, "RUNNING");

    // Replay the open on the healthy connection: created exactly once now.
    const opened = openApprovalCheckpoint(world.db, {
      executionId: "exec-fm-db05",
      proposal,
      cwd: makeLaunchDir(world, "fm-db05"),
      grantedPermissions: ["repo.read"],
      ttlSeconds: 3_600,
      now: iso(3_000)
    });
    assert.equal(opened.created, true);
    assert.equal(opened.approval.status, "PENDING");
    assert.equal(opened.nodeState, "WAITING_APPROVAL");
    assert.equal(listApprovalsForRun(world.db, runId).length, 1);
    // Event history of the execution stays intact and verifiable.
    assert.ok(listEventsForExecution(world.db, "exec-fm-db05").length > 0);
    assert.deepEqual(verifyEventChecksums(world.db), []);
  } finally {
    world.close();
  }
}
