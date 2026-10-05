/**
 * M10-04 — the task_runs.outcome write surface (migration 018) and the
 * aggregation rules the run driver applies, pinned at the store layer:
 *
 *  - setTaskRunOutcome writes each vocabulary value and NULL (in progress),
 *    rejects unknown values and unknown runs (typed NoRowUpdatedError);
 *  - the cancellation rule 取消→CANCELLED+outcome=cancelled: the store write
 *    surface pairs the frozen CANCELLED status with outcome 'cancelled'.
 *    HONEST SCOPE NOTE: no production surface mints a run CANCELLED today
 *    (the only run-status writers are the run driver's PLANNED->RUNNING and
 *    ->READY_FOR_DELIVERY; there is no run-cancel route/UI in v1) — the
 *    pairing is therefore pinned HERE, at the write surface any future
 *    cancel flow must go through.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  createMigratedFileDb,
  expectError,
  type TestDb
} from "./helpers.js";
import {
  applyMigrations,
  createTaskRun,
  getTaskRun,
  NoRowUpdatedError,
  setTaskRunOutcome,
  setTaskRunStatus,
  TASK_RUN_OUTCOME_MIGRATION,
  TaskRunOutcomeSchema
} from "../src/index.js";

const T0 = "2026-09-22T00:00:00.000Z";

describe("task_runs.outcome write surface (M10-04)", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = createMigratedFileDb("task-run-outcome");
    // The outcome column rides migration 018 — apply it over the 001 helper DB.
    await applyMigrations(testDb.db, { now: T0, migrations: [TASK_RUN_OUTCOME_MIGRATION] });
  });

  function seedRun(id: string): void {
    testDb.db
      .prepare("INSERT INTO projects (id, repo_root, execution_target, trust_status, created_at) VALUES (?, ?, 'windows-native', 'requires-user-confirmation', ?)")
      .run(`proj-${id}`, `h:/repos/${id}`, T0);
    createTaskRun(testDb.db, {
      id,
      projectId: `proj-${id}`,
      taskId: `task-${id}`,
      graphRevision: 0,
      configSnapshotHash: "h",
      baseSha: "s",
      now: T0
    });
  }

  it("writes every vocabulary value and resets to NULL (in progress)", () => {
    seedRun("run-out");
    for (const outcome of ["failed", "blocked", "cancelled", "success"] as const) {
      setTaskRunOutcome(testDb.db, { id: "run-out", outcome });
      expect(getTaskRun(testDb.db, "run-out")?.outcome).toBe(outcome);
    }
    setTaskRunOutcome(testDb.db, { id: "run-out", outcome: null });
    expect(getTaskRun(testDb.db, "run-out")?.outcome).toBeNull();
  });

  it("rejects an out-of-vocabulary value and an unknown run (typed, never silent)", () => {
    seedRun("run-guard");
    expect(() =>
      // @ts-expect-error — deliberately out-of-vocabulary at the type level too.
      setTaskRunOutcome(testDb.db, { id: "run-guard", outcome: "bogus" })
    ).toThrowError();
    expect(
      expectError(
        () => setTaskRunOutcome(testDb.db, { id: "run-unknown", outcome: "failed" }),
        NoRowUpdatedError
      )
    ).toBeInstanceOf(NoRowUpdatedError);
  });

  it("pins the cancellation rule: status CANCELLED pairs with outcome 'cancelled'", () => {
    seedRun("run-cancel");
    // The cancel surface's write sequence: the frozen status, then the outcome.
    setTaskRunStatus(testDb.db, { id: "run-cancel", status: "CANCELLED" });
    setTaskRunOutcome(testDb.db, { id: "run-cancel", outcome: "cancelled" });
    const run = getTaskRun(testDb.db, "run-cancel");
    expect(run?.status).toBe("CANCELLED");
    expect(run?.outcome).toBe("cancelled");
  });

  it("the outcome schema accepts exactly the four values plus null", () => {
    expect([...["success", "failed", "cancelled", "blocked"].map((value) =>
      TaskRunOutcomeSchema.safeParse(value).success
    )]).toEqual([true, true, true, true]);
    expect(TaskRunOutcomeSchema.safeParse("bogus").success).toBe(false);
    expect(TaskRunOutcomeSchema.nullable().safeParse(null).success).toBe(true);
  });
});
