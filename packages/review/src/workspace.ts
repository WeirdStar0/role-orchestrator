/**
 * One-shot validation workspace (A13) — the ONLY place review-time test
 * processes may write (docs/GIT_AND_WORKSPACES.md 读者与测试: "测试运行在
 * disposable validation workspace，允许写入临时文件、缓存、coverage 和编译
 * 产物，但不允许修改被审查源码").
 *
 * Lifecycle: `openReviewSession` copies the reviewed baseline into a fresh
 * `mkdtemp` directory under the OS temp root (prefix `ro-review-validation-`)
 * and verifies the copy is byte-faithful against the baseline manifest.
 * Validation commands run with their cwd pinned to the copy — temp files,
 * caches and build outputs land there, never in the reviewed source. When the
 * session ends the copy is deleted with whitelisted primitives; a guard
 * refuses to dispose any directory that is not one of our own temp roots.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isInsidePath } from "@role-orchestrator/worktree";
import { ReviewBaselineUnsupportedError, ReviewWorkspaceError } from "./errors.js";

const VALIDATION_TEMP_PREFIX = "ro-review-validation-";

export interface ValidationWorkspace {
  readonly workspacePath: string;
  readonly tempRoot: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyTree(source: string, destination: string, depth: number): void {
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    if (depth === 0 && entry.name === ".git") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ReviewBaselineUnsupportedError([entry.name]);
    }
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to, depth + 1);
      continue;
    }
    if (!entry.isFile()) {
      throw new ReviewBaselineUnsupportedError([entry.name]);
    }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/**
 * Copy the reviewed baseline into a fresh one-shot workspace under the OS
 * temp root. The copy is created from the baseline worktree contents with
 * whitelisted primitives (M0-05: no fs.rm / no fs.cp on Node 25/win32).
 */
export function createValidationWorkspace(baselineWorktreePath: string): ValidationWorkspace {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), VALIDATION_TEMP_PREFIX));
  const workspacePath = path.join(tempRoot, "workspace");
  try {
    copyTree(baselineWorktreePath, workspacePath, 0);
  } catch (error) {
    removeTreeRobust(tempRoot);
    throw new ReviewWorkspaceError({
      workspacePath,
      detail: `copying the reviewed baseline into the validation workspace failed: ${describeError(error)}`,
      cause: error
    });
  }
  return { workspacePath, tempRoot };
}

/**
 * Recursive removal with whitelisted primitives; returns true only when the
 * directory is actually gone. Never throws for stubborn files — a leftover
 * temp copy is reported, not masked as success.
 */
export function removeTreeRobust(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return !existsSync(dir);
  }
  let ok = true;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stats = statSync(entryPath, { throwIfNoEntry: false });
    if (stats?.isDirectory() === true) {
      if (!removeTreeRobust(entryPath)) ok = false;
    } else {
      try {
        unlinkSync(entryPath);
      } catch {
        ok = false;
      }
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    ok = false;
  }
  return ok && !existsSync(dir);
}

/**
 * Dispose the one-shot workspace. The guard is fail-closed: only a
 * `ro-review-validation-*` directory inside the OS temp root can ever be
 * removed through this function — never an arbitrary caller-supplied path.
 */
export function disposeValidationWorkspace(workspace: ValidationWorkspace): {
  readonly removed: boolean;
  readonly detail: string | null;
} {
  if (!isInsidePath(workspace.tempRoot, os.tmpdir()) || path.basename(workspace.tempRoot).startsWith(VALIDATION_TEMP_PREFIX) === false) {
    throw new ReviewWorkspaceError({
      workspacePath: workspace.tempRoot,
      detail: `refusing to dispose "${workspace.tempRoot}": it is not a ${VALIDATION_TEMP_PREFIX}* directory inside the OS temp root`
    });
  }
  const removed = removeTreeRobust(workspace.tempRoot);
  return {
    removed,
    detail:
      removed ?
        null :
        "temporary directory could not be fully removed (open handles?); it is inside the OS temp root and can be deleted manually"
  };
}

const ValidationCommandInputSchema = z.strictObject({
  /** Direct argv vector — no shell anywhere (same discipline as GitRunner). */
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000)
});

export type ValidationCommandInput = z.input<typeof ValidationCommandInputSchema>;

export interface ValidationCommandResult {
  readonly argv: readonly string[];
  /** null when the process was killed by the timeout (never exited itself). */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

const TAIL_CHARS = 4_000;

function tail(text: string): string {
  const normalized = text.length <= TAIL_CHARS ? text : `…${text.slice(text.length - TAIL_CHARS)}`;
  return normalized;
}

/**
 * Run one validation command INSIDE the workspace (cwd pinned, argv array,
 * no shell). The result reports facts — exit code, timeout, output tails —
 * and never interprets them: judging a test run is the verdict's job, backed
 * by the recorded evidence. A command that cannot be spawned at all is a
 * workspace error (no evidence is fabricated for a process that never ran).
 *
 * Known boundary: on timeout only the direct child is killed (child.kill());
 * full process-tree termination is the engine launcher's M0-05 capability,
 * not this package's.
 */
export async function runWorkspaceCommand(
  workspacePath: string,
  input: ValidationCommandInput
): Promise<ValidationCommandResult> {
  const value = ValidationCommandInputSchema.parse(input);
  const argv = value.argv;
  const startedAt = Date.now();
  return await new Promise<ValidationCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject(
        new ReviewWorkspaceError({
          workspacePath,
          detail: `validation command could not be spawned: ${describeError(error)}`,
          cause: error
        })
      );
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, value.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(
        new ReviewWorkspaceError({
          workspacePath,
          detail: `validation command could not be executed: ${error.name}: ${error.message}`,
          cause: error
        })
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        argv,
        exitCode: code,
        timedOut,
        stdoutTail: tail(Buffer.concat(stdoutChunks).toString("utf8")),
        stderrTail: tail(Buffer.concat(stderrChunks).toString("utf8")),
        durationMs: Date.now() - startedAt
      });
    });
  });
}
