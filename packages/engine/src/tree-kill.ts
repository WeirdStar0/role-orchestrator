/**
 * Process-tree termination (the engine side of A26-style kills).
 *
 * Windows: `taskkill /PID <pid> /T /F` — /T is the only builtin that walks
 * the whole child tree, /F is required because console children do not
 * receive window messages (M0-05 process-lab conclusion).
 *
 * POSIX: the launch spawns the root `detached` (own process group), so a
 * group SIGKILL reaches the whole tree; a bare pid SIGKILL is the fallback
 * when the group no longer exists.
 *
 * Every invocation returns its evidence (argv, exit code, stderr) instead of
 * throwing "not found" noise — a kill racing a natural exit is a NORMAL
 * outcome here, and the evidence lands in the lifecycle event payload.
 */
import { spawn } from "node:child_process";

export interface TreeKillEvidence {
  readonly tool: "taskkill" | "signal";
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
}

export function killProcessTree(pid: number): Promise<TreeKillEvidence> {
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", "/F"];
    return new Promise((resolve) => {
      const child = spawn("taskkill", args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      const errChunks: Buffer[] = [];
      let settled = false;
      const finish = (exitCode: number | null, stderr: string): void => {
        if (settled) return;
        settled = true;
        resolve({ tool: "taskkill", args, exitCode, stderr });
      };
      child.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));
      child.once("error", (error) => finish(null, String(error)));
      child.once("exit", (code) => finish(code, Buffer.concat(errChunks).toString("utf8").trim()));
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
    return Promise.resolve({ tool: "signal", args: [`-${pid}`, "SIGKILL"], exitCode: 0, stderr: "" });
  } catch (groupError) {
    try {
      process.kill(pid, "SIGKILL");
      return Promise.resolve({ tool: "signal", args: [String(pid), "SIGKILL"], exitCode: 0, stderr: "" });
    } catch {
      return Promise.resolve({
        tool: "signal",
        args: [String(pid), "SIGKILL"],
        exitCode: null,
        stderr: `process already gone (${String(groupError)})`
      });
    }
  }
}
