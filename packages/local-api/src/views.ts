/**
 * Read-only API views over the store (M1-04): task-run detail, execution
 * status and the per-execution event log. This is the ONLY place local-api
 * touches durable state, and it never writes.
 *
 * Two boundaries live here:
 * - SECRET-FIELD boundary: raw execution rows carry capability material the
 *   API must never serve — `dispatchToken` (a dispatch capability) and the
 *   full `pidIdentity` object (including `executionNonce`). The view layer
 *   projects rows down to explicitly allowlisted fields.
 * - CONTENT-redaction boundary (A36, second layer): every event payload
 *   string passes `redactJsonValue` BEFORE the payload leaves the process.
 *   The FIRST layer is the engine, which redacts before persisting; this
 *   egress pass is defence in depth — raw secret text written by a
 *   non-engine writer is still never re-served. Malformed stored payloads
 *   raise `LocalApiStateError` instead of degrading silently.
 */
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@role-orchestrator/contracts";
import { redactJsonValue } from "@role-orchestrator/cli-events";
import {
  getExecution,
  getTaskRun,
  JsonRecordSchema,
  listEventsForExecution,
  listExecutionsForRun,
  type EventRow,
  type ExecutionRow,
  type TaskRunRow
} from "@role-orchestrator/store";
import { LocalApiStateError } from "./errors.js";

/** Public execution status view — allowlisted fields only. */
export interface ExecutionStatusView {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly definitionRevision: string;
  readonly attempt: number;
  readonly phase: string;
  readonly sessionId: string | null;
  /** OS pid only; the pid-identity nonce never leaves the process. */
  readonly pid: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Public task-run detail: the run row plus its execution attempts. */
export interface RunDetailView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly graphRevision: number;
  readonly status: string;
  readonly baseSha: string;
  readonly createdAt: string;
  readonly executions: readonly ExecutionStatusView[];
}

/** Event envelope served by GET /api/v1/executions/:id/events (docs/API_AND_EVENTS.md shape). */
export interface EventEnvelopeView {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly seq: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Record<string, JsonValue>;
}

export interface ListEventsOptions {
  /** Exclusive lower seq bound (cursor); events with seq > after are returned. */
  readonly after?: number | undefined;
  /** Page size; default 100, hard-capped at 200. */
  readonly limit?: number | undefined;
}

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 200;

function toExecutionStatusView(row: ExecutionRow): ExecutionStatusView {
  return {
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    definitionRevision: row.definitionRevision,
    attempt: row.attempt,
    phase: row.phase,
    sessionId: row.sessionId,
    pid: parsePidOnly(row.pidIdentity),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * Extract ONLY the pid from the stored pid-identity JSON. Any structural
 * deviation raises `LocalApiStateError` — a tampered identity is never
 * silently rendered as "no process".
 */
function parsePidOnly(pidIdentityJson: string | null): number | null {
  if (pidIdentityJson === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(pidIdentityJson) as unknown;
  } catch (error) {
    throw new LocalApiStateError("stored pid_identity is not valid JSON", { cause: error });
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const pid = (parsed as Record<string, unknown>)["pid"];
    if (typeof pid === "number" && Number.isInteger(pid) && pid >= 1) {
      return pid;
    }
  }
  throw new LocalApiStateError("stored pid_identity does not carry an integer pid");
}

/** Run detail or `null` when the run id is unknown (served as 404). */
export function getRunDetail(db: DatabaseSync, runId: string): RunDetailView | null {
  const run: TaskRunRow | null = getTaskRun(db, runId);
  if (run === null) return null;
  return {
    id: run.id,
    projectId: run.projectId,
    taskId: run.taskId,
    graphRevision: run.graphRevision,
    status: run.status,
    baseSha: run.baseSha,
    createdAt: run.createdAt,
    executions: listExecutionsForRun(db, runId).map(toExecutionStatusView)
  };
}

/** Execution status or `null` when the id is unknown (served as 404). */
export function getExecutionStatus(db: DatabaseSync, executionId: string): ExecutionStatusView | null {
  const row = getExecution(db, executionId);
  return row === null ? null : toExecutionStatusView(row);
}

/**
 * The event log of one execution, redacted and paged. Enforces the
 * execution's existence first so callers can map unknown ids to 404.
 */
export function listExecutionEventViews(
  db: DatabaseSync,
  executionId: string,
  options: ListEventsOptions = {}
): { readonly events: readonly EventEnvelopeView[] } | null {
  const execution = getExecution(db, executionId);
  if (execution === null) return null;
  const run = getTaskRun(db, execution.runId);
  const projectId = run?.projectId ?? null;
  const after = options.after ?? 0;
  const limit = Math.min(options.limit ?? DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
  if (!Number.isInteger(after) || after < 0) {
    throw new LocalApiStateError(`event cursor "after" must be a non-negative integer, got ${String(after)}`);
  }
  const events = listEventsForExecution(db, executionId)
    .filter((event) => event.seq > after)
    .slice(0, limit)
    .map((event) => buildEventEnvelopeView({ projectId, runId: execution.runId, executionId: execution.id, event }));
  return { events };
}

/**
 * Build the redacted event envelope view for ONE stored event row — the
 * shared projection of the REST events route AND the M5-04 live WebSocket
 * stream, so both egress paths carry the identical shape and the identical
 * A36 egress-redaction pass. Malformed durable payload raises
 * `LocalApiStateError` (fail-closed), never a degraded envelope.
 */
export function buildEventEnvelopeView(input: {
  readonly projectId: string | null;
  readonly runId: string;
  readonly executionId: string;
  readonly event: EventRow;
}): EventEnvelopeView {
  const payload = parseStoredPayload(input.event.payload, input.event.id);
  const redacted = redactJsonValue(payload);
  // parseStoredPayload proved the shape; redaction preserves it.
  const payloadRecord = redacted.value as Record<string, JsonValue>;
  return {
    schemaVersion: 1,
    eventId: input.event.id,
    projectId: input.projectId ?? "",
    runId: input.runId,
    executionId: input.executionId,
    seq: input.event.seq,
    type: input.event.type,
    occurredAt: input.event.occurredAt,
    payload: payloadRecord
  };
}

function parseStoredPayload(payloadJson: string, eventId: string): Record<string, JsonValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new LocalApiStateError(`stored payload of event "${eventId}" is not valid JSON`, { cause: error });
  }
  const result = JsonRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new LocalApiStateError(`stored payload of event "${eventId}" is not a JSON record`, {
      cause: result.error
    });
  }
  return result.data;
}
