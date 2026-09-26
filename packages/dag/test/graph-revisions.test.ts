/**
 * M5-01 dag-layer tests for the graph-revision primitives (A38): the one-time
 * baseline, the optimistic `expectedGraphRevision` lock, the editable-state
 * gate, the A08-before-persist ordering, and the dag layer of the A02
 * three-layer rejection (the strict patch schema + the frozen contracts
 * schema — the layers BEHIND the API/UI refusal).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@role-orchestrator/store";
import {
  DependencyCycleError,
  GRAPH_EDIT_MIGRATIONS,
  GraphRevisionBaselineExistsError,
  GraphRevisionBaselineMismatchError,
  GraphRevisionBaselineMissingError,
  GraphRevisionConflictError,
  NodeNotEditableError,
  PlanRoleResolutionError,
  SelfDependencyError,
  UnknownDependencyError,
  UnknownNodeError,
  UnknownRunError,
  GraphRevisionIntegrityError,
  appliedMigrationRecords,
  applyGraphNodeEdit,
  applyGraphEditMigrations,
  createRunGraph,
  isNodeStructurallyEditable,
  listGraphRevisions,
  recordInitialGraphRevision,
  transitionNodeState
} from "../src/index.js";
import { T0, expectError, rawNode, rawWorkflow, seedReadyRun } from "./helpers.js";

/** A file-backed DB with the graph-edit chain (001+002+003+015). */
function createGraphEditDb(label: string): DatabaseSync {
  const dbPath = makeTempPath(label);
  const db = openDatabase(dbPath);
  void applyGraphEditMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 4 || records[3]?.version !== 15) {
    db.close();
    throw new Error("test helper: graph-edit migrations were not applied");
  }
  return db;
}

function makeTempPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `ro-dag-grev-${label}-`)), "test.db");
}

const THREE_NODE_WORKFLOW = (): unknown =>
  rawWorkflow([
    rawNode({ id: "a", role: "coordinator" }),
    rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
    rawNode({ id: "c", role: "reviewer", dependencies: ["b"] })
  ]);

/** Seed -> createRunGraph -> recordInitialGraphRevision (the edit-enabled setup). */
async function seedEditEnabledRun(db: DatabaseSync, runId: string): Promise<void> {
  await seedReadyRun(db, { runId });
  createRunGraph(db, { runId, workflow: THREE_NODE_WORKFLOW(), now: T0 });
  recordInitialGraphRevision(db, { runId, workflow: THREE_NODE_WORKFLOW(), now: T0 });
}

describe("GRAPH_EDIT_MIGRATIONS (migration 015)", () => {
  it("extends the shipped DAG chain with the revision table, leaving DAG_MIGRATIONS pinned", async () => {
    expect(GRAPH_EDIT_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 15]);
    const db = createGraphEditDb("chain");
    const row = db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'task_graph_revisions'"
    ).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(String(row?.["sql"])).toContain("UNIQUE (run_id, revision)");
    db.close();
  });
});

describe("recordInitialGraphRevision — the one-time baseline", () => {
  it("records the initial workflow at the run's current revision", async () => {
    const db = createGraphEditDb("baseline-ok");
    await seedEditEnabledRun(db, "run-1");
    const rows = listGraphRevisions(db, "run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "run-1", revision: 0, source: "initial" });
    expect(rows[0]?.workflow.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(rows[0]?.workflow.nodes.find((node) => node.id === "b")?.objective).toBe("objective-b");
    db.close();
  });

  it("refuses a mismatching workflow BEFORE the baseline exists, then refuses a second one", async () => {
    const db = createGraphEditDb("baseline-bad");
    await seedReadyRun(db, { runId: "run-1" });
    createRunGraph(db, { runId: "run-1", workflow: THREE_NODE_WORKFLOW(), now: T0 });

    // Same node count, different role — the live rows do not match.
    const swapped = rawWorkflow([
      rawNode({ id: "a", role: "coordinator" }),
      rawNode({ id: "b", role: "reviewer", dependencies: ["a"] }),
      rawNode({ id: "c", role: "reviewer", dependencies: ["b"] })
    ]);
    expectError(() => recordInitialGraphRevision(db, { runId: "run-1", workflow: swapped, now: T0 }), GraphRevisionBaselineMismatchError);

    // Extra node in the workflow — node-count mismatch (`d` has no row).
    const extra = rawWorkflow([
      rawNode({ id: "a", role: "coordinator" }),
      rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
      rawNode({ id: "c", role: "reviewer", dependencies: ["b"] }),
      rawNode({ id: "d", role: "reviewer", dependencies: ["c"] })
    ]);
    expectError(() => recordInitialGraphRevision(db, { runId: "run-1", workflow: extra, now: T0 }), GraphRevisionBaselineMismatchError);
    expect(listGraphRevisions(db, "run-1")).toHaveLength(0);

    // Now the honest baseline lands, and a second attempt is refused.
    recordInitialGraphRevision(db, { runId: "run-1", workflow: THREE_NODE_WORKFLOW(), now: T0 });
    expectError(() => recordInitialGraphRevision(db, { runId: "run-1", workflow: THREE_NODE_WORKFLOW(), now: T0 }), GraphRevisionBaselineExistsError);
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);

    expectError(() => recordInitialGraphRevision(db, { runId: "run-missing", workflow: THREE_NODE_WORKFLOW(), now: T0 }), UnknownRunError);
    db.close();
  });

  it("refuses an invalid graph (A08) without writing a baseline", async () => {
    const db = createGraphEditDb("baseline-a08");
    await seedReadyRun(db, { runId: "run-1" });
    createRunGraph(db, { runId: "run-1", workflow: THREE_NODE_WORKFLOW(), now: T0 });
    const cyclic = rawWorkflow([
      rawNode({ id: "a", role: "coordinator", dependencies: ["c"] }),
      rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
      rawNode({ id: "c", role: "reviewer", dependencies: ["b"] })
    ]);
    expectError(() => recordInitialGraphRevision(db, { runId: "run-1", workflow: cyclic, now: T0 }), DependencyCycleError);
    expect(listGraphRevisions(db, "run-1")).toHaveLength(0);
    db.close();
  });
});

describe("applyGraphNodeEdit — success and the guarded state effects", () => {
  it("applies the patch, bumps the revision and appends (never rewrites) history", async () => {
    const db = createGraphEditDb("edit-ok");
    await seedEditEnabledRun(db, "run-1");
    const result = applyGraphNodeEdit(db, {
      runId: "run-1",
      nodeId: "c",
      expectedGraphRevision: 0,
      patch: { role: "architect", objective: "复审架构", dependencies: ["a"] },
      now: T0
    });
    expect(result.revision).toBe(1);
    expect(result.node).toMatchObject({ nodeId: "c", roleId: "architect", state: "PENDING" });
    expect(result.node.dependencies).toEqual(["a"]);
    expect(result.node.definitionRevision).toBe("1");
    const rows = listGraphRevisions(db, "run-1");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.source).toBe("ui-node-edit");
    expect(rows[1]?.workflow.nodes.find((node) => node.id === "c")).toMatchObject({
      role: "architect",
      objective: "复审架构",
      dependencies: ["a"]
    });
    // The baseline is untouched.
    expect(rows[0]?.workflow.nodes.find((node) => node.id === "c")?.role).toBe("reviewer");
    // No execution was created by the edit.
    const executions = db.prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = 'run-1'").get() as Record<string, unknown>;
    expect(Number(executions["n"])).toBe(0);
    db.close();
  });

  it("re-propagates blocked/ready after the edit through the legal state machine", async () => {
    const db = createGraphEditDb("edit-propagate");
    await seedEditEnabledRun(db, "run-1");
    // a finishes; then c is re-pointed at a — the edit's propagation makes the
    // PENDING node READY within the same transaction.
    transitionNodeState(db, { runId: "run-1", nodeId: "a", to: "RUNNING", now: T0 });
    transitionNodeState(db, { runId: "run-1", nodeId: "a", to: "SUCCEEDED", now: T0 });
    const result = applyGraphNodeEdit(db, {
      runId: "run-1",
      nodeId: "c",
      expectedGraphRevision: 0,
      patch: { dependencies: ["a"] },
      now: T0
    });
    // BOTH now-satisfied nodes go READY in one topological pass: b (whose dep
    // a finished) and c (just re-pointed at a). c's own edit does not bypass
    // the state machine — its READY arrives from the propagation.
    expect(result.transitions).toEqual([
      { nodeId: "b", from: "PENDING", to: "READY" },
      { nodeId: "c", from: "PENDING", to: "READY" }
    ]);
    expect(result.node.state).toBe("READY");
    db.close();
  });
});

describe("applyGraphNodeEdit — typed refusals before any write", () => {
  it("refuses a stale expectedGraphRevision (A38 optimistic lock)", async () => {
    const db = createGraphEditDb("edit-conflict");
    await seedEditEnabledRun(db, "run-1");
    const error = expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "c",
          expectedGraphRevision: 9,
          patch: { objective: "stale" },
          now: T0
        }),
      GraphRevisionConflictError
    );
    expect(error.expected).toBe(9);
    expect(error.current).toBe(0);
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });

  it("refuses running/finished nodes (A38 前半) and unknown nodes", async () => {
    const db = createGraphEditDb("edit-states");
    await seedEditEnabledRun(db, "run-1");
    transitionNodeState(db, { runId: "run-1", nodeId: "a", to: "RUNNING", now: T0 });
    const running = expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "a",
          expectedGraphRevision: 0,
          patch: { objective: "in-flight" },
          now: T0
        }),
      NodeNotEditableError
    );
    expect(running.state).toBe("RUNNING");
    transitionNodeState(db, { runId: "run-1", nodeId: "a", to: "SUCCEEDED", now: T0 });
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "a",
          expectedGraphRevision: 0,
          patch: { objective: "after the fact" },
          now: T0
        }),
      NodeNotEditableError
    );
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "ghost",
          expectedGraphRevision: 0,
          patch: { objective: "x" },
          now: T0
        }),
      UnknownNodeError
    );
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });

  it("refuses cycle / self-dependency / missing dependency BEFORE persisting (A08)", async () => {
    const db = createGraphEditDb("edit-a08");
    await seedEditEnabledRun(db, "run-1");

    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "b",
          expectedGraphRevision: 0,
          patch: { dependencies: ["c"] },
          now: T0
        }),
      DependencyCycleError
    );
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "b",
          expectedGraphRevision: 0,
          patch: { dependencies: ["b"] },
          now: T0
        }),
      SelfDependencyError
    );
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "c",
          expectedGraphRevision: 0,
          patch: { dependencies: ["ghost"] },
          now: T0
        }),
      UnknownDependencyError
    );
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });

  it("refuses edits without a recorded baseline", async () => {
    const db = createGraphEditDb("edit-nobaseline");
    await seedReadyRun(db, { runId: "run-1" });
    createRunGraph(db, { runId: "run-1", workflow: THREE_NODE_WORKFLOW(), now: T0 });
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "a",
          expectedGraphRevision: 0,
          patch: { objective: "x" },
          now: T0
        }),
      GraphRevisionBaselineMissingError
    );
    db.close();
  });

  it("refuses a role the run's FROZEN snapshots cannot resolve (A34, wrapped typed)", async () => {
    const db = createGraphEditDb("edit-role");
    await seedEditEnabledRun(db, "run-1");
    // Remove the architect snapshot the run was created with — simulates a
    // run whose frozen set never pinned the target role.
    db.prepare("DELETE FROM run_profile_snapshots WHERE run_id = 'run-1' AND role_id = 'architect'").run();
    const error = expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "b",
          expectedGraphRevision: 0,
          patch: { role: "architect" },
          now: T0
        }),
      PlanRoleResolutionError
    );
    expect(error.kind).toBe("missing");
    expect(error.roleId).toBe("architect");
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });
});

describe("A02 layer 3 — the dag schemas themselves refuse override carriers", () => {
  it("the strict patch schema rejects model/profile fields", async () => {
    const db = createGraphEditDb("edit-a02");
    await seedEditEnabledRun(db, "run-1");
    for (const key of ["model", "modelId", "profile", "profileId", "profiles", "fallbackProfileId"]) {
      expect(() =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "c",
          expectedGraphRevision: 0,
          patch: { [key]: "override" } as never,
          now: T0
        })
      ).toThrow(/unrecognized|invalid/i);
    }
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });

  it("a revision row carrying an override field is refused at READ time (never flows anywhere)", async () => {
    const db = createGraphEditDb("edit-a02-deep");
    await seedEditEnabledRun(db, "run-1");
    // Simulate a tampered baseline row that carries a model field on a node.
    const tampered = JSON.parse(String(
      (db.prepare("SELECT workflow FROM task_graph_revisions WHERE run_id = 'run-1' AND revision = 0").get() as Record<string, unknown>)["workflow"]
    )) as { nodes: Record<string, unknown>[] };
    (tampered.nodes[0] as Record<string, unknown>)["model"] = "claude-opus-4-6";
    db.prepare("UPDATE task_graph_revisions SET workflow = ? WHERE run_id = 'run-1' AND revision = 0").run(
      JSON.stringify(tampered)
    );
    // The read path itself refuses: the strict frozen schema is the gate, so
    // an override carrier can never even be read back, let alone edited on.
    expect(() => listGraphRevisions(db, "run-1")).toThrow(GraphRevisionIntegrityError);
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "c",
          expectedGraphRevision: 0,
          patch: { objective: "x" },
          now: T0
        }),
      GraphRevisionIntegrityError
    );
    db.close();
  });

  it("a schema-valid but cyclic tampered baseline is refused by A08 BEFORE the write", async () => {
    const db = createGraphEditDb("edit-a08-deep");
    await seedEditEnabledRun(db, "run-1");
    // The stored workflow re-parses cleanly (schema-valid) but closing b -> c
    // while c -> b must fail the A08 re-validation before any row is written.
    const tampered = JSON.parse(String(
      (db.prepare("SELECT workflow FROM task_graph_revisions WHERE run_id = 'run-1' AND revision = 0").get() as Record<string, unknown>)["workflow"]
    )) as { nodes: { id: string; dependencies: string[] }[] };
    (tampered.nodes.find((node) => node.id === "b") ?? { dependencies: [] }).dependencies = ["c"];
    db.prepare("UPDATE task_graph_revisions SET workflow = ? WHERE run_id = 'run-1' AND revision = 0").run(
      JSON.stringify(tampered)
    );
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1); // read is fine
    expectError(
      () =>
        applyGraphNodeEdit(db, {
          runId: "run-1",
          nodeId: "a",
          expectedGraphRevision: 0,
          patch: { objective: "x" },
          now: T0
        }),
      DependencyCycleError
    );
    // Nothing was written: still exactly the (tampered) baseline row.
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });
});

describe("isNodeStructurallyEditable — the exact A38 editable vocabulary", () => {
  it("accepts exactly PENDING/READY/BLOCKED", () => {
    expect(isNodeStructurallyEditable("PENDING")).toBe(true);
    expect(isNodeStructurallyEditable("READY")).toBe(true);
    expect(isNodeStructurallyEditable("BLOCKED")).toBe(true);
    for (const state of [
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "WAITING_APPROVAL",
      "INTERRUPTED",
      "CANCELLED",
      "RETRY_PENDING",
      "RECOVERY_REQUIRED"
    ] as const) {
      expect(isNodeStructurallyEditable(state)).toBe(false);
    }
  });
});
