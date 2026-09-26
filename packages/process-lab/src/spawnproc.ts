/**
 * Spawn helpers with incremental line collection.
 *
 * Windows note (M0-05): Node refuses to spawn a `.cmd`/`.bat` file directly
 * without a shell since the CVE-2024-27980 fix (spawn returns EINVAL).
 * Launchers must therefore go through `cmd.exe /d /s /c <shim> <args>` —
 * which is exactly what a Windows shell does for a `.cmd` on PATH, and it
 * creates the cmd.exe -> node chain the tree-kill experiments target.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { exitPromise, LineCollector, type ExitInfo } from "./lines.js";

export interface Proc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: LineCollector;
  readonly stderr: LineCollector;
  readonly exit: Promise<ExitInfo>;
}

/** Defensive: newer Node typings model child.pid as number | undefined. */
export function requiredPid(child: ChildProcessWithoutNullStreams): number {
  const pid = child.pid;
  if (pid === undefined) throw new Error("child pid unavailable (spawn failed)");
  return pid;
}

function collect(child: ChildProcessWithoutNullStreams): Proc {
  const stdout = new LineCollector();
  const stderr = new LineCollector();
  stdout.attach(child.stdout);
  stderr.attach(child.stderr);
  return { child, stdout, stderr, exit: exitPromise(child) };
}

/** Spawns `node <scriptPath> [args...]` directly (no shell). */
export function spawnNodeProcess(scriptPath: string, args: readonly string[], cwd?: string): Proc {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(cwd !== undefined ? { cwd } : {})
  }) as ChildProcessWithoutNullStreams;
  return collect(child);
}

/**
 * Spawns a `.cmd` wrapper the way a Windows shell does:
 * `cmd.exe /d /c <shimPath> [args...]`. `/d` skips the user AutoRun registry
 * scripts.
 *
 * M0-05 finding: `/s` must NOT be used. With `/s`, cmd strips the outer
 * quotes from the (Node-quoted) shim path, then fails to resolve the
 * unquoted remainder at the first space ("...proc-lab is not recognized as
 * an internal or external command"). Without `/s`, cmd's two-quote rule
 * preserves the quoting and the shim runs from space/CJK directories, with
 * its `exit /b <code>` propagated.
 */
export function spawnCmdProcess(shimPath: string, args: readonly string[], cwd?: string): Proc {
  const child = spawn("cmd.exe", ["/d", "/c", shimPath, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...(cwd !== undefined ? { cwd } : {})
  }) as ChildProcessWithoutNullStreams;
  return collect(child);
}
