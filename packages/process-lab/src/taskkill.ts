/**
 * `taskkill` wrapper. The /T flag is the only Windows builtin that terminates
 * a whole tree; /F is required because CLIs do not have window messages and
 * WM_CLOSE would not reach console children anyway. Every invocation is
 * recorded (exit code + stdout/stderr) so experiments can cite real output.
 */
import { spawn } from "node:child_process";

export interface TaskkillOptions {
  /** /T - kill the process tree (children of the PID). */
  readonly tree?: boolean;
  /** /F - force terminate (TerminateProcess). */
  readonly force?: boolean;
}

export interface TaskkillOutcome {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function taskkill(pid: number, options: TaskkillOptions = {}): Promise<TaskkillOutcome> {
  const args = ["/PID", String(pid)];
  if (options.tree === true) args.push("/T");
  if (options.force === true) args.push("/F");
  return new Promise((resolve) => {
    const child = spawn("taskkill", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({
        args: [...args],
        exitCode,
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8").trim()
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code));
  });
}
