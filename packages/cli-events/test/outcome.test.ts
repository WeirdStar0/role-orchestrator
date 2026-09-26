/**
 * Outcome evaluation tests: the fail-closed success rule
 * (exitCode=0 AND final result without error AND business schema valid AND
 * no protocol errors) and the deterministic failure-reason ordering.
 */
import { describe, expect, test } from "vitest";
import { EventStreamPipeline, evaluateOutcome } from "../src/index.js";

function pipelineWith(lines: readonly string[]): EventStreamPipeline {
  const pipeline = new EventStreamPipeline({ dialect: "claude", executionId: "exec_outcome" });
  pipeline.feedStdout(lines.map((line) => `${line}\n`).join(""));
  return pipeline;
}

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "s", synthetic: true });

const VALID_RESULT = {
  schemaVersion: 1,
  outcome: "completed",
  summary: "ok",
  artifactRefs: [{ id: "artifact_a", kind: "report" }],
  memoryProposals: [],
  taskProposals: []
};

const HAPPY_RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: VALID_RESULT,
  synthetic: true
});

describe("evaluateOutcome", () => {
  test("a complete successful stream with exit 0 succeeds", () => {
    const pipeline = pipelineWith([INIT, HAPPY_RESULT_LINE]);
    pipeline.emitProcessExited({ exitCode: 0, signal: null });
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.finalResultEventId).not.toBeNull();
  });

  test("exitCode null (killed process) fails with nonzero-exit", () => {
    const pipeline = pipelineWith([INIT, HAPPY_RESULT_LINE]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: null });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["nonzero-exit"]);
  });

  test("nonzero exit fails even with a perfect result event", () => {
    const pipeline = pipelineWith([INIT, HAPPY_RESULT_LINE]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 1 });
    expect(verdict.reasons).toEqual(["nonzero-exit"]);
  });

  test("a missing final result event fails with exit 0 (A06 direction)", () => {
    const pipeline = pipelineWith([INIT]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["missing-final-result"]);
    expect(verdict.finalResultEventId).toBeNull();
  });

  test("an error-marked final result fails (A06 direction)", () => {
    const errorLine = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      structured_output: VALID_RESULT,
      synthetic: true
    });
    const pipeline = pipelineWith([INIT, errorLine]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["final-result-error"]);
  });

  test("a schema-invalid business payload fails (A06 direction)", () => {
    const invalidLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: { ...VALID_RESULT, bogus: true },
      synthetic: true
    });
    const pipeline = pipelineWith([INIT, invalidLine]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["business-schema-invalid"]);
  });

  test("a result event without a business payload cannot pass", () => {
    const bareLine = JSON.stringify({ type: "result", subtype: "success", is_error: false, synthetic: true });
    const pipeline = pipelineWith([INIT, bareLine]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.reasons).toEqual(["business-schema-invalid"]);
  });

  test("protocol errors poison an otherwise perfect stream", () => {
    const pipeline = pipelineWith([INIT, HAPPY_RESULT_LINE]);
    pipeline.feedStdout('{"type":"result","subtype":"succ'); // truncated junk
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["protocol-error"]);
  });

  test("the last result event wins when several appear", () => {
    const badLine = JSON.stringify({ type: "result", subtype: "error_x", is_error: true, synthetic: true });
    const pipeline = pipelineWith([INIT, badLine, HAPPY_RESULT_LINE]);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(true);
  });

  test("failure reasons are ordered deterministically", () => {
    const pipeline = pipelineWith([INIT]);
    pipeline.feedStdout("broken ");
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 3 });
    expect(verdict.reasons).toEqual(["nonzero-exit", "protocol-error", "missing-final-result"]);
  });
});
