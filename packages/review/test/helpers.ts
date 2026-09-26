/**
 * Shared test plumbing for the M2-05 review suite.
 *
 * Discipline mirrors packages/integration/test/helpers.ts: every fixture
 * repository is created BY THE TESTS via git inside the SYSTEM TEMP directory
 * — never inside the H:\role-orchestrator workspace, which must stay a
 * non-git working area. No force/reset/clean/remote anywhere; teardown walks
 * the tree with whitelisted primitives (M0-05: fs.rm is broken on
 * Node 25/win32 for non-ASCII paths).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appliedMigrationRecords, createProject, createTaskRun, openDatabase } from "@role-orchestrator/store";
import { GitRunner } from "@role-orchestrator/worktree";
import { applyReviewMigrations } from "../src/index.js";

/** Fixed clock base so DB timestamps are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** The fixture commit identity: fixed dates -> deterministic SHAs. */
export const FIXTURE_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

export interface ReviewFixture {
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly git: GitRunner;
  readonly runId: string;
  readonly baseSha: string;
  /**
   * Commit one file on the fixture's integration line (main) and return the
   * new head SHA — the next "candidateSha" an integration service would hand
   * to the reviewer.
   */
  createCandidate: (input: { readonly fileName: string; readonly content: string }) => Promise<string>;
  readFile: (absolutePath: string) => string;
}

export function makeScratchDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `ro-review-${label}-`));
}

export async function createReviewFixture(
  label: string,
  options?: { readonly runId?: string; readonly seedFiles?: Readonly<Record<string, string>> }
): Promise<ReviewFixture> {
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

  const seedFiles = options?.seedFiles ?? { "src/app.ts": "export const app = true;\n" };
  for (const [relativePath, content] of Object.entries(seedFiles)) {
    const absolute = path.join(repoPath, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
    await git.run(repoPath, ["add", relativePath]);
  }
  await git.run(repoPath, ["commit", "-m", "seed"], { env: { ...FIXTURE_COMMIT_ENV } });
  const baseSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();

  const runId = options?.runId ?? "run-1";

  const createCandidate = async (input: {
    readonly fileName: string;
    readonly content: string;
  }): Promise<string> => {
    const absolute = path.join(repoPath, ...input.fileName.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, input.content, "utf8");
    await git.run(repoPath, ["add", input.fileName]);
    await git.run(repoPath, ["commit", "-m", `candidate ${input.fileName}`], {
      env: { ...FIXTURE_COMMIT_ENV }
    });
    return (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  };

  const readFile = (absolutePath: string): string => readFileSync(absolutePath, "utf8");

  return { scratchDir, repoPath, worktreesRoot, git, runId, baseSha, createCandidate, readFile };
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/** Fresh file-backed DB with migrations 001..006 applied and a run row. */
export function createMigratedFileDb(label: string, repoRoot: string, runId = "run-1"): TestDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ro-review-db-${label}-`));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyReviewMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 6 || records[5]?.version !== 6) {
    db.close();
    throw new Error("test helper: migrations 001..006 were not applied");
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
