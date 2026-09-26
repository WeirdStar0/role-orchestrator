import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTarget } from "@role-orchestrator/contracts";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import type { ProjectRow } from "@role-orchestrator/store";
import { createProject, openDatabase } from "@role-orchestrator/store";
import {
  appliedMigrationRecords,
  applyRuntimeProfileMigrations,
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding,
  type ProfileRevisionRow,
  type ProfileRow,
  type RunWithSnapshotResult
} from "../src/index.js";

/** Fixed clock base so timestamps are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export function makeTempDbPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ro-rp-${label}-`));
  return join(dir, "test.db");
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Open a fresh file-backed database (WAL + FK on) with BOTH migrations
 * (001 core + 002 profiles) applied. Verifies the post-condition instead of
 * assuming it, mirroring the store test helper convention.
 */
export function createMigratedFileDb(label: string): TestDb {
  const dbPath = makeTempDbPath(label);
  const db = openDatabase(dbPath);
  void applyRuntimeProfileMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== 2 ||
    records[0]?.version !== 1 ||
    records[1]?.version !== 2
  ) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return { db, dbPath, close: () => db.close() };
}

export function createMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  void applyRuntimeProfileMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 2 || records[1]?.version !== 2) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  return db;
}

export interface FixtureConfigDir {
  readonly dir: string;
}

/**
 * Create a synthetic host-CLI-like config dir with explicitly declared,
 * non-credential fixture files. All content is generated here (synthetic);
 * no real CLI configuration is ever read.
 */
export function makeFixtureConfigDir(files: Record<string, string> = {}): FixtureConfigDir {
  const dir = join(mkdtempSync(join(tmpdir(), `ro-rp-cfg-`)), "config");
  mkdirSync(dir, { recursive: true });
  const defaults: Record<string, string> = {
    "settings.json": '{"permissions":{"allow":[]},"synthetic":true}\n',
    "mcp.json": '{"mcpServers":{},"synthetic":true}\n',
    ...files
  };
  for (const [relativePath, content] of Object.entries(defaults)) {
    const absolute = join(dir, ...relativePath.split("/"));
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  return { dir };
}

export interface SeedOptions {
  readonly projectId?: string;
  readonly projectTarget?: ExecutionTarget;
  readonly profileId?: string;
  readonly configDir?: string;
}

export interface SeedState {
  readonly project: ProjectRow;
  readonly profile: ProfileRow;
  readonly revision: ProfileRevisionRow;
  readonly configDir: string;
  readonly projectId: string;
  readonly profileId: string;
}

/**
 * Seed: project (windows-native) + profile (claude, windows-native, fixture
 * configDir) + revision 1 (model null, baseline over settings.json+mcp.json)
 * + the four initialized + bound role bindings.
 */
export async function seedBoundProject(db: DatabaseSync, options: SeedOptions = {}): Promise<SeedState> {
  const projectId = options.projectId ?? "proj-1";
  const profileId = options.profileId ?? "claude-main";
  const projectTarget = options.projectTarget ?? "windows-native";
  const configDir = options.configDir ?? makeFixtureConfigDir().dir;

  const project = createProject(db, {
    id: projectId,
    repoRoot: `h:/repos/${projectId}`,
    executionTarget: projectTarget,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  const profile = createProfile(db, {
    id: profileId,
    runtime: "claude",
    executable: "claude.cmd",
    executionTarget: "windows-native",
    configDir,
    credentialGroup: "personal",
    maxConcurrency: 2,
    timeoutSeconds: 600,
    now: T0
  });
  const revision = await createProfileRevision(db, {
    profileId,
    model: null,
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: T0
  });
  initializeProjectRoleBindings(db, { projectId, now: T0 });
  for (const roleId of ROLE_IDS) {
    setRoleBinding(db, {
      projectId,
      roleId,
      profileId,
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
  return { project, profile, revision, configDir, projectId, profileId };
}

/** Seed a fully-bound project AND create a frozen run over it. */
export async function seedReadyRun(
  db: DatabaseSync,
  options: SeedOptions & { readonly runId?: string } = {}
): Promise<SeedState & { readonly result: RunWithSnapshotResult }> {
  const state = await seedBoundProject(db, options);
  const result = createTaskRunWithProfileSnapshot(db, {
    runId: options.runId ?? "run-1",
    projectId: state.projectId,
    taskId: "task-1",
    graphRevision: 0,
    baseSha: "base-sha-1",
    now: T0
  });
  return { ...state, result };
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
