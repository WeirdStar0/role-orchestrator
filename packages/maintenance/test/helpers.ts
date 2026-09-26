/**
 * Shared test plumbing for the maintenance suite (M6-02).
 *
 * The workspace root H:\role-orchestrator stays a NON-git area: every fixture
 * repository is created via `git init` INSIDE the system temp directory, and
 * every cleanup scan gets its OWN isolated temp root so concurrent package
 * test runs (review workspaces, store temp DBs) can never leak into the
 * assertions. Teardown uses whitelisted removal primitives because M0-05
 * showed fs.rm is broken on Node 25/win32 for non-ASCII paths.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { chmodSync, rmdirSync, statSync, unlinkSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  createActiveAttempt,
  createProject,
  createTaskRun,
  enqueueOutboxMessage,
  openDatabase,
  setAttemptPhase
} from "@role-orchestrator/store";
import { proposeMemory } from "@role-orchestrator/memory";
import { GitRunner } from "@role-orchestrator/worktree";
import { createWorktree } from "@role-orchestrator/worktree";
import { DAEMON_MIGRATIONS } from "../src/index.js";

export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

export function makeScratchDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `ro-maint-${label}-`));
}

export interface FixtureRepo {
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly tempRoot: string;
  readonly evidenceRoot: string;
  readonly git: GitRunner;
  headSha: () => Promise<string>;
}

/**
 * One isolated world: a git fixture repo, an engine worktrees root, a private
 * temp root (for validation workspaces / temp DBs) and an evidence root.
 */
export async function createFixtureWorld(label: string): Promise<FixtureRepo> {
  const scratchDir = makeScratchDir(label);
  const repoPath = path.join(scratchDir, "repo");
  const worktreesRoot = path.join(scratchDir, "worktrees");
  const tempRoot = path.join(scratchDir, "temp");
  const evidenceRoot = path.join(scratchDir, "evidence");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });

  const git = new GitRunner();
  await git.run(repoPath, ["init", "-b", "main"]);
  await git.run(repoPath, ["config", "core.autocrlf", "false"]);
  await git.run(repoPath, ["config", "user.email", "fixture@example.com"]);
  await git.run(repoPath, ["config", "user.name", "fixture"]);
  writeFileSync(path.join(repoPath, "seed.txt"), "seed v1\n", "utf8");
  await git.run(repoPath, ["add", "seed.txt"]);
  await git.run(repoPath, ["commit", "-m", "seed"]);

  return {
    scratchDir,
    repoPath,
    worktreesRoot,
    tempRoot,
    evidenceRoot,
    git,
    headSha: async () => (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim()
  };
}

export interface DaemonDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly scratchDir: string;
  close(): void;
}

/** Open a fresh file database with the FULL daemon chain (001..017) applied. */
export function createDaemonDb(label: string): DaemonDb {
  const scratchDir = makeScratchDir(label);
  const dbPath = path.join(scratchDir, "daemon.db");
  const db = openDatabase(dbPath);
  void applyMigrations(db, { now: T0, migrations: DAEMON_MIGRATIONS });
  const versions = db
    .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
    .get();
  if (Number(versions?.n) !== DAEMON_MIGRATIONS.length) {
    db.close();
    throw new Error("test helper: daemon migrations were not applied synchronously");
  }
  return { db, dbPath, scratchDir, close: () => db.close() };
}

/**
 * A finished execution worktree: run + node + attempt recorded as SUCCEEDED,
 * created through the REAL worktree lifecycle (fixed baseSha, engine root).
 */
export async function createFinishedExecutionWorktree(
  world: FixtureRepo,
  db: DatabaseSync,
  ids: { readonly runId: string; readonly nodeId: string; readonly attempt: number }
): Promise<{ readonly worktreePath: string; readonly branch: string }> {
  createProject(db, {
    id: `proj-${ids.runId}`,
    repoRoot: `h:/repos/${ids.runId}`,
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createTaskRun(db, {
    id: ids.runId,
    projectId: `proj-${ids.runId}`,
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-1",
    baseSha: "base",
    now: T0
  });
  const baseSha = await world.headSha();
  const created = await createWorktree(world.git, {
    repoPath: world.repoPath,
    worktreesRoot: world.worktreesRoot,
    runId: ids.runId,
    nodeId: ids.nodeId,
    attempt: ids.attempt,
    baseSha
  });
  createActiveAttempt(db, {
    id: `exec-${ids.runId}-${ids.nodeId}-${ids.attempt}`,
    runId: ids.runId,
    nodeId: ids.nodeId,
    definitionRevision: "rev-1",
    attempt: ids.attempt,
    dispatchToken: `dt-${ids.runId}-${ids.nodeId}-${ids.attempt}`,
    phase: "STARTING",
    now: T0
  });
  setAttemptPhase(db, { id: `exec-${ids.runId}-${ids.nodeId}-${ids.attempt}`, phase: "SUCCEEDED", now: T0 });
  return { worktreePath: created.worktreePath, branch: created.branch };
}

/** Marks a worktree DIRTY: one untracked file = undelivered work (A40). */
export function makeWorktreeDirty(worktreePath: string): void {
  writeFileSync(path.join(worktreePath, "undelivered.txt"), "not committed\n", "utf8");
}

/**
 * Integration worktree: registers a `task/<run-id>` worktree under
 * `<worktreesRoot>/_integration/<run-id>` — the frozen layout the
 * integration package uses — via plain git (the integration service itself
 * needs candidate machinery the cleanup tests do not exercise).
 */
export async function createIntegrationWorktree(
  world: FixtureRepo,
  runId: string
): Promise<string> {
  const worktreePath = `${world.worktreesRoot.replace(/[\\/]+$/, "")}/_integration/${runId}`;
  const baseSha = await world.headSha();
  await world.git.run(world.repoPath, ["worktree", "add", "-b", `task/${runId}`, worktreePath, baseSha]);
  return worktreePath;
}

/** Raw review_records row (schema-checked by SQLite itself). */
export function insertReviewRecord(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly state: "IN_PROGRESS" | "COMPLETED" | "INVALID";
    readonly validationTempRoot: string;
  }
): void {
  db.prepare(
    "INSERT INTO review_records(id, run_id, node_id, candidate_sha, state, repo_path, baseline_worktree_path, " +
      "validation_workspace_path, validation_temp_root, baseline_file_count, baseline_digest, baseline_manifest, " +
      "evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    input.id,
    input.runId,
    "node-1",
    "a".repeat(40),
    input.state,
    "h:/repos/fixture",
    "h:/repos/fixture-baseline",
    `${input.validationTempRoot}/workspace`,
    input.validationTempRoot,
    1,
    "digest-1",
    JSON.stringify({ synthetic: true }),
    JSON.stringify([]),
    T0,
    T0
  );
}

/** Raw integration_records row (state machine values as CHECK-constrained). */
export function insertIntegrationRecord(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly state: "IN_PROGRESS" | "COMPLETED" | "PAUSED_CONFLICT";
  }
): void {
  db.prepare(
    "INSERT INTO integration_records(id, run_id, node_id, integration_id, state, integration_branch, " +
      "integration_worktree_path, base_sha, input_sha_set, manifest, candidate_sha, conflict_files, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    input.id,
    input.runId,
    "node-1",
    `integ-${input.id}`,
    input.state,
    `task/${input.runId}`,
    `h:/wt/_integration/${input.runId}`,
    "0".repeat(40),
    JSON.stringify(["0".repeat(40)]),
    JSON.stringify({ synthetic: true }),
    input.state === "COMPLETED" ? "1".repeat(40) : null,
    input.state === "PAUSED_CONFLICT" ? JSON.stringify(["src/a.ts"]) : null,
    T0,
    T0
  );
}

/** Real business data through store APIs: project/run/execution/events/memory/outbox. */
export function seedBusinessData(db: DatabaseSync, runId: string): void {
  createProject(db, {
    id: `proj-${runId}`,
    repoRoot: `h:/repos/${runId}`,
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createTaskRun(db, {
    id: runId,
    projectId: `proj-${runId}`,
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-1",
    baseSha: "base",
    now: T0
  });
  createActiveAttempt(db, {
    id: `exec-${runId}`,
    runId,
    nodeId: "node-1",
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: `dt-${runId}`,
    phase: "STARTING",
    now: T0
  });
  proposeMemory(db, {
    id: `mem-${runId}`,
    projectId: `proj-${runId}`,
    type: "discovery",
    content: "fixture discovery memory",
    evidenceRefs: [],
    actor: { kind: "role", roleId: "developer", executionId: `exec-${runId}` },
    now: T0
  });
  enqueueOutboxMessage(db, {
    id: `msg-${runId}`,
    aggregateId: runId,
    type: "run.completed",
    payload: { synthetic: true },
    now: T0
  });
}

/** A published (= delivered) outbox row, inserted directly. */
export function insertPublishedOutboxRow(db: DatabaseSync, id: string): void {
  db.prepare(
    "INSERT INTO outbox(id, aggregate_id, type, payload, attempts, claim_token, claim_expires_at, published_at, created_at) " +
      "VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, ?)"
  ).run(id, "agg-1", "residue.published", JSON.stringify({ synthetic: true }), T0, T0);
}

/** Robust recursive removal for teardown (read-only pack files included). */
export function removeTreeRobust(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stats = statSync(entryPath, { throwIfNoEntry: false });
    if (stats?.isDirectory() === true) {
      removeTreeRobust(entryPath);
    } else if (stats !== undefined) {
      try {
        unlinkSync(entryPath);
      } catch {
        try {
          chmodSync(entryPath, 0o666);
          unlinkSync(entryPath);
        } catch {
          // teardown must never mask the real result
        }
      }
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // best effort
  }
}
