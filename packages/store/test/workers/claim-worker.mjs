/**
 * Worker used by the genuine-concurrency claim race in concurrency.test.ts.
 *
 * It reproduces EXACTLY the transaction protocol of `claimLease` in
 * `src/entities/leases.ts` (check live lease -> fencing token = max+1 ->
 * insert -> COMMIT, all inside BEGIN IMMEDIATE) with raw SQL, because the
 * worker cannot import the TypeScript sources. If the protocol in
 * `leases.ts` changes, this file must change with it — the test comment
 * cross-references both sides.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const { dbPath, resourceKey, leaseId, executionId, now, expiresAt } = workerData;

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");

let outcome;
db.exec("BEGIN IMMEDIATE");
try {
  const live = db
    .prepare("SELECT id FROM leases WHERE resource_key = ? AND released_at IS NULL")
    .get(resourceKey);
  if (live !== undefined) {
    db.exec("ROLLBACK");
    outcome = { granted: false, reason: "held" };
  } else {
    const fencing = Number(
      db
        .prepare(
          "SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next_token FROM leases WHERE resource_key = ?"
        )
        .get(resourceKey).next_token
    );
    db.prepare(
      "INSERT INTO leases(id, execution_id, resource_key, fencing_token, expires_at, released_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)"
    ).run(leaseId, executionId, resourceKey, fencing, expiresAt, now);
    db.exec("COMMIT");
    outcome = { granted: true, fencingToken: fencing };
  }
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // no transaction open
  }
  outcome = { granted: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
}

db.close();
parentPort.postMessage(outcome);
