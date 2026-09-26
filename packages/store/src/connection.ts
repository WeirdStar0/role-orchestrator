import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StoreError } from "./errors.js";

export const MEMORY_PATH = ":memory:";

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const OpenDatabaseOptionsSchema = z.strictObject({
  busyTimeoutMs: z.number().int().min(0).max(3_600_000).default(DEFAULT_BUSY_TIMEOUT_MS)
});

export interface OpenDatabaseOptions {
  /** How long SQLite waits on a locked database before surfacing SQLITE_BUSY. Default 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * Open a store database with the connection pragmas this package guarantees:
 *
 * - `foreign_keys = ON`  — referential integrity is per-connection and must be
 *   re-asserted on every open; it is read back and enforced (fails closed).
 * - `busy_timeout = <n>` — concurrent connections wait instead of failing fast.
 * - `journal_mode = WAL` — persistent in the database file; a no-op for
 *   `:memory:`. WAL gives readers/writers non-blocking snapshots.
 * - `synchronous = FULL` — commits survive OS-level crashes, not just process
 *   crashes; acceptable for a local daemon with low write volume.
 *
 * Pragmas are deliberately NOT part of migrations: `journal_mode` cannot run
 * inside a transaction and the rest are connection-scoped.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const parsed = OpenDatabaseOptionsSchema.parse(options);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`PRAGMA busy_timeout = ${String(parsed.busyTimeoutMs)};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");

  // Fail closed if a future Node change silently drops a pragma instead of
  // letting the store run without integrity guarantees.
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get();
  if (foreignKeys?.foreign_keys !== 1) {
    db.close();
    throw new StoreError("openDatabase: PRAGMA foreign_keys=ON did not take effect");
  }
  if (path !== MEMORY_PATH) {
    const journalMode = db.prepare("PRAGMA journal_mode").get();
    if (journalMode?.journal_mode !== "wal") {
      db.close();
      throw new StoreError("openDatabase: PRAGMA journal_mode=WAL did not take effect");
    }
  }
  return db;
}
