import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { createActiveAttempt, createProject, createTaskRun, openDatabase, appliedMigrationRecords, applyMigrations } from "@role-orchestrator/store";
import { BUDGET_SCHEMA_MIGRATION } from "@role-orchestrator/budget";
import { createRunGraph } from "@role-orchestrator/dag";
import {
  applySchedulerMigrations,
  type PollQueueInput
} from "../src/index.js";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding,
  type RunWithSnapshotResult
} from "@role-orchestrator/runtime-profile";

/** Fixed clock base so timestamps are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

/**
 * Fixture execution target follows the RUNNING platform: A29 binds fixture
 * path forms to the target's own world, so a windows-native fixture cannot be
 * seeded from POSIX temp dirs. Domain assertions are platform-independent;
 * cross-world rejection tests build their own explicit fixtures.
 */
export const FIXTURE_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";

/** Fixture repo root in the host world (A29 path form). */
export function fixtureRepoRoot(projectId: string): string {
  return process.platform === "win32" ? `h:/repos/${projectId}` : `/repos/${projectId}`;
}


export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export function makeTempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ro-scheduler-${label}-`));
  return join(dir, "test.db");
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Open a fresh file-backed database (WAL + FK on) with ALL migrations
 * (001 core + 002 profiles + 003 task_nodes + 004 scheduler) applied.
 * Verifies the post-condition instead of assuming it.
 */
export function createMigratedFileDb(label: string): TestDb {
  const dbPath = makeTempDbPath(label);
  const db = openDatabase(dbPath);
  void applySchedulerMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== 4 ||
    records[0]?.version !== 1 ||
    records[1]?.version !== 2 ||
    records[2]?.version !== 3 ||
    records[3]?.version !== 4
  ) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return { db, dbPath, close: () => db.close() };
}

/**
 * File-backed database with the scheduler chain PLUS the budget migration
 * (001 + 002 + 003 + 004 + 014) — the composition scheduler consumers use
 * once M4-04 budget enforcement is in play. The expansion tables (005..013)
 * are deliberately absent here: the held-run enforcement over
 * `expansion_user_holds` is exercised in the expand suite, which owns that
 * part of the chain.
 */
export function createBudgetAwareFileDb(label: string): TestDb {
  const { db, dbPath, close } = createMigratedFileDb(label);
  void applyMigrations(db, { now: T0, migrations: [BUDGET_SCHEMA_MIGRATION] });
  const records = appliedMigrationRecords(db);
  if (records.length !== 5 || records[4]?.version !== 14) {
    close();
    throw new Error("test helper: budget migration 014 was not applied");
  }
  return { db, dbPath, close };
}

export function createMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  void applySchedulerMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 4 || records[3]?.version !== 4) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return db;
}

/**
 * Synthetic host-CLI-like config dir with explicitly declared, non-credential
 * fixture files (same approach as the runtime-profile/dag tests).
 */
export function makeFixtureConfigDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ro-scheduler-cfg-")), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"permissions":{"allow":[]},"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface SeedProfileOptions {
  readonly profileId: string;
  readonly runtime?: "claude" | "codex";
  readonly credentialGroup?: string;
  readonly maxConcurrency?: number;
}

export async function seedProfile(db: DatabaseSync, options: SeedProfileOptions): Promise<void> {
  await createProfile(db, {
    id: options.profileId,
    runtime: options.runtime ?? "claude",
    executable: `${options.profileId}.cmd`,
    executionTarget: FIXTURE_TARGET,
    configDir: makeFixtureConfigDir(),
    credentialGroup: options.credentialGroup ?? "personal",
    maxConcurrency: options.maxConcurrency ?? 2,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, {
    profileId: options.profileId,
    model: null,
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: T0
  });
}

export interface SeedProjectOptions {
  readonly projectId: string;
  /** Profile id bound to ALL FOUR roles of the project. */
  readonly profileId: string;
}

export async function seedProject(db: DatabaseSync, options: SeedProjectOptions): Promise<void> {
  await createProject(db, {
    id: options.projectId,
    repoRoot: fixtureRepoRoot(options.projectId),
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  initializeProjectRoleBindings(db, { projectId: options.projectId, now: T0 });
  for (const roleId of ROLE_ID_LIST) {
    setRoleBinding(db, {
      projectId: options.projectId,
      roleId,
      profileId: options.profileId,
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
}

export interface SeedRunOptions {
  readonly projectId: string;
  readonly runId: string;
  /** Node ids, all `developer` role with no dependencies -> READY at creation. */
  readonly nodeIds?: readonly string[];
}

export interface SeedRunResult {
  readonly run: RunWithSnapshotResult;
  readonly readyNodeIds: readonly string[];
}

/**
 * Seed a run whose graph is created and whose entry nodes are READY — the
 * exact state the scheduler queue consumes (M2-01 output).
 */
export async function seedReadyRun(db: DatabaseSync, options: SeedRunOptions): Promise<SeedRunResult> {
  const nodeIds = options.nodeIds ?? ["n1"];
  const run = await createTaskRunWithProfileSnapshot(db, {
    runId: options.runId,
    projectId: options.projectId,
    taskId: `task-${options.runId}`,
    graphRevision: 0,
    baseSha: "base-sha-1",
    now: T0
  });
  createRunGraph(db, {
    runId: options.runId,
    workflow: rawWorkflow(nodeIds.map((id) => rawNode(id))),
    now: T0
  });
  return { run, readyNodeIds: nodeIds };
}

const ROLE_ID_LIST: readonly RoleId[] = ["coordinator", "architect", "developer", "reviewer"];

// ---------------------------------------------------------------------------
// Workflow fixtures — RAW (unparsed) input so createRunGraph exercises the
// full schema + graph path the way a Coordinator's output would arrive.
// ---------------------------------------------------------------------------

export function rawNode(id: string, dependencies: readonly string[] = []): Record<string, unknown> {
  return {
    id,
    role: "developer",
    title: `title-${id}`,
    objective: `objective-${id}`,
    dependencies,
    capabilityTags: ["backend"],
    acceptanceCriteria: [`criteria-${id}`]
  };
}

export function rawWorkflow(nodes: readonly Record<string, unknown>[], id = "wf-1"): unknown {
  return { id, name: `workflow-${id}`, nodes };
}

/** Default poll input: policies of docs/PROFILE_AND_MODEL.md (Global=4, Project=3, Profile from the seeded rows). */
export function pollInput(now: string, overrides: Partial<PollQueueInput> = {}): PollQueueInput {
  return {
    leaseMs: 3_600_000,
    retryWindowMs: 60_000,
    starvationMs: 3_600_000,
    limit: 8,
    concurrency: { globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 1 },
    now,
    ...overrides
  };
}

export interface SeedExecutionIds {
  readonly projectId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly nodeId: string;
}

/**
 * Minimal dispatch chain (project -> task run -> active attempt) so quota
 * grants have an `executions` row to reference (FK).
 */
export function seedExecution(db: DatabaseSync, overrides: Partial<SeedExecutionIds> = {}): SeedExecutionIds {
  const executionId = overrides.executionId ?? "exec-1";
  const ids: SeedExecutionIds = {
    // Defaults derive from the execution id so repeated calls in one database
    // never collide on projects'/task_runs' unique constraints.
    projectId: overrides.projectId ?? `proj-${executionId}`,
    runId: overrides.runId ?? `run-${executionId}`,
    executionId,
    nodeId: overrides.nodeId ?? "node-1"
  };
  createProject(db, {
    id: ids.projectId,
    repoRoot: fixtureRepoRoot(ids.projectId),
    executionTarget: FIXTURE_TARGET,
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
