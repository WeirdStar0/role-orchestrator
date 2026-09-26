/**
 * M5-02 dag-layer tests: migration 016 (the `task_graph_revisions` rebuild
 * that widens `source` with 'expansion' while preserving every row) and the
 * guarded `recordExpansionGraphRevision` append — optimistic
 * `expectedGraphRevision` lock (A38), append-only history, A08-before-persist.
 * Every assertion runs against a real file-backed database with the full
 * migration chain applied.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, verifyMigrations, getTaskRun } from "@role-orchestrator/store";
import {
  GRAPH_EDIT_MIGRATIONS,
  GRAPH_EXPANSION_MIGRATIONS,
  GRAPH_REVISIONS_EXPANSION_SOURCE_MIGRATION,
  GraphRevisionBaselineMissingError,
  GraphRevisionConflictError,
  UnknownDependencyError,
  UnknownRunError,
  appliedMigrationRecords,
  applyGraphEditMigrations,
  applyGraphExpansionMigrations,
  createRunGraph,
  getLatestGraphRevision,
  listGraphRevisions,
  recordExpansionGraphRevision,
  recordInitialGraphRevision
} from "../src/index.js";
import { T0, expectError, rawNode, rawWorkflow, seedReadyRun } from "./helpers.js";

/** A file-backed DB at the graph-edit chain (001+002+003+015, pre-016). */
function createPreExpansionDb(label: string): DatabaseSync {
  const dbPath = join(mkdtempSync(join(tmpdir(), `ro-dag-xrev-pre-${label}-`)), "test.db");
  const db = openDatabase(dbPath);
  void applyGraphEditMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 4 || records[3]?.version !== 15) {
    db.close();
    throw new Error("test helper: graph-edit migrations were not applied");
  }
  return db;
}

/** A file-backed DB with the expansion-enabled chain (001+002+003+015+016). */
function createGraphEditDb(label: string): DatabaseSync {
  const dbPath = join(mkdtempSync(join(tmpdir(), `ro-dag-xrev-${label}-`)), "test.db");
  const db = openDatabase(dbPath);
  void applyGraphExpansionMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 5 || records[3]?.version !== 15 || records[4]?.version !== 16) {
    db.close();
    throw new Error("test helper: graph-expansion migrations were not applied");
  }
  return db;
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

/** The composed post-expansion workflow: the baseline plus one minted pair. */
const EXPANDED_WORKFLOW = (): unknown =>
  rawWorkflow([
    rawNode({ id: "a", role: "coordinator" }),
    rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
    rawNode({ id: "c", role: "reviewer", dependencies: ["b"] }),
    rawNode({ id: "b-fix-2", role: "developer", dependencies: ["b"] }),
    rawNode({ id: "b-review-2", role: "reviewer", dependencies: ["b-fix-2"] })
  ]);

describe("GRAPH_EXPANSION_MIGRATIONS (migration 016)", () => {
  it("appends the widened-source rebuild to the graph-edit chain, leaving it pinned", () => {
    expect(GRAPH_EDIT_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 15]);
    expect(GRAPH_EXPANSION_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 15, 16]);
    expect(GRAPH_REVISIONS_EXPANSION_SOURCE_MIGRATION.name).toBe("016-graph-revision-expansion-source");
  });

  it("preserves every existing revision row and widens the source vocabulary", async () => {
    const db = createPreExpansionDb("rebuild");
    await seedEditEnabledRun(db, "run-1");
    const before = db
      .prepare("SELECT run_id, revision, source, workflow, created_at FROM task_graph_revisions ORDER BY revision")
      .all() as Record<string, unknown>[];

    const result = await applyGraphExpansionMigrations(db, { now: T0 });
    expect(result.appliedVersions).toEqual([16]);

    // The rows survived the rebuild verbatim.
    const after = db
      .prepare("SELECT run_id, revision, source, workflow, created_at FROM task_graph_revisions ORDER BY revision")
      .all() as Record<string, unknown>[];
    expect(after).toEqual(before);

    // The rebuilt CHECK accepts the 'expansion' source...
    const inserted = db
      .prepare(
        "INSERT INTO task_graph_revisions(run_id, revision, source, workflow, created_at) VALUES (?, ?, 'expansion', ?, ?)"
      )
      .run("run-1", 1, JSON.stringify(THREE_NODE_WORKFLOW()), T0);
    expect(Number(inserted.changes)).toBe(1);
    // ...and still rejects a source outside the widened vocabulary.
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_graph_revisions(run_id, revision, source, workflow, created_at) VALUES (?, ?, 'improvised', ?, ?)"
        )
        .run("run-1", 2, JSON.stringify(THREE_NODE_WORKFLOW()), T0)
    ).toThrow(/CHECK/);
    expect(verifyMigrations(db, { migrations: GRAPH_EXPANSION_MIGRATIONS }).checked).toBe(5);
    db.close();
  });
});

describe("recordExpansionGraphRevision — the guarded append (A38)", () => {
  it("appends an 'expansion' revision row and bumps the revision under the lock", async () => {
    const db = createGraphEditDb("append-ok");
    await seedEditEnabledRun(db, "run-1");

    const recorded = recordExpansionGraphRevision(db, {
      runId: "run-1",
      workflow: EXPANDED_WORKFLOW(),
      expectedGraphRevision: 0,
      now: T0
    });
    expect(recorded.revision).toBe(1);
    expect(recorded.source).toBe("expansion");

    // The live pointer moved; history APPENDED (the baseline row is unchanged).
    expect(getTaskRun(db, "run-1")?.graphRevision).toBe(1);
    const rows = listGraphRevisions(db, "run-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ revision: 0, source: "initial" });
    expect(rows[1]).toMatchObject({ revision: 1, source: "expansion" });
    // The recorded workflow is the FULL post-expansion definition — the
    // property that keeps later ui-node-edits from dropping minted nodes.
    expect(getLatestGraphRevision(db, "run-1")?.workflow.nodes.map((node) => node.id)).toEqual([
      "a", "b", "c", "b-fix-2", "b-review-2"
    ]);
    db.close();
  });

  it("refuses a stale expected revision with the current one and writes nothing (A38)", async () => {
    const db = createGraphEditDb("append-stale");
    await seedEditEnabledRun(db, "run-1");

    const error = expectError(
      () =>
        recordExpansionGraphRevision(db, {
          runId: "run-1",
          workflow: EXPANDED_WORKFLOW(),
          expectedGraphRevision: 5,
          now: T0
        }),
      GraphRevisionConflictError
    );
    expect(error.expected).toBe(5);
    expect(error.current).toBe(0);
    expect(getTaskRun(db, "run-1")?.graphRevision).toBe(0);
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });

  it("refuses an A08-invalid workflow before any write", async () => {
    const db = createGraphEditDb("append-a08");
    await seedEditEnabledRun(db, "run-1");
    const invalid = rawWorkflow([
      rawNode({ id: "a", role: "coordinator" }),
      rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
      rawNode({ id: "c", role: "reviewer", dependencies: ["b"] }),
      rawNode({ id: "x-fix-2", role: "developer", dependencies: ["no-such-node"] })
    ]);

    expectError(
      () =>
        recordExpansionGraphRevision(db, {
          runId: "run-1",
          workflow: invalid,
          expectedGraphRevision: 0,
          now: T0
        }),
      UnknownDependencyError
    );
    expect(getTaskRun(db, "run-1")?.graphRevision).toBe(0);
    expect(listGraphRevisions(db, "run-1")).toHaveLength(1);
    db.close();
  });

  it("refuses a run without a recorded baseline (nothing to append onto)", async () => {
    const db = createGraphEditDb("append-nobaseline");
    await seedReadyRun(db, { runId: "run-2" });
    createRunGraph(db, { runId: "run-2", workflow: THREE_NODE_WORKFLOW(), now: T0 });

    expectError(
      () =>
        recordExpansionGraphRevision(db, {
          runId: "run-2",
          workflow: EXPANDED_WORKFLOW(),
          expectedGraphRevision: 0,
          now: T0
        }),
      GraphRevisionBaselineMissingError
    );
    expect(listGraphRevisions(db, "run-2")).toHaveLength(0);
    db.close();
  });

  it("keeps two appends sequential: each lands on the revision the caller read", async () => {
    const db = createGraphEditDb("append-twice");
    await seedEditEnabledRun(db, "run-1");
    recordExpansionGraphRevision(db, {
      runId: "run-1",
      workflow: EXPANDED_WORKFLOW(),
      expectedGraphRevision: 0,
      now: T0
    });
    // A second expansion composed on top of revision 1 lands at revision 2 —
    // pure appends compose losslessly on top of any newer revision.
    const second = recordExpansionGraphRevision(db, {
      runId: "run-1",
      workflow: EXPANDED_WORKFLOW(),
      expectedGraphRevision: 1,
      now: T0
    });
    expect(second.revision).toBe(2);
    expect(getTaskRun(db, "run-1")?.graphRevision).toBe(2);
    expect(listGraphRevisions(db, "run-1").map((row) => row.source)).toEqual([
      "initial", "expansion", "expansion"
    ]);
    db.close();
  });

  it("refuses an unknown run loudly", async () => {
    const db = createGraphEditDb("append-unknown");
    await seedEditEnabledRun(db, "run-1");
    expectError(
      () =>
        recordExpansionGraphRevision(db, {
          runId: "no-such-run",
          workflow: EXPANDED_WORKFLOW(),
          expectedGraphRevision: 0,
          now: T0
        }),
      UnknownRunError
    );
    db.close();
  });
});
