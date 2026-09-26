import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  BackupError,
  MigrationError,
  INITIAL_SCHEMA_MIGRATION,
  applyMigrations,
  backupDatabase,
  createProject,
  inspectBackupFile,
  openDatabase,
  restoreBackup,
  verifyMigrations
} from "../src/index.js";
import { T0, createMigratedFileDb, expectError } from "./helpers.js";

/**
 * A41 pre-restore verification: a backup file that is truncated, structurally
 * corrupt, tampered, or not from this schema lineage is refused BEFORE any
 * byte is copied, and the live database is left untouched.
 */
describe("restore pre-verification (A41)", () => {
  it("inspects a valid backup: integrity ok + migration records readable", async () => {
    const store = createMigratedFileDb("restore-inspect");
    try {
      createProject(store.db, {
        id: "proj-1",
        repoRoot: "h:/repos/proj-1",
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });
      const backupPath = `${store.dbPath}.backup.db`;
      await backupDatabase(store.db, backupPath);

      const inspection = inspectBackupFile(backupPath);
      expect(inspection.integrity).toBe("ok");
      expect(inspection.bytes).toBeGreaterThan(0);
      expect(inspection.migrationRecords.map((record) => record.version)).toEqual([1]);
    } finally {
      store.close();
    }
  });

  it("refuses a TRUNCATED backup and leaves the live database untouched", async () => {
    const store = createMigratedFileDb("restore-truncated");
    try {
      const { db, dbPath } = store;
      createProject(db, {
        id: "proj-1",
        repoRoot: "h:/repos/proj-1",
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });
      const backupPath = `${dbPath}.backup.db`;
      await backupDatabase(db, backupPath);

      // Truncate to half: structurally broken SQLite.
      const original = readFileSync(backupPath);
      writeFileSync(backupPath, original.subarray(0, Math.floor(original.length / 2)));

      const error = expectError(
        () => restoreBackup({ backupPath, databasePath: dbPath }),
        BackupError
      );
      expect(error.message).toContain("integrity");

      // The refused restore must not have touched the live database.
      expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(1);
      expect(verifyMigrations(db).versions).toEqual([1]);
    } finally {
      store.close();
    }
  });

  it("refuses a zero-byte or non-SQLite backup file", async () => {
    const store = createMigratedFileDb("restore-garbage");
    try {
      const dbPath = store.dbPath;
      const zeroPath = `${dbPath}.zero`;
      writeFileSync(zeroPath, Buffer.alloc(0));
      expectError(() => restoreBackup({ backupPath: zeroPath, databasePath: dbPath }), BackupError);

      const garbagePath = `${dbPath}.garbage`;
      writeFileSync(garbagePath, "this is definitely not a sqlite database".repeat(4), "utf8");
      expectError(
        () => restoreBackup({ backupPath: garbagePath, databasePath: dbPath }),
        BackupError
      );
    } finally {
      store.close();
    }
  });

  it("refuses a TAMPERED backup (schema_migrations rewritten) when expectedMigrations is given", async () => {
    const store = createMigratedFileDb("restore-tampered");
    try {
      const { db, dbPath } = store;
      createProject(db, {
        id: "proj-1",
        repoRoot: "h:/repos/proj-1",
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });
      const backupPath = `${dbPath}.backup.db`;
      await backupDatabase(db, backupPath);

      // Tamper INSIDE the backup: structurally valid SQLite, wrong checksum
      // record — exactly what integrity_check alone cannot see.
      const tamper = new DatabaseSync(backupPath);
      try {
        tamper
          .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
          .run("0".repeat(64));
      } finally {
        tamper.close();
      }

      const error = expectError(
        () => restoreBackup({ backupPath, databasePath: dbPath, expectedMigrations: [INITIAL_SCHEMA_MIGRATION] }),
        MigrationError
      );
      expect(error.kind).toBe("checksum-mismatch");
      expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(1);
    } finally {
      store.close();
    }
  });

  it("refuses a backup from a NEWER schema than the expected list (downgrade guard)", async () => {
    const store = createMigratedFileDb("restore-newer");
    try {
      const { db, dbPath } = store;
      const backupPath = `${dbPath}.backup.db`;
      await backupDatabase(db, backupPath);

      const error = expectError(
        () => restoreBackup({ backupPath, databasePath: dbPath, expectedMigrations: [] }),
        MigrationError
      );
      expect(error.kind).toBe("unknown-applied-version");
    } finally {
      store.close();
    }
  });

  it("restores with expectedMigrations and reports the verified record count", async () => {
    const store = createMigratedFileDb("restore-verified");
    const { db, dbPath } = store;
    createProject(db, {
      id: "proj-1",
      repoRoot: "h:/repos/proj-1",
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    const backupPath = `${dbPath}.backup.db`;
    await backupDatabase(db, backupPath);

    // Damage the live database AFTER the backup (extra project), then restore.
    createProject(db, {
      id: "proj-2",
      repoRoot: "h:/repos/proj-2",
      executionTarget: "linux-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    db.close();

    const restored = restoreBackup({
      backupPath,
      databasePath: dbPath,
      expectedMigrations: [INITIAL_SCHEMA_MIGRATION]
    });
    expect(restored.backupIntegrity).toBe("ok");
    expect(restored.verifiedMigrationCount).toBe(1);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    const reopened = openDatabase(dbPath);
    try {
      expect(reopened.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(1);
      expect(verifyMigrations(reopened, { migrations: [INITIAL_SCHEMA_MIGRATION] }).versions).toEqual([1]);
    } finally {
      reopened.close();
    }
  });

  it("applyMigrations still writes a pre-migration backup when migrations are pending", async () => {
    // Guard the contract the runbook relies on: backupPath fires BEFORE the
    // first pending migration and is a full backup, not a placeholder.
    const store = createMigratedFileDb("restore-runbook-contract");
    try {
      const backupPath = `${store.dbPath}.pre-upgrade.db`;
      const bad = { version: 2, name: "002-bad", upSql: "CREATE TABLE broken (id TEXT PRIMARY KEY STRICT;" };
      await applyMigrations(store.db, {
        now: T0,
        migrations: [INITIAL_SCHEMA_MIGRATION, bad],
        backupPath
      }).catch(() => undefined);
      expect(existsSync(backupPath)).toBe(true);
      const inspection = inspectBackupFile(backupPath);
      expect(inspection.integrity).toBe("ok");
    } finally {
      store.close();
    }
  });
});
