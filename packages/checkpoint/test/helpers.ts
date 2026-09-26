/**
 * Shared test plumbing for the M4-02 checkpoint suite.
 *
 * Everything runs under the SYSTEM temp directory — never inside
 * H:\role-orchestrator, which stays a non-git area. The E2E suites spawn the
 * BUILT fake-cli dist bin (dogfood); the pure suites only need the migrated
 * database.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import {
  appliedMigrationRecords,
  createProject,
  openDatabase,
  createActiveAttempt,
  setAttemptPhase,
  type ExecutionRow
} from "@role-orchestrator/store";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { createRunGraph, transitionNodeState } from "@role-orchestrator/dag";
import { applyCheckpointMigrations, openApprovalCheckpoint } from "../src/index.js";
import type { ActionProposal, PermissionId } from "../src/index.js";

/**
 * Fixture execution target follows the RUNNING platform: A29 binds fixture
 * path forms to the target's own world, so a windows-native fixture cannot be
 * seeded from POSIX temp dirs. Domain assertions are platform-independent;
 * launcher-bound cells are additionally win32-gated at the test level.
 */
const FIXTURE_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";


/** Fixed clock base so expiry comparisons are deterministic. */
export const T0 = "2026-09-23T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** 40-hex SHAs — the descriptor contract requires CommitSha-shaped values. */
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** The BUILT fake-cli dist bin (dogfood path) — never a real claude/codex. */
export function fakeBinPath(dialect: FakeDialect): string {
  const bin = path.resolve(testDir, "..", "..", "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new Error(`fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`);
  }
  return bin;
}

export type FakeDialect = "claude" | "codex";

/** A directory an execution can run in (the engine's stdin prompt file lands here). */
export function makeWorkDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ro-checkpoint-cwd-${label}-`));
}

/** Synthetic host-CLI-like config dir with the two declared baseline files. */
export function makeConfigDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), `ro-checkpoint-cfg-`)), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface WorldOptions {
  readonly dialect?: FakeDialect;
  /** Point the profile executable at the fake-cli dist bin (spawn-capable E2E). */
  readonly forSpawn?: boolean;
  readonly runId?: string;
}

export interface World {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly scratchDir: string;
  readonly projectId: string;
  readonly profileId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly dialect: FakeDialect;
  readonly executable: string;
  close(): void;
}

/**
 * Fully migrated world (migrations 001..012): project + profile + revision 1
 * + four bound roles + a run with frozen snapshots + a single-node graph
 * (node-1, developer). baseSha is 40-hex so descriptors built over it are
 * valid CommitSha values.
 */
export async function createCheckpointWorld(label: string, options: WorldOptions = {}): Promise<World> {
  const dialect = options.dialect ?? "claude";
  const runId = options.runId ?? "run-1";
  const scratchDir = mkdtempSync(join(tmpdir(), `ro-checkpoint-${label}-`));
  const dbPath = join(scratchDir, "store.db");
  const db = openDatabase(dbPath);
  void applyCheckpointMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 12 || records[11]?.version !== 12) {
    db.close();
    throw new Error("test helper: migrations 001..012 were not applied");
  }

  const projectId = "proj-1";
  const profileId = "profile-fake";
  const executable = options.forSpawn === true ? fakeBinPath(dialect) : "claude.cmd";

  createProject(db, {
    id: projectId,
    repoRoot: "h:/repos/proj-1",
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createProfile(db, {
    id: profileId,
    runtime: dialect,
    executable,
    executionTarget: FIXTURE_TARGET,
    configDir: makeConfigDir(),
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
    baseSha: SHA_A,
    now: T0
  });
  createRunGraph(db, {
    runId,
    workflow: {
      id: "wf-1",
      name: "workflow-wf-1",
      nodes: [
        {
          id: "node-1",
          role: "developer",
          title: "title-node-1",
          objective: "objective-node-1",
          dependencies: [],
          capabilityTags: ["backend"],
          acceptanceCriteria: ["criteria-node-1"]
        }
      ]
    },
    now: T0
  });
  return {
    db,
    dbPath,
    scratchDir,
    projectId,
    profileId,
    runId,
    nodeId: "node-1",
    dialect,
    executable,
    close: () => db.close()
  };
}

/**
 * Create a TERMINAL attempt row without spawning anything (pure-suite
 * helper): the checkpoint's precondition is an execution that has ended.
 */
export function seedTerminalExecution(
  db: DatabaseSync,
  input: {
    readonly executionId: string;
    readonly runId: string;
    readonly nodeId?: string;
    readonly attempt?: number;
    readonly dispatchToken?: string;
    readonly finalPhase?: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELLED";
    readonly now?: string;
  }
): ExecutionRow {
  const nodeId = input.nodeId ?? "node-1";
  const attempt = input.attempt ?? 1;
  const now = input.now ?? T0;
  createActiveAttempt(db, {
    id: input.executionId,
    runId: input.runId,
    nodeId,
    definitionRevision: "1",
    attempt,
    dispatchToken: input.dispatchToken ?? `dt-${input.executionId}`,
    phase: "PREPARING",
    now
  });
  setAttemptPhase(db, { id: input.executionId, phase: "STARTING", wherePhaseIn: ["PREPARING"], now });
  setAttemptPhase(db, { id: input.executionId, phase: "RUNNING", wherePhaseIn: ["STARTING"], now });
  setAttemptPhase(db, {
    id: input.executionId,
    phase: input.finalPhase ?? "FAILED",
    wherePhaseIn: ["RUNNING"],
    now
  });
  return requireExecutionRow(db, input.executionId);
}

function requireExecutionRow(db: DatabaseSync, id: string): ExecutionRow {
  const row = requireExecutionOrNull(db, id);
  if (row === null) throw new Error(`test helper: execution "${id}" was not created`);
  return row;
}

function requireExecutionOrNull(db: DatabaseSync, id: string): ExecutionRow | null {
  const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return null;
  return {
    id: String(row["id"]),
    runId: String(row["run_id"]),
    nodeId: String(row["node_id"]),
    definitionRevision: String(row["definition_revision"]),
    attempt: Number(row["attempt"]),
    phase: String(row["phase"]) as ExecutionRow["phase"],
    dispatchToken: String(row["dispatch_token"]),
    sessionId: row["session_id"] === null ? null : String(row["session_id"]),
    pidIdentity: row["pid_identity"] === null ? null : String(row["pid_identity"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"])
  };
}

/** The graph readies node-1 on creation; move it to RUNNING (the pre-checkpoint state). */
export function markNodeRunning(db: DatabaseSync, runId: string, nodeId = "node-1"): void {
  transitionNodeState(db, { runId, nodeId, to: "RUNNING", whereStateIn: ["READY"], now: T0 });
}

let proposalCounter = 0;

/**
 * A controlled unscoped-write proposal (high risk after grading: the
 * unscoped write + the repo.write increment). Distinct ids/argv per call so
 * digests never collide across tests.
 */
export function sampleProposal(
  overrides: Partial<ActionProposal["action"]> = {},
  proposalId?: string
): ActionProposal {
  proposalCounter += 1;
  const id = proposalId ?? `propose-${String(proposalCounter)}`;
  return {
    schemaVersion: 1,
    proposalId: id,
    action: {
      argv: ["fake-agent", "write", "--path", `h:/worktrees/demo/file-${String(proposalCounter)}.txt`],
      dimensions: ["write"],
      writeScope: "unscoped",
      requiredPermissions: ["repo.write"],
      requiredCapabilities: ["claude.noninteractive-entry"],
      targetSha: null,
      requiresInteractiveApproval: false,
      ...overrides
    },
    source: {
      eventType: "approval_requested",
      sourceType: "control_request",
      eventSeq: 3,
      requestId: `req-${String(proposalCounter)}`
    }
  };
}

/** openApprovalCheckpoint with the world's defaults (deterministic cwd). */
export function openWorldCheckpoint(
  world: World,
  input: {
    readonly executionId: string;
    readonly proposal: ActionProposal;
    readonly now?: string;
    readonly cwd?: string;
    readonly grantedPermissions?: readonly PermissionId[];
  }
): ReturnType<typeof openApprovalCheckpoint> {
  return openApprovalCheckpoint(world.db, {
    executionId: input.executionId,
    proposal: input.proposal,
    // The cwd feeds the A17 digest; a DETERMINISTIC default keeps replays of
    // the same proposal comparable (tests needing a real directory pass one).
    cwd: input.cwd ?? "h:/worktrees/checkpoint-open",
    grantedPermissions: input.grantedPermissions ?? ["repo.read"],
    ttlSeconds: 3600,
    now: input.now ?? iso(1000)
  });
}

// ---------------------------------------------------------------------------
// Polling / process helpers for the E2E suites (real subprocess assertions)
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}`);
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
  throw new Error(`pid ${String(pid)} is still alive ${String(timeoutMs)}ms after termination`);
}

/** Narrow helper: run fn, require it to throw the given error class. */
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
