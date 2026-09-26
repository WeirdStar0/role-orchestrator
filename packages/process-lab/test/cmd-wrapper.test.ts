/**
 * M0-05 scenario 1 — npm `.cmd` wrapper (A26/A28 direction).
 *
 * Chain: node(vitest) -> cmd.exe (shim with `call node`) -> node (fake CLI
 * root) -> node (child) -> node (grandchild).
 * - `taskkill /PID <shim> /T /F` must end the whole chain;
 * - `taskkill /PID <shim> /F` without /T must leave the fake CLI tree alive
 *   (the residual-kill hazard a launcher must handle);
 * - the shim must propagate node exit codes (0 / 1 / 2).
 */
import { expect, test } from "vitest";
import { parseGrandchildReport } from "../src/fakecli.js";
import { waitForLine, withTimeout } from "../src/lines.js";
import { expectPidGone, isAlive, queryProcessIdentity } from "../src/proc.js";
import { taskkill } from "../src/taskkill.js";
import { requiredPid, spawnCmdProcess } from "../src/spawnproc.js";
import { setupLabFixture, teardownLabFixture, type LabFixture } from "./helpers.js";

const isWindows = process.platform === "win32";
const d = isWindows ? test : test.skip;

async function startGrandchildTree(
  fixture: LabFixture
): Promise<{
  shimPid: number;
  rootNodePid: number;
  childPid: number;
  grandchildPid: number;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
  const run = spawnCmdProcess(fixture.shim.path, ["--scenario", "grandchild"]);
  const shimPid = requiredPid(run.child);
  fixture.registry.add(shimPid);
  const reportLine = await waitForLine(
    run.stdout,
    (line) => line.includes("grandchildPid"),
    45_000,
    "grandchild PID report"
  );
  const report = parseGrandchildReport(reportLine);
  expect(report, `grandchild report line: ${reportLine.slice(0, 200)}`).not.toBeNull();
  const childIdentity = await queryProcessIdentity(report!.childPid);
  const rootNodePid = childIdentity?.parentPid;
  expect(rootNodePid, "fake CLI root PID resolved from the child's parent").toBeTypeOf("number");
  return {
    shimPid,
    rootNodePid: rootNodePid!,
    childPid: report!.childPid,
    grandchildPid: report!.grandchildPid,
    exit: run.exit
  };
}

d(
  "taskkill /T /F on the .cmd shim kills the whole cmd -> node -> node -> node chain",
  { timeout: 360_000 },
  async () => {
    const fixture = setupLabFixture("cmdwrap-treekill");
    try {
      const tree = await startGrandchildTree(fixture);

      const shimIdentity = await queryProcessIdentity(tree.shimPid);
      expect(shimIdentity?.name.toLowerCase()).toBe("cmd.exe");
      const rootIdentity = await queryProcessIdentity(tree.rootNodePid);
      expect(rootIdentity?.name.toLowerCase()).toBe("node.exe");

      const kill = await taskkill(tree.shimPid, { tree: true, force: true });
      expect(kill.exitCode, `taskkill /T /F output: ${kill.stdout} ${kill.stderr}`).toBe(0);
      const info = await withTimeout(tree.exit, 30_000, "cmd exit after tree kill");
      expect(info.code === 0, `cmd must not exit cleanly (got code=${String(info.code)})`).toBe(false);

      await expectPidGone(tree.shimPid);
      await expectPidGone(tree.rootNodePid);
      await expectPidGone(tree.childPid);
      await expectPidGone(tree.grandchildPid);
    } finally {
      await teardownLabFixture(fixture);
    }
  }
);

d(
  "without /T, killing only the .cmd shim leaves the fake CLI tree running",
  { timeout: 360_000 },
  async () => {
    const fixture = setupLabFixture("cmdwrap-residual");
    try {
      const tree = await startGrandchildTree(fixture);
      const rootIdentityBefore = await queryProcessIdentity(tree.rootNodePid);

      const kill = await taskkill(tree.shimPid, { force: true });
      expect(kill.exitCode, `taskkill /F output: ${kill.stdout} ${kill.stderr}`).toBe(0);
      await expectPidGone(tree.shimPid);

      // The orphaned subtree keeps running: identical creation timestamps
      // prove these are the original processes, not PID-reuse coincidences.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const rootIdentityAfter = await queryProcessIdentity(tree.rootNodePid);
      expect(rootIdentityAfter?.name.toLowerCase()).toBe("node.exe");
      expect(rootIdentityAfter?.creationTimeIso).toBe(rootIdentityBefore?.creationTimeIso);
      expect(isAlive(tree.childPid), "child must survive a shim-only kill").toBe(true);
      expect(isAlive(tree.grandchildPid), "grandchild must survive a shim-only kill").toBe(true);

      // Launcher lesson: the orphaned subtree must be found and killed.
      const cleanup = await taskkill(tree.rootNodePid, { tree: true, force: true });
      expect(cleanup.exitCode).toBe(0);
      await expectPidGone(tree.rootNodePid);
      await expectPidGone(tree.childPid);
      await expectPidGone(tree.grandchildPid);
    } finally {
      await teardownLabFixture(fixture);
    }
  }
);

d(".cmd shim propagates node exit codes (0 / 1 / 2)", { timeout: 360_000 }, async () => {
  const fixture = setupLabFixture("cmdwrap-codes");
  try {
    const cases: ReadonlyArray<{ argv: readonly string[]; expected: number }> = [
      { argv: ["--scenario", "success"], expected: 0 },
      { argv: ["--scenario", "error-result"], expected: 1 },
      { argv: ["--scenario", "success", "--definitely-not-a-flag"], expected: 2 }
    ];
    for (const item of cases) {
      const run = spawnCmdProcess(fixture.shim.path, item.argv);
      fixture.registry.add(requiredPid(run.child));
      const info = await withTimeout(run.exit, 45_000, `shim exit code for ${item.argv.join(" ")}`);
      expect(info.code, `argv: ${item.argv.join(" ")}`).toBe(item.expected);
      run.stdout.finish();
      run.stderr.finish();
    }
  } finally {
    await teardownLabFixture(fixture);
  }
});
