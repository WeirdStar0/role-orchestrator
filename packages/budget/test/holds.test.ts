/**
 * `budget_run_holds` (migration 014): a repeated pause absorbs into the SAME
 * row, only the explicit human resolution writes resolution evidence, and
 * only the usage-undetermined hold blocks run scheduling — the other holds
 * are traceability for their own cap checks.
 */
import { describe, expect, it } from "vitest";
import {
  BudgetRowIntegrityError,
  UnknownBudgetHoldError,
  isRunSchedulingBlocked,
  listUnresolvedBudgetHolds,
  recordBudgetRunHold,
  resolveBudgetRunHold
} from "../src/index.js";
import { createBudgetDb, createCoreOnlyDb, expectError, seedRunOnly } from "./helpers.js";

describe("budget run holds", () => {
  it("absorbs repeated pauses into the same (run, reason) row", () => {
    const { db } = createBudgetDb("holds-absorb");
    seedRunOnly(db, "run-1");
    const first = recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "attempts-exhausted",
      detail: { nodeId: "node-1", attempts: 3 },
      now: "2026-09-22T00:00:01.000Z"
    });
    const second = recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "attempts-exhausted",
      detail: { nodeId: "node-1", attempts: 3, repeat: true },
      now: "2026-09-22T00:00:02.000Z"
    });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe("2026-09-22T00:00:01.000Z");
    expect(listUnresolvedBudgetHolds(db, "run-1")).toHaveLength(1);
  });

  it("only the usage-undetermined hold blocks run scheduling", () => {
    const { db } = createBudgetDb("holds-blocking");
    seedRunOnly(db, "run-1");
    recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "execution-budget-exhausted",
      detail: { used: 96 },
      now: "2026-09-22T00:00:01.000Z"
    });
    // Its enforcement lives in the budget check itself, not in the hold.
    expect(isRunSchedulingBlocked(db, "run-1")).toBe(false);
    recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "usage-undetermined",
      detail: { unavailable: 3 },
      now: "2026-09-22T00:00:02.000Z"
    });
    expect(isRunSchedulingBlocked(db, "run-1")).toBe(true);
    expect(listUnresolvedBudgetHolds(db, "run-1")).toHaveLength(2);

    // Resolving the blocking hold lifts the scheduling pause; the ceiling
    // hold stays unresolved (its cap still gates every dispatch).
    const resolved = resolveBudgetRunHold(db, {
      runId: "run-1",
      reason: "usage-undetermined",
      note: "user accepts unknown cost; usage remains displayed as unavailable",
      now: "2026-09-22T00:00:03.000Z"
    });
    expect(resolved.resolvedAt).toBe("2026-09-22T00:00:03.000Z");
    expect(resolved.resolutionNote).toContain("user accepts unknown cost");
    expect(isRunSchedulingBlocked(db, "run-1")).toBe(false);
    expect(listUnresolvedBudgetHolds(db, "run-1")).toHaveLength(1);
  });

  it("resolution is single-shot and typed on unknown holds", () => {
    const { db } = createBudgetDb("holds-resolve");
    seedRunOnly(db, "run-1");
    expectError(
      () => resolveBudgetRunHold(db, { runId: "run-1", reason: "usage-undetermined", note: "nothing", now: "2026-09-22T00:00:01.000Z" }),
      UnknownBudgetHoldError
    );
    recordBudgetRunHold(db, {
      runId: "run-1",
      reason: "usage-undetermined",
      detail: {},
      now: "2026-09-22T00:00:01.000Z"
    });
    resolveBudgetRunHold(db, { runId: "run-1", reason: "usage-undetermined", note: "accepted", now: "2026-09-22T00:00:02.000Z" });
    // A second resolution has nothing left to resolve.
    expectError(
      () => resolveBudgetRunHold(db, { runId: "run-1", reason: "usage-undetermined", note: "again", now: "2026-09-22T00:00:03.000Z" }),
      UnknownBudgetHoldError
    );
  });

  it("rejects malformed input and fails closed on tampered rows", () => {
    const { db } = createBudgetDb("holds-strict");
    seedRunOnly(db, "run-1");
    expect(() =>
      recordBudgetRunHold(db, {
        runId: "run-1",
        reason: "made-up-reason" as never,
        detail: {},
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    expect(() =>
      recordBudgetRunHold(db, {
        runId: "run-1",
        reason: "usage-undetermined",
        detail: { nested: { too: "deep" } } as never,
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    recordBudgetRunHold(db, { runId: "run-1", reason: "usage-undetermined", detail: { a: 1 }, now: "2026-09-22T00:00:01.000Z" });
    db.prepare("UPDATE budget_run_holds SET detail = '{\"nested\":{\"too\":\"deep\"}}' WHERE run_id = 'run-1'").run();
    expectError(() => listUnresolvedBudgetHolds(db, "run-1"), BudgetRowIntegrityError);
  });

  it("is inert on a database without migration 014", () => {
    const { db } = createCoreOnlyDb("holds-absent");
    expect(listUnresolvedBudgetHolds(db, "run-1")).toEqual([]);
    expect(isRunSchedulingBlocked(db, "run-1")).toBe(false);
  });
});
