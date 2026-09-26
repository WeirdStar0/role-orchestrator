/**
 * Shared test plumbing for the worktree lifecycle suite.
 *
 * Every fixture repository is created BY THE TESTS via `git init` inside the
 * system temp directory (never inside the H:\role-orchestrator workspace,
 * which must stay a non-git working area). Teardown removal walks the tree
 * with whitelisted primitives (mkdir/copy-free: stat/unlink/rmdir) because
 * M0-05 showed fs.rm is broken on Node 25/win32 for non-ASCII paths.
 */
import {
  realpathSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmodSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRunner, type GitRunResult } from "../src/index.js";

export interface FixtureRepo {
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly git: GitRunner;
  headSha: () => Promise<string>;
  /** Writes a file in the repo and commits it; resolves the new HEAD sha. */
  writeAndCommitFile: (relativePath: string, content: string) => Promise<string>;
  branchNames: () => Promise<string[]>;
}

/** Scratch dir under the system temp; `dirName` nests an extra named dir. */
export function makeScratchDir(label: string, dirName?: string): string {
  // realpathSync canonicalizes Windows 8.3 short temp forms (e.g. the GitHub
  // windows runner's RUNNER~1) to the long form git reports back, so the
  // git gate's strict top-level comparison sees the same path the fixture
  // constructed (A28/A29 discipline: canonicalize the FIXTURE, not the gate).
  const base = mkdtempSync(path.join(realpathSync(os.tmpdir()), `worktree-m2-03-${label}-`));
  if (dirName === undefined) return base;
  const nested = path.join(base, dirName);
  mkdirSync(nested, { recursive: true });
  return nested;
}

/** git init + local config + one seed commit, all through GitRunner argvs. */
export async function createFixtureRepo(
  label: string,
  options?: { dirName?: string }
): Promise<FixtureRepo> {
  const scratchDir = makeScratchDir(label, options?.dirName);
  const repoPath = path.join(scratchDir, "repo");
  mkdirSync(repoPath, { recursive: true });
  const git = new GitRunner();
  await git.run(repoPath, ["init", "-b", "main"]);
  await git.run(repoPath, ["config", "core.autocrlf", "false"]);
  await git.run(repoPath, ["config", "user.email", "fixture@example.com"]);
  await git.run(repoPath, ["config", "user.name", "fixture"]);

  const writeAndCommitFile = async (relativePath: string, content: string): Promise<string> => {
    const absolute = path.join(repoPath, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
    await git.run(repoPath, ["add", relativePath]);
    await git.run(repoPath, ["commit", "-m", `add ${relativePath}`]);
    return await headSha();
  };
  const headSha = async (): Promise<string> =>
    (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  const branchNames = async (): Promise<string[]> =>
    (await git.run(repoPath, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]))
      .stdout.trim()
      .split("\n")
      .filter((line) => line.length > 0);

  await writeAndCommitFile("seed.txt", "seed content v1\n");
  return { scratchDir, repoPath, git, headSha, writeAndCommitFile, branchNames };
}

/**
 * Records every git invocation (argv + cwd) while delegating to the real git.
 * This is the audit surface for the "argv arrays, never a shell string" rule.
 */
export class RecordingRunner extends GitRunner {
  readonly calls: { readonly cwd: string; readonly argv: readonly string[] }[] = [];

  protected override async exec(cwd: string, argv: readonly string[]): Promise<GitRunResult> {
    this.calls.push({ cwd, argv: [...argv] });
    return await super.exec(cwd, argv);
  }
}

/** Throws instead of executing any matched call (mid-flow fault injection). */
export class InjectedFailureRunner extends GitRunner {
  constructor(
    private readonly matches: (cwd: string, argv: readonly string[]) => boolean,
    private readonly error: Error = new Error("injected fault")
  ) {
    super();
  }

  protected override async exec(cwd: string, argv: readonly string[]): Promise<GitRunResult> {
    if (this.matches(cwd, argv)) throw this.error;
    return await super.exec(cwd, argv);
  }
}

/** Simulates the git binary vanishing after the --version preflight passed. */
export class SpawnFailureRunner extends GitRunner {
  protected override async exec(cwd: string, argv: readonly string[]): Promise<GitRunResult> {
    if (argv[0] === "--version") return await super.exec(cwd, argv);
    return { argv: [...argv], cwd, exitCode: null, stdout: "", stderr: "ENOENT (injected)" };
  }
}

/** Replays a canned `git --version` line; real git for everything else. */
export class FixedVersionRunner extends GitRunner {
  constructor(private readonly versionOutput: string) {
    super();
  }

  protected override async exec(cwd: string, argv: readonly string[]): Promise<GitRunResult> {
    if (argv[0] === "--version") {
      return { argv: [...argv], cwd, exitCode: 0, stdout: this.versionOutput, stderr: "" };
    }
    return await super.exec(cwd, argv);
  }
}

/**
 * expectRejection, same contract as the engine tests: resolves with the typed
 * error or fails the test with a precise message.
 */
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

export interface FileEvidence {
  readonly contentSha256: string;
  readonly mtimeMs: number;
}

/**
 * Recursive snapshot of every FILE under a working tree, .git excluded:
 * relative path -> content hash + mtime. A11 uses before/after equality to
 * prove the user's working tree was not touched.
 */
export function walkWorkingTree(root: string): Map<string, FileEvidence> {
  const files = new Map<string, FileEvidence>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      const entryPath = path.join(dir, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        visit(entryPath);
      } else {
        files.set(
          path.relative(root, entryPath),
          { contentSha256: createHash("sha256").update(readFileSync(entryPath)).digest("hex"), mtimeMs: stats.mtimeMs }
        );
      }
    }
  };
  visit(root);
  return files;
}

/**
 * Recursive removal with whitelisted primitives. Git's loose objects and
 * pack files are read-only on Windows; libuv clears the attribute on unlink,
 * and the chmod retry covers any libuv that does not.
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
          // best effort; teardown must never mask the real result
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
