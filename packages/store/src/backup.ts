import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { BackupError } from "./errors.js";
import { MEMORY_PATH } from "./connection.js";
import { isInTransaction } from "./transactions.js";

export interface CheckpointStats {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

export interface BackupResult {
  readonly source: string;
  readonly destination: string;
  readonly checkpoint: CheckpointStats | null;
  readonly bytes: number;
  /** `PRAGMA integrity_check` result of the written backup file; always "ok" or we throw. */
  readonly integrity: "ok";
}

/**
 * Whole-database backup: WAL checkpoint (TRUNCATE) first so every committed
 * frame lands in the main file, then a plain file copy, then the copy is
 * opened and `PRAGMA integrity_check` is run against it before we report
 * success. A backup that cannot be opened and verified is an error, never a
 * reported success.
 *
 * Boundary: this procedure assumes no concurrent writers on OTHER connections
 * during the copy (checkpoint busy > 0 is treated as an error, not ignored).
 * The migration-backup path satisfies this by construction (backups run
 * before any migration, on a quiescent connection).
 *
 * Not supported for `:memory:` databases.
 */
export async function backupDatabase(db: DatabaseSync, destinationPath: string): Promise<BackupResult> {
  if (isInTransaction(db)) {
    throw new BackupError("backupDatabase: refusing to back up while this connection is inside a transaction");
  }
  const source = db.location();
  if (source === null || source === "" || source === MEMORY_PATH) {
    throw new BackupError("backupDatabase: refusing to back up a non-file (memory) database");
  }
  mkdirSync(dirname(destinationPath), { recursive: true });

  const checkpointRow = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const checkpoint: CheckpointStats | null =
    checkpointRow === undefined
      ? null
      : {
          busy: Number(checkpointRow.busy),
          log: Number(checkpointRow.log),
          checkpointed: Number(checkpointRow.checkpointed)
        };
  if (checkpoint !== null && checkpoint.busy !== 0) {
    throw new BackupError(
      "backupDatabase: WAL checkpoint was blocked by another connection (busy != 0); close other connections and retry"
    );
  }

  copyFileSync(source, destinationPath);

  // Verify the copy by opening it read-only and running integrity_check.
  let verify: DatabaseSync;
  try {
    verify = new DatabaseSync(destinationPath, { readOnly: true });
  } catch (error) {
    throw new BackupError(`backupDatabase: written backup could not be opened (${destinationPath})`, {
      cause: error
    });
  }
  try {
    const row = verify.prepare("PRAGMA integrity_check").get();
    if (row?.integrity_check !== "ok") {
      throw new BackupError(
        `backupDatabase: backup failed integrity_check (${String(row?.integrity_check ?? "no result")})`
      );
    }
  } finally {
    verify.close();
  }

  return {
    source,
    destination: destinationPath,
    checkpoint,
    bytes: statSync(destinationPath).size,
    integrity: "ok"
  };
}

// Restore lives in `./restore.js` (A41): it must checksum-verify the backup
// against the migration definitions BEFORE copying bytes, which would make
// `backup.ts` import `migrations.ts` — and `migrations.ts` already imports
// `backup.ts` for the pre-migration backup. Keeping restore in its own module
// avoids that import cycle while the package entry point re-exports both.

