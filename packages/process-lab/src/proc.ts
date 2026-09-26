/**
 * Process observability (Windows-first):
 * - `isAlive`: fast signal-0 liveness check. CAVEAT (the M0-05 finding): on
 *   Windows a PID value can be reused by a different process after the
 *   original exits, so `isAlive` can false-positive on a stale PID.
 * - `queryProcessIdentity`: authoritative (pid, name, parentPid, creation
 *   time) via PowerShell's Win32_Process. The creation timestamp is what
 *   disambiguates a reused PID value from the original process.
 */
import { spawn } from "node:child_process";
import { sleep } from "./lines.js";

export interface ProcessIdentity {
  readonly pid: number;
  readonly name: string;
  readonly parentPid: number;
  readonly creationTimeIso: string | null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(cmd: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8")
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/**
 * PowerShell 5.1 is present on every supported Windows build; the query is
 * read-only (Win32_Process enumeration). All inner quotes are single quotes
 * so the script survives Node's double-quoted argument passing.
 */
const IDENTITY_SCRIPT_PREFIX = "Get-CimInstance Win32_Process | Where-Object ProcessId -EQ";
const IDENTITY_SCRIPT_SUFFIX =
  "| ForEach-Object { $d = $_.CreationDate; " +
  "if ($d) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.ParentProcessId, $d.ToUniversalTime().ToString('o') } " +
  "else { '{0}|{1}|{2}|' -f $_.ProcessId, $_.Name, $_.ParentProcessId } }";

/** Returns null when no process with this PID exists (or the query fails). */
export async function queryProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const script = `${IDENTITY_SCRIPT_PREFIX} ${pid} ${IDENTITY_SCRIPT_SUFFIX}`;
  const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
  if (result.exitCode !== 0) return null;
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
  if (line === undefined) return null;
  const parts = line.split("|");
  if (parts.length < 3) return null;
  const parsedPid = Number(parts[0]);
  const parentPid = Number(parts[2]);
  if (!Number.isFinite(parsedPid) || !Number.isFinite(parentPid)) return null;
  const creation = parts[3];
  return {
    pid: parsedPid,
    name: parts[1] ?? "",
    parentPid,
    creationTimeIso: creation !== undefined && creation !== "" ? creation : null
  };
}

/**
 * Waits until the PID is provably gone. Robust against PID reuse: the fast
 * signal-0 check short-circuits, but a false positive (stale PID reassigned
 * to a new process) is corrected by the Win32_Process identity query.
 */
export async function expectPidGone(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    const identity = await queryProcessIdentity(pid);
    if (identity === null) return;
    await sleep(100);
  }
  throw new Error(`pid ${pid} is still alive ${timeoutMs}ms after termination`);
}
