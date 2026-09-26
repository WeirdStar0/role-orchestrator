import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTarget, RoleId } from "@role-orchestrator/contracts";
import type { ProjectRow } from "@role-orchestrator/store";
import { createProject, openDatabase } from "@role-orchestrator/store";
import {
  appliedMigrationRecords,
  applyDagMigrations
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
export const FIXTURE_TARGET: ExecutionTarget =
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
  const dir = mkdtempSync(join(tmpdir(), `ro-dag-${label}-`));
  return join(dir, "test.db");
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Open a fresh file-backed database (WAL + FK on) with ALL migrations
 * (001 core + 002 profiles + 003 task_nodes) applied. Verifies the
 * post-condition instead of assuming it.
 */
export function createMigratedFileDb(label: string): TestDb {
  const dbPath = makeTempDbPath(label);
  const db = openDatabase(dbPath);
  void applyDagMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== 3 ||
    records[0]?.version !== 1 ||
    records[1]?.version !== 2 ||
    records[2]?.version !== 3
  ) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return { db, dbPath, close: () => db.close() };
}

export function createMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  void applyDagMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 3 || records[2]?.version !== 3) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return db;
}

/**
 * Synthetic host-CLI-like config dir with explicitly declared, non-credential
 * fixture files (same approach as the runtime-profile tests).
 */
export function makeFixtureConfigDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ro-dag-cfg-")), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"permissions":{"allow":[]},"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface SeedOptions {
  readonly projectId?: string;
  readonly profileId?: string;
  readonly runId?: string;
}

export interface SeedState {
  readonly project: ProjectRow;
  readonly projectId: string;
  readonly profileId: string;
  readonly run: RunWithSnapshotResult;
}

/**
 * Seed: project + profile + revision 1 + four bound roles + a run with its
 * frozen profile snapshots — everything below `createRunGraph`.
 */
export async function seedReadyRun(db: DatabaseSync, options: SeedOptions = {}): Promise<SeedState> {
  const projectId = options.projectId ?? "proj-1";
  const profileId = options.profileId ?? "claude-main";
  const runId = options.runId ?? "run-1";

  const project = createProject(db, {
    id: projectId,
    repoRoot: fixtureRepoRoot(projectId),
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  const configDir = makeFixtureConfigDir();
  await createProfile(db, {
    id: profileId,
    runtime: "claude",
    executable: "claude.cmd",
    executionTarget: FIXTURE_TARGET,
    configDir,
    credentialGroup: "personal",
    maxConcurrency: 2,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, {
    profileId,
    model: null,
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: T0
  });
  initializeProjectRoleBindings(db, { projectId, now: T0 });
  for (const roleId of ROLE_ID_LIST) {
    setRoleBinding(db, {
      projectId,
      roleId,
      profileId,
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
  const run = createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId,
    taskId: "task-1",
    graphRevision: 0,
    baseSha: "base-sha-1",
    now: T0
  });
  return { project, projectId, profileId, run };
}

const ROLE_ID_LIST: readonly RoleId[] = ["coordinator", "architect", "developer", "reviewer"];

// ---------------------------------------------------------------------------
// Workflow fixtures — RAW (unparsed) input so validateWorkflowPlan exercises
// the full schema + graph path the way a Coordinator's output would arrive.
// ---------------------------------------------------------------------------

export interface RawNodeFixture {
  readonly id: string;
  readonly role: RoleId;
  readonly dependencies?: readonly string[];
}

export function rawNode(fixture: RawNodeFixture): Record<string, unknown> {
  return {
    id: fixture.id,
    role: fixture.role,
    title: `title-${fixture.id}`,
    objective: `objective-${fixture.id}`,
    dependencies: fixture.dependencies ?? [],
    capabilityTags: ["backend"],
    acceptanceCriteria: [`criteria-${fixture.id}`]
  };
}

export function rawWorkflow(nodes: readonly Record<string, unknown>[], id = "wf-1"): unknown {
  return { id, name: `workflow-${id}`, nodes };
}

/** a -> (b, c) -> d — the reference diamond. */
export function diamondWorkflow(): unknown {
  return rawWorkflow([
    rawNode({ id: "a", role: "coordinator" }),
    rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
    rawNode({ id: "c", role: "developer", dependencies: ["a"] }),
    rawNode({ id: "d", role: "reviewer", dependencies: ["b", "c"] })
  ]);
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
