import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  appliedMigrationRecords,
  applyMigrations,
  createActiveAttempt,
  createProject,
  createTaskRun,
  openDatabase
} from "../src/index.js";

/** Fixed clock base so lease comparisons are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export function makeTempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ro-store-${label}-`));
  return join(dir, "test.db");
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Open a fresh file-backed database (WAL + FK on) with migrations applied.
 *
 * `applyMigrations` without `backupPath` runs to completion synchronously
 * (its only `await` sits behind the backupPath branch); the helper verifies
 * that post-condition instead of assuming it, so a future refactor that makes
 * migrations truly async fails loudly here.
 */
export function createMigratedFileDb(label: string): TestDb {
  const dbPath = makeTempDbPath(label);
  const db = openDatabase(dbPath);
  void applyMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 1 || records[0]?.version !== 1) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return { db, dbPath, close: () => db.close() };
}

/** Same as `createMigratedFileDb` but backed by `:memory:`. */
export function createMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  void applyMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 1 || records[0]?.version !== 1) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return db;
}

export interface SeedIds {
  readonly projectId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly nodeId: string;
}

/**
 * Minimal dispatch chain (project -> task run -> active attempt) used by
 * tests that need an existing slot, e.g. for lease or event FKs.
 */
export function seedExecution(
  db: DatabaseSync,
  overrides: Partial<SeedIds> = {}
): SeedIds {
  const ids: SeedIds = {
    projectId: overrides.projectId ?? "proj-1",
    runId: overrides.runId ?? "run-1",
    executionId: overrides.executionId ?? "exec-1",
    nodeId: overrides.nodeId ?? "node-1"
  };
  createProject(db, {
    id: ids.projectId,
    repoRoot: `h:/repos/${ids.projectId}`,
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createTaskRun(db, {
    id: ids.runId,
    projectId: ids.projectId,
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-config-1",
    baseSha: "base-sha-1",
    now: T0
  });
  createActiveAttempt(db, {
    id: ids.executionId,
    runId: ids.runId,
    nodeId: ids.nodeId,
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: `dt-${ids.executionId}`,
    phase: "STARTING",
    now: T0
  });
  return ids;
}

/** Narrowing helper: run fn, require it to throw the given error class. */
export function expectError<T extends Error>(
  fn: () => unknown,
  errorClass: new (...args: never[]) => T
): T {
  try {
    fn();
  } catch (error) {
    if (error instanceof errorClass) {
      return error;
    }
    throw new Error(`expected ${errorClass.name}, got: ${String(error)}`);
  }
  throw new Error(`expected ${errorClass.name} to be thrown, but the call succeeded`);
}

/** Same as expectError for awaited promises. */
export async function expectRejection<T extends Error>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => T
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof errorClass) {
      return error;
    }
    throw new Error(`expected ${errorClass.name}, got: ${String(error)}`);
  }
  throw new Error(`expected ${errorClass.name} to be rejected, but the promise resolved`);
}
