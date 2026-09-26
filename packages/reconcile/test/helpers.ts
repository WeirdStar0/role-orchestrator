/**
 * Shared helpers for reconcile tests: a migrated database, a fully bound run
 * over the BUILT fake-cli dist bins (same dogfood shape as the engine tests),
 * store-level attempt factories for the durable states reconcile scans, and
 * real hold-process spawners for the Windows identity tests.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
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
import {
  createActiveAttempt,
  createProject,
  enqueueOutboxMessage,
  openDatabase,
  setAttemptPhase,
  setExecutionPidIdentity,
  type AttemptPhase
} from "@role-orchestrator/store";

export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export function nowIso(): string {
  return new Date().toISOString();
}

const testDir = path.dirname(fileURLToPath(import.meta.url));

export function fakeBinPath(dialect: "claude" | "codex"): string {
  const bin = path.resolve(testDir, "..", "..", "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new Error(`fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`);
  }
  return bin;
}

export interface SeededDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

export function createSeededDb(label: string): SeededDb {
  const dir = mkdtempSync(join(tmpdir(), `ro-reconcile-db-${label}-`));
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

export interface SeedState {
  readonly projectId: string;
  readonly runId: string;
  readonly dialect: "claude" | "codex";
  readonly executable: string;
}

/** Project + fake-cli profile + revision 1 + four bound roles + a frozen run. */
export async function seedFakeRun(db: DatabaseSync, options: { dialect?: "claude" | "codex"; runId?: string } = {}): Promise<SeedState> {
  const dialect = options.dialect ?? "claude";
  const projectId = "proj-rec";
  const profileId = "profile-fake";
  const runId = options.runId ?? "run-1";
  const executable = fakeBinPath(dialect);

  createProject(db, {
    id: projectId,
    repoRoot: `h:/repos/${projectId}`,
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  const configDir = join(mkdtempSync(join(tmpdir(), "ro-reconcile-cfg-")), "config");
  mkdirSync(configDir, { recursive: true });
  // Synthetic, non-credential baseline files (same shape as the engine tests):
  // createProfileRevision hashes exactly this declared manifest.
  writeFileSync(join(configDir, "settings.json"), '{"synthetic":true}\n', "utf8");
  writeFileSync(join(configDir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  createProfile(db, {
    id: profileId,
    runtime: dialect,
    executable,
    executionTarget: "windows-native",
    configDir,
    credentialGroup: "personal",
    maxConcurrency: 1,
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
  for (const roleId of ["coordinator", "architect", "developer", "reviewer"] as const satisfies readonly RoleId[]) {
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
    taskId: "task-rec",
    graphRevision: 0,
    baseSha: "base-sha-rec",
    now: T0
  });
  return { projectId, runId, dialect, executable };
}

export interface MakeAttemptOptions {
  readonly executionId: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly phase?: AttemptPhase;
  readonly dispatchToken?: string;
  /** When set, records a pid identity (engine-shaped: wall clock at spawn). */
  readonly pid?: number;
  readonly pidCreationTime?: string;
  /** When true, enqueues the dispatch-requested outbox message (the engine commits it with the row). */
  readonly withDispatchOutbox?: boolean;
}

/**
 * Create an attempt row exactly the way the engine's PREPARING transaction
 * does (row + dispatch outbox together), then walk the phase to the requested
 * one and stamp the pid identity the way the engine does right after spawn.
 */
export function makeAttempt(db: DatabaseSync, options: MakeAttemptOptions): void {
  const runId = options.runId ?? "run-1";
  const nodeId = options.nodeId ?? "node-1";
  const attempt = options.attempt ?? 1;
  const phase = options.phase ?? "PREPARING";
  const dispatchToken = options.dispatchToken ?? `dt-${options.executionId}`;
  createActiveAttempt(db, {
    id: options.executionId,
    runId,
    nodeId,
    definitionRevision: "rev-1",
    attempt,
    dispatchToken,
    phase: "PREPARING",
    sessionId: null,
    now: T0
  });
  if (options.withDispatchOutbox !== false) {
    enqueueOutboxMessage(db, {
      id: `ob-rec-${options.executionId.replace(/[^a-z0-9_-]/g, "-")}`,
      aggregateId: options.executionId,
      type: "execution.dispatch-requested",
      payload: { executionId: options.executionId, runId, nodeId, attempt, dispatchToken },
      now: T0
    });
  }
  if (phase !== "PREPARING") {
    setAttemptPhase(db, { id: options.executionId, phase, wherePhaseIn: ["PREPARING"], now: iso(1) });
  }
  if (options.pid !== undefined) {
    setExecutionPidIdentity(db, {
      id: options.executionId,
      pidIdentity: {
        pid: options.pid,
        creationTime: options.pidCreationTime ?? nowIso(),
        executionNonce: randomUUID(),
        target: "windows-native"
      },
      now: iso(2)
    });
  }
}

/** A directory an engine launch can use as cwd (the stdin prompt file lands here). */
export function makeWorkDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ro-reconcile-cwd-${label}-`));
}

export interface HoldProcess {
  readonly pid: number;
  stop(): Promise<void>;
}

/** Spawn a REAL long-lived process: the fake-cli dist bin holding forever. */
export function spawnFakeCliHold(scenario: "timeout" = "timeout"): HoldProcess {
  const bin = fakeBinPath("claude");
  const child = spawn(process.execPath, [bin, "--scenario", scenario], {
    stdio: "ignore",
    windowsHide: true
  });
  if (child.pid === undefined) {
    throw new Error("fake-cli hold process failed to spawn");
  }
  return {
    pid: child.pid,
    stop: async () => {
      child.kill();
    }
  };
}

/** Spawn a placeholder `cmd.exe /d /c ping -n <n>` (a REAL second process). */
export function spawnCmdPlaceholder(pings: number): HoldProcess {
  const child = spawn("cmd.exe", ["/d", "/c", "ping", "-n", String(pings), "127.0.0.1"], {
    stdio: "ignore",
    windowsHide: true
  });
  if (child.pid === undefined) {
    throw new Error("cmd placeholder failed to spawn");
  }
  return {
    pid: child.pid,
    stop: async () => {
      child.kill();
    }
  };
}
