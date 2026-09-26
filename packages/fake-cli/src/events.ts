/**
 * Synthetic raw-event builders for the two CLI dialects.
 *
 * IMPORTANT: every line produced here carries `"synthetic": true`, and the
 * processes print a SYNTHETIC banner to stderr at startup. These shapes are
 * *approximations* of `claude -p --output-format stream-json` and
 * `codex exec --json` written from public documentation. They have NOT been
 * validated against the real executables — that verification happens in
 * M0-03/M0-04. Nothing in this package may claim byte-level compatibility.
 *
 * All builders return plain JSON objects (no timestamps, no PIDs) so that
 * pregenerated fixtures are byte-for-byte deterministic.
 */

export type Dialect = "claude" | "codex";

export type Raw = Record<string, unknown>;

/** Fixed session/thread ids keep fixtures deterministic. */
export const SYNTH_SESSION_ID = "session_synth_0001";
export const SYNTH_THREAD_ID = "thread_synth_0001";

/**
 * Business payload embedded in final events. The shape mirrors the frozen
 * ExecutionResult contract (packages/contracts ExecutionResultSchema): the
 * fake CLI only serializes it; schema enforcement lives in cli-events.
 */
export const VALID_BUSINESS_RESULT: Raw = {
  schemaVersion: 1,
  outcome: "completed",
  summary: "Synthetic execution completed (fake-cli)",
  artifactRefs: [{ id: "artifact_fake_report", kind: "report" }],
  memoryProposals: [],
  taskProposals: []
};

/** A look-alike success whose business payload violates the strict schema. */
export const SCHEMA_INVALID_BUSINESS_RESULT: Raw = {
  ...VALID_BUSINESS_RESULT,
  summary: "Synthetic fake success with a schema-invalid business payload",
  unexpectedField: true
};

/** `synthetic` marker is appended last so it is easy to spot in fixtures. */
function mark(raw: Raw): Raw {
  return { ...raw, synthetic: true };
}

// ---------------------------------------------------------------------------
// claude dialect (approximation of `claude -p --output-format stream-json`)
// ---------------------------------------------------------------------------

export function claudeInit(): Raw {
  return mark({
    type: "system",
    subtype: "init",
    session_id: SYNTH_SESSION_ID,
    model: "fake-model",
    cwd: "/synthetic/cwd",
    tools: ["Bash", "Read", "Edit"]
  });
}

export function claudeAssistantText(text: string): Raw {
  return mark({
    type: "assistant",
    session_id: SYNTH_SESSION_ID,
    message: { role: "assistant", content: [{ type: "text", text }] }
  });
}

export function claudeToolUse(id: string, name: string, input: Raw): Raw {
  return mark({
    type: "assistant",
    session_id: SYNTH_SESSION_ID,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }
  });
}

export function claudeToolResult(toolUseId: string, content: string, isError = false): Raw {
  return mark({
    type: "user",
    session_id: SYNTH_SESSION_ID,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }]
    }
  });
}

/**
 * Synthetic extension event reporting an artifact. The real claude protocol
 * may not carry such a line; M0-03 records the verified mapping.
 */
export function claudeArtifact(artifactId: string, kind: string): Raw {
  return mark({ type: "artifact", artifact_id: artifactId, kind });
}

export interface ClaudeResultOptions {
  subtype: string;
  isError: boolean;
  businessResult?: Raw | undefined;
  usage?: Raw | undefined;
}

export function claudeResult(opts: ClaudeResultOptions): Raw {
  const raw: Raw = {
    type: "result",
    subtype: opts.subtype,
    is_error: opts.isError,
    session_id: SYNTH_SESSION_ID,
    result: opts.isError ? null : "Synthetic final message"
  };
  if (opts.businessResult !== undefined) raw["structured_output"] = opts.businessResult;
  if (opts.usage !== undefined) raw["usage"] = opts.usage;
  return mark(raw);
}

export function claudeError(message: string): Raw {
  return mark({ type: "error", message });
}

/** Synthetic extension approximating the canUseTool control protocol. */
export function claudeApprovalRequest(requestId: string, toolName: string): Raw {
  return mark({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: toolName, input: {} }
  });
}

/**
 * Synthetic control request CARRYING a structured action proposal (M4-02):
 * the agent asks to perform `input`'s action instead of performing it. The
 * proposal payload shape mirrors @role-orchestrator/checkpoint's strict
 * `ActionProposal` schema so the checkpoint layer can digest the action.
 * Synthetic only — real M0 captures never contained control_request events.
 */
export function claudeActionProposalRequest(requestId: string, toolName: string, input: Raw): Raw {
  return mark({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: toolName, input }
  });
}

export function claudePermissionDenied(requestId: string): Raw {
  return mark({
    type: "control_response",
    request_id: requestId,
    response: { subtype: "permission_denied" }
  });
}

export function claudeInterruptedDelta(): Raw {
  return claudeAssistantText("[synthetic] interrupted, exiting nonzero");
}

export function claudeGrandchildReport(childPid: number, grandchildPid: number): Raw {
  return claudeToolUse("toolu_synth_tree", "spawn_chain", { childPid, grandchildPid });
}

// ---------------------------------------------------------------------------
// codex dialect (approximation of `codex exec --json`)
// ---------------------------------------------------------------------------

export function codexThreadStarted(): Raw {
  return mark({ type: "thread.started", thread_id: SYNTH_THREAD_ID });
}

export function codexTurnStarted(): Raw {
  return mark({ type: "turn.started" });
}

export function codexItemStarted(item: Raw): Raw {
  return mark({ type: "item.started", item });
}

export function codexItemCompleted(item: Raw): Raw {
  return mark({ type: "item.completed", item });
}

export function codexTurnCompleted(usage: Raw, businessResult?: Raw | undefined): Raw {
  const raw: Raw = { type: "turn.completed", usage };
  if (businessResult !== undefined) raw["execution_result"] = businessResult;
  return mark(raw);
}

export function codexTurnFailed(message: string): Raw {
  return mark({ type: "turn.failed", error: { message } });
}

export function codexError(message: string): Raw {
  return mark({ type: "error", message });
}

/** Synthetic extension; M0-04 records the real approval protocol if any. */
export function codexApprovalRequested(requestId: string, tool: string): Raw {
  return mark({ type: "approval.requested", request_id: requestId, tool });
}

/**
 * Synthetic approval.requested CARRYING a structured action proposal (M4-02).
 * The real codex approval protocol shape is unverified (gate cell
 * codex.approval-sandbox-rejection-path); the proposal field here is a
 * synthetic extension the real stream is NOT expected to carry.
 */
export function codexActionProposalRequested(requestId: string, tool: string, actionProposal: Raw): Raw {
  return mark({ type: "approval.requested", request_id: requestId, tool, actionProposal });
}

export function codexApprovalDenied(requestId: string): Raw {
  return mark({ type: "approval.denied", request_id: requestId });
}

export function codexInterruptedDelta(): Raw {
  return codexItemCompleted({ id: "item_interrupt", type: "agent_message", text: "[synthetic] interrupted, exiting nonzero" });
}

export function codexGrandchildReport(childPid: number, grandchildPid: number): Raw {
  return codexItemStarted({
    id: "item_tree",
    type: "command_execution",
    command: "spawn_chain",
    status: "in_progress",
    childPid,
    grandchildPid
  });
}

// ---------------------------------------------------------------------------

export function syntheticBanner(dialect: Dialect, scenario: string, variant: string | undefined): string {
  const suffix = variant === undefined ? "" : ` variant=${variant}`;
  return (
    `SYNTHETIC EVENT STREAM — dialect=${dialect} scenario=${scenario}${suffix} — ` +
    `this process is part of @role-orchestrator/fake-cli and is NOT a real claude/codex binary; ` +
    `every emitted line is synthetic test data.`
  );
}
