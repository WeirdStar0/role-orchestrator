/**
 * Process-boundary fault injections (M4-05), Windows-native dogfood.
 *
 * - FM-PROC-01 (A24): the crash window between spawn and the pid-identity
 *   write leaves a STARTING row with NO pid — the matrix feeds that durable
 *   state to the real reconcile and asserts: recovery-required, the slot
 *   stays constraint-blocked (no re-dispatch, no second writer), the item
 *   waits for a human, and after operator resolution a NEW attempt runs the
 *   fake-cli to a correct SUCCEEDED.
 * - FM-PROC-02: spawn itself fails (ENOENT direct executable) — a determinate
 *   launch failure with persisted evidence, classified `auto` by the retry
 *   budget and bounded by the A21 cap.
 * - FM-PROC-03 (A26): the engine's kill budget terminates the WHOLE tree of
 *   the fake-cli `grandchild` scenario (taskkill /T /F evidence in the
 *   lifecycle payload; child+grandchild verified dead via process-lab).
 * - FM-PROC-04 (A27): a real live placeholder occupies a pid whose recorded
 *   identity belongs to an EARLIER holder — reconcile interrupts the attempt
 *   WITHOUT touching the unrelated holder.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import {
  ActiveAttemptConflictError,
  createActiveAttempt,
  getEvent,
  getExecution,
  listActiveAttempts,
  listEventsForExecution,
  listPendingOutboxMessages,
  readExecutionPidIdentity,
  verifyEventChecksums
} from "@role-orchestrator/store";
import { ExecutionLaunchError, startExecution } from "@role-orchestrator/engine";
import {
  listRecoveryItems,
  reconcileEventId,
  reconcileStartup,
  resolveRecoveryItem
} from "@role-orchestrator/reconcile";
import { AttemptsExhaustedError, requeueForRetry } from "@role-orchestrator/scheduler";
import { listUnresolvedBudgetHolds } from "@role-orchestrator/budget";
import { expectPidGone, isAlive, queryProcessIdentity, taskkill } from "@role-orchestrator/process-lab";
import { requireNodeState, transitionNodeState } from "@role-orchestrator/dag";
import {
  DIRTY_FILE_CONTENT,
  createGhostRun,
  createMatrixRun,
  createMatrixWorld,
  iso,
  makeLaunchDir
} from "../world.js";
import { MatrixUsageError } from "../errors.js";
import { expectRejection, makeAttemptRow, sleep } from "./support.js";
import { CHAIN_DEFINITION_REVISION, singleNodeSpec } from "./chain-specs.js";
import { planGraph } from "../pipeline.js";

function phaseOf(db: DatabaseSync, executionId: string): string | null {
  const row: unknown = db.prepare("SELECT phase FROM executions WHERE id = ?").get(executionId);
  if (row === undefined || row === null) return null;
  return String((row as { phase: unknown }).phase);
}

function pendingDispatchIds(db: DatabaseSync, executionId: string): readonly string[] {
  return listPendingOutboxMessages(db)
    .filter((message) => message.aggregateId === executionId && message.publishedAt === null)
    .map((message) => message.id);
}

// ---------------------------------------------------------------------------
// FM-PROC-01 (A24): crash between spawn and the pid-identity record
// ---------------------------------------------------------------------------

export async function runProcLaunchWindowCrash(): Promise<void> {
  const world = await createMatrixWorld("fm-p01");
  try {
    const { runId } = createMatrixRun(world, "run-fm-p01", "task-fm-p01");

    // Durable crash state: STARTING with dispatch committed, NO pid ever
    // recorded (the engine records the identity immediately after spawn, so
    // this row is exactly what that crash leaves behind).
    makeAttemptRow(world.db, {
      executionId: "exec-fm-p01",
      runId,
      nodeId: "node-alpha",
      phase: "STARTING"
    });

    // The probe must NOT be consulted (no pid recorded): count invocations.
    let probeCalls = 0;
    const scan = await reconcileStartup(world.db, {
      probe: async () => {
        probeCalls += 1;
        return { kind: "indeterminate", reason: "must not be consulted" };
      }
    });
    assert.equal(scan.scanned, 1);
    assert.equal(probeCalls, 0, "the launch-window decision needs no OS query");
    const decision = scan.decisions[0];
    assert.ok(decision !== undefined);
    assert.equal(decision.outcome, "recovery-required");
    assert.equal(decision.detail.reason, "launch-window-undetermined");
    assert.equal(decision.applied, "applied");
    // The attempt row deliberately STAYS active: the A23 constraint keeps
    // blocking new attempts, so nothing can auto re-run (A22).
    assert.equal(phaseOf(world.db, "exec-fm-p01"), "STARTING");
    assert.throws(
      () =>
        createActiveAttempt(world.db, {
          id: "exec-fm-p01-attempt2",
          runId,
          nodeId: "node-alpha",
          definitionRevision: CHAIN_DEFINITION_REVISION,
          attempt: 2,
          dispatchToken: "dt-fm-p01-2",
          phase: "PREPARING",
          now: iso(1_000)
        }),
      ActiveAttemptConflictError,
      "the blocked slot must refuse a second attempt (no re-dispatch, A24)"
    );

    // The interrupted list surfaces the item for a human, with side-effect
    // evidence; a second scan is idempotent, never a second marker.
    const items = listRecoveryItems(world.db).filter((item) => item.executionId === "exec-fm-p01");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.status, "RECOVERY_REQUIRED");
    assert.equal(items[0]?.followUp, "manual-recovery");
    assert.equal(items[0]?.pendingDispatchIds.length, 1, "the dispatch side effect is the A22 evidence");
    const rescan = await reconcileStartup(world.db, {});
    assert.equal(rescan.decisions[0]?.applied, "already-applied");

    // Operator resolution frees the slot (still never a re-dispatch).
    assert.equal(
      resolveRecoveryItem(world.db, {
        executionId: "exec-fm-p01",
        note: "operator confirmed the launch never started",
        now: iso(2_000)
      }),
      "applied"
    );
    assert.equal(phaseOf(world.db, "exec-fm-p01"), "INTERRUPTED");

    // Recovery continues the chain: a NEW attempt runs fake-cli correctly.
    const run = startExecution(world.db, {
      executionId: "exec-fm-p01-attempt2",
      runId,
      roleId: "developer",
      nodeId: "node-alpha",
      definitionRevision: CHAIN_DEFINITION_REVISION,
      attempt: 2,
      dispatchToken: "dt-fm-p01-2b",
      cwd: makeLaunchDir(world, "fm-p01"),
      prompt: "fault matrix FM-PROC-01 (recovered attempt)",
      invocationArgs: ["--scenario", "success"],
      timeoutSeconds: 120,
      now: iso(3_000)
    });
    const result = await run.result;
    assert.equal(result.finalPhase, "SUCCEEDED");
    const slot = listActiveAttempts(world.db);
    assert.equal(slot.length, 0, "no active attempt may remain");
    assert.equal(
      (getExecution(world.db, "exec-fm-p01-attempt2")?.phase ?? ""), "SUCCEEDED"
    );
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
    assert.deepEqual(verifyEventChecksums(world.db), []);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-PROC-02: spawn failure (ENOENT) is determinate, evidenced, auto-retryable
// ---------------------------------------------------------------------------

export async function runProcSpawnFailure(): Promise<void> {
  const world = await createMatrixWorld("fm-p02");
  try {
    const ghost = await createGhostRun(world, "run-fm-p02");
    // The requeue path reasons about the DAG node, so the ghost run gets the
    // standard single-node graph.
    planGraph(world, ghost.runId, [singleNodeSpec("node-alpha")], CHAIN_DEFINITION_REVISION);

    const launch = (attempt: number): Promise<unknown> => {
      const run = startExecution(world.db, {
        executionId: `exec-fm-p02-${String(attempt)}`,
        runId: ghost.runId,
        roleId: "developer",
        nodeId: "node-alpha",
        definitionRevision: CHAIN_DEFINITION_REVISION,
        attempt,
        dispatchToken: `dt-fm-p02-${String(attempt)}`,
        cwd: makeLaunchDir(world, `fm-p02-${String(attempt)}`),
        prompt: "fault matrix FM-PROC-02 (ghost executable)",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 120,
        now: iso(attempt * 1_000)
      });
      return run.result;
    };

    await expectRejection(launch(1), ExecutionLaunchError);
    assert.equal(phaseOf(world.db, "exec-fm-p02-1"), "FAILED");
    assert.equal(readExecutionPidIdentity(world.db, "exec-fm-p02-1"), null, "no process ever existed");
    const launchFailedEvent = listEventsForExecution(world.db, "exec-fm-p02-1").find(
      (event) => event.type === "lifecycle_launch_failed"
    );
    assert.ok(launchFailedEvent !== undefined, "launch failure must be persisted as evidence");
    assert.ok(
      pendingDispatchIds(world.db, "exec-fm-p02-1").length >= 1,
      "the attempt-finished outbox message is pending evidence"
    );

    // Terminal FAILED row: startup reconcile has nothing to scan.
    const scan = await reconcileStartup(world.db, {});
    assert.equal(scan.scanned, 0);

    // The failure is determinate: classified auto by the retry budget, so
    // the controlled requeue reopens the node — bounded by the A21 cap.
    // The node walk mirrors the orchestrator: the dispatch decision moves
    // READY -> RUNNING, the failure bookkeeping RUNNING -> FAILED, and the
    // requeue FAILED -> RETRY_PENDING -> READY.
    // Attempt 1 was launched at the top of the case (its dispatch token is
    // burned — the A24 anchor refuses a replayed token). The controlled
    // requeue opens attempts 2 and 3 within the cap.
    for (const round of [1, 2]) {
      const attempt = round + 1;
      transitionNodeState(world.db, {
        runId: ghost.runId,
        nodeId: "node-alpha",
        to: "RUNNING",
        whereStateIn: ["READY"],
        now: iso(9_000 + round)
      });
      await expectRejection(launch(attempt), ExecutionLaunchError);
      transitionNodeState(world.db, {
        runId: ghost.runId,
        nodeId: "node-alpha",
        to: "FAILED",
        whereStateIn: ["RUNNING"],
        now: iso(9_500 + round)
      });
      if (round === 1) {
        const requeue = requeueForRetry(world.db, {
          runId: ghost.runId,
          nodeId: "node-alpha",
          failureReasons: ["launch-failed"],
          now: iso(10_000 + round)
        });
        assert.equal(requeue.policy, "auto");
        assert.equal(requeue.totalAttempts, 2, "the cap counts TOTAL attempts");
        assert.equal(requireNodeState(world.db, { runId: ghost.runId, nodeId: "node-alpha" }).state, "READY");
      } else {
        // Three TOTAL attempts consumed: the A21 cap refuses the fourth —
        // typed refusal, durable hold, no automatic anything.
        assert.throws(
          () =>
            requeueForRetry(world.db, {
              runId: ghost.runId,
              nodeId: "node-alpha",
              failureReasons: ["launch-failed"],
              now: iso(10_000 + round)
            }),
          AttemptsExhaustedError
        );
      }
    }

    // The run is durably held for the user, and the fourth attempt never
    // happens: a further requeue hits the hold.
    const holds = listUnresolvedBudgetHolds(world.db, ghost.runId);
    assert.equal(holds.length, 1);
    assert.equal(holds[0]?.reason, "attempts-exhausted");
    assert.equal(listActiveAttempts(world.db).length, 0);
    assert.throws(
      () =>
        requeueForRetry(world.db, {
          runId: ghost.runId,
          nodeId: "node-alpha",
          failureReasons: ["launch-failed"],
          now: iso(21_000)
        }),
      AttemptsExhaustedError
    );
    assert.equal(listUnresolvedBudgetHolds(world.db, ghost.runId).length, 1, "the hold is idempotent");
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
    assert.deepEqual(verifyEventChecksums(world.db), []);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-PROC-03 (A26): the kill budget terminates child AND grandchild
// ---------------------------------------------------------------------------

export async function runProcTreeKillGrandchild(): Promise<void> {
  if (process.platform !== "win32") {
    throw new MatrixUsageError("FM-PROC-03 is windows-native only (taskkill semantics)");
  }
  const world = await createMatrixWorld("fm-p03");
  try {
    const { runId } = createMatrixRun(world, "run-fm-p03", "task-fm-p03");
    // The coordinator binds the claude profile — its dialect preserves the
    // grandchild report's input payload verbatim.
    const run = startExecution(world.db, {
      executionId: "exec-fm-p03",
      runId,
      roleId: "coordinator",
      nodeId: "node-alpha",
      definitionRevision: CHAIN_DEFINITION_REVISION,
      attempt: 1,
      dispatchToken: "dt-fm-p03",
      cwd: makeLaunchDir(world, "fm-p03"),
      prompt: "fault matrix FM-PROC-03 (grandchild tree)",
      invocationArgs: ["--scenario", "grandchild"],
      timeoutSeconds: 2,
      now: iso(1_000)
    });
    const result = await run.result;
    assert.equal(result.finalPhase, "FAILED");
    assert.ok(result.reasons.includes("timeout"), `expected timeout in reasons: ${result.reasons.join(",")}`);

    // The grandchild report carried both pids through the persisted stream.
    const payloads = listEventsForExecution(world.db, "exec-fm-p03").map((event) => event.payload);
    const reportLine = payloads.find((payload) => payload.includes("grandchildPid"));
    assert.ok(reportLine !== undefined, "grandchild report event must be persisted");
    const childPid = Number(/"childPid":(\d+)/.exec(reportLine)?.[1]);
    const grandchildPid = Number(/"grandchildPid":(\d+)/.exec(reportLine)?.[1]);
    assert.ok(Number.isInteger(childPid) && childPid > 0, `child pid unparsable: ${reportLine}`);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

    // The kill evidence is a real `taskkill /T /F` that exited 0.
    const outcomeEvent = listEventsForExecution(world.db, "exec-fm-p03").find(
      (event) => event.type === "lifecycle_outcome"
    );
    assert.ok(outcomeEvent !== undefined);
    const payload = JSON.parse(outcomeEvent.payload) as {
      killEvidence: { tool: string; args: string[]; exitCode: number | null } | null;
    };
    assert.ok(payload.killEvidence !== null, "kill evidence must be recorded");
    assert.equal(payload.killEvidence.tool, "taskkill");
    assert.ok(payload.killEvidence.args.includes("/T"), "the tree flag is mandatory (A26)");
    assert.ok(payload.killEvidence.args.includes("/F"));
    assert.equal(payload.killEvidence.exitCode, 0);

    // process-lab verification: the WHOLE tree is dead — root, child, grandchild.
    await expectPidGone(result.pidIdentity.pid);
    await expectPidGone(childPid);
    await expectPidGone(grandchildPid);
    assert.equal(world.readDirtyFile(), DIRTY_FILE_CONTENT);
  } finally {
    world.close();
  }
}

// ---------------------------------------------------------------------------
// FM-PROC-04 (A27): a reused pid is interrupted, the holder left alive
// ---------------------------------------------------------------------------

export async function runProcPidReuseHolderSurvives(): Promise<void> {
  if (process.platform !== "win32") {
    throw new MatrixUsageError("FM-PROC-04 is windows-native only (Win32_Process identity)");
  }
  const world = await createMatrixWorld("fm-p04");
  let placeholder: { pid: number; stop(): Promise<void> } | null = null;
  try {
    const { runId } = createMatrixRun(world, "run-fm-p04", "task-fm-p04");

    // A REAL second process occupies the pid value now; the recorded identity
    // belongs to an EARLIER holder created 60s before it — the exact
    // observable state after Windows reused the pid.
    const child = spawn("cmd.exe", ["/d", "/c", "ping", "-n", "60", "127.0.0.1"], {
      stdio: "ignore",
      windowsHide: true
    });
    const pid = child.pid;
    assert.ok(pid !== undefined, "placeholder must spawn");
    placeholder = {
      pid,
      stop: async (): Promise<void> => {
        child.kill();
      }
    };
    const holder = await queryProcessIdentity(pid);
    assert.ok(holder !== null && holder.creationTimeIso !== null, "placeholder identity must resolve");
    const holderCreatedMs = Date.parse(holder.creationTimeIso);
    const originalCreatedMs = holderCreatedMs - 60_000;

    makeAttemptRow(world.db, {
      executionId: "exec-fm-p04",
      runId,
      nodeId: "node-alpha",
      phase: "RUNNING",
      pid,
      pidCreationTime: new Date(originalCreatedMs).toISOString()
    });

    // Give the real probe a generous window (PowerShell startup dominates).
    await sleep(200);
    const scan = await reconcileStartup(world.db, { probeTimeoutMs: 30_000 });
    assert.equal(scan.scanned, 1);
    const decision = scan.decisions[0];
    assert.ok(decision !== undefined);
    assert.equal(decision.outcome, "interrupted");
    assert.equal(decision.detail.reason, "pid-reused-identity-mismatch");
    assert.equal(phaseOf(world.db, "exec-fm-p04"), "INTERRUPTED");

    // 不误杀: the unrelated holder is untouched by the reconcile.
    assert.equal(isAlive(pid), true, "the live holder must survive the scan (A27)");
    // 不误认: the marker reports stored vs observed identity.
    const marker = getEvent(world.db, reconcileEventId("exec-fm-p04", "interrupted"));
    assert.ok(marker !== null);
    const markerPayload = String(marker.payload);
    assert.ok(markerPayload.includes("pid-reused-identity-mismatch"));
    assert.ok(markerPayload.includes("observedCreationTime"));

    // The freed slot accepts a NEW attempt; cleanup kills the placeholder.
    assert.doesNotThrow(() =>
      createActiveAttempt(world.db, {
        id: "exec-fm-p04-attempt2",
        runId,
        nodeId: "node-alpha",
        definitionRevision: CHAIN_DEFINITION_REVISION,
        attempt: 2,
        dispatchToken: "dt-fm-p04-2",
        phase: "PREPARING",
        now: iso(1_000)
      })
    );
  } finally {
    if (placeholder !== null) {
      const kill = await taskkill(placeholder.pid, { tree: true, force: true });
      assert.equal(kill.exitCode, 0);
      await expectPidGone(placeholder.pid);
    }
    world.close();
  }
}
