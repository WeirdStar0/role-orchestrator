/**
 * Shared helpers for engine tests: a migrated database, a fully bound
 * project whose profiles point at the BUILT fake-cli dist bins (dogfood
 * path), and polling/termination helpers for real subprocess assertions.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTarget } from "@role-orchestrator/contracts";
import { ROLE_IDS, type RoleId } from "@role-orchestrator/contracts";
import {
  RUNTIME_PROFILE_MIGRATIONS,
  appliedMigrationRecords,
  applyRuntimeProfileMigrations,
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding,
  verifyMigrations
} from "@role-orchestrator/runtime-profile";
import { createProject, openDatabase } from "@role-orchestrator/store";
import type { StartExecutionInput } from "../src/index.js";
import { startExecution, type ExecutionRun } from "../src/index.js";

export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export type FakeDialect = "claude" | "codex";

const testDir = path.dirname(fileURLToPath(import.meta.url));

export function fakeBinPath(dialect: FakeDialect): string {
  const bin = path.resolve(testDir, "..", "..", "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new Error(`fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`);
  }
  return bin;
}

/** A directory the engine can use as cwd (the stdin prompt file lands here). */
export function makeWorkDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ro-engine-cwd-${label}-`));
}

/** Synthetic, non-credential config dir with the two declared baseline files. */
export function makeConfigDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), `ro-engine-cfg-`)), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface SeededDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

export function createSeededDb(label: string): SeededDb {
  const dir = mkdtempSync(join(tmpdir(), `ro-engine-db-${label}-`));
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyRuntimeProfileMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 2 || records[1]?.version !== 2) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  verifyMigrations(db, { migrations: RUNTIME_PROFILE_MIGRATIONS });
  return { db, dbPath, close: () => db.close() };
}

export interface SeedOptions {
  readonly dialect?: FakeDialect;
  readonly projectId?: string;
  readonly profileId?: string;
  readonly runId?: string;
  readonly projectTarget?: ExecutionTarget;
}

export interface SeedState {
  readonly projectId: string;
  readonly profileId: string;
  readonly runId: string;
  readonly dialect: FakeDialect;
  readonly executable: string;
  readonly timeoutSeconds: number;
}

/**
 * Seed project + profile (executable = the fake-cli dist bin) + revision 1 +
 * the four bound roles + a frozen run over them. For non-windows-native
 * targets a precomputed externalConfigHash is used (the documented escape
 * hatch for registering a profile before its configDir exists on this
 * machine — relative path forms are used to satisfy the A29 shape checks).
 */
export async function seedFakeRun(db: DatabaseSync, options: SeedOptions = {}): Promise<SeedState> {
  const dialect = options.dialect ?? "claude";
  const projectId = options.projectId ?? "proj-1";
  const profileId = options.profileId ?? "profile-fake";
  const runId = options.runId ?? "run-1";
  const projectTarget = options.projectTarget ?? "windows-native";
  const windowsNative = projectTarget === "windows-native";
  const executable = windowsNative ? fakeBinPath(dialect) : "fake-cli-relative";

  createProject(db, {
    id: projectId,
    repoRoot: `h:/repos/${projectId}`,
    executionTarget: projectTarget,
    trustStatus: "requires-user-confirmation",
    now: T0
  });

  createProfile(db, {
    id: profileId,
    runtime: dialect,
    executable,
    executionTarget: projectTarget,
    configDir: windowsNative ? makeConfigDir() : "cfg/synthetic",
    credentialGroup: "personal",
    maxConcurrency: 1,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, {
    profileId,
    model: null,
    externalConfigFiles: windowsNative ? ["settings.json", "mcp.json"] : ["settings.json"],
    ...(windowsNative
      ? {}
      : { externalConfigHash: createHash("sha256").update("synthetic").digest("hex") }),
    now: T0
  });
  initializeProjectRoleBindings(db, { projectId, now: T0 });
  for (const roleId of ROLE_IDS as readonly RoleId[]) {
    setRoleBinding(db, {
      projectId,
      roleId,
      profileId,
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
  createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId,
    taskId: "task-1",
    graphRevision: 0,
    baseSha: "base-sha-1",
    now: T0
  });
  return { projectId, profileId, runId, dialect, executable, timeoutSeconds: 600 };
}

export interface LaunchOverrides {
  readonly executionId?: string;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly dispatchToken?: string;
  readonly scenario?: string;
  readonly variant?: string | undefined;
  readonly timeoutSeconds?: number;
  readonly cwd?: string;
  readonly invocationArgs?: readonly string[];
  readonly now?: string;
  /** M2-06: launch an attempt row the scheduler's dispatch claim already created. */
  readonly claimedAttempt?: boolean;
}

/** startExecution with the test defaults for the seeded fake run. */
export function launchFake(
  db: DatabaseSync,
  seed: SeedState,
  overrides: LaunchOverrides = {}
): ExecutionRun {
  const invocationArgs = overrides.invocationArgs ?? (() => {
    const args = ["--scenario", overrides.scenario ?? "success"];
    if (overrides.variant !== undefined) args.push("--variant", overrides.variant);
    return args;
  })();
  const input: StartExecutionInput = {
    executionId: overrides.executionId ?? `exec-${overrides.nodeId ?? "node-1"}`,
    runId: seed.runId,
    roleId: "developer",
    nodeId: overrides.nodeId ?? "node-1",
    definitionRevision: "rev-1",
    attempt: overrides.attempt ?? 1,
    dispatchToken: overrides.dispatchToken ?? `dt-${overrides.executionId ?? "exec-node-1"}`,
    cwd: overrides.cwd ?? makeWorkDir("launch"),
    prompt: "synthetic task prompt (engine dogfood)",
    invocationArgs,
    timeoutSeconds: overrides.timeoutSeconds ?? 120,
    now: overrides.now ?? T0,
    ...(overrides.claimedAttempt === true ? { claimedAttempt: true } : {})
  };
  return startExecution(db, input);
}

/** Polls until the predicate holds; fails with a label after the timeout. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls until the PID no longer exists (process.kill(pid, 0) raises). */
export async function expectPidDead(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
    await sleep(100);
  }
  throw new Error(`pid ${pid} is still alive ${timeoutMs}ms after termination`);
}

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
