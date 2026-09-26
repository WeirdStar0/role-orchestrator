/**
 * Event-id scoping (defect found by the M2-06 end-to-end baseline):
 *
 * The store persists events with an replay-idempotent insert
 * (ON CONFLICT(id) DO NOTHING keyed on the event id). If the event id were
 * derived from the LINE CONTENT alone, two DIFFERENT executions emitting
 * byte-identical lines (deterministic fake-cli streams are exactly that)
 * would collide on the primary key and the second execution's protocol log
 * would silently vanish from the store — per-node traceability broken.
 *
 * The event id is therefore scoped to (executionId, line content): replaying
 * ONE execution's stream stays idempotent, distinct executions never share
 * event rows.
 */
import { describe, expect, test } from "vitest";
import { EventStreamPipeline } from "../src/index.js";

const INIT_LINE = {
  type: "system",
  subtype: "init",
  session_id: "session_scope",
  synthetic: true
};

function line(raw: object): string {
  return `${JSON.stringify(raw)}\n`;
}

describe("event ids are scoped to the execution", () => {
  test("identical lines in two executions produce distinct event ids", () => {
    const first = new EventStreamPipeline({ dialect: "claude", executionId: "exec_alpha" });
    const second = new EventStreamPipeline({ dialect: "claude", executionId: "exec_beta" });

    first.feedStdout(line(INIT_LINE));
    second.feedStdout(line(INIT_LINE));

    const alphaEvent = first.drainNewEvents()[0];
    const betaEvent = second.drainNewEvents()[0];

    expect(alphaEvent).toBeDefined();
    expect(betaEvent).toBeDefined();
    expect(alphaEvent?.eventId).toMatch(/^evt_[0-9a-f]{32}_0$/);
    expect(alphaEvent?.eventId).not.toBe(betaEvent?.eventId);
    // Each pipeline still carries its own execution identity.
    expect(alphaEvent?.executionId).toBe("exec_alpha");
    expect(betaEvent?.executionId).toBe("exec_beta");
  });

  test("replaying the SAME execution's stream reproduces the same ids", () => {
    const first = new EventStreamPipeline({ dialect: "claude", executionId: "exec_replay" });
    first.feedStdout(line(INIT_LINE));
    const original = first.drainNewEvents()[0];

    const replay = new EventStreamPipeline({ dialect: "claude", executionId: "exec_replay" });
    replay.feedStdout(line(INIT_LINE));
    const replayed = replay.drainNewEvents()[0];

    expect(replayed?.eventId).toBe(original?.eventId);
  });
});
