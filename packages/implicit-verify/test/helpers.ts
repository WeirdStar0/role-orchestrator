import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import {
  appliedMigrationRecords,
  applyMigrations,
  createProject,
  openDatabase
} from "@role-orchestrator/store";
import { BUDGET_SCHEMA_MIGRATION } from "@role-orchestrator/budget";
import { createRunGraph } from "@role-orchestrator/dag";
import {
  applySchedulerMigrations,
  type PollQueueInput
} from "@role-orchestrator/scheduler";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding,
  type RunWithSnapshotResult
} from "@role-orchestrator/runtime-profile";

/** Fixed clock base so timestamps are deterministic (scheduler-test pattern). */
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


export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Fresh file-backed database with the FULL composed chain this package
 * verifies against: 001 core + 002 profiles + 003 task_nodes + 004 scheduler
 * + 014 budget (expansion tables 005..013 belong to the expand suite). The
 * post-condition is verified, not assumed.
 */
export function createImplicitVerifyDb(label: string): TestDb {
  const dir = mkdtempSync(join(tmpdir(), `ro-implicit-verify-${label}-`));
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applySchedulerMigrations(db, { now: T0 });
  void applyMigrations(db, { now: T0, migrations: [BUDGET_SCHEMA_MIGRATION] });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== 5 ||
    records[0]?.version !== 1 ||
    records[1]?.version !== 2 ||
    records[2]?.version !== 3 ||
    records[3]?.version !== 4 ||
    records[4]?.version !== 14
  ) {
    db.close();
    throw new Error("test helper: composed migration chain 001..004+014 was not applied");
  }
  return { db, dbPath, close: () => db.close() };
}

/**
 * Synthetic host-CLI-like config dir: explicitly declared, non-credential
 * fixture files (same approach as the scheduler/runtime-profile test rigs).
 * Content is returned so a test can re-write the identical bytes later.
 */
export interface FixtureConfigDir {
  readonly dir: string;
  readonly files: readonly ["settings.json", "mcp.json"];
  readonly settingsContent: string;
  readonly mcpContent: string;
}

export function makeFixtureConfigDir(label: string): FixtureConfigDir {
  const dir = join(mkdtempSync(join(tmpdir(), `ro-implicit-verify-cfg-${label}-`)), "config");
  mkdirSync(dir, { recursive: true });
  const settingsContent = '{"permissions":{"allow":[]},"synthetic":true}\n';
  const mcpContent = '{"mcpServers":{},"synthetic":true}\n';
  writeFileSync(join(dir, "settings.json"), settingsContent, "utf8");
  writeFileSync(join(dir, "mcp.json"), mcpContent, "utf8");
  return { dir, files: ["settings.json", "mcp.json"], settingsContent, mcpContent };
}

export interface SeedProfileOptions {
  readonly profileId: string;
  readonly runtime?: "claude" | "codex";
  readonly credentialGroup?: string;
  readonly maxConcurrency?: number;
  /** Defaults to a fresh fixture config dir; a test may pass its own to drift it. */
  readonly configDir?: string;
}

export async function seedProfile(db: DatabaseSync, options: SeedProfileOptions): Promise<void> {
  createProfile(db, {
    id: options.profileId,
    runtime: options.runtime ?? "claude",
    executable: `${options.profileId}.cmd`,
    executionTarget: FIXTURE_TARGET,
    configDir: options.configDir ?? makeFixtureConfigDir(options.profileId).dir,
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

export function seedProject(db: DatabaseSync, options: { readonly projectId: string; readonly profileId: string }): void {
  createProject(db, {
    id: options.projectId,
    repoRoot: process.platform === "win32" ? `h:/repos/${options.projectId}` : `/repos/${options.projectId}`,
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

const ROLE_ID_LIST: readonly RoleId[] = ["coordinator", "architect", "developer", "reviewer"];

export interface SeedRunResult {
  readonly run: RunWithSnapshotResult;
  readonly readyNodeIds: readonly string[];
}

/** Run whose graph exists and whose entry nodes are READY (scheduler input). */
export async function seedReadyRun(
  db: DatabaseSync,
  options: { readonly projectId: string; readonly runId: string; readonly nodeIds?: readonly string[] }
): Promise<SeedRunResult> {
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

function rawNode(id: string): Record<string, unknown> {
  return {
    id,
    role: "developer",
    title: `title-${id}`,
    objective: `objective-${id}`,
    dependencies: [],
    capabilityTags: ["backend"],
    acceptanceCriteria: [`criteria-${id}`]
  };
}

function rawWorkflow(nodes: readonly Record<string, unknown>[], id = "wf-1"): unknown {
  return { id, name: `workflow-${id}`, nodes };
}

/** Default poll input: docs/PROFILE_AND_MODEL.md policies (Global=4, Project=3). */
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
