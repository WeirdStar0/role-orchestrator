/**
 * Shared test plumbing for the M4-03 expansion suite.
 *
 * Discipline mirrors the review/engine suites: every fixture repository is
 * created BY THE TESTS via git inside the SYSTEM TEMP directory — never
 * inside the H:\role-orchestrator workspace, which must stay a non-git
 * working area. No force/reset/clean/remote anywhere; teardown walks the tree
 * with whitelisted primitives (M0-05: fs.rm is broken on Node 25/win32 for
 * non-ASCII paths). No real claude/codex is ever invoked: the dogfood CLI is
 * the built `packages/fake-cli` dist bin.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { createProject, openDatabase } from "@role-orchestrator/store";
import { createRunGraph } from "@role-orchestrator/dag";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import {
  completeReviewRecord,
  createReviewRecord,
  manifestDigest,
  reviewIdFor
} from "@role-orchestrator/review";
import { applyMigrations, appliedMigrationRecords } from "@role-orchestrator/store";
import { BUDGET_SCHEMA_MIGRATION } from "@role-orchestrator/budget";
import { GitRunner } from "@role-orchestrator/worktree";
import { EXPAND_MIGRATIONS, applyExpandMigrations } from "../src/index.js";

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


/** Fixed clock base so DB timestamps are deterministic. */
export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

const testDir = path.dirname(fileURLToPath(import.meta.url));

export function fakeBinPath(dialect: "claude" | "codex" = "claude"): string {
  const bin = path.resolve(testDir, "..", "..", "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new Error(`fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`);
  }
  return bin;
}

/** Synthetic, non-credential config dir with the two declared baseline files. */
export function makeConfigDir(): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "ro-expand-cfg-")), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), '{"synthetic":true}\n', "utf8");
  writeFileSync(path.join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export function makeScratchDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `ro-expand-${label}-`));
}

export interface TestDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  close(): void;
}

/**
 * Fresh file-backed DB with the FULL migration chain 001..013 applied
 * (core -> profiles -> task_nodes -> scheduler -> integration -> review ->
 * context -> memories -> source/staleness -> rebuild -> approvals ->
 * approval checkpoints -> review expansions), post-condition verified.
 */
export function createExpandedDb(label: string): TestDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ro-expand-db-${label}-`));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyExpandMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 13 || records[12]?.version !== 13) {
    db.close();
    throw new Error("test helper: migrations 001..013 were not applied");
  }
  return { db, dbPath, close: () => db.close() };
}

/**
 * Fresh file-backed DB with the FULL migration chain INCLUDING the budget
 * migration (001..013 + 014) — the shape the M4-04 scheduling enforcement
 * tests need (expansion holds + budget tables in one schema).
 */
export function createExpandedBudgetDb(label: string): TestDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ro-expand-db-budget-${label}-`));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase(dbPath);
  void applyMigrations(db, { now: T0, migrations: [...EXPAND_MIGRATIONS, BUDGET_SCHEMA_MIGRATION] });
  const records = appliedMigrationRecords(db);
  if (records.length !== 14 || records[13]?.version !== 14) {
    db.close();
    throw new Error('test helper: migrations 001..013+014 were not applied');
  }
  return { db, dbPath, close: () => db.close() };
}

const ROLE_ID_LIST: readonly RoleId[] = ["coordinator", "architect", "developer", "reviewer"];

// ---------------------------------------------------------------------------
// Workflow fixtures — RAW (unparsed) input so createRunGraph exercises the
// full schema + graph path a Coordinator's plan would arrive through.
// ---------------------------------------------------------------------------

export function rawNode(input: {
  readonly id: string;
  readonly role: RoleId;
  readonly dependencies?: readonly string[];
}): Record<string, unknown> {
  return {
    id: input.id,
    role: input.role,
    title: `title-${input.id}`,
    objective: `objective-${input.id}`,
    dependencies: input.dependencies ?? [],
    capabilityTags: ["backend"],
    acceptanceCriteria: [`criteria-${input.id}`]
  };
}

export function rawWorkflow(nodes: readonly Record<string, unknown>[], id = "wf-1"): unknown {
  return { id, name: `workflow-${id}`, nodes };
}

export interface SeedRunOptions {
  readonly runId: string;
  readonly projectId?: string;
  readonly profileId?: string;
  /** Profile executable; defaults to a non-spawnable fixture name. */
  readonly executable?: string;
  /** RAW workflow nodes; defaults to dev_a -> review_0. */
  readonly nodes?: readonly Record<string, unknown>[];
}

export interface SeedRunResult {
  readonly projectId: string;
  readonly profileId: string;
  readonly runId: string;
}

/**
 * Seed project + profile + the four bound roles + a frozen run snapshot over
 * them, then create the run's graph (the M2-01/M2-02 path). The default plan
 * is the A20 shape: `dev_a` (developer) reviewed by `review_0` (reviewer).
 */
export async function seedExpansionRun(db: DatabaseSync, options: SeedRunOptions): Promise<SeedRunResult> {
  const projectId = options.projectId ?? "proj-1";
  const profileId = options.profileId ?? "profile-fake";
  const runId = options.runId;

  createProject(db, {
    id: projectId,
    repoRoot: process.platform === "win32" ? `h:/repos/${projectId}` : `/repos/${projectId}`,
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createProfile(db, {
    id: profileId,
    runtime: "claude",
    executable: options.executable ?? `${profileId}.cmd`,
    executionTarget: FIXTURE_TARGET,
    configDir: makeConfigDir(),
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
  await createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId,
    taskId: `task-${runId}`,
    graphRevision: 0,
    baseSha: "base-sha-1",
    now: T0
  });
  createRunGraph(db, {
    runId,
    workflow: rawWorkflow(options.nodes ?? [rawNode({ id: "dev_a", role: "developer" }), rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })]),
    now: T0
  });
  return { projectId, profileId, runId };
}

// ---------------------------------------------------------------------------
// Verdict fixtures — a COMPLETED fail/pass record via the M2-05 record API
// (the same store layer the full session machinery persists through).
// ---------------------------------------------------------------------------

const FAKE_FILE_SHA = "b".repeat(64);

function fakeBaseline(candidateSha: string) {
  const files = [{ path: "src/app.ts", sha256: FAKE_FILE_SHA }];
  return { candidateSha, fileCount: files.length, digest: manifestDigest(files), files };
}

export function recordVerdict(
  db: DatabaseSync,
  input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly candidateSha: string;
    readonly verdict: "pass" | "fail" | "blocked";
    readonly findings?: readonly string[];
    readonly repoPath?: string;
    readonly now: string;
  }
): string {
  const reviewId = reviewIdFor(input.runId, input.nodeId, input.candidateSha, input.now);
  createReviewRecord(db, {
    reviewId,
    runId: input.runId,
    nodeId: input.nodeId,
    candidateSha: input.candidateSha,
    repoPath: input.repoPath ?? "h:/repos/fixture",
    baselineWorktreePath: "h:/worktrees/fixture-baseline",
    validationWorkspacePath: "h:/worktrees/fixture-workspace",
    validationTempRoot: "h:/worktrees/fixture-root",
    baseline: fakeBaseline(input.candidateSha),
    now: input.now
  });
  completeReviewRecord(db, {
    reviewId,
    review: {
      verdict: input.verdict,
      candidateSha: input.candidateSha,
      evidenceRefs: ["evidence-fixture-1"],
      findings: [...(input.findings ?? [`finding against ${input.candidateSha}`])]
    },
    evidence: [
      {
        artifactRef: { id: "evidence-fixture-1", kind: "report" },
        summary: "fixture review evidence",
        exitCode: 0,
        recordedAt: input.now
      }
    ],
    now: input.now
  });
  return reviewId;
}

/** A syntactically valid 40-hex candidate identity for fixture verdicts. */
export function fakeSha(seed: string): string {
  // Deterministic 40-hex value derived from the seed (test-only identity).
  let hex = "";
  for (let i = 0; i < 40; i++) {
    hex += ((seed.charCodeAt(i % seed.length) + i * 7) % 16).toString(16);
  }
  return hex;
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

export interface GitFixture {
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly git: GitRunner;
  readonly baseSha: string;
  /** Commit one file on the fixture line and return the new head SHA. */
  createCandidate: (input: { readonly fileName: string; readonly content: string }) => Promise<string>;
}

/**
 * A minimal git fixture for tests that drive the REAL M2-05 review protocol
 * (openReviewSession needs a repository). Everything lives under the system
 * temp dir; teardown uses `removeTreeRobust`.
 */
export async function createGitFixture(label: string): Promise<GitFixture> {
  const scratchDir = makeScratchDir(label);
  const initPath = path.join(scratchDir, "repo");
  mkdirSync(initPath, { recursive: true });
  const git = new GitRunner();
  await git.run(initPath, ["init", "-b", "main"]);
  // Anchor to git's canonical world: on Windows environments with 8.3-short
  // TMP forms (the GitHub windows runner's RUNNER~1) Node's realpathSync does
  // not expand the short form, and the worktree git gate compares caller
  // paths against git's own reports (PROPOSALS 2026-09-26 CI 批次).
  const repoPath = (await git.run(initPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const canonicalScratchDir = path.dirname(repoPath);
  const worktreesRoot = path.join(canonicalScratchDir, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  await git.run(repoPath, ["config", "core.autocrlf", "false"]);
  await git.run(repoPath, ["config", "user.email", "fixture@example.com"]);
  await git.run(repoPath, ["config", "user.name", "fixture"]);
  writeFileSync(path.join(repoPath, "src.ts"), "export const seed = true;\n", "utf8");
  await git.run(repoPath, ["add", "src.ts"]);
  await git.run(repoPath, ["commit", "-m", "seed"], { env: { ...FIXTURE_COMMIT_ENV } });
  const baseSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
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
  return { scratchDir: canonicalScratchDir, repoPath, worktreesRoot, git, baseSha, createCandidate };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

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
    throw new Error(`expected ${errorClass.name} to be thrown, but the call returned`);
}
