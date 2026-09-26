/**
 * M0-05 scenario 5 — WSL (recorded separately from native Windows; A29
 * direction). Conditional on the environment:
 * - `wsl --status` must succeed (read-only probe);
 * - the default distro must contain a node binary.
 * When either fails, the test is skipped with the probe result recorded in
 * the run output — the report marks WSL as unverified in that case.
 */
import { expect, test } from "vitest";
import { installFakeCli } from "../src/fakecli.js";
import { makeScratchDir, removeScratch } from "../src/scratch.js";
import { parseWslDriverJson, probeWsl, windowsPathToWsl, writeWslDriver, wslSh } from "../src/wsl.js";

const probe = probeWsl();
const nodeCheck = probe.available
  ? wslSh("command -v node >/dev/null 2>&1 && echo WSL_NODE_YES || echo WSL_NODE_NO", 60_000)
  : null;
const nodeAvailable = nodeCheck !== null && nodeCheck.stdout.includes("WSL_NODE_YES");

test("WSL availability probe produces a recorded result", () => {
  expect(typeof probe.available).toBe("boolean");
  // Detail is informational (wsl.exe writes UTF-16LE); the exit code is the
  // authoritative availability signal.
  expect(probe.available).toBe(probe.exitCode === 0);
});

const wslReady = probe.available && nodeAvailable;
(wslReady ? test : test.skip)(
  "WSL grandchild tree: single root kill leaves descendants; negative-PGID SIGKILL removes all",
  { timeout: 300_000 },
  async () => {
    const scratch = makeScratchDir("wsl");
    try {
      const fake = installFakeCli(scratch);
      const mntDist = windowsPathToWsl(fake.distDir);
      const driverPath = `${scratch}\\wsl-driver.sh`;
      writeWslDriver(driverPath, mntDist);
      const run = wslSh(`sh "${windowsPathToWsl(driverPath)}"`, 240_000);
      expect(run.timedOut, "WSL driver must not time out").toBe(false);
      expect(run.exitCode, `driver stderr: ${run.stderr.slice(0, 500)}`).toBe(0);
      const record = parseWslDriverJson(run.stdout);
      expect(record, `driver output must carry a WSLJSON record: ${run.stdout.slice(0, 500)}`).not.toBeNull();

      expect(String(record!["rootAfterSingleKill"])).toBe("dead");
      expect(String(record!["childAfterSingleKill"])).toBe("alive");
      expect(String(record!["grandAfterSingleKill"])).toBe("alive");
      expect(String(record!["childAfterTreeKill"])).toBe("dead");
      expect(String(record!["grandAfterTreeKill"])).toBe("dead");
      expect(String(record!["nodeVersion"])).toMatch(/^v\d+\./);

      // Safety net: nothing must survive inside the distro.
      const rootPid = Number(record!["rootPid"]);
      const childPid = Number(record!["childPid"]);
      const grandPid = Number(record!["grandchildPid"]);
      if (Number.isFinite(rootPid) && Number.isFinite(childPid) && Number.isFinite(grandPid)) {
        const cleanup = wslSh(`kill -9 ${rootPid} ${childPid} ${grandPid} 2>/dev/null; true`, 30_000);
        expect(cleanup.exitCode === 0 || cleanup.exitCode === null).toBe(true);
      }
    } finally {
      removeScratch(scratch);
    }
  }
);
