import { describe, expect, it } from "vitest";
import {
  ActiveAttemptConflictError,
  createActiveAttempt,
  getActiveAttempt,
  getExecution,
  listActiveAttempts,
  markAttemptInterrupted,
  NoRowUpdatedError,
  readExecutionPidIdentity,
  setAttemptPhase,
  setExecutionPidIdentity,
  setExecutionSessionId
} from "../src/index.js";
import { T0, createMigratedMemoryDb, expectError, iso, seedExecution } from "./helpers.js";

const PID_IDENTITY = {
  pid: 4242,
  creationTime: iso(1),
  executionNonce: "nonce-1",
  target: "windows-native"
} as const;

describe("execution pid/session primitives (M1-03)", () => {
  it("records and reads back a pid identity", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    setExecutionPidIdentity(db, { id: executionId, pidIdentity: PID_IDENTITY, now: iso(2) });
    expect(readExecutionPidIdentity(db, executionId)).toEqual(PID_IDENTITY);
    const row = getExecution(db, executionId);
    expect(row?.pidIdentity).not.toBeNull();
    expect(row?.updatedAt).toBe(iso(2));
  });

  it("returns null for an attempt that never recorded a process", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    expect(readExecutionPidIdentity(db, executionId)).toBeNull();
  });

  it("guards the pid write with wherePhaseIn", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db); // seeded as STARTING
    expectError(
      () =>
        setExecutionPidIdentity(db, {
          id: executionId,
          pidIdentity: PID_IDENTITY,
          wherePhaseIn: ["RUNNING"],
          now: iso(2)
        }),
      NoRowUpdatedError
    );
    // The guarded failure must not have written anything.
    expect(readExecutionPidIdentity(db, executionId)).toBeNull();
    setExecutionPidIdentity(db, {
      id: executionId,
      pidIdentity: PID_IDENTITY,
      wherePhaseIn: ["STARTING"],
      now: iso(2)
    });
    expect(readExecutionPidIdentity(db, executionId)).toEqual(PID_IDENTITY);
  });

  it("records a session id with the same guard semantics", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    setExecutionSessionId(db, {
      id: executionId,
      sessionId: "session_synth_0001",
      wherePhaseIn: ["STARTING", "RUNNING"],
      now: iso(3)
    });
    expect(getExecution(db, executionId)?.sessionId).toBe("session_synth_0001");
    expectError(
      () =>
        setExecutionSessionId(db, {
          id: executionId,
          sessionId: "session-second",
          wherePhaseIn: ["FINALIZING"],
          now: iso(4)
        }),
      NoRowUpdatedError
    );
    // The rejected write must not have clobbered the recorded session id.
    expect(getExecution(db, executionId)?.sessionId).toBe("session_synth_0001");
  });

  it("rejects malformed identity records and empty phase guards", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    expectError(
      () =>
        setExecutionPidIdentity(db, {
          id: executionId,
          pidIdentity: { ...PID_IDENTITY, pid: 0 },
          now: iso(2)
        }),
      Error
    );
    expectError(
      () =>
        setExecutionPidIdentity(db, {
          id: executionId,
          // The static input type already rejects unknown targets; this cast
          // exercises the RUNTIME validator against the same malformed value
          // (data arriving from outside TypeScript's view must still fail).
          pidIdentity: { ...PID_IDENTITY, target: "not-a-target" as unknown as "windows-native" },
          now: iso(2)
        }),
      Error
    );
    expectError(
      () =>
        setExecutionSessionId(db, {
          id: executionId,
          sessionId: "session-x",
          wherePhaseIn: [],
          now: iso(2)
        }),
      NoRowUpdatedError
    );
  });

  it("raises NoRowUpdatedError for an unknown execution", () => {
    const db = createMigratedMemoryDb();
    expectError(
      () =>
        setExecutionSessionId(db, { id: "exec-missing", sessionId: "s", now: iso(1) }),
      NoRowUpdatedError
    );
    expectError(() => readExecutionPidIdentity(db, "exec-missing"), NoRowUpdatedError);
  });
});

describe("A23/A24 reconcile primitives", () => {
  it("lists every active attempt across slots and frees the slot via INTERRUPTED", () => {
    const db = createMigratedMemoryDb();
    seedExecution(db, { projectId: "proj-a", runId: "run-1", nodeId: "node-a", executionId: "exec-a" });
    seedExecution(db, { projectId: "proj-b", runId: "run-2", nodeId: "node-b", executionId: "exec-b" });
    const active = listActiveAttempts(db);
    expect(active.map((row) => row.id).sort()).toEqual(["exec-a", "exec-b"]);

    markAttemptInterrupted(db, { id: "exec-a", now: iso(1) });
    expect(listActiveAttempts(db).map((row) => row.id)).toEqual(["exec-b"]);
  });

  it("keeps at most one active attempt per slot until reconcile marks it INTERRUPTED", () => {
    const db = createMigratedMemoryDb();
    const { runId, nodeId } = seedExecution(db, { executionId: "exec-a" });
    expectError(
      () =>
        createActiveAttempt(db, {
          id: "exec-b",
          runId,
          nodeId,
          definitionRevision: "rev-1",
          attempt: 2,
          dispatchToken: "dt-exec-b",
          now: T0
        }),
      ActiveAttemptConflictError
    );

    markAttemptInterrupted(db, { id: "exec-a", now: iso(1) });
    // Reconcile freed the slot: a new attempt can now be created.
    const second = createActiveAttempt(db, {
      id: "exec-b",
      runId,
      nodeId,
      definitionRevision: "rev-1",
      attempt: 2,
      dispatchToken: "dt-exec-b",
      now: iso(2)
    });
    expect(second.phase).toBe("PREPARING");
    expect(getActiveAttempt(db, { runId, nodeId })?.id).toBe("exec-b");
  });

  it("keeps dispatch tokens unique so a restarting dispatcher finds the old attempt", () => {
    const db = createMigratedMemoryDb();
    const { runId } = seedExecution(db, { executionId: "exec-a" });
    setExecutionPidIdentity(db, {
      id: "exec-a",
      pidIdentity: PID_IDENTITY,
      wherePhaseIn: ["STARTING"],
      now: iso(1)
    });
    // A24: the same dispatch token must never create a second attempt row.
    let violation: unknown;
    try {
      createActiveAttempt(db, {
        id: "exec-b",
        runId,
        nodeId: "node-other",
        definitionRevision: "rev-1",
        attempt: 1,
        dispatchToken: "dt-exec-a",
        now: T0
      });
    } catch (error) {
      violation = error;
    }
    expect(String(violation)).toContain("dispatch_token");

    // The restart path reads the existing attempt through the token and its
    // recorded process identity instead of re-dispatching.
    setAttemptPhase(db, { id: "exec-a", phase: "RUNNING", wherePhaseIn: ["STARTING"], now: iso(2) });
    expect(readExecutionPidIdentity(db, "exec-a")).toEqual(PID_IDENTITY);
  });
});
