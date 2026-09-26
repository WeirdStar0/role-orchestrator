/**
 * The simulation world (M7-03): one in-memory store database with real
 * migrations + the real lease authority + the fake transport + the simulated
 * worker, sharing one logical clock. Fully hermetic — `:memory:` SQLite, no
 * temp files, no timers, no network.
 *
 * The store's `leases.execution_id` is a real foreign key to `executions`,
 * so every world seeds the project/task-run/execution rows the lease claims
 * point at — the same seeding pattern the store's own tests use
 * (packages/store/test/helpers.ts `seedExecution`), via the store's public
 * API. Each seeded execution sits on its own node so the A23 active-attempt
 * constraint is never in the way of a scenario.
 */
import {
  appliedMigrationRecords,
  applyMigrations,
  createActiveAttempt,
  createProject,
  createTaskRun,
  openDatabase
} from "@role-orchestrator/store";
import type { DatabaseSync } from "node:sqlite";
import { WorkerLeaseAuthority } from "./lease.js";
import { InMemoryWorkerTransport } from "./transport.js";
import { SimulatedRemoteWorker } from "./worker.js";

/** Fixed clock base so lease comparisons are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function seedExecutionRows(db: DatabaseSync): void {
  createProject(db, {
    id: "proj-1",
    repoRoot: "h:/repos/proj-1",
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createTaskRun(db, {
    id: "run-1",
    projectId: "proj-1",
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-config-1",
    baseSha: "base-sha-1",
    now: T0
  });
  for (const n of [1, 2, 3]) {
    createActiveAttempt(db, {
      id: `exec-${String(n)}`,
      runId: "run-1",
      nodeId: `node-${String(n)}`,
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: `dt-exec-${String(n)}`,
      phase: "STARTING",
      now: T0
    });
  }
}

export interface RemoteWorld {
  readonly db: DatabaseSync;
  readonly authority: WorkerLeaseAuthority;
  readonly transport: InMemoryWorkerTransport;
  readonly worker: SimulatedRemoteWorker;
  readonly clock: { now: string; advanceMs(deltaMs: number): void };
  close(): void;
}

export function createRemoteWorld(): RemoteWorld {
  const db = openDatabase(":memory:");
  void applyMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 1 || records[0]?.version !== 1) {
    db.close();
    throw new Error("remote world: migrations were not applied synchronously");
  }
  seedExecutionRows(db);
  const clock = { now: T0 };
  const transport = new InMemoryWorkerTransport();
  const worker = new SimulatedRemoteWorker({
    transport,
    clock: () => clock.now
  });
  return {
    db,
    authority: new WorkerLeaseAuthority(db),
    transport,
    worker,
    clock: {
      get now(): string {
        return clock.now;
      },
      advanceMs(deltaMs: number): void {
        clock.now = new Date(Date.parse(clock.now) + deltaMs).toISOString();
      }
    },
    close: () => db.close()
  };
}

/** Run one scenario against a fresh world, closing the database either way. */
export function withWorld(fn: (world: RemoteWorld) => void): void {
  const world = createRemoteWorld();
  try {
    fn(world);
  } finally {
    world.close();
  }
}
