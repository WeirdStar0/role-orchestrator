/**
 * Run budgets (migration 014): frozen enrollment, the read-only dispatch
 * gate over nodes/executions/duration/undetermined usage, and the atomic
 * consumption that raises `BudgetExceededSignal` (the shape the scheduler's
 * dispatch claim rolls back on).
 */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  BudgetAlreadyEnrolledError,
  BudgetExceededSignal,
  ensureRunBudget,
  evaluateDispatchBudgetGate,
  getRunBudget,
  recordBudgetRunHold,
  recordDispatchConsumption,
  recordUsageUnavailable,
  resolveBudgetRunHold
} from "../src/index.js";
import { createBudgetDb, createCoreOnlyDb, expectError, seedRunOnly, seedSlot } from "./helpers.js";

const SMALL_LIMITS = {
  maxNodes: 2,
  maxExecutions: 3,
  maxDurationMs: 3_600_000,
  undeterminedUsageLimit: 1
};

/** Narrow the gate union to its boolean verdict (tests only). */
function gateAllowed(
  db: DatabaseSync,
  input: { runId: string; attempt: number; now: string }
): boolean {
  const gate = evaluateDispatchBudgetGate(db, input);
  return gate.managed && gate.allowed;
}

describe("run budgets", () => {
  it("enrolls once, freezes limits, and refuses re-enrollment", () => {
    const { db } = createBudgetDb("enroll");
    seedRunOnly(db, "run-1");
    const budget = ensureRunBudget(db, { runId: "run-1", limits: SMALL_LIMITS, now: "2026-09-22T00:00:01.000Z" });
    expect(budget).toMatchObject({
      runId: "run-1",
      maxNodes: 2,
      maxExecutions: 3,
      nodesUsed: 0,
      executionsUsed: 0
    });
    const again = expectError(
      () => ensureRunBudget(db, { runId: "run-1", limits: { ...SMALL_LIMITS, maxExecutions: 999 }, now: "2026-09-22T00:00:02.000Z" }),
      BudgetAlreadyEnrolledError
    );
    expect(again.runId).toBe("run-1");
    // The attempted re-scope changed nothing.
    expect(getRunBudget(db, "run-1")?.maxExecutions).toBe(3);
    expect(getRunBudget(db, "run-unknown")).toBeNull();
  });

  it("treats a database without migration 014 as unmanaged and a 014 database without enrollment as allowed", () => {
    const { db } = createCoreOnlyDb("gate-unmanaged");
    expect(evaluateDispatchBudgetGate(db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:01.000Z" })).toEqual({
      managed: false
    });
    // Consumption without a budget row is a no-op, not a crash.
    expect(() => recordDispatchConsumption(db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:01.000Z" })).not.toThrow();

    const managed = createBudgetDb("gate-unenrolled");
    seedSlot(managed.db, { executionId: "exec-g" });
    expect(evaluateDispatchBudgetGate(managed.db, { runId: "run-exec-g", attempt: 1, now: "2026-09-22T00:00:01.000Z" })).toEqual({
      managed: true,
      allowed: true
    });
  });

  it("blocks the node, execution and duration ceilings with distinct reasons", () => {
    const { db } = createBudgetDb("gate-ceilings");
    seedRunOnly(db, "run-1");
    ensureRunBudget(db, { runId: "run-1", limits: SMALL_LIMITS, now: "2026-09-22T00:00:00.000Z" });

    // Execution ceiling: 3 consumptions land, the 4th signal-fails.
    for (const [index, attempt] of [1, 2, 1].entries()) {
      expect(gateAllowed(db, { runId: "run-1", attempt, now: "2026-09-22T00:00:0" + String(index + 1) + ".000Z" })).toBe(true);
      recordDispatchConsumption(db, { runId: "run-1", attempt, now: "2026-09-22T00:00:0" + String(index + 1) + ".000Z" });
    }
    expect(getRunBudget(db, "run-1")).toMatchObject({ executionsUsed: 3, nodesUsed: 2 });
    const overExecution = expectError(
      () => recordDispatchConsumption(db, { runId: "run-1", attempt: 2, now: "2026-09-22T00:00:10.000Z" }),
      BudgetExceededSignal
    );
    expect(overExecution.reason).toBe("execution-budget-exhausted");
    const gate = evaluateDispatchBudgetGate(db, { runId: "run-1", attempt: 2, now: "2026-09-22T00:00:10.000Z" });
    expect(gate).toMatchObject({ managed: true, allowed: false, reason: "execution-budget-exhausted" });

    // Node ceiling: on a fresh budget, the third node's FIRST attempt is
    // refused (maxNodes = 2).
    const nodeBudgetDb = createBudgetDb("gate-nodes");
    seedRunOnly(nodeBudgetDb.db, "run-1");
    ensureRunBudget(nodeBudgetDb.db, { runId: "run-1", limits: SMALL_LIMITS, now: "2026-09-22T00:00:00.000Z" });
    recordDispatchConsumption(nodeBudgetDb.db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:01.000Z" });
    recordDispatchConsumption(nodeBudgetDb.db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:02.000Z" });
    expect(
      evaluateDispatchBudgetGate(nodeBudgetDb.db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:03.000Z" })
    ).toMatchObject({
      managed: true,
      allowed: false,
      reason: "node-budget-exhausted"
    });

    // Duration ceiling: elapsed since enrollment exceeds maxDurationMs.
    const durationDb = createBudgetDb("gate-duration");
    seedRunOnly(durationDb.db, "run-1");
    ensureRunBudget(durationDb.db, { runId: "run-1", limits: { ...SMALL_LIMITS, maxDurationMs: 5_000 }, now: "2026-09-22T00:00:00.000Z" });
    expect(gateAllowed(durationDb.db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:03.000Z" })).toBe(true);
    expect(
      evaluateDispatchBudgetGate(durationDb.db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:06.000Z" })
    ).toMatchObject({
      managed: true,
      allowed: false,
      reason: "duration-budget-exhausted"
    });
  });

  it("treats undeterminable usage as UNDECIDABLE: pause at the threshold, resume only on human acceptance", () => {
    const { db } = createBudgetDb("gate-usage");
    const seeded = seedSlot(db, { executionId: "exec-u1", runId: "run-1", projectId: "proj-u1" });
    expect(seeded.runId).toBe("run-1");
    ensureRunBudget(db, { runId: "run-1", limits: { ...SMALL_LIMITS, undeterminedUsageLimit: 1 }, now: "2026-09-22T00:00:00.000Z" });

    // Below the threshold the gate is silent.
    expect(gateAllowed(db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:01.000Z" })).toBe(true);

    // One unavailable usage report reaches the limit: the run PAUSES (A37:
    // unknown usage is never priced as 0, and never treated as free-and-
    // continue).
    recordUsageUnavailable(db, { executionId: "exec-u1", now: "2026-09-22T00:00:02.000Z" });
    expect(
      evaluateDispatchBudgetGate(db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:03.000Z" })
    ).toMatchObject({
      managed: true,
      allowed: false,
      reason: "usage-undetermined"
    });

    // The gate is read-only: with NO hold recorded yet there is nothing to
    // resolve (typed refusal).
    expectError(
      () => resolveBudgetRunHold(db, { runId: "run-1", reason: "usage-undetermined", note: "x", now: "2026-09-22T00:00:04.000Z" }),
      Error
    );
    // The scheduler records the hold when it refuses the dispatch; the
    // explicit human resolution of THAT hold is the only exit.
    const hold = recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "usage-undetermined",
      detail: { reason: "1 unavailable usage record reached the limit 1" },
      now: "2026-09-22T00:00:04.000Z"
    });
    expect(
      resolveBudgetRunHold(db, {
        runId: "run-1",
        reason: "usage-undetermined",
        note: "user accepts unknown cost for this run; usage stays displayed as unavailable",
        now: "2026-09-22T00:00:05.000Z"
      }).id
    ).toBe(hold.id);
    expect(gateAllowed(db, { runId: "run-1", attempt: 1, now: "2026-09-22T00:00:06.000Z" })).toBe(true);
  });

  it("refuses malformed limits and unknown fields (strict input)", () => {
    const { db } = createBudgetDb("enroll-strict");
    expect(() =>
      ensureRunBudget(db, {
        runId: "run-1",
        limits: { ...SMALL_LIMITS, maxNodes: 0 },
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    expect(() =>
      ensureRunBudget(db, {
        runId: "run-1",
        limits: SMALL_LIMITS,
        extra: true,
        now: "2026-09-22T00:00:01.000Z"
      } as never)
    ).toThrow();
    expect(() =>
      ensureRunBudget(db, {
        runId: "run-1",
        limits: { ...SMALL_LIMITS, undeterminedUsageLimit: 0 },
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    expect(getRunBudget(db, "run-1")).toBeNull();
  });
});
