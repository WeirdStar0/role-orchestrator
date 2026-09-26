/**
 * Store-level scan semantics with an injected probe (no OS processes):
 * interrupt-and-retry over the A23 constraint, the A24 recovery window and
 * its slot blocking, fail-closed probe failures, concurrent idempotency
 * across two connections, no-changes on terminal rows, and the interrupted
 * list composition.
 */
import { describe, expect, test } from "vitest";
import {
  ActiveAttemptConflictError,
  countOutboxMessages,
  createActiveAttempt,
  getEvent,
  listEventsForExecution,
  markAttemptInterrupted,
  openDatabase,
  setAttemptPhase,
  verifyEventChecksums
} from "@role-orchestrator/store";
import {
  listRecoveryItems,
  reconcileEventId,
  reconcileStartup,
  resolveRecoveryItem,
  ReconcileTargetStateError,
  windowsProcessProbe,
  type ProcessProbeFn
} from "../src/index.js";
import {
  createSeededDb,
  iso,
  makeAttempt,
  seedFakeRun,
  T0
} from "./helpers.js";

const notFound: ProcessProbeFn = async () => ({ kind: "not-found" });
const indeterminate: ProcessProbeFn = async () => ({ kind: "indeterminate", reason: "injected failure" });
const foundAt = (creationTimeIso: string): ProcessProbeFn => async () => ({
  kind: "found",
  identity: { pid: 4242, name: "node.exe", parentPid: 1, creationTimeIso }
});

describe("reconcileStartup over the store (injected probe)", () => {
  test("pid gone: interrupted, slot freed, new attempt creatable (A23 retry)", async () => {
    const { db, close } = createSeededDb("gone");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-gone", runId: seed.runId, phase: "RUNNING", pid: 4242 });

      // While the attempt is active the slot blocks a second attempt.
      expect(() =>
        createActiveAttempt(db, {
          id: "exec-gone-2",
          runId: seed.runId,
          nodeId: "node-1",
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-gone-2",
          now: iso(10)
        })
      ).toThrow(ActiveAttemptConflictError);

      const scan = await reconcileStartup(db, { now: iso(20), probe: notFound });
      expect(scan.scanned).toBe(1);
      expect(scan.interrupted).toBe(1);
      const decision = scan.decisions[0];
      expect(decision?.outcome).toBe("interrupted");
      expect(decision?.detail.reason).toBe("process-gone");
      expect(decision?.applied).toBe("applied");

      const marker = getEvent(db, reconcileEventId("exec-gone", "interrupted"));
      expect(marker?.type).toBe("reconcile_interrupted");
      expect(String(marker?.payload)).toContain("process-gone");
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-gone")?.phase).toBe("INTERRUPTED");

      // Disposition frees the slot: the NEW attempt (attempt 2) is creatable.
      expect(() =>
        createActiveAttempt(db, {
          id: "exec-gone-2",
          runId: seed.runId,
          nodeId: "node-1",
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-gone-2",
          now: iso(30)
        })
      ).not.toThrow();

      const items = listRecoveryItems(db);
      const item = items.find((candidate) => candidate.executionId === "exec-gone");
      expect(item?.status).toBe("INTERRUPTED");
      expect(item?.followUp).toBe("retry-or-cancel");
      expect(item?.pendingDispatchIds).toHaveLength(1);
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("A24 window (STARTING, no pid): RECOVERY_REQUIRED, slot stays blocked, resolve frees it (A22)", async () => {
    const { db, close } = createSeededDb("a24");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-a24", runId: seed.runId, phase: "STARTING" });

      const scan = await reconcileStartup(db, { now: iso(20), probe: notFound });
      const decision = scan.decisions[0];
      expect(decision?.outcome).toBe("recovery-required");
      expect(decision?.detail.reason).toBe("launch-window-undetermined");
      expect(decision?.applied).toBe("applied");

      // The phase is NOT changed and the slot stays blocked — no auto re-run.
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-a24")?.phase).toBe("STARTING");
      expect(() =>
        createActiveAttempt(db, {
          id: "exec-a24-2",
          runId: seed.runId,
          nodeId: "node-1",
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-a24-2",
          now: iso(30)
        })
      ).toThrow(ActiveAttemptConflictError);

      const item = listRecoveryItems(db).find((candidate) => candidate.executionId === "exec-a24");
      expect(item?.status).toBe("RECOVERY_REQUIRED");
      expect(item?.followUp).toBe("manual-recovery");
      expect(item?.pendingDispatchIds).toHaveLength(1);

      // Resolving an execution WITHOUT the marker is refused.
      makeAttempt(db, { executionId: "exec-plain", runId: seed.runId, nodeId: "node-2", phase: "PREPARING" });
      expect(() =>
        resolveRecoveryItem(db, { executionId: "exec-plain", note: "no marker", now: iso(40) })
      ).toThrow(ReconcileTargetStateError);

      // Human resolution: INTERRUPTED, then the slot frees for attempt 2.
      const resolved = resolveRecoveryItem(db, {
        executionId: "exec-a24",
        note: "verified no side effects on disk",
        now: iso(50)
      });
      expect(resolved).toBe("applied");
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-a24")?.phase).toBe("INTERRUPTED");
      expect(() =>
        createActiveAttempt(db, {
          id: "exec-a24-2",
          runId: seed.runId,
          nodeId: "node-1",
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-a24-2",
          now: iso(60)
        })
      ).not.toThrow();
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("PREPARING rows are determinate never-started and interrupted", async () => {
    const { db, close } = createSeededDb("preparing");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-prep", runId: seed.runId, phase: "PREPARING" });
      const scan = await reconcileStartup(db, { now: iso(20), probe: notFound });
      expect(scan.decisions[0]?.detail.reason).toBe("never-started-preparing");
      expect(scan.interrupted).toBe(1);
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-prep")?.phase).toBe("INTERRUPTED");
    } finally {
      close();
    }
  });

  test("probe failure is fail-closed: recovery-required, slot stays blocked", async () => {
    const { db, close } = createSeededDb("probe-fail");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-fail", runId: seed.runId, phase: "RUNNING", pid: 4242 });
      const scan = await reconcileStartup(db, { now: iso(20), probe: indeterminate });
      expect(scan.recoveryRequired).toBe(1);
      expect(scan.decisions[0]?.detail.reason).toBe("probe-indeterminate");
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-fail")?.phase).toBe("RUNNING");
      expect(() =>
        createActiveAttempt(db, {
          id: "exec-fail-2",
          runId: seed.runId,
          nodeId: "node-1",
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-fail-2",
          now: iso(30)
        })
      ).toThrow(ActiveAttemptConflictError);
    } finally {
      close();
    }
  });

  test("live holder with mismatched creation time interrupts at scan level; matching one observes", async () => {
    const { db, close } = createSeededDb("reuse-scan");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, {
        executionId: "exec-reuse",
        runId: seed.runId,
        phase: "RUNNING",
        pid: 4242,
        pidCreationTime: T0
      });
      const reused = await reconcileStartup(db, { now: iso(20), probe: foundAt(iso(60_000)) });
      expect(reused.decisions[0]?.detail.reason).toBe("pid-reused-identity-mismatch");
      expect(reused.interrupted).toBe(1);
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-reuse")?.phase).toBe("INTERRUPTED");

      makeAttempt(db, {
        executionId: "exec-alive",
        runId: seed.runId,
        nodeId: "node-2",
        phase: "RUNNING",
        pid: 4243,
        pidCreationTime: T0
      });
      const alive = await reconcileStartup(db, { now: iso(30), probe: foundAt(iso(500)) });
      const decision = alive.decisions.find((candidate) => candidate.executionId === "exec-alive");
      expect(decision?.outcome).toBe("observed-running");
      expect(decision?.applied).toBe("applied");
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-alive")?.phase).toBe("RUNNING");
      const item = listRecoveryItems(db).find((candidate) => candidate.executionId === "exec-alive");
      expect(item?.status).toBe("RUNNING_CONFIRMED");
      expect(item?.followUp).toBe("resume-observation");
    } finally {
      close();
    }
  });

  test("terminal and unmarked rows are invisible to the scan and the list; nothing changes", async () => {
    const { db, close } = createSeededDb("terminal");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-done", runId: seed.runId, phase: "PREPARING" });
      // Simulate the engine's normal terminal transition.
      setAttemptPhase(db, { id: "exec-done", phase: "SUCCEEDED", now: iso(10) });
      const outboxBefore = countOutboxMessages(db, { pendingOnly: true });
      const eventsBefore = listEventsForExecution(db, "exec-done").length;

      const scan = await reconcileStartup(db, { now: iso(20), probe: notFound });
      expect(scan.scanned).toBe(0);
      expect(scan.decisions).toEqual([]);
      expect(listRecoveryItems(db)).toEqual([]);
      expect(countOutboxMessages(db, { pendingOnly: true })).toBe(outboxBefore);
      expect(listEventsForExecution(db, "exec-done")).toHaveLength(eventsBefore);
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("pre-existing INTERRUPTED rows are listed with reason null (not set by reconcile)", async () => {
    const { db, close } = createSeededDb("foreign-interrupted");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-foreign", runId: seed.runId, phase: "RUNNING", pid: 500 });
      markAttemptInterrupted(db, { id: "exec-foreign", now: iso(5) });
      const scan = await reconcileStartup(db, { now: iso(20), probe: notFound });
      expect(scan.scanned).toBe(0);
      const item = listRecoveryItems(db).find((candidate) => candidate.executionId === "exec-foreign");
      expect(item?.status).toBe("INTERRUPTED");
      expect(item?.reason).toBeNull();
      expect(item?.markedAt).toBeNull();
    } finally {
      close();
    }
  });

  test("re-scans are idempotent: one marker event, phase stable, results agree", async () => {
    const { db, close } = createSeededDb("idempotent");
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-twice", runId: seed.runId, phase: "RUNNING", pid: 4242 });
      const first = await reconcileStartup(db, { now: iso(20), probe: notFound });
      expect(first.decisions[0]?.applied).toBe("applied");
      const second = await reconcileStartup(db, { now: iso(30), probe: notFound });
      expect(second.scanned).toBe(0); // interrupted rows are no longer active
      expect(second.decisions).toEqual([]);

      // The recovery-required path re-scans the same active row but never duplicates.
      makeAttempt(db, { executionId: "exec-rec", runId: seed.runId, nodeId: "node-2", phase: "STARTING" });
      const third = await reconcileStartup(db, { now: iso(40), probe: notFound });
      expect(third.decisions.find((candidate) => candidate.executionId === "exec-rec")?.applied).toBe("applied");
      const fourth = await reconcileStartup(db, { now: iso(50), probe: notFound });
      expect(fourth.decisions.find((candidate) => candidate.executionId === "exec-rec")?.applied).toBe("already-applied");
      const recMarkers = listEventsForExecution(db, "exec-rec").filter(
        (event) => event.type === "reconcile_recovery_required"
      );
      expect(recMarkers).toHaveLength(1);
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("concurrent reconciles on two connections: exactly one application, both scans succeed", async () => {
    const { db, dbPath, close } = createSeededDb("concurrent");
    const db2 = openDatabase(dbPath);
    try {
      const seed = await seedFakeRun(db);
      makeAttempt(db, { executionId: "exec-race", runId: seed.runId, phase: "RUNNING", pid: 4242 });

      const [a, b] = await Promise.all([
        reconcileStartup(db, { now: iso(20), probe: notFound }),
        reconcileStartup(db2, { now: iso(20), probe: notFound })
      ]);
      const applications = [...a.decisions, ...b.decisions].filter(
        (decision) => decision.executionId === "exec-race" && decision.applied === "applied"
      );
      expect(applications).toHaveLength(1);
      for (const decision of [...a.decisions, ...b.decisions]) {
        expect(decision.outcome).toBe("interrupted");
      }
      expect(db.prepare("SELECT phase FROM executions WHERE id = ?").get("exec-race")?.phase).toBe("INTERRUPTED");
      expect(
        listEventsForExecution(db, "exec-race").filter((event) => event.type === "reconcile_interrupted")
      ).toHaveLength(1);
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      db2.close();
      close();
    }
  });

  test(
    "the default probe is the real windowsProcessProbe and platform-honest",
    // The real probe's own budget is 15s (a full Win32_Process enumeration via
    // powershell.exe). Under a full turbo run (~20 parallel workers) that
    // enumeration can exceed vitest's 5s default, which surfaced as a
    // load-only failure once the turbo cache for this package was invalidated
    // (M6-01, 2026-09-24). The explicit budget matches the probe's own; no
    // assertion is weakened. Same convention as the process-lab OS-bound
    // tests.
    { timeout: 20_000 },
    async () => {
      // On a non-Windows host the real probe must refuse to interpret pids
      // rather than guess; on Windows it runs a live query for THIS process.
      const probe = await windowsProcessProbe(process.pid, 15_000);
      if (process.platform === "win32") {
        expect(probe.kind).toBe("found");
        if (probe.kind === "found") {
          expect(probe.identity.pid).toBe(process.pid);
          expect(probe.identity.creationTimeIso).not.toBeNull();
        }
      } else {
        expect(probe.kind).toBe("indeterminate");
      }
    }
  );
});
