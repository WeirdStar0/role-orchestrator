/**
 * Real-process reconcile tests (Windows): the fake-cli dist bin and real
 * OS processes in combination, probed through the REAL Win32_Process query.
 *
 * - a killed fake-cli child reconciles to interrupted and the slot frees;
 * - a PID-reuse simulation (real live placeholder holder + the recorded
 *   identity of an earlier, older holder) interrupts WITHOUT killing or
 *   adopting the unrelated holder (A27);
 * - an engine dogfood run (real fake-cli through startExecution) is confirmed
 *   running mid-flight, then finalizes normally; a completed run changes
 *   nothing.
 *
 * The process-identity probe is Windows-only by design (A29: no cross-namespace
 * pid interpretation), so these tests are gated like the process-lab suite.
 */
import { expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  createActiveAttempt,
  getExecution,
  getEvent,
  listEventsForExecution,
  readExecutionPidIdentity
} from "@role-orchestrator/store";
import { startExecution } from "@role-orchestrator/engine";
import { expectPidGone, isAlive, queryProcessIdentity, taskkill } from "@role-orchestrator/process-lab";
import {
  listRecoveryItems,
  reconcileEventId,
  reconcileStartup,
  windowsProcessProbe
} from "../src/index.js";
import {
  createSeededDb,
  makeAttempt,
  makeWorkDir,
  nowIso,
  seedFakeRun,
  spawnCmdPlaceholder,
  spawnFakeCliHold,
  type HoldProcess
} from "./helpers.js";

const isWindows = process.platform === "win32";
const d = isWindows ? test : test.skip;

const SPAWN_TIMEOUT = 240_000;

function phase(db: DatabaseSync, executionId: string): string | null {
  const row: unknown = db.prepare("SELECT phase FROM executions WHERE id = ?").get(executionId);
  if (row === undefined || row === null) return null;
  return String((row as { phase: unknown }).phase);
}

/** Poll until the probe sees the pid alive with the recorded identity window. */
async function waitForIdentityMatch(
  pid: number,
  storedCreationTime: string,
  toleranceMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "probe never ran";
  let firstProbeLogged = false;
  while (Date.now() < deadline) {
    const probe = await windowsProcessProbe(pid, 60_000);
    if (!firstProbeLogged) {
      firstProbeLogged = true;
      // Ground truth for CI diagnosis: the indeterminate REASON discriminates
      // timeout vs nonzero exit (stderr included) vs unparseable output.
      console.warn(`[reconcile-scan-test] first probe of pid ${String(pid)}: ${JSON.stringify(probe)}`);
    }
    if (probe.kind === "found" && probe.identity.creationTimeIso !== null) {
      const skew = Date.parse(probe.identity.creationTimeIso) - Date.parse(storedCreationTime);
      if (Math.abs(skew) <= toleranceMs) return;
      last = `skew ${String(skew)}ms`;
    } else {
      last = probe.kind === "found" ? "no creation time" : `${probe.kind}: ${"reason" in probe ? probe.reason : ""}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`identity of pid ${String(pid)} never matched within ${String(timeoutMs)}ms (last: ${last})`);
}

d("killed fake-cli child reconciles to INTERRUPTED and frees the slot", { timeout: SPAWN_TIMEOUT }, async () => {
  const { db, close } = createSeededDb("kill");
  let hold: HoldProcess | null = null;
  try {
    const seed = await seedFakeRun(db);
    hold = spawnFakeCliHold("timeout");
    const pid = hold.pid;
    const creationTime = nowIso();
    makeAttempt(db, {
      executionId: "exec-killed",
      runId: seed.runId,
      phase: "RUNNING",
      pid,
      pidCreationTime: creationTime
    });

    // Cross-check with the independent process-lab implementation, and wait
    // until the identity window is stable (the engine records the wall clock
    // at spawn; Win32_Process reports the real creation date).
    // 120s total (POLISH-1 pid-gone precedent): each poll may cost a full
    // cold-CIM probe on a 2-core runner.
    await waitForIdentityMatch(pid, creationTime, 5_000, 60_000);
    const labIdentity = await queryProcessIdentity(pid);
    expect(labIdentity?.creationTimeIso).not.toBeNull();

    // Simulate the daemon death + process death: taskkill /T /F, the engine
    // is NOT running for this attempt, nothing finalizes it.
    const kill = await taskkill(pid, { force: true });
    expect(kill.exitCode).toBe(0);
    await expectPidGone(pid);

    const scan = await reconcileStartup(db, { now: nowIso() });
    expect(scan.scanned).toBe(1);
    expect(scan.decisions[0]?.outcome).toBe("interrupted");
    expect(scan.decisions[0]?.detail.reason).toBe("process-gone");
    expect(scan.decisions[0]?.applied).toBe("applied");
    expect(phase(db, "exec-killed")).toBe("INTERRUPTED");
    expect(getEvent(db, reconcileEventId("exec-killed", "interrupted"))?.type).toBe("reconcile_interrupted");

    // Retry is now possible: a NEW attempt for the slot is creatable.
    expect(() =>
      createActiveAttempt(db, {
        id: "exec-killed-2",
        runId: seed.runId,
        nodeId: "node-1",
        definitionRevision: "rev-1",
        attempt: 2,
        dispatchToken: "dt-exec-killed-2",
        now: nowIso()
      })
    ).not.toThrow();
  } finally {
    if (hold !== null) await hold.stop();
    close();
  }
});

d("PID reuse simulation: the live placeholder holder survives the reconcile (A27)", { timeout: SPAWN_TIMEOUT }, async () => {
  const { db, close } = createSeededDb("reuse");
  let placeholder: HoldProcess | null = null;
  try {
    const seed = await seedFakeRun(db);

    // A REAL second process occupies the pid value now. The recorded identity
    // belongs to an EARLIER holder of the same pid (created 60s before the
    // placeholder) — the exact observable state after Windows reused the pid.
    // The placeholder is short-lived by construction (ping -n 600 self-exits
    // after ~10 minutes) and is tree-killed in cleanup regardless. The long
    // lifetime matters: on CI the pre-scan identity probes themselves can
    // cost 30-60s in CIM waves, which consumed most of a 60s ping window and
    // made the holder exit before the scan (run 36235211408: scan correctly
    // reported process-gone for an already-exited placeholder).
    const pid = placeholder.pid;
    // Diagnostic: distinguish "holder really exited" (not-found — an
    // environment property, e.g. ping blocked on the runner) from a query
    // failure (indeterminate + reason) before the process-lab cross-check.
    const holderProbe = await windowsProcessProbe(pid, 30_000);
    console.warn(`[reconcile-scan-test] placeholder holder probe: ${JSON.stringify(holderProbe)}`);
    const holderIdentity = await queryProcessIdentity(pid);
    expect(holderIdentity, `placeholder identity must be resolvable (probe: ${JSON.stringify(holderProbe)})`).not.toBeNull();
    expect(holderIdentity?.creationTimeIso).not.toBeNull();
    const holderCreatedMs = Date.parse(holderIdentity?.creationTimeIso ?? "");
    const originalCreatedMs = holderCreatedMs - 60_000;

    makeAttempt(db, {
      executionId: "exec-reuse",
      runId: seed.runId,
      phase: "RUNNING",
      pid,
      pidCreationTime: new Date(originalCreatedMs).toISOString()
    });

    const scan = await reconcileStartup(db, { now: nowIso() });
    expect(scan.decisions[0]?.outcome).toBe("interrupted");
    expect(scan.decisions[0]?.detail.reason).toBe("pid-reused-identity-mismatch");
    expect(phase(db, "exec-reuse")).toBe("INTERRUPTED");

    // 不误杀: the unrelated holder is untouched by the reconcile.
    expect(isAlive(pid)).toBe(true);
    // 不误认: the decision is NOT observed-running; the stored identity and the
    // observed holder are reported as different processes in the marker.
    const marker = getEvent(db, reconcileEventId("exec-reuse", "interrupted"));
    expect(String(marker?.payload)).toContain("pid-reused-identity-mismatch");
    expect(String(marker?.payload)).toContain("observedCreationTime");
  } finally {
    if (placeholder !== null) {
      await taskkill(placeholder.pid, { force: true, tree: true });
      await expectPidGone(placeholder.pid);
    }
    close();
  }
});

d("engine dogfood: mid-flight run is observed-running, then finalizes; completed run changes nothing", { timeout: SPAWN_TIMEOUT * 2 }, async () => {
  const { db, close } = createSeededDb("dogfood");
  try {
    const seed = await seedFakeRun(db);
    const run = startExecution(db, {
      executionId: "exec-dogfood",
      runId: seed.runId,
      roleId: "developer",
      nodeId: "node-1",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-dogfood",
      cwd: makeWorkDir("dogfood"),
      prompt: "synthetic reconcile dogfood prompt",
      invocationArgs: ["--scenario", "timeout"],
      timeoutSeconds: 120,
      now: nowIso()
    });

    // Wait until the engine has spawned, recorded identity, and moved to RUNNING.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const row = getExecution(db, "exec-dogfood");
      if (row?.phase === "RUNNING" && readExecutionPidIdentity(db, "exec-dogfood") !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(phase(db, "exec-dogfood")).toBe("RUNNING");
    const recorded = readExecutionPidIdentity(db, "exec-dogfood");
    expect(recorded).not.toBeNull();

    // Reconcile WHILE the engine genuinely owns the process: the real probe
    // must confirm the identity, change nothing, and surface the item.
    const scan = await reconcileStartup(db, { now: nowIso() });
    expect(scan.decisions[0]?.outcome).toBe("observed-running");
    expect(scan.decisions[0]?.detail.reason).toBe("process-alive-identity-confirmed");
    expect(scan.decisions[0]?.applied).toBe("applied");
    expect(phase(db, "exec-dogfood")).toBe("RUNNING");
    const item = listRecoveryItems(db).find((candidate) => candidate.executionId === "exec-dogfood");
    expect(item?.status).toBe("RUNNING_CONFIRMED");

    // The engine keeps ownership and finalizes normally.
    const cancelled = await run.cancel("test-cleanup");
    expect(cancelled).toBe(true);
    const result = await run.result;
    expect(result.finalPhase).toBe("CANCELLED");
    expect(phase(db, "exec-dogfood")).toBe("CANCELLED");

    // Post-terminal reconcile: no scan-visible rows, item gone, marker untouched.
    const markersBefore = listEventsForExecution(db, "exec-dogfood").filter((event) =>
      event.type.startsWith("reconcile_")
    ).length;
    const finalScan = await reconcileStartup(db, { now: nowIso() });
    expect(finalScan.scanned).toBe(0);
    expect(listRecoveryItems(db).filter((candidate) => candidate.executionId === "exec-dogfood")).toEqual([]);
    const markersAfter = listEventsForExecution(db, "exec-dogfood").filter((event) =>
      event.type.startsWith("reconcile_")
    ).length;
    expect(markersAfter).toBe(markersBefore);
  } finally {
    close();
  }
});

d("completed (SUCCEEDED) run: reconcile reports no changes end-to-end", { timeout: SPAWN_TIMEOUT * 2 }, async () => {
  const { db, close } = createSeededDb("noop");
  try {
    const seed = await seedFakeRun(db);
    const run = startExecution(db, {
      executionId: "exec-noop",
      runId: seed.runId,
      roleId: "developer",
      nodeId: "node-1",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-noop",
      cwd: makeWorkDir("noop"),
      prompt: "synthetic reconcile noop prompt",
      invocationArgs: ["--scenario", "success"],
      timeoutSeconds: 120,
      now: nowIso()
    });
    const result = await run.result;
    expect(result.finalPhase).toBe("SUCCEEDED");

    const scan = await reconcileStartup(db, { now: nowIso() });
    expect(scan.scanned).toBe(0);
    expect(scan.decisions).toEqual([]);
    expect(listRecoveryItems(db)).toEqual([]);
  } finally {
    close();
  }
});
