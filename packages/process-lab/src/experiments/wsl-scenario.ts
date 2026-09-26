/**
 * Experiment 5 — WSL availability and (when available) the minimal tree-kill
 * verification inside the default distro. Recorded separately from the
 * native Windows results (A29 direction: no silent mixing).
 */
import { installFakeCli } from "../fakecli.js";
import { isAlive } from "../proc.js";
import { TreeRegistry } from "../registry.js";
import { makeScratchDir, removeScratch, type LabResult } from "../scratch.js";
import { parseWslDriverJson, probeWsl, windowsPathToWsl, writeWslDriver, wslSh, type WslProbe } from "../wsl.js";

export interface WslScenarioResult extends LabResult {
  readonly probe: WslProbe;
  readonly verified: boolean;
  readonly reason: string;
}

export async function runWslExperiment(): Promise<WslScenarioResult> {
  const probe = probeWsl();
  if (!probe.available) {
    return {
      ok: true,
      probe,
      verified: false,
      reason: `wsl --status did not succeed (exitCode=${String(probe.exitCode)}, detail="${probe.detail}")`
    };
  }
  const nodeCheck = wslSh("command -v node >/dev/null 2>&1 && echo WSL_NODE_YES || echo WSL_NODE_NO", 60_000);
  const nodePresent = nodeCheck.stdout.includes("WSL_NODE_YES");
  const nodeVersion = nodePresent ? wslSh("node --version", 30_000).stdout.trim() : "";
  if (!nodePresent) {
    return {
      ok: true,
      probe,
      verified: false,
      reason: "WSL is available but no node binary is installed inside the default distro",
      nodeCheck: { exitCode: nodeCheck.exitCode, stdout: nodeCheck.stdout.trim(), stderr: nodeCheck.stderr.trim() }
    };
  }

  const registry = new TreeRegistry();
  const scratch = makeScratchDir("wsl");
  try {
    const fake = installFakeCli(scratch);
    const mntDist = windowsPathToWsl(fake.distDir);
    const driver = scratch + "\\wsl-driver.sh";
    writeWslDriver(driver, mntDist);
    const run = wslSh(`sh "${windowsPathToWsl(driver)}"`, 240_000);
    const parsed = parseWslDriverJson(run.stdout);
    if (parsed === null) {
      return {
        ok: false,
        probe,
        verified: false,
        reason: "WSL driver produced no WSLJSON record",
        nodeVersion,
        driverRun: { exitCode: run.exitCode, stdout: run.stdout.slice(0, 2_000), stderr: run.stderr.slice(0, 2_000), timedOut: run.timedOut }
      };
    }
    const rootAfterSingleKill = String(parsed["rootAfterSingleKill"]);
    const childAfterSingleKill = String(parsed["childAfterSingleKill"]);
    const grandAfterSingleKill = String(parsed["grandAfterSingleKill"]);
    const childAfterTreeKill = String(parsed["childAfterTreeKill"]);
    const grandAfterTreeKill = String(parsed["grandAfterTreeKill"]);
    const verified =
      rootAfterSingleKill === "dead" &&
      childAfterSingleKill === "alive" &&
      grandAfterSingleKill === "alive" &&
      childAfterTreeKill === "dead" &&
      grandAfterTreeKill === "dead";
    // Safety net: make sure nothing inside the distro survived.
    const childPid = Number(parsed["childPid"]);
    const grandPid = Number(parsed["grandchildPid"]);
    const rootPid = Number(parsed["rootPid"]);
    if (Number.isFinite(childPid) && Number.isFinite(grandPid) && Number.isFinite(rootPid)) {
      wslSh(`kill -9 ${rootPid} ${childPid} ${grandPid} 2>/dev/null; true`, 30_000);
    }
    // Cross-namespace observation only (never asserted): the Linux PIDs mean
    // nothing to the Windows PID space.
    const crossNamespace = {
      windowsIsAliveChildPid: isAlive(childPid),
      note: "Windows-side liveness of a Linux PID is meaningless; recorded, not asserted"
    };
    return {
      ok: verified,
      probe,
      verified,
      reason: verified
        ? "single root kill left both descendants alive; negative-PGID SIGKILL removed the rest"
        : "WSL driver completed but the kill semantics did not match expectations",
      nodeVersion,
      wsl: parsed,
      crossNamespace,
      driverRun: { exitCode: run.exitCode, timedOut: run.timedOut }
    };
  } finally {
    registry.reapAll();
    removeScratch(scratch);
  }
}
