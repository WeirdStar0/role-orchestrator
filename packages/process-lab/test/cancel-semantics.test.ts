/**
 * M0-05 scenario 3 — cancel and daemon-loss semantics (A26).
 *
 * - `timeout` scenario: the hanging CLI is killed by plain `taskkill /F`;
 *   the process dies and the exit is not clean.
 * - `grandchild` scenario: a plain `/F` kill of the root takes the whole
 *   libuv-spawned subtree down on Node 25.0.0/win32 (parent-death cascade;
 *   taskkill names only the root PID). The surviving-orphan case is real one
 *   level up — killing the `.cmd` wrapper leaves the node tree alive — and
 *   is covered by cmd-wrapper.test.ts.
 */
import { expect, test } from "vitest";
import { parseGrandchildReport } from "../src/fakecli.js";
import { sleep, waitForLine, withTimeout } from "../src/lines.js";
import { expectPidGone, isAlive, queryProcessIdentity } from "../src/proc.js";
import { taskkill } from "../src/taskkill.js";
import { requiredPid, spawnNodeProcess } from "../src/spawnproc.js";
import { setupLabFixture, teardownLabFixture } from "./helpers.js";

const isWindows = process.platform === "win32";
const d = isWindows ? test : test.skip;

d(
  "timeout scenario: hanging CLI dies on plain taskkill /F with a non-clean exit",
  { timeout: 360_000 },
  async () => {
    const fixture = setupLabFixture("cancel-timeout");
    try {
      const bin = fixture.fake.binPath("claude");
      const run = spawnNodeProcess(bin, ["--scenario", "timeout"]);
      const rootPid = requiredPid(run.child);
      fixture.registry.add(rootPid);
      await waitForLine(run.stdout, (lines) => lines.length >= 2, 30_000, "timeout partial stream");

      await sleep(1_500);
      expect(isAlive(rootPid), "timeout scenario must still hang before the kill").toBe(true);

      const kill = await taskkill(rootPid, { force: true });
      expect(kill.exitCode, `taskkill /F output: ${kill.stdout} ${kill.stderr}`).toBe(0);
      const info = await withTimeout(run.exit, 30_000, "timeout kill exit");
      expect(info.code === 0, `killed process must not report a clean exit (code=${String(info.code)})`).toBe(false);
      await expectPidGone(rootPid);
    } finally {
      await teardownLabFixture(fixture);
    }
  }
);

d(
  "grandchild scenario: plain /F on the root takes the whole libuv-spawned subtree down (Node 25 cascade)",
  { timeout: 420_000 },
  async () => {
    const fixture = setupLabFixture("cancel-orphans");
    try {
      const bin = fixture.fake.binPath("claude");
      const run = spawnNodeProcess(bin, ["--scenario", "grandchild"]);
      const rootPid = requiredPid(run.child);
      fixture.registry.add(rootPid);
      const reportLine = await waitForLine(
        run.stdout,
        (line) => line.includes("grandchildPid"),
        45_000,
        "grandchild PID report"
      );
      const report = parseGrandchildReport(reportLine);
      expect(report).not.toBeNull();
      const childPid = report!.childPid;
      const grandPid = report!.grandchildPid;

      const childIdentityBefore = await queryProcessIdentity(childPid);
      const rootIdentityBefore = await queryProcessIdentity(rootPid);
      const grandIdentityBefore = await queryProcessIdentity(grandPid);
      expect(rootIdentityBefore?.name.toLowerCase()).toBe("node.exe");
      expect(childIdentityBefore?.parentPid).toBe(rootPid);
      expect(grandIdentityBefore?.parentPid).toBe(childPid);

      // Single kill of the root only — taskkill names only the root PID.
      const killRoot = await taskkill(rootPid, { force: true });
      expect(killRoot.exitCode, `taskkill /F output: ${killRoot.stdout} ${killRoot.stderr}`).toBe(0);
      await expectPidGone(rootPid);

      // Observed Node 25/win32 cascade: descendants die with the root even
      // though taskkill /F targeted only the root. Teardown is awaited with
      // the package's own bounded helper (same one the root above uses): the
      // assertion still requires each descendant to DIE — a surviving orphan
      // throws — but the OS gets its bounded budget instead of a fixed 2s
      // wall clock that full-parallel runs can outrun (M6-04 disclosure in
      // PROPOSALS.md; same load-sensitivity class as the M6-01 adjustment).
      await expectPidGone(childPid);
      await expectPidGone(grandPid);
      expect(await queryProcessIdentity(childPid)).toBeNull();
      expect(await queryProcessIdentity(grandPid)).toBeNull();
    } finally {
      await teardownLabFixture(fixture);
    }
  }
);
