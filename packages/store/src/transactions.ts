import type { DatabaseSync } from "node:sqlite";
import { TransactionStateError } from "./errors.js";

/**
 * Tracks which connections currently run a `withTransaction` block.
 *
 * This is API-level bookkeeping for our own helpers (nested transactions and
 * backups-inside-transactions are refused early with clear errors). Raw
 * `db.exec("BEGIN ...")` bypasses it, but SQLite itself still rejects a nested
 * BEGIN at the engine level, so there is no unsafe path.
 */
const inTransaction = new WeakSet<object>();

export function isInTransaction(db: DatabaseSync): boolean {
  return inTransaction.has(db);
}

/**
 * Run `fn` inside a single write transaction.
 *
 * `BEGIN IMMEDIATE` acquires the write lock up front so a claim/lease flow
 * never fails mid-transaction on lock promotion (the lock is the point). On
 * any error the transaction is rolled back and the original error is
 * rethrown; if the rollback itself fails, an AggregateError carries both.
 * Nesting on the same connection is rejected — compose within one block
 * instead (all entity functions accept the same connection and join the
 * open transaction automatically).
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (isInTransaction(db)) {
    throw new TransactionStateError(
      "withTransaction called while this connection is already inside a transaction; compose inside the existing block instead"
    );
  }
  db.exec("BEGIN IMMEDIATE");
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "transaction failed and the rollback also failed; inspect the database state manually"
      );
    }
    throw error;
  } finally {
    inTransaction.delete(db);
  }
}
