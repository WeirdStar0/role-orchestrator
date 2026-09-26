/**
 * `node_retry_state` (migration 014): the classification mirror records
 * every failed attempt exactly once, refuses to rewind or exceed the A21
 * bound, re-validates stored rows strictly, and stays presence-tolerant on
 * databases that predate migration 014.
 */
import { describe, expect, it } from "vitest";
import {
  BudgetRowIntegrityError,
  AttemptBeyondCapError,
  InvalidRetryStateError,
  getRetryState,
  recordAttemptFailure
} from "../src/index.js";
import { createBudgetDb, createCoreOnlyDb, expectError, seedRunOnly } from "./helpers.js";

describe("node_retry_state mirror", () => {
  it("records the first failure and reads it back strictly", () => {
    const { db } = createBudgetDb("mirror-first");
    seedRunOnly(db, "run-1");
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      reasons: ["timeout"],
      now: "2026-09-22T00:00:01.000Z"
    });
    const state = getRetryState(db, { runId: "run-1", nodeId: "node-1" });
    expect(state).toEqual({
      runId: "run-1",
      nodeId: "node-1",
      totalAttempts: 1,
      conditionalRetriesUsed: 0,
      lastFailureReasons: ["timeout"],
      lastRetryPolicy: "auto",
      exhaustedAt: null,
      createdAt: "2026-09-22T00:00:01.000Z",
      updatedAt: "2026-09-22T00:00:01.000Z"
    });
  });

  it("tracks the once-then-manual consumption and the exhaustion stamp", () => {
    const { db } = createBudgetDb("mirror-conditional");
    seedRunOnly(db, "run-1");
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      reasons: ["protocol-error"],
      now: "2026-09-22T00:00:01.000Z"
    });
    // The one granted conditional retry, consumed on the second failure.
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 2,
      reasons: ["protocol-error"],
      consumedConditionalRetry: true,
      now: "2026-09-22T00:00:02.000Z"
    });
    let state = getRetryState(db, { runId: "run-1", nodeId: "node-1" });
    expect(state?.conditionalRetriesUsed).toBe(1);
    expect(state?.totalAttempts).toBe(2);
    expect(state?.exhaustedAt).toBeNull();

    // A third failure with an auto reason stamps the A21 exhaustion (the
    // CHECK would refuse a fourth).
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 3,
      reasons: ["timeout"],
      now: "2026-09-22T00:00:03.000Z"
    });
    state = getRetryState(db, { runId: "run-1", nodeId: "node-1" });
    expect(state?.totalAttempts).toBe(3);
    expect(state?.exhaustedAt).toBe("2026-09-22T00:00:03.000Z");
    expect(state?.lastRetryPolicy).toBe("auto");
  });

  it("refuses to record a fourth attempt or rewind the mirror", () => {
    const { db } = createBudgetDb("mirror-cap");
    seedRunOnly(db, "run-1");
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      reasons: ["timeout"],
      now: "2026-09-22T00:00:01.000Z"
    });
    const beyond = expectError(
      () =>
        recordAttemptFailure(db, {
          runId: "run-1",
          nodeId: "node-1",
          attempt: 4,
          reasons: ["timeout"],
          now: "2026-09-22T00:00:02.000Z"
        }),
      AttemptBeyondCapError
    );
    expect(beyond.attempt).toBe(4);
    expect(beyond.nodeId).toBe("node-1");

    const rewind = expectError(
      () =>
        recordAttemptFailure(db, {
          runId: "run-1",
          nodeId: "node-1",
          attempt: 1,
          reasons: ["timeout"],
          now: "2026-09-22T00:00:02.000Z"
        }),
      InvalidRetryStateError
    );
    expect(rewind.message).toContain("refusing to rewind");
  });

  it("grants the conditional retry on the first failure and refuses a second consumption", () => {
    const { db } = createBudgetDb("mirror-conditional-guards");
    seedRunOnly(db, "run-1");
    // The FIRST protocol-error failure grants (and thereby consumes) the
    // node's single conditional retry — the mirror is born with it used.
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      reasons: ["protocol-error"],
      consumedConditionalRetry: true,
      now: "2026-09-22T00:00:01.000Z"
    });
    expect(getRetryState(db, { runId: "run-1", nodeId: "node-1" })).toMatchObject({
      totalAttempts: 1,
      conditionalRetriesUsed: 1
    });
    // A direct second consumption on the existing row is a typed refusal —
    // the mirror's own backstop behind the eligibility check.
    expectError(
      () =>
        recordAttemptFailure(db, {
          runId: "run-1",
          nodeId: "node-1",
          attempt: 2,
          reasons: ["protocol-error"],
          consumedConditionalRetry: true,
          now: "2026-09-22T00:00:02.000Z"
        }),
      InvalidRetryStateError
    );
    // A non-conditional second failure records fine.
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 2,
      reasons: ["business-schema-invalid"],
      now: "2026-09-22T00:00:03.000Z"
    });
    expect(getRetryState(db, { runId: "run-1", nodeId: "node-1" })).toMatchObject({
      totalAttempts: 2,
      conditionalRetriesUsed: 1
    });
  });

  it("fails closed on a tampered mirror row", () => {
    const { db } = createBudgetDb("mirror-tamper");
    seedRunOnly(db, "run-1");
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      reasons: ["timeout"],
      now: "2026-09-22T00:00:01.000Z"
    });
    db.prepare("UPDATE node_retry_state SET last_failure_reasons = ? WHERE run_id = 'run-1'").run(
      JSON.stringify(["not-a-real-reason"])
    );
    expectError(() => getRetryState(db, { runId: "run-1", nodeId: "node-1" }), BudgetRowIntegrityError);
    // Non-array JSON is unreachable even by direct SQL tampering: the
    // column CHECK (json_type = 'array') refuses it at the storage layer.
    expect(() =>
      db.prepare("UPDATE node_retry_state SET last_failure_reasons = 'not-json' WHERE run_id = 'run-1'").run()
    ).toThrow(/malformed JSON|CHECK constraint failed/);
  });

  it("is presence-tolerant on a database without migration 014", () => {
    const { db } = createCoreOnlyDb("mirror-absent");
    // No throw, no write: the mirror simply does not exist yet; the attempt
    // cap itself is enforced from `executions` and needs no mirror.
    recordAttemptFailure(db, {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      reasons: ["timeout"],
      now: "2026-09-22T00:00:01.000Z"
    });
    expect(getRetryState(db, { runId: "run-1", nodeId: "node-1" })).toBeNull();
  });

  it("rejects malformed input before touching the database", () => {
    const { db } = createBudgetDb("mirror-input");
    seedRunOnly(db, "run-1");
    expect(() =>
      recordAttemptFailure(db, {
        runId: "run-1",
        nodeId: "node-1",
        attempt: 1,
        reasons: ["made-up-reason" as unknown as "timeout"],
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    expect(() =>
      recordAttemptFailure(db, {
        runId: "run-1",
        nodeId: "node-1",
        attempt: 1,
        reasons: ["timeout"],
        extraField: true,
        now: "2026-09-22T00:00:01.000Z"
      } as never)
    ).toThrow();
    expect(getRetryState(db, { runId: "run-1", nodeId: "node-1" })).toBeNull();
  });
});
