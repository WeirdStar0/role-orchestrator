/**
 * Experiment 1 — npm `.cmd` wrapper scenario (A26/A28 direction).
 *
 * Chain under test: node(spawner) -> cmd.exe (shim) -> `call node` (fake CLI
 * root) -> node (child) -> node (grandchild).
 *
 * Phase 1: taskkill /PID <shim> /T /F must terminate the whole chain.
 * Phase 2: taskkill /PID <shim> /F (no /T) kills only the shim; the fake CLI
 *          tree survives as an orphaned subtree (the residual-kill hazard).
 * Phase 3: the shim must propagate node exit codes (0 / 1 / 2).
 */
import { installFakeCli, parseGrandchildReport } from "../fakecli.js";
import { sleep, waitForLine, withTimeout } from "../lines.js";
import { expectPidGone, isAlive, queryProcessIdentity, type ProcessIdentity } from "../proc.js";
import { TreeRegistry } from "../registry.js";
import { makeScratchDir, removeScratch, type LabResult } from "../scratch.js";
import { writeCmdShim } from "../shim.js";
import { requiredPid, spawnCmdProcess } from "../spawnproc.js";
import { taskkill } from "../taskkill.js";

interface TreeIds {
  readonly shimPid: number;
  readonly rootNodePid: number;
  readonly childPid: number;
  readonly grandchildPid: number;
  readonly shimIdentity: ProcessIdentity | null;
  readonly rootNodeIdentity: ProcessIdentity | null;
  readonly grandchildParentCheck: ProcessIdentity | null;
}

/** Starts one grandchild run through the shim and resolves every PID. */
async function startTree(
  shimPath: string,
  registry: TreeRegistry
): Promise<{ run: ReturnType<typeof spawnCmdProcess>; ids: TreeIds }> {
  const run = spawnCmdProcess(shimPath, ["--scenario", "grandchild"]);
  const shimPid = requiredPid(run.child);
  registry.add(shimPid);
  const reportLine = await waitForLine(run.stdout, (line) => line.includes("grandchildPid"), 45_000, "grandchild PID report");
  const report = parseGrandchildReport(reportLine);
  if (report === null) throw new Error(`grandchild report line not parseable: ${reportLine.slice(0, 200)}`);
  const childIdentity = await queryProcessIdentity(report.childPid);
  const rootNodePid = childIdentity?.parentPid;
  if (rootNodePid === undefined) throw new Error("could not resolve the fake CLI root PID from the child's parent");
  const rootNodeIdentity = await queryProcessIdentity(rootNodePid);
  const grandIdentity = await queryProcessIdentity(report.grandchildPid);
  return {
    run,
    ids: {
      shimPid,
      rootNodePid,
      childPid: report.childPid,
      grandchildPid: report.grandchildPid,
      shimIdentity: await queryProcessIdentity(shimPid),
      rootNodeIdentity,
      grandchildParentCheck: grandIdentity
    }
  };
}

export async function runCmdWrapperExperiment(): Promise<LabResult> {
  const registry = new TreeRegistry();
  const scratch = makeScratchDir("cmdwrap");
  const startedAt = new Date().toISOString();
  try {
    installFakeCli(scratch);
    const shim = writeCmdShim(scratch, "fake-claude.cmd", "fake-cli-dist\\bin\\fake-claude.js");

    // ---- Phase 1: tree kill ------------------------------------------------
    const tree1 = await startTree(shim.path, registry);
    const killTree = await taskkill(tree1.ids.shimPid, { tree: true, force: true });
    let tree1Exit: { code: number | null; signal: NodeJS.Signals | null } | { error: string };
    try {
      tree1Exit = await withTimeout(tree1.run.exit, 30_000, "phase-1 cmd exit");
    } catch (error) {
      tree1Exit = { error: String(error) };
    }
    await sleep(200);
    const phase1 = {
      ids: tree1.ids,
      kill: killTree,
      cmdExit: tree1Exit,
      shimDead: !(await isAlive(tree1.ids.shimPid)),
      rootNodeDead: !(await isAlive(tree1.ids.rootNodePid)),
      childDead: !(await isAlive(tree1.ids.childPid)),
      grandchildDead: !(await isAlive(tree1.ids.grandchildPid))
    };
    await expectPidGone(tree1.ids.shimPid);
    await expectPidGone(tree1.ids.rootNodePid);
    await expectPidGone(tree1.ids.childPid);
    await expectPidGone(tree1.ids.grandchildPid);
    const phase1Ok =
      killTree.exitCode === 0 && phase1.shimDead && phase1.rootNodeDead && phase1.childDead && phase1.grandchildDead;

    // ---- Phase 2: single kill without /T ----------------------------------
    const tree2 = await startTree(shim.path, registry);
    const rootIdentityBefore = tree2.ids.rootNodeIdentity;
    const killSingle = await taskkill(tree2.ids.shimPid, { force: true });
    let shim2Exit: { code: number | null; signal: NodeJS.Signals | null } | { error: string };
    try {
      shim2Exit = await withTimeout(tree2.run.exit, 30_000, "phase-2 cmd exit");
    } catch (error) {
      shim2Exit = { error: String(error) };
    }
    await expectPidGone(tree2.ids.shimPid);
    // Give any cascading termination a generous window before judging.
    await sleep(2_000);
    const rootIdentityAfter = await queryProcessIdentity(tree2.ids.rootNodePid);
    const childIdentityAfter = await queryProcessIdentity(tree2.ids.childPid);
    const grandIdentityAfter = await queryProcessIdentity(tree2.ids.grandchildPid);
    const sameRootStillRunning =
      rootIdentityAfter !== null &&
      rootIdentityBefore !== null &&
      rootIdentityAfter.creationTimeIso === rootIdentityBefore.creationTimeIso;
    const phase2 = {
      ids: { shimPid: tree2.ids.shimPid, rootNodePid: tree2.ids.rootNodePid, childPid: tree2.ids.childPid, grandchildPid: tree2.ids.grandchildPid },
      kill: killSingle,
      cmdExit: shim2Exit,
      rootStillRunning: sameRootStillRunning,
      rootIdentityAfter,
      childIdentityAfter,
      grandIdentityAfter
    };
    const phase2Ok =
      killSingle.exitCode === 0 && sameRootStillRunning && childIdentityAfter !== null && grandIdentityAfter !== null;
    // Cleanup of the residuals (this is the product-side lesson: without /T
    // the launcher MUST find and kill the orphaned subtree itself).
    const cleanupKill = await taskkill(tree2.ids.rootNodePid, { tree: true, force: true });
    await expectPidGone(tree2.ids.rootNodePid);
    await expectPidGone(tree2.ids.childPid);
    await expectPidGone(tree2.ids.grandchildPid);
    const cleanupOk = cleanupKill.exitCode === 0;

    // ---- Phase 3: exit-code propagation through the shim -------------------
    const propagation: Array<{ argv: readonly string[]; exitCode: number | null }> = [];
    for (const argv of [
      ["--scenario", "success"],
      ["--scenario", "error-result"],
      ["--scenario", "success", "--definitely-not-a-flag"]
    ]) {
      const run = spawnCmdProcess(shim.path, argv);
      registry.add(requiredPid(run.child));
      const info = await withTimeout(run.exit, 45_000, `shim propagation ${argv.join(" ")}`);
      propagation.push({ argv, exitCode: info.code });
      run.stdout.finish();
      run.stderr.finish();
    }
    const phase3Ok =
      propagation[0]?.exitCode === 0 && propagation[1]?.exitCode === 1 && propagation[2]?.exitCode === 2;

    return {
      ok: phase1Ok && phase2Ok && phase3Ok && cleanupOk,
      startedAt,
      scratch,
      shimPath: shim.path,
      shimText: shim.text,
      phase1,
      phase1Ok,
      phase2,
      phase2Ok,
      residualCleanup: { kill: cleanupKill, ok: cleanupOk },
      phase3: propagation,
      phase3Ok
    };
  } finally {
    await registry.reapAll();
    removeScratch(scratch);
  }
}
