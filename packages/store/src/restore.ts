import { copyFileSync, existsSync, openSync, readSync, closeSync, statSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BackupError } from "./errors.js";
import { MEMORY_PATH } from "./connection.js";
import {
  appliedMigrationRecords,
  verifyMigrations,
  type AppliedMigrationRecord,
  type MigrationDefinition
} from "./migrations.js";

/**
 * Restore side of `backup.ts` (A41).
 *
 * `restoreBackup` refuses to copy bytes it has not verified first:
 *
 * 1. the backup file must exist, be a file, differ from the target, and the
 *    target must not be an in-memory database;
 * 2. the backup is opened READ-ONLY and must pass `PRAGMA integrity_check`
 *    BEFORE any byte is copied — a truncated or structurally corrupted file
 *    is rejected with `BackupError` and the live database is untouched;
 * 3. when the caller passes `expectedMigrations`, the applied migration
 *    records inside the BACKUP are checksum-verified against that list
 *    (`verifyMigrations`), so a structurally valid SQLite file that is not a
 *    database of THIS schema lineage (tampered `schema_migrations`, a foreign
 *    database, or a schema newer than this build) is rejected with the typed
 *    `MigrationError` before anything is overwritten.
 *
 * As before, the restore itself is a plain file operation: the caller MUST
 * have closed every connection to `databasePath` first — restoring under a
 * live connection corrupts state. The maintenance package's README documents
 * the full operator step list.
 */
export interface BackupInspection {
  readonly backupPath: string;
  readonly bytes: number;
  /** `PRAGMA integrity_check` of the backup file; always "ok" or we throw. */
  readonly integrity: "ok";
  /** Applied migration records found inside the backup, oldest first. */
  readonly migrationRecords: readonly AppliedMigrationRecord[];
}

const RestoreOptionsSchema = z.strictObject({
  backupPath: z.string().min(1),
  databasePath: z.string().min(1),
  /**
   * When provided, the backup's `schema_migrations` records are verified
   * against this list before any byte is copied. Structural validation of
   * the list (duplicates, entry shape) is delegated to `verifyMigrations`.
   */
  expectedMigrations: z
    .array(
      z.object({
        version: z.number().int().min(1),
        name: z.string().min(1),
        upSql: z.string().min(1)
      })
    )
    .optional()
});

export interface RestoreOptions {
  readonly backupPath: string;
  readonly databasePath: string;
  readonly expectedMigrations?: readonly MigrationDefinition[] | undefined;
}

export interface RestoreResult {
  readonly databasePath: string;
  readonly bytes: number;
  readonly removedSidecars: readonly string[];
  /** The backup passed `PRAGMA integrity_check` before any byte was copied. */
  readonly backupIntegrity: "ok";
  /**
   * How many applied migration records inside the backup were checksum-
   * verified; `null` when the caller did not pass `expectedMigrations`.
   */
  readonly verifiedMigrationCount: number | null;
}

function openBackupReadOnly(backupPath: string): DatabaseSync {
  try {
    return new DatabaseSync(backupPath, { readOnly: true });
  } catch (error) {
    throw new BackupError(
      `restoreBackup: backup file could not be opened as a SQLite database (${backupPath})`,
      { cause: error }
    );
  }
}

/** Every real SQLite 3 file starts with this exact 16-byte magic header. */
const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * Cheap deterministic pre-check BEFORE handing the file to SQLite: SQLite
 * treats a zero-byte file as a VALID empty database (integrity_check says
 * "ok"!), so size and magic-header checks must run first — otherwise a
 * truncated-to-zero "backup" would pass verification and wipe the live
 * database with an empty one.
 */
function assertPlausibleSqliteFile(backupPath: string): void {
  const bytes = statSync(backupPath).size;
  if (bytes < 100) {
    throw new BackupError(
      `inspectBackupFile: backup file is not a plausible SQLite database (${String(bytes)} bytes < 100-byte header) (${backupPath})`
    );
  }
  const header = Buffer.alloc(16);
  const fd = openSync(backupPath, "r");
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  if (!header.equals(Buffer.from(SQLITE_MAGIC, "utf8"))) {
    throw new BackupError(
      `inspectBackupFile: backup file lacks the SQLite 3 magic header (${backupPath})`
    );
  }
}

/**
 * Read-only verification pass over a backup file: open it, run
 * `PRAGMA integrity_check`, and read its applied migration records. Throws
 * `BackupError` on a missing/unreadable/corrupt file; never writes anything.
 * This is the runbook's "verify the backup BEFORE touching the live database"
 * step, usable standalone.
 */
export function inspectBackupFile(backupPath: string): BackupInspection {
  if (!existsSync(backupPath)) {
    throw new BackupError(`inspectBackupFile: backup file does not exist (${backupPath})`);
  }
  assertPlausibleSqliteFile(backupPath);
  const db = openBackupReadOnly(backupPath);
  try {
    let integrityResult: unknown;
    try {
      integrityResult = (db.prepare("PRAGMA integrity_check").get() as
        | { integrity_check?: unknown }
        | undefined)?.integrity_check;
    } catch (error) {
      throw new BackupError(
        `inspectBackupFile: integrity_check could not run on the backup (${backupPath}); the file is corrupt`,
        { cause: error }
      );
    }
    if (integrityResult !== "ok") {
      throw new BackupError(
        `inspectBackupFile: backup failed integrity_check (${String(integrityResult ?? "no result")}) (${backupPath})`
      );
    }
    return {
      backupPath,
      bytes: statSync(backupPath).size,
      integrity: "ok",
      migrationRecords: appliedMigrationRecords(db)
    };
  } finally {
    db.close();
  }
}

/**
 * Roll a database file back to a previously taken backup. Verification runs
 * BEFORE anything on disk changes — see the module doc. The target's stale
 * `-wal`/`-shm` sidecars are removed (a leftover WAL would otherwise be
 * replayed over the restored file) and the backup copy replaces the target.
 */
export function restoreBackup(options: RestoreOptions): RestoreResult {
  const parsed = RestoreOptionsSchema.parse(options);
  if (parsed.databasePath === MEMORY_PATH || !existsSync(parsed.backupPath)) {
    throw new BackupError(
      `restoreBackup: backup file does not exist (${parsed.backupPath}) or target is an in-memory database`
    );
  }
  if (parsed.backupPath === parsed.databasePath) {
    throw new BackupError("restoreBackup: backup path and database path are identical");
  }

  // ---- pre-validation: refuse BEFORE any byte moves ------------------------
  const inspection = inspectBackupFile(parsed.backupPath);
  let verifiedMigrationCount: number | null = null;
  if (parsed.expectedMigrations !== undefined) {
    const backupDb = openBackupReadOnly(parsed.backupPath);
    try {
      verifyMigrations(backupDb, { migrations: parsed.expectedMigrations });
      verifiedMigrationCount = inspection.migrationRecords.length;
    } finally {
      backupDb.close();
    }
  }

  const removedSidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"] as const) {
    const sidecar = `${parsed.databasePath}${suffix}`;
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
      removedSidecars.push(sidecar);
    }
  }
  copyFileSync(parsed.backupPath, parsed.databasePath);
  return {
    databasePath: parsed.databasePath,
    bytes: statSync(parsed.databasePath).size,
    removedSidecars,
    backupIntegrity: inspection.integrity,
    verifiedMigrationCount
  };
}
