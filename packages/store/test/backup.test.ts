import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BackupError,
  INITIAL_SCHEMA_MIGRATION,
  applyMigrations,
  backupDatabase,
  createProject,
  createTaskRun,
  openDatabase,
  restoreBackup,
  verifyMigrations,
  withTransaction
} from "../src/index.js";
import { T0, createMigratedFileDb, type TestDb } from "./helpers.js";

describe("backup/restore (A41 foundation)", () => {
  it("backs up a WAL database checkpoint-then-copy and the copy round-trips", async () => {
    const store = createMigratedFileDb("backup-roundtrip");
    try {
      const { db, dbPath } = store;
      const backupPath = `${dbPath}.backup.db`;
      createProject(db, {
        id: "proj-1",
        repoRoot: "h:/repos/proj-1",
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });

      const result = await backupDatabase(db, backupPath);
      expect(result.integrity).toBe("ok");
      expect(result.checkpoint?.busy).toBe(0);
      expect(result.bytes).toBeGreaterThan(0);

      // WAL checkpoint left the live sidecar truncated (0 bytes), which is
      // what makes the plain file copy self-contained. Checked immediately:
      // later writes legitimately add new frames.
      const walPath = `${dbPath}-wal`;
      if (existsSync(walPath)) {
        expect(statSync(walPath).size).toBe(0);
      }

      // Writes after the backup must not leak into the snapshot.
      createTaskRun(db, {
        id: "run-after-backup",
        projectId: "proj-1",
        taskId: "task-1",
        graphRevision: 0,
        configSnapshotHash: "h",
        baseSha: "s",
        now: T0
      });

      const backup = openDatabase(backupPath);
      try {
        expect(backup.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        expect(backup.prepare("SELECT COUNT(*) AS n FROM task_runs").get()?.n).toBe(0);
        const project = backup.prepare("SELECT id, repo_root FROM projects").get();
        expect(project?.id).toBe("proj-1");
        expect(project?.repo_root).toBe("h:/repos/proj-1");
      } finally {
        backup.close();
      }
    } finally {
      store.close();
    }
  });

  it("refuses to back up in-memory databases and open transactions", async () => {
    const mem = openDatabase(":memory:");
    try {
      await expect(backupDatabase(mem, "unused-path.db")).rejects.toThrowError(BackupError);
    } finally {
      mem.close();
    }

    const store: TestDb = createMigratedFileDb("backup-tx");
    try {
      await expect(
        withTransaction(store.db, () => backupDatabase(store.db, `${store.dbPath}.bak`))
      ).rejects.toThrowError(BackupError);
    } finally {
      store.close();
    }
  });

  it("restore rolls the live database back to the backup state", async () => {
    const store = createMigratedFileDb("backup-restore");
    const backupPath = `${store.dbPath}.backup.db`;
    const { db, dbPath } = store;
    createProject(db, {
      id: "proj-1",
      repoRoot: "h:/repos/proj-1",
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    await backupDatabase(db, backupPath);

    // Post-backup damage on the live database.
    createProject(db, {
      id: "proj-2",
      repoRoot: "h:/repos/proj-2",
      executionTarget: "linux-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    db.close();

    const restored = restoreBackup({ backupPath, databasePath: dbPath });
    expect(restored.bytes).toBeGreaterThan(0);

    const reopened = openDatabase(dbPath);
    try {
      expect(reopened.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      const projects = reopened
        .prepare("SELECT id FROM projects ORDER BY id")
        .all()
        .map((row) => String(row.id));
      expect(projects).toEqual(["proj-1"]);
      expect(verifyMigrations(reopened).versions).toEqual([1]);
    } finally {
      reopened.close();
    }
  });

  it("refuses restores with missing backups or identical paths", () => {
    const store = createMigratedFileDb("backup-guard");
    try {
      expect(() =>
        restoreBackup({ backupPath: `${store.dbPath}.does-not-exist`, databasePath: store.dbPath })
      ).toThrowError(BackupError);
      expect(() =>
        restoreBackup({ backupPath: store.dbPath, databasePath: store.dbPath })
      ).toThrowError(BackupError);
    } finally {
      store.close();
    }
  });

  it("applyMigrations honors backupPath and the backup holds pre-migration data", async () => {
    const store = createMigratedFileDb("backup-migrate");
    try {
      const { db, dbPath } = store;
      applyMigrations(db, { now: T0 });
      createProject(db, {
        id: "proj-1",
        repoRoot: "h:/repos/proj-1",
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });

      const backupPath = `${dbPath}.pre-migration.db`;
      const migration2 = {
        version: 2,
        name: "002-test-extra",
        upSql: "CREATE TABLE test_extra (id TEXT PRIMARY KEY) STRICT;"
      };
      const result = await applyMigrations(db, {
        now: T0,
        migrations: [INITIAL_SCHEMA_MIGRATION, migration2],
        backupPath
      });
      // Migration 1 is already applied so only 2 runs — but the backup was
      // still written first because at least one migration was pending.
      expect(result.appliedVersions).toEqual([2]);
      expect(result.backupPath).toBe(backupPath);
      expect(existsSync(backupPath)).toBe(true);

      const backup = openDatabase(backupPath);
      try {
        expect(backup.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(1);
      } finally {
        backup.close();
      }
    } finally {
      store.close();
    }
  });
});
