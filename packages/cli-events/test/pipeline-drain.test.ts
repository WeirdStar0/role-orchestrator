/**
 * Incremental drain extension (used by the M1-03 engine to persist events
 * while the child process is still streaming):
 * - drainNewEvents() returns only the events emitted since the last drain;
 * - it does NOT end the stream, unlike finalize();
 * - finalize() still returns the complete event list afterwards.
 */
import { describe, expect, test } from "vitest";
import { EventStreamPipeline } from "../src/index.js";

const INIT_LINE = {
  type: "system",
  subtype: "init",
  session_id: "session_drain",
  synthetic: true
};
const HAPPY_RESULT_LINE = {
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: {
    schemaVersion: 1,
    outcome: "completed",
    summary: "drain test result",
    artifactRefs: [],
    memoryProposals: [],
    taskProposals: []
  },
  synthetic: true
};

function line(raw: object): string {
  return `${JSON.stringify(raw)}\n`;
}

describe("EventStreamPipeline.drainNewEvents", () => {
  test("returns only new events per drain and keeps feeding alive", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_drain" });
    expect(pipeline.drainNewEvents()).toEqual([]);

    pipeline.feedStdout(line(INIT_LINE));
    const first = pipeline.drainNewEvents();
    expect(first.map((event) => event.type)).toEqual(["started"]);

    // Feeding continues after a drain (finalize() would have ended the stream).
    pipeline.feedStdout(line(HAPPY_RESULT_LINE));
    const second = pipeline.drainNewEvents();
    expect(second.map((event) => event.type)).toEqual(["result_reported"]);
    expect(pipeline.drainNewEvents()).toEqual([]);

    // Seq numbering stays continuous across drains (persisted rows must not
    // collide on UNIQUE(execution_id, seq)).
    expect(first[0]?.seq).toBe(1);
    expect(second.map((event) => event.seq)).toEqual([2]);
  });

  test("finalize() after drains still returns the complete stream", () => {
    const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_drain" });
    pipeline.feedStdout(line(INIT_LINE));
    pipeline.drainNewEvents();
    pipeline.feedStdout(line(HAPPY_RESULT_LINE));
    pipeline.drainNewEvents();
    const stream = pipeline.finalize();
    expect(stream.events.map((event) => event.type)).toEqual([
      "started",
      "result_reported"
    ]);
  });
});
