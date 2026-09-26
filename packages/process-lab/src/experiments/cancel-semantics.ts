/**
 * Experiment 3 — cancel and daemon-loss semantics (A26 direction).
 *
 * Case A: hanging fake-cli (`timeout` scenario, no children) killed with
 *         plain `taskkill /F`. The process dies, the exit is not clean.
 * Case B: grandchild tree; root killed with `/F` only. M0-05 OBSERVED
 *         BEHAVIOR on Node 25.0.0/win32: the descendants die with the root
 *         (libuv parent-death cascade; `detached: true` exempts a child).
 *         The pre-kill identities prove the same processes were involved.
 *         (The surviving-orphan scenario is real but only one level up:
 *         killing the cmd.exe wrapper leaves the node tree alive — covered
 *         by the cmd-wrapper experiment's phase 2.)
 * Case C: same hanging CLI killed with `/T /F` for comparison.
 */
import { installFakeCli, parseGrandchildReport } from "../fakecli.js";
import { sleep, waitForLine, withTimeout } from "../lines.js";
import { expectPidGone, isAlive, queryProcessIdentity } from "../proc.js";
import { TreeRegistry } from "../registry.js";
import { makeScratchDir, removeScratch, type LabResult } from "../scratch.js";
import { requiredPid, spawnNodeProcess } from "../spawnproc.js";
import { taskkill } from "../taskkill.js";

interface ExitRecord {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A killed process must not report a clean exit; an unobserved exit counts as unclean too. */
function isUncleanExit(exit: ExitRecord | { error: string }): boolean {
  return "code" in exit ? exit.code !== 0 : true;
}

export async function runCancelSemanticsExperiment(): Promise<LabResult> {
  const registry = new TreeRegistry();
  const scratch = makeScratchDir("cancel");
  try {
    const fake = installFakeCli(scratch);
    const bin = fake.binPath("claude");

    // ---- Case A: timeout scenario + plain /F ------------------------------
    const runA = spawnNodeProcess(bin, ["--scenario", "timeout"]);
    const rootA = requiredPid(runA.child);
    registry.add(rootA);
    await waitForLine(runA.stdout, (lines) => lines.length >= 2, 30_000, "case A partial stream");
    await sleep(1_500);
    const hangCheckA = { stillRunningAfterMs: 1500, alive: isAlive(rootA) };
    const killA = await taskkill(rootA, { force: true });
    let exitA: ExitRecord | { error: string };
    try {
      exitA = await withTimeout(runA.exit, 30_000, "case A exit");
    } catch (error) {
      exitA = { error: String(error) };
    }
    await expectPidGone(rootA);
    const caseAOks =
      hangCheckA.alive && killA.exitCode === 0 && !isAlive(rootA) && isUncleanExit(exitA);

    // ---- Case B: grandchild tree, root /F, orphans, then /T /F ------------
    const runB = spawnNodeProcess(bin, ["--scenario", "grandchild"]);
    const rootB = requiredPid(runB.child);
    registry.add(rootB);
    const reportLine = await waitForLine(runB.stdout, (line) => line.includes("grandchildPid"), 45_000, "case B report");
    const report = parseGrandchildReport(reportLine);
    if (report === null) throw new Error("case B grandchild report unparseable");
    const childIdentityBefore = await queryProcessIdentity(report.childPid);
    const rootNodePid = childIdentityBefore?.parentPid;
    if (rootNodePid === undefined) throw new Error("case B could not resolve the root PID");
    const rootIdentityBefore = await queryProcessIdentity(rootNodePid);
    const killB = await taskkill(rootB, { force: true });
    let exitB: ExitRecord | { error: string };
    try {
      exitB = await withTimeout(runB.exit, 30_000, "case B exit");
    } catch (error) {
      exitB = { error: String(error) };
    }
    await expectPidGone(rootB);
    await sleep(2_000);
    const statesAfterRootKill = {
      child: await queryProcessIdentity(report.childPid),
      grandchild: await queryProcessIdentity(report.grandchildPid)
    };
    // Observed Node 25 cascade: the whole libuv-spawned subtree dies with the
    // root even under a plain /F (taskkill stdout names only the root PID).
    const childSame =
      childIdentityBefore !== null && statesAfterRootKill.child === null;
    const grandSame = statesAfterRootKill.grandchild === null;
    const caseBOk =
      killB.exitCode === 0 && !isAlive(rootB) && childSame && grandSame &&
      !isAlive(report.childPid) && !isAlive(report.grandchildPid);

    // ---- Case C: timeout scenario + /T /F ---------------------------------
    const runC = spawnNodeProcess(bin, ["--scenario", "timeout"]);
    const rootC = requiredPid(runC.child);
    registry.add(rootC);
    await waitForLine(runC.stdout, (lines) => lines.length >= 2, 30_000, "case C partial stream");
    const killC = await taskkill(rootC, { tree: true, force: true });
    let exitC: ExitRecord | { error: string };
    try {
      exitC = await withTimeout(runC.exit, 30_000, "case C exit");
    } catch (error) {
      exitC = { error: String(error) };
    }
    await expectPidGone(rootC);
    const caseCOk = killC.exitCode === 0 && !isAlive(rootC) && isUncleanExit(exitC);

    return {
      ok: caseAOks && caseBOk && caseCOk,
      caseA: {
        hangCheck: hangCheckA,
        kill: killA,
        exit: exitA,
        ok: caseAOks
      },
      caseB: {
        rootPid: rootB,
        rootNodePid,
        childPid: report.childPid,
        grandchildPid: report.grandchildPid,
        identitiesBeforeKill: { root: rootIdentityBefore, child: childIdentityBefore },
        killRootOnly: killB,
        rootExit: exitB,
        statesAfterRootKill,
        cascadeEvidence: { childGoneWithRoot: childSame, grandchildGoneWithRoot: grandSame },
        ok: caseBOk
      },
      caseC: {
        kill: killC,
        exit: exitC,
        ok: caseCOk
      }
    };
  } finally {
    await registry.reapAll();
    removeScratch(scratch);
  }
}
