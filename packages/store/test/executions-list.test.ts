import { describe, expect, it } from "vitest";
import { createActiveAttempt, createTaskRun, listExecutionsForRun } from "../src/index.js";
import { T0, createMigratedMemoryDb, iso, seedExecution } from "./helpers.js";

// M1-04 read-side extension: the local API needs all attempts of a run in a
// stable order to render run detail. Read-only view primitive; the ordering
// contract is creation time, then id.
describe("listExecutionsForRun", () => {
  it("returns only the executions of the given run, in creation order", () => {
    const db = createMigratedMemoryDb();
    // seedExecution seeds the project + "run-1"; additional runs must reuse
    // the project (repo_root is unique) and add their own task_run + attempt.
    seedExecution(db, { runId: "run-1", executionId: "exec-1", nodeId: "node-1" });
    createActiveAttempt(db, {
      id: "exec-2",
      runId: "run-1",
      nodeId: "node-2",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-2",
      phase: "STARTING",
      now: T0
    });
    createTaskRun(db, {
      id: "run-2",
      projectId: "proj-1",
      taskId: "task-1",
      graphRevision: 0,
      configSnapshotHash: "hash-config-1",
      baseSha: "base-sha-1",
      now: T0
    });
    createActiveAttempt(db, {
      id: "exec-3",
      runId: "run-2",
      nodeId: "node-1",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-3",
      phase: "STARTING",
      now: T0
    });

    expect(listExecutionsForRun(db, "run-1").map((row) => row.id)).toEqual(["exec-1", "exec-2"]);
    expect(listExecutionsForRun(db, "run-2").map((row) => row.id)).toEqual(["exec-3"]);
    expect(listExecutionsForRun(db, "run-unknown")).toEqual([]);
  });

  it("uses creation time first and the id as tiebreaker; rejects malformed ids", () => {
    const db = createMigratedMemoryDb();
    seedExecution(db, { runId: "run-1", executionId: "exec-b", nodeId: "node-1" });
    createActiveAttempt(db, {
      id: "exec-a",
      runId: "run-1",
      nodeId: "node-2",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-a",
      phase: "STARTING",
      now: T0
    });
    // Both rows share the same timestamp, so the id tiebreaker decides.
    expect(listExecutionsForRun(db, "run-1").map((row) => row.id)).toEqual(["exec-a", "exec-b"]);

    const db2 = createMigratedMemoryDb();
    seedExecution(db2, { runId: "run-1", executionId: "exec-b", nodeId: "node-1" });
    createActiveAttempt(db2, {
      id: "exec-a",
      runId: "run-1",
      nodeId: "node-2",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-a",
      phase: "STARTING",
      now: iso(1) // created AFTER exec-b
    });
    expect(listExecutionsForRun(db2, "run-1").map((row) => row.id)).toEqual(["exec-b", "exec-a"]);

    // Id-shape violations never reach SQL.
    expect(() => listExecutionsForRun(db2, "NOT_A_VALID_ID")).toThrow();
  });
});
