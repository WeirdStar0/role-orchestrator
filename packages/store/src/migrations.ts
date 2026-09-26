import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MigrationError } from "./errors.js";
import { TimestampSchema } from "./time.js";
import { backupDatabase } from "./backup.js";
import { withTransaction } from "./transactions.js";
import { DEFAULT_MIGRATIONS } from "./schema.js";

/**
 * One forward migration. `upSql` is the single source of truth for the
 * checksum: `sha256(upSql)` is what gets recorded in `schema_migrations` and
 * what `verifyMigrations` recomputes. Migrations are forward-only; rollback
 * is done by restoring a backup taken before the migration (see `backup.ts`
 * and the `backupPath` option of `applyMigrations`).
 */
export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly upSql: string;
}

const MIGRATION_LIST_ENTRY_SCHEMA = z.strictObject({
  version: z.number().int().min(1),
  name: z.string().min(1).max(128),
  upSql: z.string().min(1)
});

const ApplyMigrationsOptionsSchema = z.strictObject({
  now: TimestampSchema.optional(),
  backupPath: z.string().min(1).optional()
});

export interface ApplyMigrationsOptions {
  /** Defaults to the shipped `DEFAULT_MIGRATIONS`. Validated structurally. */
  readonly migrations?: readonly MigrationDefinition[];
  /** Applied-at timestamp; defaults to the wall clock. */
  readonly now?: string;
  /**
   * When set and at least one migration is pending, a backup of the whole
   * database is written to this path BEFORE any migration runs, so a failed
   * or regretted upgrade can be rolled back to the file. See README for the
   * restore steps.
   */
  readonly backupPath?: string;
}

export interface ApplyMigrationsResult {
  /** Versions that were applied by this call, in application order. */
  readonly appliedVersions: readonly number[];
  /** The backup written before migrating, if one was requested and needed. */
  readonly backupPath: string | null;
}

export interface AppliedMigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface VerifyMigrationsResult {
  readonly ok: true;
  readonly checked: number;
  readonly versions: readonly number[];
}

/**
 * `schema_migrations` is bootstrap infrastructure, not a migration itself:
 * it must exist before migration 001 runs so the INSERT that reserves the
 * version happens in the same transaction as the DDL it vouches for.
 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

export function migrationChecksum(migration: MigrationDefinition): string {
  return createHash("sha256").update(migration.upSql, "utf8").digest("hex");
}

function migrationTableExists(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  return row?.present === 1;
}

function ensureSchemaMigrationsTable(db: DatabaseSync): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);
}

/** All applied migration records, oldest first. Empty on a fresh database. */
export function appliedMigrationRecords(db: DatabaseSync): readonly AppliedMigrationRecord[] {
  if (!migrationTableExists(db)) {
    return [];
  }
  const rows = db
    .prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC")
    .all();
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: String(row.applied_at)
  }));
}

function normalizeList(
  migrations: readonly MigrationDefinition[] | undefined
): readonly MigrationDefinition[] {
  const list = migrations ?? DEFAULT_MIGRATIONS;
  const seen = new Set<number>();
  for (const migration of list) {
    const parsed = MIGRATION_LIST_ENTRY_SCHEMA.safeParse(migration);
    if (!parsed.success) {
      throw new MigrationError(
        "application-failed",
        null,
        `invalid migration definition (${String(parsed.error.issues[0]?.message ?? "unknown issue")})`
      );
    }
    if (seen.has(migration.version)) {
      throw new MigrationError(
        "application-failed",
        null,
        `duplicate migration version ${String(migration.version)} in list`
      );
    }
    seen.add(migration.version);
  }
  return [...list].sort((a, b) => a.version - b.version);
}

/**
 * Apply all pending migrations, oldest first. Each migration runs in its own
 * single transaction: first an INSERT reserves `version` (the PRIMARY KEY
 * makes a second application of the same version impossible — re-entry is
 * rejected, not silently repeated), then the DDL executes. A failing
 * migration rolls back both, leaving the database at the previous version.
 */
export async function applyMigrations(
  db: DatabaseSync,
  options: ApplyMigrationsOptions = {}
): Promise<ApplyMigrationsResult> {
  const defs = normalizeList(options.migrations);
  const parsed = ApplyMigrationsOptionsSchema.parse({
    now: options.now,
    backupPath: options.backupPath
  });

  const records = appliedMigrationRecords(db);
  const appliedVersions = new Set(records.map((record) => record.version));
  const maxApplied = records.reduce((max, record) => Math.max(max, record.version), 0);
  const maxKnown = defs.reduce((max, def) => Math.max(max, def.version), 0);

  if (maxApplied > maxKnown) {
    throw new MigrationError(
      "unknown-applied-version",
      maxApplied,
      `database schema version ${String(maxApplied)} is newer than this build knows (max ${String(maxKnown)}); refusing to operate on a newer schema`
    );
  }
  for (const def of defs) {
    if (!appliedVersions.has(def.version) && def.version < maxApplied) {
      throw new MigrationError(
        "unknown-applied-version",
        def.version,
        `migration history gap: version ${String(def.version)} is below the highest applied version ${String(maxApplied)} but has no record`
      );
    }
  }

  const pending = defs.filter((def) => !appliedVersions.has(def.version));
  if (pending.length === 0) {
    return { appliedVersions: [], backupPath: null };
  }

  let backupPath: string | null = null;
  if (parsed.backupPath !== undefined) {
    await backupDatabase(db, parsed.backupPath);
    backupPath = parsed.backupPath;
  }

  const appliedAt = parsed.now ?? new Date().toISOString();
  for (const def of pending) {
    applyOneMigration(db, def, appliedAt);
  }
  return { appliedVersions: pending.map((def) => def.version), backupPath };
}

function applyOneMigration(
  db: DatabaseSync,
  def: MigrationDefinition,
  appliedAt: string
): void {
  ensureSchemaMigrationsTable(db);
  try {
    withTransaction(db, () => {
      // The version reservation happens FIRST, inside the same transaction
      // as the DDL: a re-application attempt dies on the PRIMARY KEY before
      // any SQL runs, and a failing DDL rolls the reservation back with it.
      db.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      ).run(def.version, def.name, migrationChecksum(def), appliedAt);
      db.exec(def.upSql);
    });
  } catch (error) {
    if (isAlreadyAppliedInsert(error)) {
      throw new MigrationError(
        "already-applied",
        def.version,
        `migration version ${String(def.version)} ("${def.name}") is already applied; applying the same version twice is rejected`,
        { cause: error }
      );
    }
    throw new MigrationError(
      "application-failed",
      def.version,
      `migration ${String(def.version)} ("${def.name}") failed and was rolled back; database remains at the previous version (cause: ${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}

function isAlreadyAppliedInsert(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: schema_migrations\.version/i.test(error.message)
  );
}

/**
 * Re-verify every applied migration against the checksum the current build
 * computes for its definition. Detects (a) a `schema_migrations` row that was
 * tampered with, and (b) a database migrated by definitions whose SQL has
 * since changed. Also fails on applied versions this build does not know
 * (schema newer than code — downgrade guard). A fresh database (no table
 * yet) verifies as ok with zero checked.
 */
export function verifyMigrations(
  db: DatabaseSync,
  options: { readonly migrations?: readonly MigrationDefinition[] } = {}
): VerifyMigrationsResult {
  const defs = normalizeList(options.migrations);
  const byVersion = new Map<number, MigrationDefinition>(defs.map((def) => [def.version, def]));

  const records = appliedMigrationRecords(db);
  for (const record of records) {
    const def = byVersion.get(record.version);
    if (def === undefined) {
      throw new MigrationError(
        "unknown-applied-version",
        record.version,
        `database has migration ${String(record.version)} ("${record.name}") which this build does not define; refusing to operate on a newer schema`
      );
    }
    const expected = migrationChecksum(def);
    if (expected !== record.checksum) {
      throw new MigrationError(
        "checksum-mismatch",
        record.version,
        `migration ${String(record.version)} ("${def.name}") failed checksum verification: recorded ${record.checksum}, expected ${expected}. The database was not produced by this schema definition; restore a verified backup instead of forcing an upgrade`
      );
    }
  }
  return { ok: true, checked: records.length, versions: records.map((record) => record.version) };
}
