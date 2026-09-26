/**
 * Git / side-effect / approval / retry-cap / full-chain fault injections
 * (M4-05).
 *
 * - FM-GIT-01 (A10 regression): a same-line merge conflict pauses the
 *   integration, preserves every branch, blocks the node — and never
 *   auto-resolves.
 * - FM-A22-01: a checkpoint continuation with COMMITTED side effects but an
 *   unknown launch outcome lands as RECOVERY_REQUIRED and nothing re-runs.
 * - FM-APR-01 (审批边界 1): the approval stays CONSUMED for exactly its
 *   execution — the evidence survives reconcile and operator resolution
 *   unchanged, and no second execution is ever authorized.
 * - FM-APR-02 (审批边界 2): a crash inside the continuation's consumption
 *   transaction rolls the WHOLE continuation back — an execution can never
 *   exist without its consumed approval, and a replayed continuation is
 *   still single-shot.
 * - FM-RETRY-01 (A21): three TOTAL attempts exhaust the cap under the real
 *   scheduler; the run is held; the fourth attempt never happens; the frozen
 *   profile never moves.
 * - FM-CHAIN-01: the full chain (dag -> scheduler -> engine fake-cli ->
 *   worktree -> integration -> review) survives a determinate mid-chain
 *   failure and finishes with the CORRECT result.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ActiveAttemptConflictError,
  createActiveAttempt,
  getEvent,
  getExecution,
  listAttemptsForSlot,
  listPendingOutboxMessages,
  verifyEventChecksums
} from "@role-orchestrator/store";
import {
  applyReconcileOutcomeToNode,
  listRunNodes,
  propagateNodeStates,
  requireNodeState,
  transitionNodeState
} from "@role-orchestrator/dag";
import {
  AttemptsExhaustedError,
  requeueForRetry,
  RequeueNotAllowedError
} from "@role-orchestrator/scheduler";
import { classifyFailureReason } from "@role-orchestrator/budget";
import {
  listRecoveryItems,
  reconcileEventId,
  reconcileStartup,
  resolveRecoveryItem
} from "@role-orchestrator/reconcile";
import {
  ApprovalDigestMismatchError,
  approveApproval,
  getApproval,
  listApprovalsForRun,
  type ApprovalRecord
} from "@role-orchestrator/approval";
import {
  CheckpointStateError,
  continueAfterApproval,
  openApprovalCheckpoint,
  type ProposedAction
} from "@role-orchestrator/checkpoint";
import { readRunRoleProfile } from "@role-orchestrator/runtime-profile";
import { startExecution } from "@role-orchestrator/engine";
import {
  IntegrationConflictError,
  IntegrationPausedError,
  applyIntegrationOutcomeToNode,
  assertNodeNotIntegrationPaused,
  getIntegrationRecord,
  integrateParents
} from "@role-orchestrator/integration";
import {
  DIRTY_FILE_CONTENT,
  createMatrixRun,
  createMatrixWorld,
  iso,
  makeLaunchDir,
  type MatrixWorld
} from "../world.js";
import { MatrixCrashInjectionError } from "../errors.js";
import { crashOnSqlFragment } from "../crash-db.js";
import { extractSingleProposal, expectRejection, expectThrow } from "./support.js";
import {
  ALPHA_FILE_CONTENT,
  ALPHA_FILE_REL,
  BETA_FILE_CONTENT,
  BETA_FILE_REL,
  CHAIN_DEFINITION_REVISION,
  CHAIN_SPECS,
  chainExpectedFiles,
  singleNodeSpec
} from "./chain-specs.js";
import { newChainState, planGraph, pumpRound } from "../pipeline.js";

interface ParentBranch {
  readonly nodeId: string;
  readonly branch: string;
  readonly headSha: string;
}

async function createParentBranch(
  world: MatrixWorld,
  runId: string,
  nodeId: string,
  fileName: string,
  content: string
): Promise<ParentBranch> {
  const branch = `exec/${runId}/${nodeId}/1`;
  const worktreePath = join(world.worktreesRoot, runId, nodeId, "1");
  await world.git.run(world.repoPath, ["worktree", "add", "-b", branch, worktreePath, world.baseSha]);
  const absolute = join(worktreePath, ...fileName.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  await world.git.run(worktreePath, ["add", fileName]);
  await world.git.run(worktreePath, ["commit", "-m", `output ${nodeId}`]);
  const headSha = (await world.git.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  return { nodeId, branch, headSha };
}

// ---------------------------------------------------------------------------
// FM-GIT-01 (A10): a merge conflict pauses, preserves, blocks
// ---------------------------------------------------------------------------

export async function runGitMergeConflictPaused(): Promise<void> {
  const world = await createMatrixWorld("fm-git01");
  try {
    const { runId } = createMatrixRun(world, "run-fm-git01", "task-fm-git01");
    const spec = singleNodeSpec("integrate");
    planGraph(world, runId, [spec], CHAIN_DEFINITION_REVISION);

    const a = await createParentBranch(world, runId, "n-a", "shared.txt", "line1-A\nline2\n");
    const b = await createParentBranch(world, runId, "n-b", "shared.txt", "line1-B\nline2\n");

    await expectRejection(
      integrateParents(
        { db: world.db, git: world.git },
        {
          repoPath: world.repoPath,
          worktreesRoot: world.worktreesRoot,
          runId,
          nodeId: "integrate",
          baseSha: world.baseSha,
          parents: [
            { nodeId: a.nodeId, branch: a.branch, headSha: a.headSha },
            { nodeId: b.nodeId, branch: b.branch, headSha: b.headSha }
          ],
          now: iso(1_000)
        }
      ),
      IntegrationConflictError
    );

    // The record holds the conflict; neither branch was touched.
    const record = getIntegrationRecord(world.db, { runId, nodeId: "integrate" });
    assert.equal(record?.state, "PAUSED_CONFLICT");
    assert.deepEqual(record?.conflictFiles, ["shared.txt"]);
    assert.equal(await world.branchHead(a.branch), a.headSha);
    assert.equal(await world.branchHead(b.branch), b.headSha);

    // The node layer refuses success on a paused integration and BLOCKS it.
    assert.throws(
      () => assertNodeNotIntegrationPaused(world.db, { runId, nodeId: "integrate" }),
      IntegrationPausedError
    );
    const blocked = applyIntegrationOutcomeToNode(world.db, { runId, nodeId: "integrate", now: iso(2_000) });
    assert.equal(blocked.action, "blocked-successor");
    assert.equal(requireNodeState(world.db, { runId, nodeId: "integrate" }).state, "BLOCKED");
    // BLOCKED has no outgoing edges: propagation cannot auto-resume (A10).
    assert.deepEqual(propagateNodeStates(world.db, { runId, now: iso(3_000) }), []);
    assert.equal(requireNodeState(world.db, { runId, nodeId: "integrate" }).state, "BLOCKED");
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// Shared continuation fixture (real dogfood, M4-02 shape)
// ---------------------------------------------------------------------------

interface ContinuationFixture {
  readonly world: MatrixWorld;
  readonly runId: string;
  readonly nodeId: string;
  readonly sentinel: string;
  readonly checkpointId: string;
  readonly approvalId: string;
  /** The second execution's id (the continuation, phase STARTING). */
  readonly continuationExecutionId: string;
  readonly proposalAction: ProposedAction;
}

/**
 * Up to the APPROVED approval: a fake-cli execution proposes a sentinel
 * write and ends safely; the proposal becomes a checkpoint + one-shot
 * approval; the user approves. Nothing has performed the write.
 */
async function setupContinuation(label: string): Promise<ContinuationFixture> {
  const world = await createMatrixWorld(label);
  const { runId } = createMatrixRun(world, `run-${label}`, `task-${label}`);
  // Coordinator binds the claude profile: the dialect whose control_request
  // carries the structured proposal payload the extraction requires.
  const spec = singleNodeSpec("node-fm", "coordinator");
  const nodeId = spec.id;
  planGraph(world, runId, [spec], CHAIN_DEFINITION_REVISION);
  transitionNodeState(world.db, {
    runId,
    nodeId,
    to: "RUNNING",
    whereStateIn: ["READY"],
    now: iso(500)
  });

  const sentinel = join(world.scratchDir, `${label}-sentinel.txt`);
  const first = startExecution(world.db, {
    executionId: `exec-${label}-1`,
    runId,
    roleId: "coordinator",
    nodeId,
    definitionRevision: CHAIN_DEFINITION_REVISION,
    attempt: 1,
    dispatchToken: `dt-${label}-1`,
    cwd: makeLaunchDir(world, label),
    prompt: `fault matrix ${label} (action proposal)`,
    invocationArgs: ["--scenario", "action-proposal", "--propose-write", sentinel],
    timeoutSeconds: 120,
    now: iso(1_000)
  });
  const firstResult = await first.result;
  assert.equal(firstResult.finalPhase, "FAILED");
  assert.equal(firstResult.exitCode, 0, "the proposing CLI ended safely (exit 0, no final result)");

  const proposal = extractSingleProposal(world.db, `exec-${label}-1`);
  const opened = openApprovalCheckpoint(world.db, {
    executionId: `exec-${label}-1`,
    proposal,
    cwd: makeLaunchDir(world, label),
    grantedPermissions: ["repo.read"],
    ttlSeconds: 3_600,
    now: iso(2_000)
  });
  assert.equal(opened.nodeState, "WAITING_APPROVAL");
  approveApproval(world.db, {
    approvalId: opened.approval.id,
    approvedBy: "user-1",
    now: iso(3_000)
  });
  return {
    world,
    runId,
    nodeId,
    sentinel,
    checkpointId: opened.checkpoint.id,
    approvalId: opened.approval.id,
    continuationExecutionId: `exec-${label}-2`,
    proposalAction: opened.checkpoint.proposal.action
  };
}

/**
 * Perform the ONE continuation the checkpoint authorizes: mints attempt 2
 * (phase STARTING) and consumes the approval — the committed side effects
 * the A22/approval cases reason about.
 */
function performContinuation(fixture: ContinuationFixture): void {
  const plan = continueAfterApproval(fixture.world.db, {
    checkpointId: fixture.checkpointId,
    newExecutionId: fixture.continuationExecutionId,
    now: iso(4_000)
  });
  assert.equal(plan.execution.phase, "STARTING");
  assert.equal(plan.approval.status, "CONSUMED");
}

/** The explicit scheduler decisions that put the node back to RUNNING. */
function resumeNodeRunning(fixture: ContinuationFixture): void {
  transitionNodeState(fixture.world.db, {
    runId: fixture.runId,
    nodeId: fixture.nodeId,
    to: "READY",
    whereStateIn: ["WAITING_APPROVAL"],
    now: iso(5_000)
  });
  transitionNodeState(fixture.world.db, {
    runId: fixture.runId,
    nodeId: fixture.nodeId,
    to: "RUNNING",
    whereStateIn: ["READY"],
    now: iso(5_001)
  });
}

// ---------------------------------------------------------------------------
// FM-A22-01: committed side effects + unknown outcome -> nothing re-runs
// ---------------------------------------------------------------------------

export async function runSideEffectUnknownNoAutoRerun(): Promise<void> {
  const fixture = await setupContinuation("fm-a22");
  const { world, runId, nodeId, sentinel, continuationExecutionId } = fixture;
  try {
    // The continuation mints attempt 2 and consumes the approval; the node
    // is back to RUNNING by explicit scheduler decisions.
    performContinuation(fixture);
    continueAfterApprovalIsDone(world, fixture);
    resumeNodeRunning(fixture);

    // The continuation committed REAL side effects (pending continuation
    // dispatch) and never recorded a pid: reconcile must fail closed.
    const scan = await reconcileStartup(world.db, {});
    assert.equal(scan.scanned, 1);
    const decision = scan.decisions[0];
    assert.ok(decision !== undefined);
    assert.equal(decision.executionId, continuationExecutionId);
    assert.equal(decision.outcome, "recovery-required");
    assert.equal(decision.detail.reason, "launch-window-undetermined");
    // The continuation's pending outbox message is the REAL side effect (its
    // type is checkpoint.continuation-requested — asserted above against the
    // outbox); reconcile's dispatch-requested evidence is a different probe.
    assert.ok(decision.sideEffects.hasProtocolEvents === false);
    assert.ok(
      listPendingOutboxMessages(world.db).some(
        (message) =>
          message.aggregateId === continuationExecutionId &&
          message.type === "checkpoint.continuation-requested" &&
          message.publishedAt === null
      ),
      "the continuation dispatch is durably pending"
    );
    assert.equal(
      getExecution(world.db, continuationExecutionId)?.phase,
      "STARTING",
      "the attempt row stays active (nothing may auto re-run)"
    );

    // NOTHING can re-run: the A23 constraint blocks a third attempt while the
    // unknown attempt is active; the CONTINUED checkpoint cannot re-authorize.
    assert.throws(
      () =>
        createActiveAttempt(world.db, {
          id: "exec-fm-a22-3",
          runId,
          nodeId,
          definitionRevision: CHAIN_DEFINITION_REVISION,
          attempt: 3,
          dispatchToken: "dt-fm-a22-3",
          phase: "PREPARING",
          now: iso(6_000)
        }),
      ActiveAttemptConflictError
    );
    expectThrow(
      () =>
        continueAfterApproval(world.db, {
          checkpointId: fixture.checkpointId,
          newExecutionId: "exec-fm-a22-3",
          now: iso(6_000)
        }),
      CheckpointStateError
    );

    // The A22 policy line: the unknown outcome classifies `recovery`, which
    // never retries; and a RUNNING node is not requeueable anyway.
    const classification = classifyFailureReason("outcome-unknown-recovery-required");
    assert.equal(classification.policy, "recovery");
    assert.equal(classification.spec.maxPolicyRetries, 0);
    assert.throws(
      () =>
        requeueForRetry(world.db, {
          runId,
          nodeId,
          failureReasons: ["outcome-unknown-recovery-required"],
          now: iso(7_000)
        }),
      RequeueNotAllowedError
    );

    // Operator resolution, then the node-level landing (checkpoint precedent):
    // RUNNING -> INTERRUPTED -> RECOVERY_REQUIRED, and propagation leaves it.
    assert.equal(
      resolveRecoveryItem(world.db, {
        executionId: continuationExecutionId,
        note: "operator confirmed the continuation never launched",
        now: iso(8_000)
      }),
      "applied"
    );
    applyReconcileOutcomeToNode(world.db, { runId, nodeId, outcome: "interrupted", now: iso(8_001) });
    applyReconcileOutcomeToNode(world.db, { runId, nodeId, outcome: "recovery-required", now: iso(8_002) });
    assert.equal(requireNodeState(world.db, { runId, nodeId }).state, "RECOVERY_REQUIRED");
    assert.deepEqual(propagateNodeStates(world.db, { runId, now: iso(9_000) }), []);
    assert.equal(requireNodeState(world.db, { runId, nodeId }).state, "RECOVERY_REQUIRED");

    // Still exactly two attempts: freeing the slot is NOT an automatic rerun.
    assert.equal(listAttemptsForSlot(world.db, { runId, nodeId }).length, 2);
    assert.equal(existsSync(sentinel), false, "the unapproved side effect never happened");
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

/** Assert the continuation is durably recorded (attempt 2 + consumed approval). */
function continueAfterApprovalIsDone(world: MatrixWorld, fixture: ContinuationFixture): void {
  assert.equal(getExecution(world.db, fixture.continuationExecutionId)?.phase, "STARTING");
  assert.equal(getApproval(world.db, fixture.approvalId)?.status, "CONSUMED");
  assert.ok(
    listPendingOutboxMessages(world.db).some(
      (message) => message.aggregateId === fixture.continuationExecutionId && message.publishedAt === null
    )
  );
}

// ---------------------------------------------------------------------------
// FM-APR-01: consumed-approval evidence survives the whole recovery
// ---------------------------------------------------------------------------

export async function runApprovalConsumedEvidencePreserved(): Promise<void> {
  const fixture = await setupContinuation("fm-apr01");
  const { world, runId, continuationExecutionId } = fixture;
  try {
    performContinuation(fixture);
    resumeNodeRunning(fixture);

    const before = requireApproval(world, fixture.approvalId);
    const evidence = (record: ApprovalRecord): string =>
      JSON.stringify({
        status: record.status,
        digest: record.actionDigest,
        approvedBy: record.approvedBy,
        approvedAt: record.approvedAt,
        consumedBy: record.consumedByExecutionId,
        consumedAt: record.consumedAt,
        requestedBy: record.requestedBy
      });
    assert.equal(before.status, "CONSUMED");
    assert.equal(before.consumedByExecutionId, continuationExecutionId);
    const beforeEvidence = evidence(before);

    const scan = await reconcileStartup(world.db, {});
    assert.equal(scan.decisions[0]?.outcome, "recovery-required");
    assert.equal(
      resolveRecoveryItem(world.db, {
        executionId: continuationExecutionId,
        note: "operator recovery",
        now: iso(6_000)
      }),
      "applied"
    );

    // The approval is untouched by reconcile and resolution: same digest,
    // same single consumption binding, same approval evidence.
    const after = requireApproval(world, fixture.approvalId);
    assert.equal(evidence(after), beforeEvidence);
    assert.equal(listApprovalsForRun(world.db, runId).length, 1);

    // The checkpoint keeps its one-shot continuation evidence.
    const row = world.db
      .prepare("SELECT status, continuation_execution_id FROM approval_checkpoints WHERE id = ?")
      .get(fixture.checkpointId) as { status: string; continuation_execution_id: string | null } | undefined;
    assert.ok(row !== undefined, "checkpoint row must exist");
    assert.equal(row.status, "CONTINUED");
    assert.equal(row.continuation_execution_id, continuationExecutionId);

    // The interrupted attempt's marker carries the A22 side-effect evidence.
    const marker = getEvent(world.db, reconcileEventId(continuationExecutionId, "interrupted"));
    assert.ok(marker !== null);
    const payload = JSON.parse(String(marker.payload)) as {
      sideEffects: { pendingDispatchIds: string[]; pendingDispatchCount: number };
    };
    assert.equal(payload.sideEffects.pendingDispatchCount, payload.sideEffects.pendingDispatchIds.length);
    // The REAL side effect — the continuation's pending dispatch — is still
    // durably pending after the whole recovery (evidence preserved).
    assert.ok(
      listPendingOutboxMessages(world.db).some(
        (message) =>
          message.aggregateId === continuationExecutionId &&
          message.type === "checkpoint.continuation-requested" &&
          message.publishedAt === null
      ),
      "the continuation dispatch remains pending after recovery"
    );
    assert.deepEqual(verifyEventChecksums(world.db), []);
  } finally {
    world.close();
  }
}

function requireApproval(world: MatrixWorld, approvalId: string): ApprovalRecord {
  const record = getApproval(world.db, approvalId);
  assert.ok(record !== null, `approval ${approvalId} must exist`);
  return record;
}

// ---------------------------------------------------------------------------
// FM-APR-02: a crashed consumption rolls the WHOLE continuation back
// ---------------------------------------------------------------------------

export async function runApprovalConsumeRollbackAtomic(): Promise<void> {
  const fixture = await setupContinuation("fm-apr02");
  const { world, runId, nodeId, continuationExecutionId } = fixture;
  try {
    const action = fixture.proposalAction;

    // A17 regression inside the continuation: any presented-action change is
    // a typed refusal with ZERO writes.
    const tampered: ProposedAction = { ...action, argv: [...action.argv, "extra-arg"] };
    expectThrow(
      () =>
        continueAfterApproval(world.db, {
          checkpointId: fixture.checkpointId,
          newExecutionId: continuationExecutionId,
          presentedAction: tampered,
          now: iso(5_000)
        }),
      ApprovalDigestMismatchError
    );
    assert.equal(getApproval(world.db, fixture.approvalId)?.status, "APPROVED");
    assert.equal(getExecution(world.db, continuationExecutionId), null);
    assert.equal(listAttemptsForSlot(world.db, { runId, nodeId }).length, 1);

    // The consumption UPDATE dies: attempt row, checkpoint CAS, approval CAS
    // and outbox message roll back TOGETHER — an execution can never exist
    // without its consumed approval.
    const crashingDb = crashOnSqlFragment(
      world.db,
      "fm-apr02-approval-consume",
      "UPDATE approvals SET status = 'CONSUMED'"
    );
    expectThrow(
      () =>
        continueAfterApproval(crashingDb, {
          checkpointId: fixture.checkpointId,
          newExecutionId: continuationExecutionId,
          now: iso(6_000)
        }),
      MatrixCrashInjectionError
    );
    assert.equal(getApproval(world.db, fixture.approvalId)?.status, "APPROVED", "approval evidence preserved");
    assert.equal(getApproval(world.db, fixture.approvalId)?.consumedByExecutionId, null);
    assert.equal(getExecution(world.db, continuationExecutionId), null, "no half-born execution");
    assert.equal(listAttemptsForSlot(world.db, { runId, nodeId }).length, 1);
    assert.equal(
      listPendingOutboxMessages(world.db).filter((message) => message.aggregateId === continuationExecutionId)
        .length,
      0,
      "no continuation outbox survived the rollback"
    );

    // The replay is still single-shot: exactly one continuation succeeds.
    const replay = continueAfterApproval(world.db, {
      checkpointId: fixture.checkpointId,
      newExecutionId: continuationExecutionId,
      now: iso(7_000)
    });
    assert.equal(replay.approval.status, "CONSUMED");
    assert.equal(replay.approval.consumedByExecutionId, continuationExecutionId);
    assert.equal(replay.execution.phase, "STARTING");
    expectThrow(
      () =>
        continueAfterApproval(world.db, {
          checkpointId: fixture.checkpointId,
          newExecutionId: "exec-fm-apr02-3",
          now: iso(8_000)
        }),
      CheckpointStateError
    );
    assert.equal(getExecution(world.db, "exec-fm-apr02-3"), null);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-RETRY-01 (A21): three total attempts, then the run is held
// ---------------------------------------------------------------------------

export async function runRetryCapThreeAttempts(): Promise<void> {
  const world = await createMatrixWorld("fm-retry01");
  try {
    const { runId } = createMatrixRun(world, "run-fm-retry01", "task-fm-retry01");
    const spec = singleNodeSpec("node-fm");
    planGraph(world, runId, [spec], CHAIN_DEFINITION_REVISION);
    const state = newChainState();
    const options = {
      runId,
      specs: [spec],
      definitionRevision: CHAIN_DEFINITION_REVISION,
      launch: (): { readonly scenario: string; readonly timeoutSeconds: number } => ({
        scenario: "error-result",
        timeoutSeconds: 120
      }),
      reviewExpectedFiles: {}
    };

    // Attempts 1 and 2 fail determinately; the controlled requeue reopens the
    // node within the A21 cap.
    for (const expectedAttempt of [1, 2]) {
      const round = await pumpRound(world, state, options, expectedAttempt);
      const trace = round.traces.find((entry) => entry.nodeId === spec.id);
      assert.ok(trace !== undefined, `attempt ${String(expectedAttempt)} must have run`);
      assert.equal(trace.attempt, expectedAttempt);
      assert.equal(trace.finalPhase, "FAILED");
      assert.ok(trace.reasons.includes("nonzero-exit"));
      // Between rounds: the retry window opens BEFORE the next round's tick.
      const requeue = requeueForRetry(world.db, {
        runId,
        nodeId: spec.id,
        failureReasons: ["nonzero-exit", "final-result-error"],
        now: iso(expectedAttempt * 1_000 + 500)
      });
      assert.equal(requeue.totalAttempts, expectedAttempt);
      assert.equal(requireNodeState(world.db, { runId, nodeId: spec.id }).state, "READY");
    }

    // Attempt 3 fails too: the A21 cap refuses the fourth — typed refusal,
    // durable hold, no automatic anything.
    const third = await pumpRound(world, state, options, 3);
    const thirdTrace = third.traces.find((entry) => entry.nodeId === spec.id);
    assert.ok(thirdTrace !== undefined && thirdTrace.attempt === 3);
    assert.throws(
      () =>
        requeueForRetry(world.db, {
          runId,
          nodeId: spec.id,
          failureReasons: ["nonzero-exit", "final-result-error"],
          now: iso(60_000)
        }),
      AttemptsExhaustedError
    );
    assert.equal(listAttemptsForSlot(world.db, { runId, nodeId: spec.id }).length, 3);
    assert.equal(requireNodeState(world.db, { runId, nodeId: spec.id }).state, "FAILED");
    assert.deepEqual(propagateNodeStates(world.db, { runId, now: iso(61_000) }), []);
    assert.equal(requireNodeState(world.db, { runId, nodeId: spec.id }).state, "FAILED");

    // The frozen profile never moved across the retries (A21/A34).
    const frozen = readRunRoleProfile(world.db, { runId, roleId: "developer" });
    assert.equal(String(frozen.snapshot.revision), "1");
    assert.deepEqual(verifyEventChecksums(world.db), []);
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-CHAIN-01: the full chain recovers from a mid-chain failure correctly
// ---------------------------------------------------------------------------

export async function runChainResumeAfterRecovery(): Promise<void> {
  const world = await createMatrixWorld("fm-chain01");
  try {
    const { runId } = createMatrixRun(world, "run-fm-chain01", "task-fm-chain01");
    planGraph(world, runId, CHAIN_SPECS, CHAIN_DEFINITION_REVISION);
    const state = newChainState();
    const options = {
      runId,
      specs: CHAIN_SPECS,
      definitionRevision: CHAIN_DEFINITION_REVISION,
      reviewExpectedFiles: chainExpectedFiles(),
      launch: (spec: { readonly id: string }, attempt: number) => ({
        // The injected fault: alpha's FIRST attempt fails determinately; its
        // retry and every other launch succeed.
        scenario: spec.id === "alpha" && attempt === 1 ? "error-result" : "success",
        timeoutSeconds: 120
      })
    };

    let requeues = 0;
    for (let round = 1; round <= 10; round += 1) {
      const result = await pumpRound(world, state, options, round);
      for (const trace of result.traces) {
        if (trace.finalPhase === "FAILED") {
          requeues += 1;
          requeueForRetry(world.db, {
            runId,
            nodeId: trace.nodeId,
            failureReasons: ["nonzero-exit", "final-result-error"],
            // Between rounds: the retry window opens before the next tick.
            now: iso(round * 1_000 + 500)
          });
        }
      }
      if (listRunNodes(world.db, runId).every((node) => node.state === "SUCCEEDED")) break;
    }

    // The whole chain is SUCCEEDED with the CORRECT result.
    const nodes = listRunNodes(world.db, runId);
    assert.ok(nodes.length === CHAIN_SPECS.length);
    for (const node of nodes) {
      assert.equal(node.state, "SUCCEEDED", `node ${node.nodeId} must be SUCCEEDED`);
    }
    const integrateRecord = getIntegrationRecord(world.db, { runId, nodeId: "integrate" });
    assert.equal(integrateRecord?.state, "COMPLETED");
    const candidateSha = integrateRecord?.candidateSha ?? "";
    assert.match(candidateSha, /^[0-9a-f]{40}$/);
    // The candidate content carries BOTH parent outputs (content-level A09).
    const alphaAt = await world.git.run(world.repoPath, ["show", `${candidateSha}:${ALPHA_FILE_REL}`]);
    const betaAt = await world.git.run(world.repoPath, ["show", `${candidateSha}:${BETA_FILE_REL}`]);
    assert.equal(alphaAt.stdout, ALPHA_FILE_CONTENT);
    assert.equal(betaAt.stdout, BETA_FILE_CONTENT);

    // The review passed, bound to that exact candidate.
    const reviewTrace = state.traces.find((trace) => trace.nodeId === "review");
    assert.ok(reviewTrace !== undefined);
    assert.equal(reviewTrace.reviewVerdict, "pass");
    assert.equal(reviewTrace.candidateSha, candidateSha);

    // Recovery facts: exactly one injected failure, exactly one retry, and
    // no leftover recovery items anywhere.
    const failedTraces = state.traces.filter((trace) => trace.finalPhase === "FAILED");
    assert.equal(failedTraces.length, 1);
    assert.equal(failedTraces[0]?.nodeId, "alpha");
    assert.equal(failedTraces[0]?.attempt, 1);
    const alphaTraces = state.traces.filter((trace) => trace.nodeId === "alpha");
    assert.equal(alphaTraces.length, 2, "alpha ran exactly twice (fail + retry)");
    assert.equal(requeues, 1);
    assert.deepEqual(listRecoveryItems(world.db), []);
    assert.deepEqual(verifyEventChecksums(world.db), []);
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}
