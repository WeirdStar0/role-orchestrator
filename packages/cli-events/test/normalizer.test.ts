/**
 * Normalizer contract tests: the 12 normalized event types, sourceType
 * preservation, unknown-type-to-diagnostic policy, duplicate suppression,
 * multi-event lines, and envelope fields.
 */
import { describe, expect, test } from "vitest";
import { EventStreamPipeline, evaluateOutcome } from "../src/index.js";
import type { NormalizedEventType } from "@role-orchestrator/contracts";

const FIXED_NOW = (): string => "2026-09-21T00:00:00.000Z";

function pipelineFor(dialect: "claude" | "codex"): EventStreamPipeline {
  return new EventStreamPipeline({
    dialect,
    executionId: "exec_norm",
    now: FIXED_NOW
  });
}

function typesOf(pipeline: EventStreamPipeline): NormalizedEventType[] {
  return pipeline.finalize().events.map((event) => event.type);
}

describe("normalizer: claude dialect", () => {
  test("maps init/assistant/tool_use/tool_result/result to the normalized vocabulary", () => {
    const pipeline = pipelineFor("claude");
    pipeline.feedStdout(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "fake-model", synthetic: true }),
        JSON.stringify({
          type: "assistant",
          synthetic: true,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "part one" },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }
            ]
          }
        }),
        JSON.stringify({
          type: "user",
          synthetic: true,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }]
          }
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { schemaVersion: 1 },
          usage: { input_tokens: 3, output_tokens: 4 },
          synthetic: true
        })
      ].join("\n")
    );
    const result = pipeline.finalize();
    expect(result.protocolErrors).toEqual([]);
    // One assistant line with two blocks maps to two events; result+usage -> two.
    expect(typesOf(pipeline)).toEqual([
      "started",
      "message_delta",
      "tool_started",
      "tool_completed",
      "result_reported",
      "usage_reported"
    ]);

    const [started, delta, toolStarted, toolCompleted, resultEvent] = result.events;
    expect(started?.sourceType).toBe("system");
    expect(started?.payload["sessionId"]).toBe("s1");
    expect(delta?.payload["text"]).toBe("part one");
    expect(toolStarted?.sourceType).toBe("assistant");
    expect(toolStarted?.payload["toolCallId"]).toBe("toolu_1");
    expect(toolStarted?.payload["tool"]).toBe("Bash");
    expect(toolCompleted?.payload["toolCallId"]).toBe("toolu_1");
    expect(toolCompleted?.payload["isError"]).toBe(false);
    expect(resultEvent?.sourceType).toBe("result");
    expect(resultEvent?.payload["isError"]).toBe(false);
    expect(resultEvent?.payload["businessResult"]).toEqual({ schemaVersion: 1 });
  });

  test("result lines with error subtypes or is_error carry the error", () => {
    const pipeline = pipelineFor("claude");
    pipeline.feedStdout(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, synthetic: true })
    );
    const result = pipeline.finalize();
    const event = result.events[0];
    expect(event?.type).toBe("result_reported");
    expect(event?.payload["isError"]).toBe(true);
  });

  test("approval and permission synthetic extensions map to dedicated types", () => {
    const pipeline = pipelineFor("claude");
    pipeline.feedStdout(
      [
        JSON.stringify({
          type: "control_request",
          request_id: "req_1",
          request: { subtype: "can_use_tool", tool_name: "Bash", input: {} },
          synthetic: true
        }),
        JSON.stringify({
          type: "control_response",
          request_id: "req_1",
          response: { subtype: "permission_denied" },
          synthetic: true
        })
      ].join("\n")
    );
    const result = pipeline.finalize();
    expect(typesOf(pipeline)).toEqual(["approval_requested", "permission_denied"]);
    expect(result.events[0]?.payload["toolName"]).toBe("Bash");
    expect(result.events[1]?.payload["requestId"]).toBe("req_1");
  });

  test("artifact synthetic extension maps to artifact_reported", () => {
    const pipeline = pipelineFor("claude");
    pipeline.feedStdout(JSON.stringify({ type: "artifact", artifact_id: "artifact_1", kind: "report", synthetic: true }));
    expect(typesOf(pipeline)).toEqual(["artifact_reported"]);
  });

  test("unknown types become diagnostics with sourceType preserved", () => {
    const pipeline = pipelineFor("claude");
    pipeline.feedStdout(
      [
        JSON.stringify({ type: "stream_event_fancy", data: 1, synthetic: true }),
        JSON.stringify({ noType: true }),
        JSON.stringify([1, 2, 3])
      ].join("\n")
    );
    const result = pipeline.finalize();
    expect(typesOf(pipeline)).toEqual(["diagnostic", "diagnostic", "diagnostic"]);
    expect(result.events[0]?.sourceType).toBe("stream_event_fancy");
    expect(result.events[0]?.payload["reason"]).toBe("unknown-source-type");
    expect(result.events[1]?.payload["reason"]).toBe("missing-type");
    expect(result.events[2]?.payload["reason"]).toBe("non-object-json-line");
  });
});

describe("normalizer: codex dialect", () => {
  test("maps thread/turn/item events to the normalized vocabulary", () => {
    const pipeline = pipelineFor("codex");
    pipeline.feedStdout(
      [
        JSON.stringify({ type: "thread.started", thread_id: "t1", synthetic: true }),
        JSON.stringify({ type: "turn.started", synthetic: true }),
        JSON.stringify({
          type: "item.started",
          item: { id: "i1", type: "command_execution", command: "pnpm test", status: "in_progress" },
          synthetic: true
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "i1", type: "command_execution", command: "pnpm test", status: "completed", exit_code: 0 },
          synthetic: true
        }),
        JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "hello" }, synthetic: true }),
        JSON.stringify({ type: "item.completed", item: { id: "i3", type: "file_change", paths: ["a.md"] }, synthetic: true }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1 },
          execution_result: { schemaVersion: 1 },
          synthetic: true
        })
      ].join("\n")
    );
    const result = pipeline.finalize();
    expect(result.protocolErrors).toEqual([]);
    expect(typesOf(pipeline)).toEqual([
      "started",
      "diagnostic", // turn.started has no normalized equivalent
      "tool_started",
      "tool_completed",
      "message_delta",
      "artifact_reported",
      "result_reported",
      "usage_reported"
    ]);
    const toolCompleted = result.events[3];
    expect(toolCompleted?.sourceType).toBe("item.completed");
    expect(toolCompleted?.payload["exitCode"]).toBe(0);
    expect(toolCompleted?.payload["isError"]).toBe(false);
  });

  test("turn.failed maps to an error result_reported", () => {
    const pipeline = pipelineFor("codex");
    pipeline.feedStdout(
      JSON.stringify({ type: "turn.failed", error: { message: "boom" }, synthetic: true })
    );
    const event = pipeline.finalize().events[0];
    expect(event?.type).toBe("result_reported");
    expect(event?.sourceType).toBe("turn.failed");
    expect(event?.payload["isError"]).toBe(true);
    expect(event?.payload["error"]).toBe("boom");
  });

  test("approval extensions and unknown item types behave as specified", () => {
    const pipeline = pipelineFor("codex");
    pipeline.feedStdout(
      [
        JSON.stringify({ type: "approval.requested", request_id: "r1", tool: "shell", synthetic: true }),
        JSON.stringify({ type: "approval.denied", request_id: "r1", synthetic: true }),
        JSON.stringify({ type: "item.completed", item: { id: "i9", type: "todo_list", steps: [] }, synthetic: true }),
        JSON.stringify({ type: "mystery", synthetic: true })
      ].join("\n")
    );
    const result = pipeline.finalize();
    expect(typesOf(pipeline)).toEqual(["approval_requested", "permission_denied", "diagnostic", "diagnostic"]);
    expect(result.events[2]?.payload["reason"]).toBe("unknown-item-type");
    expect(result.events[3]?.sourceType).toBe("mystery");
  });
});

describe("pipeline envelope and dedup", () => {
  test("envelope fields: schemaVersion, seq monotonic, eventId deterministic, occurredAt injected", () => {
    const feed = (): string =>
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "s", synthetic: true }),
        JSON.stringify({ type: "error", message: "m", synthetic: true })
      ].join("\n");
    const first = pipelineFor("claude");
    first.feedStdout(feed());
    const second = pipelineFor("claude");
    second.feedStdout(feed());
    const left = first.finalize().events;
    const right = second.finalize().events;
    expect(left.map((event) => event.eventId)).toEqual(right.map((event) => event.eventId));
    expect(left.map((event) => event.seq)).toEqual([1, 2]);
    for (const event of left) {
      expect(event.schemaVersion).toBe(1);
      expect(event.executionId).toBe("exec_norm");
      expect(event.occurredAt).toBe("2026-09-21T00:00:00.000Z");
    }
  });

  test("duplicate lines are skipped after the first occurrence", () => {
    const pipeline = pipelineFor("claude");
    const line = JSON.stringify({ type: "error", message: "dup", synthetic: true });
    pipeline.feedStdout(`${line}\n${line}\n${line}\n`);
    const result = pipeline.finalize();
    expect(result.events).toHaveLength(1);
    expect(result.stats.duplicatesSkipped).toBe(2);
  });

  test("emitProcessExited appends the final process_exited event", () => {
    const pipeline = pipelineFor("codex");
    pipeline.feedStdout(`${JSON.stringify({ type: "thread.started", thread_id: "t", synthetic: true })}\n`);
    pipeline.emitProcessExited({ exitCode: 0, signal: null });
    const result = pipeline.finalize();
    expect(typesOf(pipeline)).toEqual(["started", "process_exited"]);
    const last = result.events[result.events.length - 1];
    expect(last?.payload["exitCode"]).toBe(0);
    expect(last?.seq).toBe(2);
  });

  test("a stream of only unknown types can never look successful (exit 0)", () => {
    const pipeline = pipelineFor("claude");
    pipeline.feedStdout(`${JSON.stringify({ type: "whatever", synthetic: true })}\n`);
    pipeline.feedStdout(`${JSON.stringify({ type: "whatever", note: 2, synthetic: true })}\n`);
    const verdict = evaluateOutcome(pipeline.finalize(), { exitCode: 0 });
    expect(verdict.success).toBe(false);
    expect(verdict.reasons).toEqual(["missing-final-result"]);
  });
});
