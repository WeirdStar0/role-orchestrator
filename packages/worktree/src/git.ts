/**
 * The only place this package spawns git. Every invocation is
 * `spawn(gitPath, <argv ARRAY>)` with an explicit `cwd` — there is no shell
 * string anywhere (the same discipline as the engine launcher, and the same
 * Windows reason: arguments pass through Node's argv encoding untouched, so
 * CJK/spaces/long paths and option-LOOKING strings stay inert data).
 *
 * Fail-closed preflight: `assertAvailable` must succeed before any lifecycle
 * step reads or mutates anything. A missing/old/unparseable git is surfaced as
 * GitUnavailableError instead of being probed by side effects.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { GitCommandError, GitUnavailableError } from "./errors.js";

export interface GitRunResult {
  /** The exact argument vector that was (or would have been) executed. */
  readonly argv: readonly string[];
  /** The cwd the command ran in (pinned by the caller to a repo or worktree). */
  readonly cwd: string;
  /** null when the process could not be spawned at all (ENOENT, EACCES...). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

/**
 * Optional per-call environment overlay (M2-04). The integration service uses
 * it to pin GIT_AUTHOR_* / GIT_COMMITTER_* so merge commits are a pure
 * function of (tree, parents, message) — the deterministic-idempotency key of
 * A25. Callers that pass no options inherit the parent environment exactly as
 * before; the overlay NEVER replaces the environment, only adds on top of it.
 */
export interface GitRunOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** Oldest git line that has `git worktree` with `--porcelain` listing. */
const MINIMUM_GIT_MAJOR = 2;

const VERSION_PATTERN = /^git version (\d+)\.(\d+)(?:\.(\d+))?/;

export class GitRunner {
  readonly gitPath: string;

  constructor(options?: { gitPath?: string }) {
    this.gitPath = options?.gitPath ?? "git";
  }

  /**
   * Low-level single spawn. Subclasses may override to inject faults in
   * tests; production callers always go through run/tryRun which add the
   * error semantics on top.
   */
  protected async exec(cwd: string, argv: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
    const env =
      options?.env === undefined
        ? undefined
        : ({ ...process.env, ...options.env } as NodeJS.ProcessEnv);
    return await new Promise<GitRunResult>((resolve) => {
      const child = spawn(this.gitPath, [...argv], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(env === undefined ? {} : { env })
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      const settle = (result: GitRunResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });
      child.once("error", (error: Error) => {
        settle({
          argv,
          cwd,
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: `${error.name}: ${error.message}`
        });
      });
      child.once("close", (code) => {
        settle({
          argv,
          cwd,
          exitCode: code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8")
        });
      });
    });
  }

  /**
   * Run git and demand success: spawn failure or nonzero exit becomes
   * GitCommandError with the full argv/cwd/stderr evidence attached.
   */
  async run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
    const result = await this.exec(cwd, args, options);
    if (result.exitCode !== 0) {
      throw new GitCommandError(result.argv, cwd, result.exitCode, tail(result.stderr), {
        cause: result.exitCode === null ? result.stderr : undefined
      });
    }
    return result;
  }

  /**
   * Run git and accept nonzero exits as data (existence probes). Only a
   * spawn failure still throws — "git said no" is information, "git never
   * ran" is an error.
   */
  async tryRun(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
    const result = await this.exec(cwd, args, options);
    if (result.exitCode === null) {
      throw new GitCommandError(result.argv, cwd, null, tail(result.stderr), { cause: result.stderr });
    }
    return result;
  }

  /**
   * Fail-closed availability gate: `git --version` must run (exit 0) and
   * parse as a 2.x+ version. Run from the OS temp dir so the gate itself
   * never depends on — or touches — any repository.
   */
  async assertAvailable(): Promise<GitVersion> {
    const result = await this.exec(os.tmpdir(), ["--version"]);
    if (result.exitCode === null) {
      throw new GitUnavailableError(this.gitPath, `could not be spawned (${tail(result.stderr)})`);
    }
    if (result.exitCode !== 0) {
      throw new GitUnavailableError(this.gitPath, `--version exited ${result.exitCode}`);
    }
    const match = VERSION_PATTERN.exec(result.stdout.trim());
    if (match === null) {
      throw new GitUnavailableError(
        this.gitPath,
        `--version output is not a parseable git version: ${JSON.stringify(result.stdout.slice(0, 120))}`
      );
    }
    const major = Number(match[1]);
    const minor = Number(match[2] ?? "0");
    const patch = Number(match[3] ?? "0");
    if (major < MINIMUM_GIT_MAJOR) {
      throw new GitUnavailableError(
        this.gitPath,
        `git ${major}.${minor}.${patch} predates reliable worktree support (need >= ${MINIMUM_GIT_MAJOR}.x)`
      );
    }
    return { major, minor, patch, raw: result.stdout.trim() };
  }
}

function tail(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}
