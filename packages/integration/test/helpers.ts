/**
 * Shared test plumbing for the M2-04 integration suite.
 *
 * Discipline mirrors packages/worktree/test/helpers.ts: every fixture
 * repository is created BY THE TESTS via git inside the SYSTEM TEMP directory
 * — never inside the H:\role-orchestrator workspace, which must stay a
 * non-git working area. No force/reset/clean/remote anywhere; teardown walks
 * the tree with whitelisted primitives (M0-05: fs.rm is broken on
 * Node 25/win32 for non-ASCII paths).
 *
 * Fixture commits use a FIXED author/committer date so identical content in
 * two independent fixture repos produces identical SHAs — that is what makes
 * the cross-repo determinism assertion of A25 possible.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmodSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  appliedMigrationRecords,
  createProject,
  createTaskRun,
  openDatabase
} from "@role-orchestrator/store";
import { GitRunner } from "@role-orchestrator/worktree";
import { applyIntegrationMigrations } from "../src/index.js";

/** Fixed clock base so DB timestamps are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** The fixture commit identity: fixed dates -> cross-repo identical SHAs. */
export const FIXTURE_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

export interface ParentBranchFixture {
  readonly nodeId: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly headSha: string;
}

export interface IntegrationFixture {
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly git: GitRunner;
  readonly runId: string;
  readonly baseSha: string;
  /** Creates one exec writer branch + worktree, commits one file, returns the accepted output. */
  createParentBranch: (input: {
    readonly nodeId: string;
    readonly attempt?: number;
    readonly fileName: string;
    readonly content: string;
  }) => Promise<ParentBranchFixture>;
  /** Current HEAD of a branch (lowercase 40-hex or null). */
  branchHead: (branch: string) => Promise<string | null>;
  /** All commit SHAs of a branch, oldest first. */
  branchCommits: (branch: string) => Promise<string[]>;
  readFile: (relativePath: string) => string;
}

export function makeScratchDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `ro-integration-${label}-`));
}

/**
 * git init + fixed-identity seed commit + a run row in a fully migrated DB.
 * The seed content differs per label so independent fixtures never collide on
 * object identity; cross-repo determinism tests create the SAME label layout
 * twice (identical seed content) on purpose.
 */
export async function createIntegrationFixture(
  label: string,
  options?: {
    /** Seed file content map; defaults to one seed.txt (deterministic). */
    readonly seedFiles?: Readonly<Record<string, string>>;
    readonly runId?: string;
  }
): Promise<IntegrationFixture> {
  const scratchDir = makeScratchDir(label);
  const repoPath = path.join(scratchDir, "repo");
  const worktreesRoot = path.join(scratchDir, "worktrees");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  const git = new GitRunner();
  await git.run(repoPath, ["init", "-b", "main"]);
  await git.run(repoPath, ["config", "core.autocrlf", "false"]);
  await git.run(repoPath, ["config", "user.email", "fixture@example.com"]);
  await git.run(repoPath, ["config", "user.name", "fixture"]);

  const seedFiles = options?.seedFiles ?? { "seed.txt": "seed content v1\n" };
  for (const [relativePath, content] of Object.entries(seedFiles)) {
    writeFileSync(path.join(repoPath, relativePath), content, "utf8");
    await git.run(repoPath, ["add", relativePath]);
  }
  await git.run(repoPath, ["commit", "-m", "seed"], { env: { ...FIXTURE_COMMIT_ENV } });
  const baseSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();

  const runId = options?.runId ?? "run-1";

  const createParentBranch = async (input: {
    readonly nodeId: string;
    readonly attempt?: number;
    readonly fileName: string;
    readonly content: string;
  }): Promise<ParentBranchFixture> => {
    const attempt = input.attempt ?? 1;
    const branch = `exec/${runId}/${input.nodeId}/${String(attempt)}`;
    const worktreePath = path.join(worktreesRoot, runId, input.nodeId, String(attempt));
    await git.run(repoPath, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
    writeFileSync(path.join(worktreePath, input.fileName), input.content, "utf8");
    await git.run(worktreePath, ["add", input.fileName]);
    await git.run(worktreePath, ["commit", "-m", `output ${input.nodeId}`], {
      env: { ...FIXTURE_COMMIT_ENV }
    });
    const headSha = (await git.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    return { nodeId: input.nodeId, branch, worktreePath, headSha };
  };

  const branchHead = async (branch: string): Promise<string | null> => {
    const result = await git.tryRun(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim();
  };

  const branchCommits = async (branch: string): Promise<string[]> => {
    const result = await git.run(repoPath, ["log", "--format=%H", branch]);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  };

  const readFile = (relativePath: string): string =>
    readFileSync(path.join(repoPath, ...relativePath.split("/")), "utf8");

  return {
    scratchDir,
    repoPath,
    worktreesRoot,
    git,
    runId,
    baseSha,
    createParentBranch,
    branchHead,
    branchCommits,
    readFile
  };
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/** Fresh file-backed DB with migrations 001..005 applied and verified. */
export function createMigratedFileDb(label: string, repoRoot: string, runId = "run-1"): TestDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ro-integration-db-${label}-`));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyIntegrationMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 5 || records[4]?.version !== 5) {
    db.close();
    throw new Error("test helper: migrations 001..005 were not applied");
  }
  const projectId = "proj-1";
  createProject(db, {
    id: projectId,
    repoRoot,
    executionTarget: "windows-native",
    trustStatus: "untrusted",
    now: T0
  });
  createTaskRun(db, {
    id: runId,
    projectId,
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "snap-hash",
    baseSha: "0".repeat(40),
    now: T0
  });
  return { db, dbPath, close: () => db.close() };
}

/** Insert one task_nodes row directly (test setup only, dag test precedent). */
export function insertTaskNode(
  db: DatabaseSync,
  input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly state?: "PENDING" | "READY" | "RUNNING";
    readonly dependencies?: readonly string[];
  }
): void {
  db.prepare(
    "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
      "VALUES (?, ?, '1', 'developer', ?, ?, ?, ?)"
  ).run(
    input.runId,
    input.nodeId,
    JSON.stringify(input.dependencies ?? []),
    input.state ?? "PENDING",
    T0,
    T0
  );
}

/**
 * A DatabaseSync proxy that simulates the A25 crash: the wrapped `prepare`
 * throws for the FIRST statement matching `matchSql`, so the code under test
 * dies exactly between "git committed" and "DB updated". Everything before
 * the matched statement already committed (separate autocommit statements),
 * which is precisely the real window.
 */
export function dbCrashingOn(db: DatabaseSync, matchSql: (sql: string) => boolean): DatabaseSync {
  return new Proxy(db, {
    get(target, prop, _receiver) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          if (matchSql(sql)) {
            throw new Error("SIMULATED CRASH: process died between git commit and DB update");
          }
          type PrepareFn = (sql: string, ...rest: unknown[]) => unknown;
          return (target.prepare as unknown as PrepareFn)(sql, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  }) as DatabaseSync;
}

export async function expectRejection<T extends Error>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => T
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof errorClass) return error;
    throw new Error(`expected ${errorClass.name}, got: ${String(error)}`);
  }
  throw new Error(`expected ${errorClass.name} to be rejected, but the promise resolved`);
}

/**
 * Recursive removal with whitelisted primitives (see worktree helpers).
 * Teardown must never mask the real result and never use fs.rm (M0-05).
 */
export function removeTreeRobust(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // already gone
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stats = statSync(entryPath, { throwIfNoEntry: false });
    if (stats?.isDirectory() === true) {
      removeTreeRobust(entryPath);
    } else {
      try {
        unlinkSync(entryPath);
      } catch {
        try {
          chmodSync(entryPath, 0o666);
          unlinkSync(entryPath);
        } catch {
          // best effort
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
