import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import {
  ActiveAttemptConflictError,
  claimLease,
  createActiveAttempt,
  enqueueOutboxMessage,
  markAttemptInterrupted,
  openDatabase,
  releaseExpiredLeases,
  releaseLease,
  withTransaction
} from "../src/index.js";
import {
  T0,
  createMigratedFileDb,
  iso,
  seedExecution
} from "./helpers.js";

describe("claim contention (two connections, one winner)", () => {
  // Short busy timeout keeps the forced lock-contention path fast.
  const BUSY_MS = 150;

  it("rejects a late claimant while the winner's transaction is open, then on state", () => {
    const store = createMigratedFileDb("claim-race");
    try {
      const { db } = store;
      const { executionId } = seedExecution(db);
      const holder = openDatabase(store.dbPath, { busyTimeoutMs: BUSY_MS });
      const challenger = openDatabase(store.dbPath, { busyTimeoutMs: BUSY_MS });
      try {
        let challengerBusy: unknown = null;
        // The winner holds its claim inside an open write transaction (raw
        // BEGIN here, since claimLease opens its own transaction). The INSERT
        // mirrors the protocol of claimLease in src/entities/leases.ts.
        holder.exec("BEGIN IMMEDIATE");
        try {
          const live = holder
            .prepare("SELECT id FROM leases WHERE resource_key = ? AND released_at IS NULL")
            .get("writer:run-1:node-1");
          expect(live).toBeUndefined();
          holder
            .prepare(
              "INSERT INTO leases(id, execution_id, resource_key, fencing_token, expires_at, released_at, created_at) VALUES (?, ?, ?, 1, ?, NULL, ?)"
            )
            .run("lease-winner", executionId, "writer:run-1:node-1", iso(60_000), T0);
          // While that transaction is open, the challenger's claimLease must
          // block on the write lock and fail with SQLITE_BUSY.
          try {
            claimLease(challenger, {
              id: "lease-challenger",
              executionId,
              resourceKey: "writer:run-1:node-1",
              expiresAt: iso(60_000),
              now: T0
            });
          } catch (error) {
            challengerBusy = error;
          }
          holder.exec("COMMIT");
        } catch (error) {
          holder.exec("ROLLBACK");
          throw error;
        }
        expect(challengerBusy).toBeInstanceOf(Error);
        expect((challengerBusy as Error).message).toMatch(/database is locked/);

        // After the winner committed, the challenger loses on live-lease state.
        const afterCommit = claimLease(challenger, {
          id: "lease-challenger",
          executionId,
          resourceKey: "writer:run-1:node-1",
          expiresAt: iso(120_000),
          now: T0
        });
        expect(afterCommit).toEqual({ granted: false, reason: "held" });

        const rows = db.prepare("SELECT COUNT(*) AS n FROM leases").get();
        expect(rows?.n).toBe(1);
        expect(db.prepare("SELECT fencing_token FROM leases").get()?.fencing_token).toBe(1);
      } finally {
        holder.close();
        challenger.close();
      }
    } finally {
      store.close();
    }
  });

  it("genuine worker race: exactly one of four concurrent claimants wins", async () => {
    const store = createMigratedFileDb("claim-workers");
    try {
      const { executionId } = seedExecution(store.db);
      const results = await Promise.all(
        [0, 1, 2, 3].map(
          (index) =>
            new Promise<{ granted: boolean; reason?: string; fencingToken?: number }>(
              (resolve, reject) => {
                // The worker reproduces the claimLease transaction protocol
                // with raw SQL (see test/workers/claim-worker.mjs header).
                const worker = new Worker(new URL("./workers/claim-worker.mjs", import.meta.url), {
                  workerData: {
                    dbPath: store.dbPath,
                    resourceKey: "writer:run-1:node-1",
                    leaseId: `lease-w${index}`,
                    executionId,
                    now: T0,
                    expiresAt: iso(60_000)
                  }
                });
                worker.on("message", resolve);
                worker.on("error", reject);
                worker.on("exit", (code) => {
                  if (code !== 0) {
                    reject(new Error(`worker ${index} exited with code ${String(code)}`));
                  }
                });
              }
            )
        )
      );
      const granted = results.filter((result) => result.granted);
      expect(granted).toHaveLength(1);
      // Whatever the interleaving, the database holds exactly one lease.
      const rows = store.db.prepare("SELECT COUNT(*) AS n FROM leases").get();
      expect(rows?.n).toBe(1);
      expect(granted[0]?.fencingToken).toBe(1);
    } finally {
      store.close();
    }
  });

  it("expired leases are never stolen implicitly; only reconcile releases them", () => {
    const store = createMigratedFileDb("claim-expiry");
    try {
      const { db } = store;
      const { executionId } = seedExecution(db);
      const first = claimLease(db, {
        id: "lease-1",
        executionId,
        resourceKey: "writer:run-1:node-1",
        expiresAt: iso(1_000),
        now: T0
      });
      expect(first.granted).toBe(true);

      // After expiry the slot still refuses a plain claim: timeout means
      // "reconcile needed", not "free" (DOMAIN_MODEL invariant).
      const whileExpired = claimLease(db, {
        id: "lease-2",
        executionId,
        resourceKey: "writer:run-1:node-1",
        expiresAt: iso(120_000),
        now: iso(2_000)
      });
      expect(whileExpired).toEqual({ granted: false, reason: "needs-reconcile" });

      // The explicit reconcile step frees expired leases; the re-claim then
      // succeeds with a strictly higher fencing token.
      expect(releaseExpiredLeases(db, { now: iso(2_000) })).toBe(1);
      expect(releaseLease(db, { id: "lease-1", now: iso(2_000) })).toBe(false);
      const afterReconcile = claimLease(db, {
        id: "lease-2",
        executionId,
        resourceKey: "writer:run-1:node-1",
        expiresAt: iso(120_000),
        now: iso(2_000)
      });
      if (!afterReconcile.granted) {
        throw new Error("expected re-claim after reconcile to be granted");
      }
      expect(afterReconcile.lease.fencingToken).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("A23: crash after DB commit, before process start", () => {
  it("constraint blocks a second attempt until reconcile marks the first INTERRUPTED", () => {
    const store = createMigratedFileDb("a23");
    let secondConnection: ReturnType<typeof openDatabase> | null = null;
    try {
      const { db } = store;
      // The dispatch transaction per ORCHESTRATION.md section 4:
      // claim -> execution -> dispatch outbox, committed atomically.
      withTransaction(db, () => {
        const seeded = seedExecution(db);
        enqueueOutboxMessage(db, {
          id: "msg-dispatch-1",
          aggregateId: seeded.runId,
          type: "execution.dispatch_requested",
          payload: { nodeId: seeded.nodeId, dispatchToken: "dt-exec-1" },
          now: T0
        });
        return seeded;
      });
      // --- crash here: committed, process never started, nothing else written ---

      const second = openDatabase(store.dbPath);
      secondConnection = second;
      const runId = "run-1";
      const nodeId = "node-1";

      // A second connection may not create a second active attempt for the slot.
      let conflict: unknown = null;
      try {
        createActiveAttempt(second, {
          id: "exec-2",
          runId,
          nodeId,
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-2",
          phase: "STARTING",
          now: iso(1_000)
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ActiveAttemptConflictError);

      // Constraint-level proof without the typed wrapper: a raw INSERT is
      // also rejected by the partial unique index itself.
      expect(() =>
        second
          .prepare(
            "INSERT INTO executions(id, run_id, node_id, definition_revision, attempt, phase, dispatch_token, session_id, pid_identity, created_at, updated_at) VALUES ('exec-2', ?, ?, 'rev-1', 2, 'STARTING', 'dt-exec-2', NULL, NULL, ?, ?)"
          )
          .run(runId, nodeId, iso(1_000), iso(1_000))
      ).toThrowError(/UNIQUE constraint failed: executions\.run_id, executions\.node_id/);

      // The crashed attempt's evidence is intact; exactly one active attempt.
      expect(
        second.prepare("SELECT phase FROM executions WHERE id = 'exec-1'").get()?.phase
      ).toBe("STARTING");
      const activeBefore = second
        .prepare(
          "SELECT COUNT(*) AS n FROM executions WHERE run_id = ? AND node_id = ? AND phase IN ('PREPARING','STARTING','RUNNING','FINALIZING')"
        )
        .get(runId, nodeId);
      expect(activeBefore?.n).toBe(1);

      // Reconcile: the crashed attempt becomes INTERRUPTED (terminal), which
      // frees the slot; the retry is then the only active attempt.
      markAttemptInterrupted(secondConnection, { id: "exec-1", now: iso(2_000) });
      createActiveAttempt(secondConnection, {
        id: "exec-2",
        runId,
        nodeId,
        definitionRevision: "rev-1",
        attempt: 2,
        dispatchToken: "dt-exec-2",
        phase: "STARTING",
        now: iso(2_000)
      });
      const activeAfter = second
        .prepare(
          "SELECT COUNT(*) AS n FROM executions WHERE run_id = ? AND node_id = ? AND phase IN ('PREPARING','STARTING','RUNNING','FINALIZING')"
        )
        .get(runId, nodeId);
      expect(activeAfter?.n).toBe(1);
      expect(second.prepare("SELECT COUNT(*) AS n FROM executions").get()?.n).toBe(2);

      // The committed dispatch outbox message survived the crash exactly once.
      expect(second.prepare("SELECT COUNT(*) AS n FROM outbox").get()?.n).toBe(1);

      // Dispatch tokens are unique across attempts (launcher-level dedup).
      expect(() =>
        second
          .prepare(
            "INSERT INTO executions(id, run_id, node_id, definition_revision, attempt, phase, dispatch_token, session_id, pid_identity, created_at, updated_at) VALUES ('exec-3', 'run-1', 'node-2', 'rev-1', 1, 'PREPARING', 'dt-exec-1', NULL, NULL, ?, ?)"
          )
          .run(iso(3_000), iso(3_000))
      ).toThrowError(/UNIQUE constraint failed: executions\.dispatch_token/);
    } finally {
      secondConnection?.close();
      store.close();
    }
  });
});
