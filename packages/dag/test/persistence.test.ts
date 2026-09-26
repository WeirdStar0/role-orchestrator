import { describe, expect, it } from "vitest";
import {
  appliedMigrationRecords,
  applyDagMigrations,
  createRunGraph,
  DAG_MIGRATIONS,
  DuplicateRunNodeError,
  listRunNodes,
  NodeSnapshotIntegrityError,
  TASK_NODES_MIGRATION,
  UnknownRunError,
  verifyMigrations
} from "../src/index.js";
import {
  applyRuntimeProfileMigrations,
  RUNTIME_PROFILE_MIGRATIONS,
  UnknownRunSnapshotError
} from "@role-orchestrator/runtime-profile";
import { MigrationError, openDatabase } from "@role-orchestrator/store";
import {
  createMigratedMemoryDb,
  diamondWorkflow,
  expectError,
  rawWorkflow,
  rawNode,
  seedReadyRun,
  T0
} from "./helpers.js";

describe("migration 003 (task_nodes)", () => {
  it("applies 001+002+003 on a fresh database and verifies cleanly", async () => {
    const db = openDatabase(":memory:");
    try {
      await applyDagMigrations(db, { now: T0 });
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([1, 2, 3]);
      expect(verifyMigrations(db, { migrations: DAG_MIGRATIONS })).toEqual({
        ok: true,
        checked: 3,
        versions: [1, 2, 3]
      });
    } finally {
      db.close();
    }
  });

  it("is idempotent on re-application", async () => {
    const db = createMigratedMemoryDb();
    try {
      const result = await applyDagMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("forward-upgrades a 001+002 database", async () => {
    const db = openDatabase(":memory:");
    try {
      await applyRuntimeProfileMigrations(db, { now: T0 });
      const result = await applyDagMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([3]);
      expect(verifyMigrations(db, { migrations: DAG_MIGRATIONS }).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("the downgrade guard refuses a 003 database for a 001+002-only build", () => {
    const db = createMigratedMemoryDb();
    try {
      expectError(() => verifyMigrations(db, { migrations: RUNTIME_PROFILE_MIGRATIONS }), MigrationError);
    } finally {
      db.close();
    }
  });

  it("the state CHECK pins the eleven documented states", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
              "VALUES ('run-mig', 'x', '1', 'developer', '[]', 'RUN', ?, ?)"
          )
          .run(T0, T0)
      ).toThrowError(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("the role CHECK pins the four built-in roles (A03 at the constraint level)", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
              "VALUES ('run-mig', 'x', '1', 'tester', '[]', 'PENDING', ?, ?)"
          )
          .run(T0, T0)
      ).toThrowError(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("the dependencies snapshot must be a JSON array", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
              "VALUES ('run-mig', 'x', '1', 'developer', '{\"a\":1}', 'PENDING', ?, ?)"
          )
          .run(T0, T0)
      ).toThrowError(/CHECK constraint failed/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
              "VALUES ('run-mig', 'y', '1', 'developer', 'not-json-at-all', 'PENDING', ?, ?)"
          )
          .run(T0, T0)
      ).toThrowError(/malformed JSON|CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("enforces UNIQUE(run_id, node_id) — createRunGraph twice is a typed duplicate", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      createRunGraph(db, { runId: "run-mig", workflow: diamondWorkflow(), now: T0 });
      const error = expectError(
        () => createRunGraph(db, { runId: "run-mig", workflow: diamondWorkflow(), now: T0 }),
        DuplicateRunNodeError
      );
      expect(error.runId).toBe("run-mig");
      // Nothing was partially written by the second attempt.
      expect(listRunNodes(db, "run-mig")).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  it("stores and reads back the frozen dependency snapshot", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      createRunGraph(db, {
        runId: "run-mig",
        workflow: rawWorkflow([
          rawNode({ id: "a", role: "coordinator" }),
          rawNode({ id: "b", role: "developer", dependencies: ["a"] })
        ]),
        definitionRevision: "rev-7",
        now: T0
      });
      const nodeB = listRunNodes(db, "run-mig").find((node) => node.nodeId === "b");
      expect(nodeB?.dependencies).toEqual(["a"]);
      expect(nodeB?.definitionRevision).toBe("rev-7");
      expect(nodeB?.roleId).toBe("developer");
    } finally {
      db.close();
    }
  });

  it("a tampered dependency snapshot is an integrity error, never silently coerced", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      createRunGraph(db, { runId: "run-mig", workflow: diamondWorkflow(), now: T0 });
      // Valid JSON array (passes the SQL CHECK) with non-id elements: the
      // read-side schema check must catch it.
      db.prepare("UPDATE task_nodes SET dependencies = '[1, 2]' WHERE node_id = 'a'").run();
      expectError(() => listRunNodes(db, "run-mig"), NodeSnapshotIntegrityError);
    } finally {
      db.close();
    }
  });

  it("referencing an unknown run is a typed rejection before any write", async () => {
    const db = createMigratedMemoryDb();
    try {
      const error = expectError(
        () => createRunGraph(db, { runId: "run-missing", workflow: diamondWorkflow(), now: T0 }),
        UnknownRunError
      );
      expect(error.runId).toBe("run-missing");
    } finally {
      db.close();
    }
  });

  it("a missing frozen snapshot for a role the plan uses propagates the runtime-profile error", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-mig" });
      db.prepare("DELETE FROM run_profile_snapshots WHERE role_id = 'reviewer'").run();
      expectError(
        () => createRunGraph(db, { runId: "run-mig", workflow: diamondWorkflow(), now: T0 }),
        UnknownRunSnapshotError
      );
      expect(listRunNodes(db, "run-mig")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("the shipped migration definition carries version 3 and a stable name", () => {
    expect(TASK_NODES_MIGRATION.version).toBe(3);
    expect(TASK_NODES_MIGRATION.name).toBe("003-task-nodes");
    expect(DAG_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3]);
  });
});
