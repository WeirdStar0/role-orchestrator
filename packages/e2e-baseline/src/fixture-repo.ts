/**
 * The user fixture repository (A11 subject).
 *
 * Created BY the tests via git inside the SYSTEM TEMP directory — never inside
 * the H:\role-orchestrator workspace, which must stay a non-git working area.
 * No force/reset/clean/remote anywhere; teardown removes the whole scratch
 * tree with whitelisted primitives (`removeTreeRobust` from the review
 * package; fs.rm is broken on Node 25/win32 for non-ASCII paths, M0-05).
 *
 * The fixture models the A11 world: a repository with one committed baseline
 * AND one UNCOMMITTED user modification (`notes/scratch.txt`) that must
 * survive the entire parallel run byte-for-byte.
 *
 * Determinism: the seed commit uses a FIXED author/committer/date identity,
 * so identical fixture content in two independent repos produces the identical
 * base SHA — that is what makes the run-to-run repeatability assertion
 * (identical candidateSha chains across independent worlds) possible.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRunner } from "@role-orchestrator/worktree";

/** Fixed commit identity for fixture seed commits (deterministic SHAs). */
export const FIXTURE_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "role-orchestrator-e2e-fixture",
  GIT_AUTHOR_EMAIL: "e2e-fixture@role-orchestrator.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "role-orchestrator-e2e-fixture",
  GIT_COMMITTER_EMAIL: "e2e-fixture@role-orchestrator.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

/** Seed files committed on main before the run starts. */
export const FIXTURE_SEED_FILES: Readonly<Record<string, string>> = Object.freeze({
  "src/app.ts": "export const app = 'role-orchestrator-e2e-baseline';\n",
  "docs/baseline.md": "# e2e baseline fixture\n\nseed content for the parallel run\n"
});

/** The user's uncommitted modification — the A11 subject. */
export const DIRTY_FILE_REL = "notes/scratch.txt";
export const DIRTY_FILE_CONTENT = "user uncommitted work v1 — must survive the whole run (A11)\n";

export interface FixtureRepo {
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly git: GitRunner;
  /** HEAD of main after the seed commit (full 40-hex). */
  readonly baseSha: string;
  readSeedFile(relativePath: string): string;
  readDirtyFile(): string;
}

export function makeScratchDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `ro-e2e-${label}-`));
}

function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const absolute = path.join(repoPath, ...relativePath.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

export async function createFixtureRepo(label: string): Promise<FixtureRepo> {
  const scratchDir = makeScratchDir(label);
  const initPath = path.join(scratchDir, "repo");
  mkdirSync(initPath, { recursive: true });

  const git = new GitRunner();
  await git.run(initPath, ["init", "-b", "main"]);
  await git.run(initPath, ["config", "core.autocrlf", "false"]);
  await git.run(initPath, ["config", "user.email", FIXTURE_COMMIT_ENV["GIT_AUTHOR_EMAIL"] as string]);
  await git.run(initPath, ["config", "user.name", FIXTURE_COMMIT_ENV["GIT_AUTHOR_NAME"] as string]);
  // Anchor repoPath and the scratch base to git's canonical world: the
  // worktree git gate compares caller paths against git's own reports
  // (samePath), and some Windows environments use 8.3-short TMP forms
  // (the GitHub windows runner's RUNNER~1) where Node's realpathSync does
  // not expand the short form (PROPOSALS 2026-09-26 CI 批次).
  const repoPath = (await git.run(initPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const canonicalScratchDir = path.dirname(repoPath);
  const worktreesRoot = path.join(canonicalScratchDir, "worktrees");
  mkdirSync(worktreesRoot, { recursive: true });

  for (const [relativePath, content] of Object.entries(FIXTURE_SEED_FILES)) {
    writeRepoFile(repoPath, relativePath, content);
    await git.run(repoPath, ["add", relativePath]);
  }
  await git.run(repoPath, ["commit", "-m", "seed: e2e baseline fixture"], {
    env: { ...FIXTURE_COMMIT_ENV }
  });
  const baseSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();

  // The user's uncommitted change: written but NEVER staged or committed.
  writeRepoFile(repoPath, DIRTY_FILE_REL, DIRTY_FILE_CONTENT);

  return {
    scratchDir: canonicalScratchDir,
    repoPath,
    worktreesRoot,
    git,
    baseSha,
    readSeedFile: (relativePath: string): string =>
      readFileSync(path.join(repoPath, ...relativePath.split("/")), "utf8"),
    readDirtyFile: (): string => readFileSync(path.join(repoPath, ...DIRTY_FILE_REL.split("/")), "utf8")
  };
}
