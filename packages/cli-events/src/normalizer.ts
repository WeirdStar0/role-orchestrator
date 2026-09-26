/**
 * Dialect-aware normalization of raw CLI JSONL events into the frozen
 * NormalizedEvent vocabulary from @role-orchestrator/contracts (12 types).
 *
 * Mapping rules (see docs/CLI_ADAPTERS.md, "事件规范"):
 * - the raw event type is always preserved in `sourceType`;
 * - unknown source types become `diagnostic` events and never contribute to a
 *   success verdict — success requires a final result event, which unknown
 *   lines cannot provide;
 * - one raw line may normalize into several events (content blocks, usage).
 *
 * The synthetic shapes are shared with @role-orchestrator/fake-cli. M0-03
 * (claude) verified the real 2.1.278 protocol against captures under
 * fixtures-real/claude; M0-04 (codex) verified the real 0.154.0 protocol
 * against captures under fixtures-real/codex. Real-only shapes are handled
 * additively so the synthetic path stays byte-compatible:
 * - system subtypes api_retry / hook_started / hook_response (no normalized
 *   equivalent -> explicit diagnostics carrying the retry/hook fields);
 * - init enrichment (claudeCodeVersion, permissionMode, cwd, apiKeySource,
 *   tool/mcp-server counts) when the real init line carries them;
 * - assistant lines flagged is_api_error_message surface `apiError: true` on
 *   their message_delta, and thinking blocks become explicit diagnostics;
 * - result lines carry the real-only terminal fields (resultText,
 *   terminalReason, apiErrorStatus, numTurns, permissionDenials) when
 *   present. Notably the real CLI reports `subtype: "success"` together with
 *   `is_error: true` on API errors, so the verdict must keep keying on
 *   `is_error`, never on subtype.
 * - codex (M0-04): `item.*` lines with item type "error" (real CLI-level
 *   messages: model-metadata fallback, skill budget notice, backend
 *   rejection details) surface as `error` events; the real turn.completed
 *   usage shape and turn.failed error shape normalize through the existing
 *   codex mappings unchanged.
 */
import { RUNTIMES, type JsonValue, type NormalizedEventType } from "@role-orchestrator/contracts";

export type Dialect = (typeof RUNTIMES)[number];

/** A normalized event before the pipeline assigns envelope fields. */
export interface PartialEvent {
  readonly type: NormalizedEventType;
  readonly sourceType: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * Values arrive from JSON.parse, so they are JSON values by construction;
 * this cast only teaches the compiler that fact.
 */
function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function diagnostic(reason: string, sourceType: string, extra?: Record<string, JsonValue>): PartialEvent {
  const payload: Record<string, JsonValue> = { reason };
  if (extra !== undefined) Object.assign(payload, extra);
  return { type: "diagnostic", sourceType, payload };
}

/**
 * Normalizes one parsed raw line. Never throws: anything it cannot
 * understand comes back as a diagnostic event.
 */
export function buildNormalizedEvents(dialect: Dialect, raw: unknown): readonly PartialEvent[] {
  if (!isRecord(raw)) {
    return [diagnostic("non-object-json-line", "unknown")];
  }
  const type = asString(raw["type"]);
  if (type === undefined) {
    return [diagnostic("missing-type", "unknown")];
  }
  return dialect === "claude" ? normalizeClaude(raw, type) : normalizeCodex(raw, type);
}

// ---------------------------------------------------------------------------
// claude dialect
// ---------------------------------------------------------------------------

function normalizeClaude(raw: Record<string, unknown>, type: string): readonly PartialEvent[] {
  switch (type) {
    case "system":
      return claudeSystem(raw);
    case "assistant":
      return claudeAssistant(raw);
    case "user":
      return claudeUser(raw);
    case "result":
      return claudeResult(raw);
    case "error":
      return [{ type: "error", sourceType: "error", payload: { message: asString(raw["message"]) ?? "" } }];
    case "artifact":
      return [
        {
          type: "artifact_reported",
          sourceType: "artifact",
          payload: {
            artifactId: asString(raw["artifact_id"]) ?? "",
            kind: asString(raw["kind"]) ?? "unknown"
          }
        }
      ];
    case "control_request":
      return claudeControlRequest(raw);
    case "control_response":
      return claudeControlResponse(raw);
    default:
      return [diagnostic("unknown-source-type", type, { rawType: type })];
  }
}

function claudeSystem(raw: Record<string, unknown>): readonly PartialEvent[] {
  const subtype = asString(raw["subtype"]) ?? "";
  if (subtype === "init") {
    const payload: Record<string, JsonValue> = { sessionId: asString(raw["session_id"]) ?? "" };
    // Real 2.1.278 init enrichment (M0-03); all fields optional so the
    // synthetic init shape normalizes exactly as before.
    const model = asString(raw["model"]);
    if (model !== undefined) payload["model"] = model;
    const claudeCodeVersion = asString(raw["claude_code_version"]);
    if (claudeCodeVersion !== undefined) payload["claudeCodeVersion"] = claudeCodeVersion;
    const permissionMode = asString(raw["permissionMode"]);
    if (permissionMode !== undefined) payload["permissionMode"] = permissionMode;
    const cwd = asString(raw["cwd"]);
    if (cwd !== undefined) payload["cwd"] = cwd;
    const apiKeySource = asString(raw["apiKeySource"]);
    if (apiKeySource !== undefined) payload["apiKeySource"] = apiKeySource;
    const tools = asArray(raw["tools"]);
    if (tools !== undefined) payload["toolCount"] = tools.length;
    const mcpServers = asArray(raw["mcp_servers"]);
    if (mcpServers !== undefined) payload["mcpServerCount"] = mcpServers.length;
    return [{ type: "started", sourceType: "system", payload }];
  }
  if (subtype === "permission_denied") {
    return [{ type: "permission_denied", sourceType: "system", payload: { subtype } }];
  }
  if (subtype === "api_retry") {
    // Real-only: the CLI retries 429/5xx internally (observed max 10) and
    // reports each attempt. No normalized type exists for retries; keep the
    // evidence as an explicit diagnostic, never as progress toward success.
    const payload: Record<string, JsonValue> = {};
    const attempt = asNumber(raw["attempt"]);
    if (attempt !== undefined) payload["attempt"] = attempt;
    const maxRetries = asNumber(raw["max_retries"]);
    if (maxRetries !== undefined) payload["maxRetries"] = maxRetries;
    const errorStatus = asNumber(raw["error_status"]);
    if (errorStatus !== undefined) payload["errorStatus"] = errorStatus;
    const retryDelayMs = asNumber(raw["retry_delay_ms"]);
    if (retryDelayMs !== undefined) payload["retryDelayMs"] = retryDelayMs;
    return [diagnostic("api-retry", "system", payload)];
  }
  if (subtype === "hook_started" || subtype === "hook_response") {
    // Real-only: CLI hooks configured by the host fire around the session.
    // They are host-side automation, not model protocol; record them as
    // diagnostics so untracked side effects stay visible.
    const payload: Record<string, JsonValue> = {};
    const hookName = asString(raw["hook_name"]);
    if (hookName !== undefined) payload["hookName"] = hookName;
    const hookEvent = asString(raw["hook_event"]);
    if (hookEvent !== undefined) payload["hookEvent"] = hookEvent;
    if (subtype === "hook_response") {
      const exitCode = asNumber(raw["exit_code"]);
      if (exitCode !== undefined) payload["exitCode"] = exitCode;
    }
    return [diagnostic(`hook-${subtype === "hook_started" ? "started" : "response"}`, "system", payload)];
  }
  return [diagnostic("unmapped-system-subtype", "system", { subtype })];
}

function claudeAssistant(raw: Record<string, unknown>): readonly PartialEvent[] {
  const message = asRecord(raw["message"]);
  const content = message === undefined ? undefined : asArray(message["content"]);
  if (content === undefined) {
    return [diagnostic("malformed-assistant-message", "assistant")];
  }
  // Real 2.1.278 marks locally-generated error messages (e.g. "API Error: …")
  // with is_api_error_message: true and model "<synthetic>"; surface that on
  // the emitted message_delta so consumers can tell them from model output.
  const isApiErrorMessage = raw["is_api_error_message"] === true;
  const out: PartialEvent[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) {
      out.push(diagnostic("malformed-content-block", "assistant"));
      continue;
    }
    const blockType = asString(record["type"]) ?? "";
    if (blockType === "text") {
      const payload: Record<string, JsonValue> = { text: asString(record["text"]) ?? "" };
      if (isApiErrorMessage) payload["apiError"] = true;
      out.push({
        type: "message_delta",
        sourceType: "assistant",
        payload
      });
    } else if (blockType === "tool_use") {
      const payload: Record<string, JsonValue> = {
        toolCallId: asString(record["id"]) ?? "",
        tool: asString(record["name"]) ?? ""
      };
      if (record["input"] !== undefined) payload["input"] = asJson(record["input"]);
      out.push({ type: "tool_started", sourceType: "assistant", payload });
    } else if (blockType === "thinking" || blockType === "redacted_thinking") {
      // Real-only block kinds: reasoning is not part of the normalized
      // vocabulary and its content is deliberately not copied.
      out.push(diagnostic("thinking-block-not-normalized", "assistant", { blockType }));
    } else {
      out.push(diagnostic("unmapped-content-block", "assistant", { blockType: blockType || null }));
    }
  }
  if (out.length === 0) {
    out.push(diagnostic("empty-assistant-content", "assistant"));
  }
  return out;
}

function claudeUser(raw: Record<string, unknown>): readonly PartialEvent[] {
  const message = asRecord(raw["message"]);
  const content = message === undefined ? undefined : asArray(message["content"]);
  if (content === undefined) {
    return [diagnostic("malformed-user-message", "user")];
  }
  const out: PartialEvent[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) {
      out.push(diagnostic("malformed-content-block", "user"));
      continue;
    }
    const blockType = asString(record["type"]) ?? "";
    if (blockType === "tool_result") {
      out.push({
        type: "tool_completed",
        sourceType: "user",
        payload: {
          toolCallId: asString(record["tool_use_id"]) ?? "",
          isError: record["is_error"] === true
        }
      });
    } else if (blockType === "text") {
      out.push({
        type: "message_delta",
        sourceType: "user",
        payload: { text: asString(record["text"]) ?? "" }
      });
    } else {
      out.push(diagnostic("unmapped-content-block", "user", { blockType: blockType || null }));
    }
  }
  if (out.length === 0) {
    out.push(diagnostic("empty-user-content", "user"));
  }
  return out;
}

function claudeResult(raw: Record<string, unknown>): readonly PartialEvent[] {
  const subtype = asString(raw["subtype"]) ?? "";
  // Real 2.1.278 reports API failures as subtype "success" with is_error
  // true and terminal_reason "api_error" (verified in fixtures-real), so the
  // verdict must key on is_error, never on subtype.
  const isError = raw["is_error"] === true || subtype.startsWith("error");
  const payload: Record<string, JsonValue> = { subtype, isError };
  if (raw["structured_output"] !== undefined) {
    payload["businessResult"] = asJson(raw["structured_output"]);
  }
  // Real-only terminal fields (M0-03): copied verbatim when present so the
  // adapter can expose answer text, terminal reason, API error status, turn
  // count and permission denials without reparsing raw streams.
  const resultText = asString(raw["result"]);
  if (resultText !== undefined) payload["resultText"] = resultText;
  const terminalReason = asString(raw["terminal_reason"]);
  if (terminalReason !== undefined) payload["terminalReason"] = terminalReason;
  const apiErrorStatus = asNumber(raw["api_error_status"]);
  if (apiErrorStatus !== undefined) payload["apiErrorStatus"] = apiErrorStatus;
  const numTurns = asNumber(raw["num_turns"]);
  if (numTurns !== undefined) payload["numTurns"] = numTurns;
  if (raw["permission_denials"] !== undefined) {
    payload["permissionDenials"] = asJson(raw["permission_denials"]);
  }
  const out: PartialEvent[] = [{ type: "result_reported", sourceType: "result", payload }];
  if (asRecord(raw["usage"]) !== undefined) {
    out.push({ type: "usage_reported", sourceType: "result", payload: { usage: asJson(raw["usage"]) } });
  }
  return out;
}

function claudeControlRequest(raw: Record<string, unknown>): readonly PartialEvent[] {
  const request = asRecord(raw["request"]);
  const subtype = request === undefined ? "" : (asString(request["subtype"]) ?? "");
  if (subtype === "can_use_tool" && request !== undefined) {
    const payload: Record<string, JsonValue> = {
      requestId: asString(raw["request_id"]) ?? "",
      toolName: asString(request["tool_name"]) ?? ""
    };
    if (request["input"] !== undefined) payload["toolInput"] = asJson(request["input"]);
    return [{ type: "approval_requested", sourceType: "control_request", payload }];
  }
  return [diagnostic("unmapped-control-request", "control_request", { subtype: subtype || null })];
}

function claudeControlResponse(raw: Record<string, unknown>): readonly PartialEvent[] {
  const response = asRecord(raw["response"]);
  const subtype = response === undefined ? "" : (asString(response["subtype"]) ?? "");
  if (subtype === "permission_denied") {
    return [
      {
        type: "permission_denied",
        sourceType: "control_response",
        payload: { requestId: asString(raw["request_id"]) ?? "" }
      }
    ];
  }
  return [diagnostic("unmapped-control-response", "control_response", { subtype: subtype || null })];
}

// ---------------------------------------------------------------------------
// codex dialect
// ---------------------------------------------------------------------------

function normalizeCodex(raw: Record<string, unknown>, type: string): readonly PartialEvent[] {
  switch (type) {
    case "thread.started":
      return [
        {
          type: "started",
          sourceType: "thread.started",
          payload: { threadId: asString(raw["thread_id"]) ?? "" }
        }
      ];
    case "turn.started":
      return [diagnostic("recognized-no-normalized-equivalent", "turn.started")];
    case "item.started":
      return codexItem("item.started", raw);
    case "item.completed":
      return codexItem("item.completed", raw);
    case "turn.completed": {
      const payload: Record<string, JsonValue> = { subtype: "completed", isError: false };
      if (raw["execution_result"] !== undefined) {
        payload["businessResult"] = asJson(raw["execution_result"]);
      }
      const out: PartialEvent[] = [{ type: "result_reported", sourceType: "turn.completed", payload }];
      if (asRecord(raw["usage"]) !== undefined) {
        out.push({
          type: "usage_reported",
          sourceType: "turn.completed",
          payload: { usage: asJson(raw["usage"]) }
        });
      }
      return out;
    }
    case "turn.failed": {
      const error = asRecord(raw["error"]);
      const message = error === undefined ? "unknown error" : (asString(error["message"]) ?? "unknown error");
      return [
        {
          type: "result_reported",
          sourceType: "turn.failed",
          payload: { subtype: "failed", isError: true, error: message }
        }
      ];
    }
    case "error":
      return [{ type: "error", sourceType: "error", payload: { message: asString(raw["message"]) ?? "" } }];
    case "approval.requested":
      return [
        {
          type: "approval_requested",
          sourceType: "approval.requested",
          payload: {
            requestId: asString(raw["request_id"]) ?? "",
            tool: asString(raw["tool"]) ?? ""
          }
        }
      ];
    case "approval.denied":
      return [
        {
          type: "permission_denied",
          sourceType: "approval.denied",
          payload: { requestId: asString(raw["request_id"]) ?? "" }
        }
      ];
    default:
      return [diagnostic("unknown-source-type", type, { rawType: type })];
  }
}

function codexItem(kind: "item.started" | "item.completed", raw: Record<string, unknown>): readonly PartialEvent[] {
  const item = asRecord(raw["item"]);
  if (item === undefined) {
    return [diagnostic("malformed-item", kind)];
  }
  const itemType = asString(item["type"]) ?? "";
  const toolCallId = asString(item["id"]) ?? asString(item["command"]) ?? "";
  switch (itemType) {
    case "command_execution":
    case "mcp_tool_call": {
      const payload: Record<string, JsonValue> = { toolCallId, tool: itemType };
      if (item["command"] !== undefined) payload["command"] = asJson(item["command"]);
      // Full item copy keeps synthetic extras (e.g. spawn-chain PIDs) intact.
      payload["item"] = asJson(item);
      if (kind === "item.started") {
        return [{ type: "tool_started", sourceType: kind, payload }];
      }
      const exitCode = asNumber(item["exit_code"]);
      const completed: Record<string, JsonValue> = {
        ...payload,
        isError: exitCode !== undefined && exitCode !== 0
      };
      if (exitCode !== undefined) completed["exitCode"] = exitCode;
      return [{ type: "tool_completed", sourceType: kind, payload: completed }];
    }
    case "agent_message": {
      if (kind === "item.started") {
        return [diagnostic("agent-message-started", kind)];
      }
      return [{ type: "message_delta", sourceType: kind, payload: { text: asString(item["text"]) ?? "" } }];
    }
    case "error": {
      // Real-only (M0-04, codex 0.154.0): item lines typed "error" carry
      // CLI-level messages (model-metadata fallback warnings, skill budget
      // notices, backend rejection details). They never provide a final
      // result, so the verdict is unaffected; surface them as `error`
      // events with the raw item type preserved in sourceType.
      const payload: Record<string, JsonValue> = {
        message: asString(item["message"]) ?? ""
      };
      const itemId = asString(item["id"]);
      if (itemId !== undefined) payload["itemId"] = itemId;
      return [{ type: "error", sourceType: kind, payload }];
    }
    case "file_change": {
      if (kind === "item.started") {
        return [diagnostic("file-change-started", kind)];
      }
      const paths = asArray(item["paths"]) ?? [];
      return [{ type: "artifact_reported", sourceType: kind, payload: { paths: asJson(paths) } }];
    }
    default:
      return [diagnostic("unknown-item-type", kind, { itemType: itemType || null })];
  }
}
