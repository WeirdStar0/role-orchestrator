/**
 * M4-04 scheduler integration (A21/A22/A37/A34): the controlled requeue
 * through `requeueForRetry`, the three-total-attempt cap enforced inside the
 * dispatch claim, budget/usage enforcement over enrolled runs, and the
 * frozen-profile guarantee for retried attempts.
 *
 * No real CLI is invoked: attempt outcomes are driven through the queue APIs,
 * the dag state machine and the same terminal-FAILED execution write the
 * engine performs — exactly the composition a supervisor uses.
 */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { transitionNodeState } from "@role-orchestrator/dag";
import { listAttemptsForSlot } from "@role-orchestrator/store";
import {
  BudgetAlreadyEnrolledError,
  ensureRunBudget,
  evaluateDispatchBudgetGate,
  getExecutionUsage,
  listUnresolvedBudgetHolds,
  recordBudgetRunHold,
  recordUsageUnavailable,
  resolveBudgetRunHold
} from "@role-orchestrator/budget";
import { setRoleBinding } from "@role-orchestrator/runtime-profile";
import {
  AttemptsExhaustedError,
  ConditionalRetryExhaustedError,
  InvalidQueueEntryStateError,
  NonRetryableFailureError,
  RequeueNotAllowedError,
  RunHeldError,
  SCHEDULER_MAX_NODE_ATTEMPTS,
  enqueueReadyNodes,
  getQueueEntry,
  markQueueEntryCompleted,
  pollQueue,
  requeueForRetry,
  releaseExecutionQuotaGrants
} from "../src/index.js";
import {
  createBudgetAwareFileDb,
  expectError,
  iso,
  pollInput,
  seedProfile,
  seedProject,
  seedReadyRun
} from "./helpers.js";

/** Clock helper: monotonically increasing DB stamps per test. */
function makeClock() {
  let ms = 0;
  return () => {
    ms += 1_000;
    return iso(ms);
  };
}

/**
 * Terminate a dispatched attempt: complete the queue entry, release the
 * grants and write the terminal FAILED execution phase (the engine performs
 * that write inside its lifecycle transaction; the node-level FAILED
 * transition stays an explicit supervisor step below).
 */
function terminateAttempt(db: DatabaseSync, entryId: string, executionId: string, now: string): void {
  markQueueEntryCompleted(db, { entryId, now });
  releaseExecutionQuotaGrants(db, { executionId, now });
  db.prepare("UPDATE executions SET phase = 'FAILED' WHERE id = ?").run(executionId);
}

/** Seed one profile + project + run with the given READY entry nodes. */
async function seedSingleRun(db: DatabaseSync, runId: string, nodeIds: readonly string[]): Promise<void> {
  await seedProfile(db, { profileId: "claude-main", credentialGroup: "personal", maxConcurrency: 2 });
  await seedProject(db, { projectId: `proj-${runId}`, profileId: "claude-main" });
  await seedReadyRun(db, { projectId: `proj-${runId}`, runId, nodeIds });
}

describe("M4-04: controlled requeue and the A21 attempt cap", () => {
  it("requeues a FAILED node through COMPLETED/DISPATCHED -> WAITING and the retry edges", async () => {
    const { db } = createBudgetAwareFileDb("requeue-basic");
    await seedSingleRun(db, "run-1", ["n1"]);
    const tick = makeClock();

    enqueueReadyNodes(db, { runId: "run-1", now: tick() });
    const poll = pollQueue(db, pollInput(tick()));
    const dispatched = poll.dispatched[0];
    if (!dispatched) throw new Error("test: expected a dispatch");
    terminateAttempt(db, dispatched.entryId, dispatched.executionId, tick());
    transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });

    const requeue = requeueForRetry(db, {
      runId: "run-1",
      nodeId: "n1",
      failureReasons: ["timeout"],
      now: tick()
    });
    expect(requeue).toMatchObject({
      requeued: true,
      entryId: dispatched.entryId,
      runId: "run-1",
      nodeId: "n1",
      policy: "auto",
      totalAttempts: 1
    });

    // The entry is WAITING again (history kept in execution_id until the
    // next claim overwrites it) and the node is READY.
    const entry = getQueueEntry(db, dispatched.entryId);
    expect(entry?.state).toBe("WAITING");
    expect(entry?.executionId).toBe(dispatched.executionId);

    const poll2 = pollQueue(db, pollInput(tick()));
    expect(poll2.dispatched).toHaveLength(1);
    expect(poll2.dispatched[0]?.executionId).not.toBe(dispatched.executionId);
  });

  it("refuses a requeue for non-FAILED nodes, live attempts and non-retryable classifications", async () => {
    const { db } = createBudgetAwareFileDb("requeue-guards");
    await seedSingleRun(db, "run-1", ["n1"]);
    const tick = makeClock();

    // Guard 1: a READY (never started) node has nothing to requeue.
    enqueueReadyNodes(db, { runId: "run-1", now: tick() });
    const readyRefusal = expectError(
      () => requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["timeout"], now: tick() }),
      RequeueNotAllowedError
    );
    expect(readyRefusal.state).toBe("READY");

    // Dispatch, then fail the NODE while its attempt is still live
    // (execution STARTING): the node state passes, but the entry guard
    // refuses — a live attempt is never double-claimed.
    const poll = pollQueue(db, pollInput(tick()));
    const dispatched = poll.dispatched[0];
    if (!dispatched) throw new Error("test: expected a dispatch");
    transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });
    const liveRefusal = expectError(
      () => requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["timeout"], now: tick() }),
      InvalidQueueEntryStateError
    );
    expect(liveRefusal.entryId).toBe(dispatched.entryId);

    // Terminate the attempt properly (queue complete + terminal FAILED), then
    // the A22 guard: an UNKNOWN outcome never requeues automatically — the
    // node stays FAILED and no RETRY_PENDING is produced.
    markQueueEntryCompleted(db, { entryId: dispatched.entryId, now: tick() });
    releaseExecutionQuotaGrants(db, { executionId: dispatched.executionId, now: tick() });
    const refused = expectError(
      () =>
        requeueForRetry(db, {
          runId: "run-1",
          nodeId: "n1",
          failureReasons: ["nonzero-exit", "outcome-unknown-recovery-required"],
          now: tick()
        }),
      NonRetryableFailureError
    );
    expect(refused.policy).toBe("recovery");
    expect(refused.reasons).toContain("outcome-unknown-recovery-required");
    expect(getQueueEntry(db, dispatched.entryId)?.state).toBe("COMPLETED");
    expect(dispatchedCount(db, "run-1")).toBe(1);
  });

  it("caps once-then-manual failures at exactly one conditional retry", async () => {
    const { db } = createBudgetAwareFileDb("requeue-conditional");
    await seedSingleRun(db, "run-1", ["n1"]);
    const tick = makeClock();

    const failOnce = (): void => {
      enqueueReadyNodes(db, { runId: "run-1", now: tick() });
      const poll = pollQueue(db, pollInput(tick()));
      const dispatched = poll.dispatched[0];
      if (!dispatched) throw new Error("test: expected a dispatch");
      terminateAttempt(db, dispatched.entryId, dispatched.executionId, tick());
      transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });
    };

    // Attempt 1 fails with a protocol error; the ONE conditional retry is
    // granted (and its budget consumed).
    failOnce();
    expect(
      requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["protocol-error"], now: tick() }).policy
    ).toBe("once-then-manual");

    // Attempt 2 fails the same way: the conditional budget is spent — a
    // human decides now, even though the A21 cap has room left.
    failOnce();
    const exhausted = expectError(
      () => requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["protocol-error"], now: tick() }),
      ConditionalRetryExhaustedError
    );
    expect(exhausted.policy).toBe("once-then-manual");
    expect(dispatchedCount(db, "run-1")).toBe(2);
  });

  it("stops after three TOTAL attempts: the requeue refuses, the run holds, and the dispatch refuses a forced fourth", async () => {
    const { db } = createBudgetAwareFileDb("cap-3");
    await seedSingleRun(db, "run-1", ["n1"]);
    const tick = makeClock();
    expect(SCHEDULER_MAX_NODE_ATTEMPTS).toBe(3);

    const failOnce = (): string => {
      enqueueReadyNodes(db, { runId: "run-1", now: tick() });
      const poll = pollQueue(db, pollInput(tick()));
      const dispatched = poll.dispatched[0];
      if (!dispatched) throw new Error("test: expected a dispatch");
      terminateAttempt(db, dispatched.entryId, dispatched.executionId, tick());
      transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });
      return dispatched.entryId;
    };

    // Attempts 1 and 2 requeue cleanly (auto classification).
    failOnce();
    expect(requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["nonzero-exit"], now: tick() }).requeued).toBe(true);
    failOnce();
    expect(requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["nonzero-exit"], now: tick() }).requeued).toBe(true);

    // Attempt 3 fails: the A21 cap is reached. The requeue refuses with the
    // typed exhaustion error and durably holds the run for the user.
    const thirdEntryId = failOnce();
    const exhausted = expectError(
      () => requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["nonzero-exit"], now: tick() }),
      AttemptsExhaustedError
    );
    expect(exhausted.attempts).toBe(3);
    expect(listUnresolvedBudgetHolds(db, "run-1").map((hold) => hold.reason)).toEqual(["attempts-exhausted"]);
    expect(dispatchedCount(db, "run-1")).toBe(3);

    // Defense in depth: even a caller that forces the node READY and the
    // queue row WAITING cannot produce a fourth attempt — the claim
    // transaction itself refuses and records the entry GATE_BLOCKED.
    transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "RETRY_PENDING", whereStateIn: ["FAILED"], now: tick() });
    transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "READY", whereStateIn: ["RETRY_PENDING"], now: tick() });
    // The buggy-caller part of the scenario: force the COMPLETED entry back
    // into the poll candidates.
    const forced = db
      .prepare(
        "UPDATE scheduler_queue SET state = 'WAITING', updated_at = ? WHERE id = ? AND state = 'COMPLETED'"
      )
      .run(tick(), thirdEntryId);
    expect(Number(forced.changes)).toBe(1);
    const poll = pollQueue(db, pollInput(tick()));
    expect(poll.dispatched).toHaveLength(0);
    expect(poll.blocked).toHaveLength(1);
    expect(poll.blocked[0]).toMatchObject({ kind: "attempt-cap", reason: "attempt-cap:3" });
    expect(dispatchedCount(db, "run-1")).toBe(3);
    // The forced entry was recorded, not silently dropped.
    expect(getQueueEntry(db, poll.blocked[0]!.entryId)?.state).toBe("GATE_BLOCKED");
  });

  it("keeps the FROZEN profile for retried attempts (A34): a mid-run rebinding changes nothing", async () => {
    const { db } = createBudgetAwareFileDb("requeue-a34");
    await seedProfile(db, { profileId: "claude-original", credentialGroup: "personal", maxConcurrency: 2 });
    await seedProfile(db, { profileId: "claude-other", credentialGroup: "group-other", maxConcurrency: 2 });
    await seedProject(db, { projectId: "proj-run-1", profileId: "claude-original" });
    await seedReadyRun(db, { projectId: "proj-run-1", runId: "run-1", nodeIds: ["n1"] });
    const tick = makeClock();

    enqueueReadyNodes(db, { runId: "run-1", now: tick() });
    const poll = pollQueue(db, pollInput(tick()));
    const first = poll.dispatched[0];
    if (!first) throw new Error("test: expected a dispatch");
    terminateAttempt(db, first.entryId, first.executionId, tick());
    transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });

    // The project's CURRENT binding moves to another profile mid-run.
    for (const roleId of ["coordinator", "architect", "developer", "reviewer"] as const) {
      setRoleBinding(db, {
        projectId: "proj-run-1",
        roleId,
        profileId: "claude-other",
        canCreateSubtasks: roleId === "coordinator",
        now: tick()
      });
    }

    // The requeue does NOT re-resolve: the retried dispatch still uses the
    // frozen snapshot profile.
    requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["timeout"], now: tick() });
    const poll2 = pollQueue(db, pollInput(tick()));
    const second = poll2.dispatched[0];
    if (!second) throw new Error("test: expected the retry dispatch");
    expect(second.executionId).not.toBe(first.executionId);

    const firstEntry = db
      .prepare("SELECT profile_id FROM scheduler_queue WHERE id = ?")
      .get(first.entryId) as { profile_id: string };
    const secondEntry = db
      .prepare("SELECT profile_id FROM scheduler_queue WHERE id = ?")
      .get(second.entryId) as { profile_id: string };
    expect(firstEntry.profile_id).toBe("claude-original");
    expect(secondEntry.profile_id).toBe("claude-original");

    const firstRevision = db
      .prepare("SELECT definition_revision FROM executions WHERE id = ?")
      .get(first.executionId) as { definition_revision: string };
    const retriedRevision = db
      .prepare("SELECT definition_revision FROM executions WHERE id = ?")
      .get(second.executionId) as { definition_revision: string };
    // Same node definition revision — the retry reuses the frozen snapshot,
    // never an implicitly swapped Profile (A34).
    expect(retriedRevision.definition_revision).toBe(firstRevision.definition_revision);
  });
});

describe("M4-04: run budgets in the dispatch path", () => {
  it("enrolls a budget once and pauses the run when the execution budget is exhausted", async () => {
    const { db } = createBudgetAwareFileDb("budget-dispatch");
    await seedSingleRun(db, "run-1", ["n1", "n2"]);
    const tick = makeClock();

    ensureRunBudget(db, {
      runId: "run-1",
      limits: { maxNodes: 8, maxExecutions: 1, maxDurationMs: 3_600_000, undeterminedUsageLimit: 4 },
      now: tick()
    });
    expectError(
      () =>
        ensureRunBudget(db, {
          runId: "run-1",
          limits: { maxNodes: 8, maxExecutions: 99, maxDurationMs: 3_600_000, undeterminedUsageLimit: 4 },
          now: tick()
        }),
      BudgetAlreadyEnrolledError
    );

    // ONE poll, two WAITING entries, an execution budget of 1: the first
    // entry claims the budget, the second is blocked IN THE SAME POLL with a
    // budget reason, and the run pauses behind a hold (recorded, never
    // silently dropped).
    enqueueReadyNodes(db, { runId: "run-1", now: tick() });
    const poll = pollQueue(db, pollInput(tick()));
    expect(poll.dispatched).toHaveLength(1);
    expect(poll.blocked).toHaveLength(1);
    expect(poll.blocked[0]).toMatchObject({ kind: "budget", reason: "budget:execution-budget-exhausted" });
    expect(listUnresolvedBudgetHolds(db, "run-1").map((hold) => hold.reason)).toEqual(["execution-budget-exhausted"]);
    expect(getQueueEntry(db, poll.blocked[0]!.entryId)?.state).toBe("GATE_BLOCKED");

    // Nothing is left to dispatch: the blocked entry is terminal at the
    // queue until a human resolves the hold.
    const poll2 = pollQueue(db, pollInput(tick()));
    expect(poll2.dispatched).toHaveLength(0);
    expect(poll2.blocked).toHaveLength(0);
  });

  it("pauses a run whose usage is undeterminable past the threshold, and resumes only on explicit resolution (A37)", async () => {
    const { db } = createBudgetAwareFileDb("budget-usage");
    await seedSingleRun(db, "run-1", ["n1"]);
    const tick = makeClock();

    ensureRunBudget(db, {
      runId: "run-1",
      limits: { maxNodes: 8, maxExecutions: 8, maxDurationMs: 3_600_000, undeterminedUsageLimit: 1 },
      now: tick()
    });

    enqueueReadyNodes(db, { runId: "run-1", now: tick() });
    const poll = pollQueue(db, pollInput(tick()));
    const dispatched = poll.dispatched[0];
    if (!dispatched) throw new Error("test: expected a dispatch");

    // The attempt's usage could not be determined: recorded UNAVAILABLE —
    // never zeros.
    recordUsageUnavailable(db, { executionId: dispatched.executionId, now: tick() });
    expect(getExecutionUsage(db, dispatched.executionId)?.status).toBe("unavailable");

    // The next dispatch crosses the undetermined threshold: blocked + hold.
    markQueueEntryCompleted(db, { entryId: dispatched.entryId, now: tick() });
    releaseExecutionQuotaGrants(db, { executionId: dispatched.executionId, now: tick() });
    db.prepare("UPDATE executions SET phase = 'FAILED' WHERE id = ?").run(dispatched.executionId);
    transitionNodeState(db, { runId: "run-1", nodeId: "n1", to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });
    requeueForRetry(db, { runId: "run-1", nodeId: "n1", failureReasons: ["timeout"], now: tick() });

    const poll2 = pollQueue(db, pollInput(tick()));
    expect(poll2.dispatched).toHaveLength(0);
    expect(poll2.blocked).toHaveLength(1);
    expect(poll2.blocked[0]).toMatchObject({ kind: "budget", reason: "budget:usage-undetermined" });
    expect(listUnresolvedBudgetHolds(db, "run-1").map((hold) => hold.reason)).toEqual(["usage-undetermined"]);

    // The run is now held: enqueue refuses too (the M4-04 强制点), until the
    // user resolves the hold.
    expectError(() => enqueueReadyNodes(db, { runId: "run-1", now: tick() }), RunHeldError);
    resolveBudgetRunHold(db, {
      runId: "run-1",
      reason: "usage-undetermined",
      note: "user accepts unknown cost; usage stays unavailable in every display",
      now: tick()
    });
    const poll3 = pollQueue(db, pollInput(tick()));
    expect(poll3.dispatched).toHaveLength(1);
    expect(poll3.blocked).toHaveLength(0);
  });

  it("leaves unenrolled runs on the attempt cap only, and reads the gate as managed-and-allowed", async () => {
    const { db } = createBudgetAwareFileDb("budget-unenrolled");
    await seedSingleRun(db, "run-1", ["n1"]);
    const tick = makeClock();

    expect(evaluateDispatchBudgetGate(db, { runId: "run-1", attempt: 1, now: tick() })).toEqual({
      managed: true,
      allowed: true
    });

    enqueueReadyNodes(db, { runId: "run-1", now: tick() });
    const poll = pollQueue(db, pollInput(tick()));
    expect(poll.dispatched).toHaveLength(1);
    expect(poll.blocked).toHaveLength(0);
    expect(listUnresolvedBudgetHolds(db, "run-1")).toEqual([]);

    // A non-scheduling hold (attempts-exhausted) does NOT block enqueue on
    // its own — its enforcement lives in the attempt cap.
    recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "attempts-exhausted",
      detail: { nodeId: "n-other" },
      now: tick()
    });
    expect(() => enqueueReadyNodes(db, { runId: "run-1", now: tick() })).not.toThrow();
  });
});

function dispatchedCount(db: DatabaseSync, runId: string): number {
  return listAttemptsForSlot(db, { runId, nodeId: "n1" }).length;
}
