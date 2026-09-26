/**
 * The git adapter for the source-sha reference check (M3-03).
 *
 * The staleness PORT lives in `types.ts` (`SourceShaResolver`); this module
 * is the ONLY place that spawns git. Discipline mirrors packages/worktree:
 * `spawnSync(gitPath, <argv ARRAY>)` with an explicit `cwd` — no shell
 * string anywhere, so option-LOOKING shas and CJK paths stay inert data,
 * and `windowsHide` keeps console windows off the screen.
 *
 * Semantics against the CURRENT repository:
 * - cited sha exists as an object   -> `exists: true`
 *   (`git cat-file -e <sha>` — commit-shaped provenance is what memories
 *   cite; a non-commit object still proves the sha is present)
 * - otherwise                       -> `exists: false` (missing)
 * - `currentSha` = `git rev-parse HEAD` (the current baseline; a cited sha
 *   that exists but differs from it is SUPERSEDED). An unborn HEAD
 *   (fresh repo) yields `currentSha: null` = existence-only semantics.
 *
 * The resolver SYNCHRONOUSLY probes per sha — `checkSources` runs it
 * OUTSIDE its write transaction on purpose; callers needing async pipelines
 * implement the port themselves.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { MemorySearchError } from "./errors.js";
import type { SourceShaObservation, SourceShaResolver } from "./types.js";

export class GitSourceResolverError extends MemorySearchError {
  readonly repoRoot: string;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(input: {
    readonly repoRoot: string;
    readonly argv: readonly string[];
    readonly exitCode: number | null;
    readonly stderr: string;
  }) {
    super(
      `git source resolver could not run ${input.argv.join(" ")} in "${input.repoRoot}" ` +
        `(exit ${input.exitCode === null ? "(not spawned)" : String(input.exitCode)}): ${input.stderr}`
    );
    this.name = "GitSourceResolverError";
    this.repoRoot = input.repoRoot;
    this.argv = input.argv;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
  }
}

export interface GitSourceResolverOptions {
  /** git executable; defaults to "git" on PATH. */
  readonly gitPath?: string;
}

/**
 * Build a `SourceShaResolver` bound to one repository working tree. The
 * path is validated to exist at construction (fail closed) — the resolver
 * is a pure probe afterwards and never mutates anything (`cat-file` and
 * `rev-parse` are read-only).
 */
export function createGitSourceResolver(
  repoRoot: string,
  options: GitSourceResolverOptions = {}
): SourceShaResolver {
  const root = path.resolve(repoRoot);
  if (!existsSync(root)) {
    throw new GitSourceResolverError({
      repoRoot: root,
      argv: ["(repository root)"],
      exitCode: null,
      stderr: "repository root does not exist"
    });
  }
  const gitPath = options.gitPath ?? "git";

  const run = (argv: readonly string[]): { readonly code: number | null; readonly stdout: string; readonly stderr: string } => {
    const result = spawnSync(gitPath, [...argv], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      encoding: "utf8"
    });
    return {
      code: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : ""
    };
  };

  return (sourceSha: string): SourceShaObservation => {
    const catFile = run(["cat-file", "-e", `${sourceSha}`]);
    if (catFile.code !== 0) {
      // exit 128 = "not a valid object name" (or a bare-repo nuance) — the
      // cited sha is simply not present; that is a ANSWER, not a tool error.
      if (catFile.code === 128 || catFile.code === 1) {
        return { exists: false, currentSha: null };
      }
      throw new GitSourceResolverError({
        repoRoot: root,
        argv: ["cat-file", "-e", sourceSha],
        exitCode: catFile.code,
        stderr: catFile.stderr
      });
    }
    const head = run(["rev-parse", "HEAD"]);
    if (head.code !== 0) {
      // Unborn HEAD (no commits yet): the baseline does not exist, so only
      // existence semantics are available.
      return { exists: true, currentSha: null };
    }
    return { exists: true, currentSha: head.stdout.trim() };
  };
}
