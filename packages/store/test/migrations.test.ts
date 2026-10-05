import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MIGRATIONS,
  INITIAL_SCHEMA_MIGRATION,
  TASK_RUN_OUTCOME_MIGRATION,
  MigrationError,
  NoRowUpdatedError,
  appliedMigrationRecords,
  applyMigrations,
  createProject,
  createTaskRun,
  getTaskRun,
  migrationChecksum,
  openDatabase,
  verifyMigrations
} from "../src/index.js";
import {
  T0,
  createMigratedFileDb,
  expectError,
  expectRejection,
  makeTempDbPath,
  type TestDb
} from "./helpers.js";

describe("migration framework", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createMigratedFileDb("migrations");
  });

  it("applies the initial migration once and records a matching checksum", async () => {
    // Fresh database (the shared helper pre-applies migration 001).
    const db = openDatabase(makeTempDbPath("migrations-fresh"));
    try {
      const result = await applyMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([1]);
      expect(result.backupPath).toBeNull();

      const records = appliedMigrationRecords(db);
      expect(records).toHaveLength(1);
      expect(records[0]?.version).toBe(1);
      expect(records[0]?.checksum).toBe(migrationChecksum(INITIAL_SCHEMA_MIGRATION));

      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      expect(tables).toEqual(
        expect.arrayContaining([
          "projects",
          "task_runs",
          "executions",
          "leases",
          "events",
          "outbox",
          "schema_migrations"
        ])
      );

      expect(verifyMigrations(db)).toEqual({ ok: true, checked: 1, versions: [1] });
    } finally {
      db.close();
    }
  });

  it("replay safety: a second application is a skipped no-op and direct re-application is rejected", async () => {
    await applyMigrations(testDb.db, { now: T0 });
    // Framework level: the second run must not re-execute any SQL.
    const second = await applyMigrations(testDb.db, { now: T0 });
    expect(second.appliedVersions).toEqual([]);
    expect(appliedMigrationRecords(testDb.db)).toHaveLength(1);

    // Schema level: reserving the same version again violates the PRIMARY KEY.
    expect(() =>
      testDb.db
        .prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (1, 'again', 'x', ?)")
        .run(T0)
    ).toThrowError(/UNIQUE constraint failed: schema_migrations\.version/);
  });

  it("verify detects a tampered checksum row", async () => {
    await applyMigrations(testDb.db, { now: T0 });
    testDb.db.prepare("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE version = 1").run();
    const error = expectError(() => verifyMigrations(testDb.db), MigrationError);
    expect(error.kind).toBe("checksum-mismatch");
    expect(error.version).toBe(1);
  });

  it("verify detects migration SQL that changed after the database was migrated", () => {
    applyMigrations(testDb.db, { now: T0 });
    const tamperedDefinition = {
      version: 1,
      name: "001-initial-core-tables",
      upSql: `${INITIAL_SCHEMA_MIGRATION.upSql}\n-- later edit\n`
    };
    const error = expectError(
      () => verifyMigrations(testDb.db, { migrations: [tamperedDefinition] }),
      MigrationError
    );
    expect(error.kind).toBe("checksum-mismatch");
  });

  it("rejects a database whose schema is newer than this build (downgrade guard)", async () => {
    await applyMigrations(testDb.db, { now: T0 });
    testDb.db
      .prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (99, 'future', 'x', ?)")
      .run(T0);
    expect(expectError(() => verifyMigrations(testDb.db), MigrationError).kind).toBe(
      "unknown-applied-version"
    );
    const applyError = await expectRejection(
      applyMigrations(testDb.db, { now: T0 }),
      MigrationError
    );
    expect(applyError.kind).toBe("unknown-applied-version");
  });

  it("applies custom future migrations in version order and stays idempotent", async () => {
    const migration2 = {
      version: 2,
      name: "002-test-extra-table",
      upSql: "CREATE TABLE test_extra (id TEXT PRIMARY KEY) STRICT;"
    };
    const db = openDatabase(makeTempDbPath("migrations-order"));
    try {
      const first = await applyMigrations(db, {
        now: T0,
        migrations: [migration2, INITIAL_SCHEMA_MIGRATION]
      });
      expect(first.appliedVersions).toEqual([1, 2]);
      const second = await applyMigrations(db, {
        now: T0,
        migrations: [INITIAL_SCHEMA_MIGRATION, migration2]
      });
      expect(second.appliedVersions).toEqual([]);
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([1, 2]);

      db.prepare("INSERT INTO test_extra (id) VALUES (?)").run("x");
      expect(db.prepare("SELECT COUNT(*) AS n FROM test_extra").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rolls back a failing migration inside its own transaction and keeps the database usable", async () => {
    const dataBefore = { id: "proj-1" };
    await applyMigrations(testDb.db, { now: T0 });
    createProject(testDb.db, {
      id: dataBefore.id,
      repoRoot: "h:/repos/proj-1",
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });

    const broken = {
      version: 2,
      name: "002-broken",
      upSql: "CREATE TABLE broken_table (id TEXT PRIMARY KEY;"
    };
    const error = await expectRejection(
      applyMigrations(testDb.db, { now: T0, migrations: [...DEFAULT_MIGRATIONS, broken] }),
      MigrationError
    );
    expect(error.kind).toBe("application-failed");
    expect(error.version).toBe(2);

    // Reservation and DDL rolled back together: still exactly one record.
    expect(appliedMigrationRecords(testDb.db).map((record) => record.version)).toEqual([1]);
    // The database remains fully usable at version 1.
    createTaskRun(testDb.db, {
      id: "run-1",
      projectId: dataBefore.id,
      taskId: "task-1",
      graphRevision: 0,
      configSnapshotHash: "h",
      baseSha: "s",
      now: T0
    });
    expect(testDb.db.prepare("SELECT COUNT(*) AS n FROM task_runs").get()?.n).toBe(1);
  });

  it("enforces foreign keys on every connection", async () => {
    await applyMigrations(testDb.db, { now: T0 });
    // The store wraps the driver error; the underlying SQLite FK message stays
    // on `cause`, which is what proves the pragma actually fired.
    const error = expectError(
      () =>
        createTaskRun(testDb.db, {
          id: "run-orphan",
          projectId: "missing-project",
          taskId: "task-1",
          graphRevision: 0,
          configSnapshotHash: "h",
          baseSha: "s",
          now: T0
        }),
      NoRowUpdatedError
    );
    expect(error.cause instanceof Error && /FOREIGN KEY constraint failed/.test(error.cause.message)).toBe(
      true
    );
  });

  it("opens with WAL mode, foreign keys and the configured busy timeout", () => {
    const db = openDatabase(makeTempDbPath("pragmas"), { busyTimeoutMs: 1234 });
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
      expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(1234);
    } finally {
      db.close();
    }
  });
});

describe("migration 018 — task_runs.outcome (M10-04)", () => {
  const OUTCOME_CHAIN = [INITIAL_SCHEMA_MIGRATION, TASK_RUN_OUTCOME_MIGRATION];

  function seedProjectAndRun(db: ReturnType<typeof openDatabase>, label: string): void {
    createProject(db, {
      id: `proj-${label}`,
      repoRoot: `h:/repos/${label}`,
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    createTaskRun(db, {
      id: `run-${label}`,
      projectId: `proj-${label}`,
      taskId: `task-${label}`,
      graphRevision: 0,
      configSnapshotHash: "h",
      baseSha: "s",
      now: T0
    });
  }

  it("upgrades an old 001-era database in place: the column exists, pre-existing rows read NULL, data survives", async () => {
    const db = openDatabase(makeTempDbPath("outcome-upgrade"));
    try {
      // The OLD database: migration 001 only (the pre-018 task_runs shape).
      await applyMigrations(db, { now: T0 });
      seedProjectAndRun(db, "upgrade");

      // The controlled upgrade: 018 applies AFTER the recorded 001.
      const result = await applyMigrations(db, { now: T0, migrations: OUTCOME_CHAIN });
      expect(result.appliedVersions).toEqual([18]);
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([1, 18]);
      expect(verifyMigrations(db, { migrations: OUTCOME_CHAIN })).toEqual({
        ok: true,
        checked: 2,
        versions: [1, 18]
      });

      // NULL = in progress, for every row that predates the column.
      const run = getTaskRun(db, "run-upgrade");
      expect(run?.status).toBe("PLANNED");
      expect(run?.outcome).toBeNull();
    } finally {
      db.close();
    }
  });

  it("is idempotent: re-applying the chain is a skipped no-op and the record set does not move", async () => {
    const db = openDatabase(makeTempDbPath("outcome-idempotent"));
    try {
      await applyMigrations(db, { now: T0, migrations: OUTCOME_CHAIN });
      const second = await applyMigrations(db, { now: T0, migrations: OUTCOME_CHAIN });
      expect(second.appliedVersions).toEqual([]);
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([1, 18]);
      // The DDL really ran once: exactly one outcome column exists.
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('task_runs') WHERE name = 'outcome'")
        .all();
      expect(columns).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("CHECK-pins the outcome vocabulary at the SQL layer (defense in depth behind the zod setter)", async () => {
    const db = openDatabase(makeTempDbPath("outcome-check"));
    try {
      await applyMigrations(db, { now: T0, migrations: OUTCOME_CHAIN });
      seedProjectAndRun(db, "check");
      expect(() =>
        db.prepare("UPDATE task_runs SET outcome = 'bogus' WHERE id = 'run-check'").run()
      ).toThrowError(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
