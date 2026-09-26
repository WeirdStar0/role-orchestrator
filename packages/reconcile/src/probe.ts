/**
 * Three-valued process identity probe (the A27 authority).
 *
 * M0-05 conclusion (reports/M0-05-windows-launcher.md section 5.3): on
 * Windows a PID VALUE is reused within seconds, so neither `process.kill(pid,0)`
 * nor any by-PID tool can identify a process; the discriminator is the
 * Win32_Process creation timestamp. This module re-implements the
 * process-lab query on purpose, with a DIFFERENT contract: a reconcile
 * decision must distinguish "no such process" (safe to interrupt) from "the
 * query itself failed" (must NOT be read as death). process-lab returns null
 * for both and is documented as observation-only tooling no product code
 * depends on.
 *
 *   found          — the OS reports a live process for this pid; identity
 *                    carries its (pid, name, parentPid, creationTimeIso).
 *   not-found      — the query SUCCEEDED (exit 0) and reports no such
 *                    process: the original holder is definitively gone.
 *   indeterminate  — the query failed (spawn error, nonzero exit, timeout,
 *                    unparseable output). Fail-closed: callers must treat
 *                    this as "unknown", never as death.
 */
import { spawn } from "node:child_process";
import { z } from "zod";

export interface ProbeIdentity {
  readonly pid: number;
  readonly name: string;
  readonly parentPid: number;
  /** PowerShell `DateTime.ToUniversalTime().ToString('o')` — may carry >3 fractional digits. */
  readonly creationTimeIso: string | null;
}

export type ProcessProbe =
  | { readonly kind: "found"; readonly identity: ProbeIdentity }
  | { readonly kind: "not-found" }
  | { readonly kind: "indeterminate"; readonly reason: string };

/** The function shape `reconcileStartup` uses; injectable for tests. */
export type ProcessProbeFn = (pid: number, timeoutMs: number) => Promise<ProcessProbe>;

const ProbeIdentitySchema = z.strictObject({
  pid: z.number().int().min(1),
  name: z.string().max(256),
  parentPid: z.number().int().min(0),
  creationTimeIso: z.string().min(1).max(64).nullable()
});

/**
 * PowerShell 5.1 ships with every supported Windows build; the query is a
 * read-only Win32_Process enumeration. All inner quotes are single quotes so
 * the script survives Node's double-quoted argument passing (the exact
 * script shape verified in M0-05 and re-verified when this package was
 * built). Exit code 0 with no output row means "no such process" — that is
 * the ONLY path to `not-found`.
 */
// WQL server-side filtering: Win32_Process WHERE ProcessId = N lets the CIM
// service return ONE row instead of enumerating the whole process table for a
// client-side Where-Object. On a loaded runner the full enumeration was
// measured beyond 30s per query (product-gates run 36229740567 diagnostics:
// every probe timed out), while a point query stays bounded.
const IDENTITY_SCRIPT_PREFIX =
  "Get-CimInstance -Query 'SELECT ProcessId, Name, ParentProcessId, CreationDate FROM Win32_Process WHERE ProcessId = ";
const IDENTITY_SCRIPT_SUFFIX = "'";

export const windowsProcessProbe: ProcessProbeFn = async (pid, timeoutMs) => {
  if (process.platform !== "win32") {
    // reconcile must never interpret a PID across OS namespaces (A29); on a
    // non-Windows host the windows-native query simply cannot run.
    return { kind: "indeterminate", reason: `win32 identity query unavailable on platform "${process.platform}"` };
  }
  if (!Number.isInteger(pid) || pid < 1) {
    return { kind: "indeterminate", reason: `invalid pid ${String(pid)}` };
  }
  const script = `${IDENTITY_SCRIPT_PREFIX}${String(pid)}${IDENTITY_SCRIPT_SUFFIX}`;
  return await new Promise<ProcessProbe>((resolve) => {
    let settled = false;
    const finish = (probe: ProcessProbe): void => {
      if (settled) return;
      settled = true;
      resolve(probe);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish({ kind: "indeterminate", reason: `powershell spawn failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "indeterminate", reason: `identity query timed out after ${String(timeoutMs)}ms` });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ kind: "indeterminate", reason: `powershell spawn error: ${error.message}` });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        finish({ kind: "indeterminate", reason: `identity query exited ${String(code)}${stderr.length > 0 ? `: ${stderr.slice(0, 400)}` : ""}` });
        return;
      }
      const line = Buffer.concat(out)
        .toString("utf8")
        .split(/\r?\n/)
        .find((candidate) => candidate.trim() !== "");
      if (line === undefined) {
        // Query succeeded and enumerated nothing: the pid has no live holder.
        finish({ kind: "not-found" });
        return;
      }
      const parts = line.split("|");
      const parsedPid = Number(parts[0]);
      const parentPid = Number(parts[2]);
      const creation = parts[3];
      const identity = ProbeIdentitySchema.safeParse({
        pid: parsedPid,
        name: parts[1] ?? "",
        parentPid,
        creationTimeIso: creation !== undefined && creation !== "" ? creation : null
      });
      if (!identity.success || identity.data.pid !== pid) {
        finish({ kind: "indeterminate", reason: `identity query returned unparseable output: ${JSON.stringify(line.slice(0, 200))}` });
        return;
      }
      finish({ kind: "found", identity: identity.data });
    });
  });
};

/** Parse an ISO timestamp that may carry sub-millisecond digits; null when unparseable. */
export function parseProbeTimestamp(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
