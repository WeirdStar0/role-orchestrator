/**
 * Engine lifecycle dogfood over the real fake-cli dist bins (M1-03 / A06 /
 * A23 / A24):
 *
 * - success (both dialects) reaches SUCCEEDED with ordered persisted events,
 *   recorded pid identity and session id, and dispatch/finish outbox
 *   messages;
 * - error-result fails on nonzero exit + final-result-error;
 * - all three fake-success variants NEVER succeed despite exit 0 (A06 core);
 * - a truncated stream fails as a protocol error despite exit 0;
 * - the timeout scenario is killed (tree kill) and recorded FAILED/timeout;
 * - mid-run cancellation records CANCELLED and kills the tree;
 * - a second concurrent start of the same slot is refused by the
 *   ActiveAttemptConflictError constraint (A23), and a preparation failure
 *   leaves no durable row behind.
 */
import { describe, expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { UnknownRunSnapshotError } from "@role-orchestrator/runtime-profile";
import {
  ActiveAttemptConflictError,
  countOutboxMessages,
  getActiveAttempt,
  getExecution,
  listEventsForExecution,
  listPendingOutboxMessages,
  parseJsonRecord,
  readExecutionPidIdentity,
  verifyEventChecksums
} from "@role-orchestrator/store";
import {
  LAUNCHER_APPLIES,
  FIXTURE_TARGET,
  createSeededDb,
  expectPidDead,
  expectRejection,
  launchFake,
  seedFakeRun,
  waitFor
} from "./helpers.js";
import { LIFECYCLE_EVENT_SEQ_BASE } from "../src/index.js";

if (!LAUNCHER_APPLIES) {
  console.warn(
    "[engine] non-Windows platform — launcher-bound cells are skipped " +
      "(production launcher is windows-native-only; the refusal itself is asserted in invocation.test.ts)"
  );
}


const SPAWN_TIMEOUT = 60_000;

function storedPid(db: DatabaseSync, executionId: string): number | null {
  const identity = readExecutionPidIdentity(db, executionId);
  return identity === null ? null : identity.pid;
}

describe.skipIf(!LAUNCHER_APPLIES)("engine lifecycle over fake-cli (dogfood)", () => {
  test(
    "claude success reaches SUCCEEDED with ordered persisted events",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const { db, close } = createSeededDb("success-claude");
      try {
        const seed = await seedFakeRun(db, { dialect: "claude" });
        const run = launchFake(db, seed, { executionId: "exec-ok-claude", scenario: "success" });
        const result = await run.result;

        expect(result.finalPhase).toBe("SUCCEEDED");
        expect(result.reasons).toEqual([]);
        expect(result.exitCode).toBe(0);
        expect(result.cancelled).toBe(false);
        expect(result.timedOut).toBe(false);
        expect(result.sessionId).toBe("session_synth_0001");
        expect(result.pidIdentity.pid).toBeGreaterThan(0);
        expect(result.pidIdentity.target).toBe(FIXTURE_TARGET);

        const row = getExecution(db, "exec-ok-claude");
        expect(row?.phase).toBe("SUCCEEDED");
        expect(row?.sessionId).toBe("session_synth_0001");

        // pid identity round-trips through the store primitive.
        expect(storedPid(db, "exec-ok-claude")).toBe(result.pidIdentity.pid);

        // Events: continuous seq in the protocol band, started first, result
        // before process_exited; the lifecycle outcome sits in the high band.
        const events = listEventsForExecution(db, "exec-ok-claude");
        const protocol = events.filter((event) => event.seq < LIFECYCLE_EVENT_SEQ_BASE);
        expect(protocol.map((event) => event.seq)).toEqual(protocol.map((_, index) => index + 1));
        expect(protocol[0]?.type).toBe("started");
        const types = protocol.map((event) => event.type);
        expect(types).toContain("result_reported");
        expect(types).toContain("usage_reported");
        expect(types).toContain("artifact_reported");
        expect(protocol[protocol.length - 1]?.type).toBe("process_exited");
        const resultIndex = types.indexOf("result_reported");
        const exitedIndex = types.indexOf("process_exited");
        expect(resultIndex).toBeLessThan(exitedIndex);
        expect(
          events.some((event) => event.seq >= LIFECYCLE_EVENT_SEQ_BASE && event.type === "lifecycle_outcome")
        ).toBe(true);
        expect(verifyEventChecksums(db)).toEqual([]);

        // Dispatch + finish outbox messages committed.
        const outbox = listPendingOutboxMessages(db);
        const messageTypes = outbox.map((message) => message.type).sort();
        expect(messageTypes).toEqual(["execution.attempt-finished", "execution.dispatch-requested"]);
        const finish = outbox.find((message) => message.type === "execution.attempt-finished");
        expect(parseJsonRecord(finish?.payload ?? "", "outbox")["finalPhase"]).toBe("SUCCEEDED");

        // Evidence gate passed: the cited artifact was protocol-reported.
        expect(result.evidence?.satisfied).toBe(true);
        expect(result.evidence?.citedIds).toEqual(["artifact_fake_report"]);
      } finally {
        close();
      }
    }
  );

  test(
    "codex success reaches SUCCEEDED with the thread id as session",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const { db, close } = createSeededDb("success-codex");
      try {
        const seed = await seedFakeRun(db, { dialect: "codex" });
        const run = launchFake(db, seed, { executionId: "exec-ok-codex", scenario: "success" });
        const result = await run.result;

        expect(result.finalPhase).toBe("SUCCEEDED");
        expect(result.reasons).toEqual([]);
        expect(result.sessionId).toBe("thread_synth_0001");
        const allEvents = listEventsForExecution(db, "exec-ok-codex");
        const types = allEvents
          .filter((event) => event.seq < LIFECYCLE_EVENT_SEQ_BASE)
          .map((event) => event.type);
        expect(types[0]).toBe("started");
        expect(types[types.length - 1]).toBe("process_exited");
        expect(types).toContain("artifact_reported");
        // codex evidence policy: any artifact report satisfies the citing result.
        expect(result.evidence?.satisfied).toBe(true);
        expect(result.evidence?.citedIds).toEqual(["artifact_fake_report"]);
        expect(getExecution(db, "exec-ok-codex")?.phase).toBe("SUCCEEDED");
      } finally {
        close();
      }
    }
  );

  test(
    "error-result fails on nonzero exit and final-result-error",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const { db, close } = createSeededDb(`error-${dialect}`);
        try {
          const seed = await seedFakeRun(db, { dialect });
          const run = launchFake(db, seed, {
            executionId: `exec-err-${dialect}`,
            scenario: "error-result"
          });
          const result = await run.result;
          expect(result.finalPhase).toBe("FAILED");
          expect(result.exitCode).not.toBe(0);
          expect(result.reasons).toEqual(["nonzero-exit", "final-result-error"]);
          expect(getExecution(db, `exec-err-${dialect}`)?.phase).toBe("FAILED");
        } finally {
          close();
        }
      }
    }
  );

  test(
    "all three fake-success variants never succeed despite exit 0 (A06)",
    { timeout: SPAWN_TIMEOUT * 3 },
    async () => {
      const expectations = {
        "error-final": ["final-result-error"],
        "missing-final": ["missing-final-result"],
        "schema-invalid": ["business-schema-invalid"]
      } as const;
      for (const dialect of ["claude", "codex"] as const) {
        for (const variant of ["error-final", "missing-final", "schema-invalid"] as const) {
          const { db, close } = createSeededDb(`fake-${dialect}-${variant}`);
          try {
            const seed = await seedFakeRun(db, { dialect });
            const executionId = `exec-fake-${dialect.slice(0, 3)}-${variant.slice(0, 6)}`;
            const run = launchFake(db, seed, {
              executionId,
              scenario: "fake-success",
              variant
            });
            const result = await run.result;
            expect(result.exitCode).toBe(0);
            expect(result.finalPhase).toBe("FAILED");
            expect(result.reasons).toEqual([...expectations[variant]]);
            expect(getExecution(db, executionId)?.phase).toBe("FAILED");
          } finally {
            close();
          }
        }
      }
    }
  );

  test(
    "truncated stream fails as protocol error despite exit 0",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const { db, close } = createSeededDb("truncated");
      try {
        const seed = await seedFakeRun(db, { dialect: "claude" });
        const run = launchFake(db, seed, { executionId: "exec-trunc", scenario: "truncated" });
        const result = await run.result;
        expect(result.exitCode).toBe(0); // the trap: exit code alone looks successful
        expect(result.finalPhase).toBe("FAILED");
        expect(result.reasons).toEqual(["protocol-error", "missing-final-result"]);
        expect(getExecution(db, "exec-trunc")?.phase).toBe("FAILED");
      } finally {
        close();
      }
    }
  );

  test(
    "timeout kills the process tree and records FAILED with the timeout reason",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const { db, close } = createSeededDb("timeout");
      try {
        const seed = await seedFakeRun(db, { dialect: "claude" });
        const run = launchFake(db, seed, {
          executionId: "exec-timeout",
          scenario: "timeout",
          timeoutSeconds: 1
        });
        const result = await run.result;
        expect(result.timedOut).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(result.finalPhase).toBe("FAILED");
        expect(result.reasons).toEqual(["nonzero-exit", "missing-final-result", "timeout"]);
        const pid = storedPid(db, "exec-timeout");
        expect(pid).not.toBeNull();
        await expectPidDead(pid as number);
        expect(getExecution(db, "exec-timeout")?.phase).toBe("FAILED");
      } finally {
        close();
      }
    }
  );

  test(
    "mid-run cancellation records CANCELLED and kills the process tree",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const { db, close } = createSeededDb("cancel");
      try {
        const seed = await seedFakeRun(db, { dialect: "claude" });
        const run = launchFake(db, seed, {
          executionId: "exec-cancel",
          scenario: "timeout",
          timeoutSeconds: 120
        });
        // Wait until the protocol actually started before cancelling.
        await waitFor(
          () => listEventsForExecution(db, "exec-cancel").some((event) => event.type === "started"),
          30_000,
          "started event"
        );
        const requested = await run.cancel("user-requested-stop");
        expect(requested).toBe(true);
        const result = await run.result;
        expect(result.cancelled).toBe(true);
        expect(result.timedOut).toBe(false);
        expect(result.finalPhase).toBe("CANCELLED");
        expect(result.reasons).toEqual(["cancelled"]);
        expect(getExecution(db, "exec-cancel")?.phase).toBe("CANCELLED");
        await expectPidDead(storedPid(db, "exec-cancel") as number);
        // A cancelled run must never leave an active attempt behind (slot free).
        expect(getActiveAttempt(db, { runId: seed.runId, nodeId: "node-1" })).toBeNull();
      } finally {
        close();
      }
    }
  );

  test(
    "second concurrent start of the same slot is refused (A23); prepare failure leaves no row",
    { timeout: SPAWN_TIMEOUT },
    async () => {
      const { db, close } = createSeededDb("conflict");
      try {
        const seed = await seedFakeRun(db, { dialect: "claude" });
        const first = launchFake(db, seed, {
          executionId: "exec-first",
          scenario: "timeout",
          timeoutSeconds: 120
        });
        await waitFor(
          () => listEventsForExecution(db, "exec-first").length > 0,
          30_000,
          "first run protocol events"
        );

        const second = launchFake(db, seed, {
          executionId: "exec-second",
          attempt: 2,
          scenario: "success"
        });
        const error = await expectRejection(second.result, ActiveAttemptConflictError);
        expect(error.runId).toBe(seed.runId);
        expect(error.nodeId).toBe("node-1");
        // The refused second attempt left no row at all.
        expect(getExecution(db, "exec-second")).toBeNull();

        // Cleanup: cancel the first run so no process outlives the test.
        await first.cancel("test-cleanup");
        const firstResult = await first.result;
        expect(firstResult.finalPhase).toBe("CANCELLED");

        // A preparation failure (unknown run) rejects before anything durable.
        const ghostSeed = { ...seed, runId: "run-ghost" };
        const ghost = launchFake(db, ghostSeed, {
          executionId: "exec-ghost",
          scenario: "success"
        });
        await expectRejection(ghost.result, UnknownRunSnapshotError);
        expect(getExecution(db, "exec-ghost")).toBeNull();
        expect(getActiveAttempt(db, { runId: "run-ghost", nodeId: "node-1" })).toBeNull();
        expect(countOutboxMessages(db, { pendingOnly: false })).toBe(
          2 // exec-first dispatch + finish
        );
      } finally {
        close();
      }
    }
  );
});
