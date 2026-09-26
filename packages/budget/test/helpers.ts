/**
 * Shared test plumbing for the M4-04 budget suite.
 *
 * Discipline mirrors the other suites: fixture databases live in the SYSTEM
 * temp directory, nothing here touches the workspace's frozen surfaces, and
 * no real CLI is ever invoked (the budget domain needs no CLI at all — the
 * failure vocabulary arrives through the closed schema, not through
 * processes).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_MIGRATIONS,
  appliedMigrationRecords,
  applyMigrations,
  createActiveAttempt,
  createProject,
  createTaskRun,
  openDatabase
} from "@role-orchestrator/store";
import { applyBudgetMigrations } from "../src/index.js";

/** Fixed clock base so timestamps are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Fresh file-backed database with the STANDALONE budget chain applied
 * (001 core + 002 profiles + 003 task_nodes + 014 budget), post-condition
 * verified against the migration records.
 */
export function createBudgetDb(label: string): TestDb {
  const dbPath = join(mkdtempSync(join(tmpdir(), `ro-budget-${label}-`)), "test.db");
  const db = openDatabase(dbPath);
  void applyBudgetMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== 4 ||
    records[0]?.version !== 1 ||
    records[1]?.version !== 2 ||
    records[2]?.version !== 3 ||
    records[3]?.version !== 14
  ) {
    db.close();
    throw new Error("test helper: budget migrations 001..003+014 were not applied");
  }
  return { db, dbPath, close: () => db.close() };
}

/**
 * A database migrated ONLY through store's 001 core migration (no budget
 * tables at all): the presence-tolerant behavior tests need this shape.
 */
export function createCoreOnlyDb(label: string): TestDb {
  const dbPath = join(mkdtempSync(join(tmpdir(), `ro-budget-core-${label}-`)), "test.db");
  const db = openDatabase(dbPath);
  void applyMigrations(db, { now: T0, migrations: DEFAULT_MIGRATIONS });
  const records = appliedMigrationRecords(db);
  if (records.length !== 1 || records[0]?.version !== 1) {
    db.close();
    throw new Error("test helper: core-only migration 001 was not applied");
  }
  return { db, dbPath, close: () => db.close() };
}

export interface SeedSlotIds {
  readonly projectId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly nodeId: string;
}

/**
 * Minimal project -> task run chain (no attempt) for budget-domain rows that
 * reference task_runs.
 */
export function seedRunOnly(db: DatabaseSync, runId: string): void {
  const projectId = `proj-${runId}`;
  createProject(db, {
    id: projectId,
    repoRoot: `h:/repos/${projectId}`,
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createTaskRun(db, {
    id: runId,
    projectId,
    taskId: `task-${runId}`,
    graphRevision: 0,
    configSnapshotHash: "hash-config-1",
    baseSha: "base-sha-1",
    now: T0
  });
}

/**
 * Minimal project -> task run -> active attempt chain so budget rows and
 * usage rows have their foreign keys satisfied.
 */
export function seedSlot(db: DatabaseSync, overrides: Partial<SeedSlotIds> = {}): SeedSlotIds {
  const executionId = overrides.executionId ?? "exec-1";
  const ids: SeedSlotIds = {
    projectId: overrides.projectId ?? `proj-${executionId}`,
    runId: overrides.runId ?? `run-${executionId}`,
    executionId,
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
