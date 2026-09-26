import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import { DEFAULT_MIGRATIONS, MigrationError, openDatabase, verifyMigrations } from "@role-orchestrator/store";
import {
  applyRuntimeProfileMigrations,
  appliedMigrationRecords,
  initializeProjectRoleBindings,
  listRoleBindings,
  PROFILE_SCHEMA_MIGRATION,
  RUNTIME_PROFILE_MIGRATIONS
} from "../src/index.js";
import { createMigratedFileDb, createMigratedMemoryDb, T0 } from "./helpers.js";

describe("migration 0002 (profiles and role bindings)", () => {
  it("applies 001+002 on a fresh database and verifies cleanly", async () => {
    const { db, close } = createMigratedFileDb("mig-fresh");
    try {
      const records = appliedMigrationRecords(db);
      expect(records.map((r) => r.version)).toEqual([1, 2]);
      expect(records[1]?.name).toBe(PROFILE_SCHEMA_MIGRATION.name);
      expect(verifyMigrations(db, { migrations: RUNTIME_PROFILE_MIGRATIONS })).toEqual({
        ok: true,
        checked: 2,
        versions: [1, 2]
      });
    } finally {
      close();
    }
  });

  it("re-application is a no-op (idempotent)", async () => {
    const { db, close } = createMigratedFileDb("mig-reapply");
    try {
      const result = await applyRuntimeProfileMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([]);
      expect(result.backupPath).toBeNull();
    } finally {
      close();
    }
  });

  it("a store-only build (DEFAULT_MIGRATIONS) refuses a profile-migrated database (downgrade guard)", () => {
    const db = createMigratedMemoryDb();
    expect(() => verifyMigrations(db, { migrations: DEFAULT_MIGRATIONS })).toThrowError(MigrationError);
  });
});

describe("migration 0002 constraint-level guarantees", () => {
  function seedProject(db: DatabaseSync): void {
    db.prepare(
      "INSERT INTO projects(id, repo_root, execution_target, trust_status, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("proj-c", "h:/repos/c", "windows-native", "requires-user-confirmation", T0);
    initializeProjectRoleBindings(db, { projectId: "proj-c", now: T0 });
  }

  it("rejects an unknown role id via CHECK (A03)", () => {
    const db = createMigratedMemoryDb();
    seedProject(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO role_bindings(project_id, role_id, profile_id, profile_revision, permissions_revision, can_create_subtasks, created_at, updated_at) " +
            "VALUES ('proj-c', 'tester', NULL, NULL, '0', 0, ?, ?)"
        )
        .run(T0, T0)
    ).toThrowError(/CHECK constraint failed/);
  });

  it("enforces UNIQUE(project_id, role_id) (A01 at the constraint level)", () => {
    const db = createMigratedMemoryDb();
    seedProject(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO role_bindings(project_id, role_id, profile_id, profile_revision, permissions_revision, can_create_subtasks, created_at, updated_at) " +
            "VALUES ('proj-c', 'coordinator', NULL, NULL, '0', 0, ?, ?)"
        )
        .run(T0, T0)
    ).toThrowError(/UNIQUE constraint failed: role_bindings\.project_id, role_bindings\.role_id/);
  });

  it("rejects a half-set binding (profile without revision) via CHECK", () => {
    const db = createMigratedMemoryDb();
    seedProject(db);
    expect(() =>
      db
        .prepare(
          "UPDATE role_bindings SET profile_id = 'ghost', profile_revision = NULL WHERE project_id = 'proj-c' AND role_id = 'coordinator'"
        )
        .run()
    ).toThrowError(/CHECK constraint failed/);
  });

  it("rejects a binding pointing at a non-existent profile revision via composite FK", () => {
    const db = createMigratedMemoryDb();
    seedProject(db);
    expect(() =>
      db
        .prepare(
          "UPDATE role_bindings SET profile_id = 'ghost', profile_revision = 1 WHERE project_id = 'proj-c' AND role_id = 'coordinator'"
        )
        .run()
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it("initializes exactly four rows, one per built-in role", () => {
    const db = createMigratedMemoryDb();
    seedProject(db);
    const bindings = listRoleBindings(db, "proj-c");
    // listRoleBindings orders by role_id ASC (alphabetical).
    expect(bindings.map((b) => b.roleId)).toEqual([...ROLE_IDS].sort());
    expect(bindings.every((b) => b.profileId === null && b.profileRevision === null)).toBe(true);
  });

  it("run_profile_snapshots enforces UNIQUE(run_id, role_id)", async () => {
    const db = createMigratedMemoryDb();
    seedProject(db);
    // Minimal profile+revision+run rows for the FKs.
    db.prepare(
      "INSERT INTO profiles(id, runtime, executable, execution_target, config_dir, credential_group, max_concurrency, timeout_seconds, created_at) " +
        "VALUES ('p1', 'claude', 'claude.cmd', 'windows-native', 'C:/cfg', 'personal', 2, 600, ?)"
    ).run(T0);
    db.prepare(
      "INSERT INTO profile_revisions(profile_id, revision, model, external_config_hash, external_config_files, config_hash, created_at) " +
        "VALUES ('p1', 1, NULL, ?, '[]', ?, ?)"
    ).run("a".repeat(64), "b".repeat(64), T0);
    db.prepare(
      "INSERT INTO task_runs(id, project_id, task_id, graph_revision, config_snapshot_hash, base_sha, status, created_at) " +
        "VALUES ('run-x', 'proj-c', 'task-1', 0, 'cfg-hash', 'base', 'PLANNED', ?)"
    ).run(T0);
    const insert = db.prepare(
      "INSERT INTO run_profile_snapshots(run_id, role_id, profile_id, profile_revision, snapshot_json, snapshot_hash, created_at) " +
        "VALUES ('run-x', 'coordinator', 'p1', 1, '{}', 'h', ?)"
    );
    insert.run(T0);
    expect(() => insert.run(T0)).toThrowError(
      /UNIQUE constraint failed: run_profile_snapshots\.run_id, run_profile_snapshots\.role_id/
    );
    // And a snapshot pointing at a missing revision is refused by the FK:
    expect(() =>
      db
        .prepare(
          "INSERT INTO run_profile_snapshots(run_id, role_id, profile_id, profile_revision, snapshot_json, snapshot_hash, created_at) " +
            "VALUES ('run-x', 'architect', 'p1', 99, '{}', 'h', ?)"
        )
        .run(T0)
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it("profile_revisions enforces UNIQUE(profile_id, revision) (immutability at the constraint level)", () => {
    const db = createMigratedMemoryDb();
    db.prepare(
      "INSERT INTO profiles(id, runtime, executable, execution_target, config_dir, credential_group, max_concurrency, timeout_seconds, created_at) " +
        "VALUES ('p1', 'claude', 'claude.cmd', 'windows-native', 'C:/cfg', 'personal', 2, 600, ?)"
    ).run(T0);
    const insert = db.prepare(
      "INSERT INTO profile_revisions(profile_id, revision, model, external_config_hash, external_config_files, config_hash, created_at) " +
        "VALUES ('p1', 1, NULL, ?, '[]', ?, ?)"
    );
    insert.run("a".repeat(64), "b".repeat(64), T0);
    expect(() => insert.run("a".repeat(64), "b".repeat(64), T0)).toThrowError(
      /UNIQUE constraint failed: profile_revisions\.profile_id, profile_revisions\.revision/
    );
  });

  it("works on a database migrated earlier with store-only DEFAULT_MIGRATIONS (forward upgrade)", async () => {
    const dbPath = createMigratedFileDb("mig-forward-upgrade").dbPath;
    // Simulate an M1-01-era database: only migration 001 applied.
    const db = openDatabase(dbPath);
    try {
      db.exec("DELETE FROM schema_migrations WHERE version = 2");
      db.exec("DROP TABLE run_profile_snapshots");
      db.exec("DROP TABLE role_bindings");
      db.exec("DROP TABLE profile_revisions");
      db.exec("DROP TABLE profiles");
      const result = await applyRuntimeProfileMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([2]);
      expect(verifyMigrations(db, { migrations: RUNTIME_PROFILE_MIGRATIONS }).ok).toBe(true);
    } finally {
      db.close();
    }
  });
});
