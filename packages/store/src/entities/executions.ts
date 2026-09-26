import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { ExecutionTargetSchema, IdSchema } from "@role-orchestrator/contracts";
import {
  ActiveAttemptConflictError,
  DuplicateAttemptError,
  NoRowUpdatedError,
  StoreError,
  isUniqueViolation
} from "../errors.js";
import type { Row } from "../rows.js";
import { optStr, reqInt, reqStr } from "../rows.js";
import { TimestampSchema } from "../time.js";

/**
 * Execution phases (ORCHESTRATION.md section 3):
 * PREPARING -> STARTING -> RUNNING -> FINALIZING -> SUCCEEDED, and any
 * unfinished phase -> FAILED | INTERRUPTED | CANCELLED.
 *
 * `ACTIVE_ATTEMPT_PHASES` is the single source of truth shared with the
 * partial unique index `ux_executions_one_active_per_slot` in the schema
 * migration: a slot (run, node) can hold at most one attempt whose phase is
 * in this list. Full phase-transition (FSM) validation belongs to the
 * lifecycle work (M1-03); this package enforces the constraint-level core.
 */
export const ACTIVE_ATTEMPT_PHASES = ["PREPARING", "STARTING", "RUNNING", "FINALIZING"] as const;

export const ATTEMPT_PHASES = [
  ...ACTIVE_ATTEMPT_PHASES,
  "SUCCEEDED",
  "FAILED",
  "INTERRUPTED",
  "CANCELLED"
] as const;

export type ActiveAttemptPhase = (typeof ACTIVE_ATTEMPT_PHASES)[number];
export type AttemptPhase = (typeof ATTEMPT_PHASES)[number];

export const ActiveAttemptPhaseSchema = z.enum(ACTIVE_ATTEMPT_PHASES);
export const AttemptPhaseSchema = z.enum(ATTEMPT_PHASES);

export interface ExecutionRow {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly definitionRevision: string;
  readonly attempt: number;
  readonly phase: AttemptPhase;
  readonly dispatchToken: string;
  readonly sessionId: string | null;
  /** JSON-encoded `ProcessIdentity`; null until a process actually started. */
  readonly pidIdentity: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const CreateActiveAttemptInputSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  definitionRevision: z.string().min(1).max(128),
  attempt: z.number().int().min(1),
  dispatchToken: z.string().min(1).max(128),
  phase: ActiveAttemptPhaseSchema.default("PREPARING"),
  sessionId: z.string().min(1).max(256).nullable().default(null),
  now: TimestampSchema
});

export type CreateActiveAttemptInput = z.input<typeof CreateActiveAttemptInputSchema>;

/**
 * Create a process attempt in an ACTIVE phase. The partial unique index
 * `ux_executions_one_active_per_slot` rejects a second active attempt for the
 * same (run, node) slot with `ActiveAttemptConflictError` — this holds across
 * connections and processes and is the A23 guarantee (constraint-level, not
 * convention-level). Duplicate attempt numbers for the same definition
 * revision raise `DuplicateAttemptError`.
 */
export function createActiveAttempt(
  db: DatabaseSync,
  input: CreateActiveAttemptInput
): ExecutionRow {
  const value = CreateActiveAttemptInputSchema.parse(input);
  try {
    db.prepare(
      "INSERT INTO executions(id, run_id, node_id, definition_revision, attempt, phase, dispatch_token, session_id, pid_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)"
    ).run(
      value.id,
      value.runId,
      value.nodeId,
      value.definitionRevision,
      value.attempt,
      value.phase,
      value.dispatchToken,
      value.sessionId,
      value.now,
      value.now
    );
  } catch (error) {
    // SQLite names the violated index's columns in the message; match the
    // MORE specific signature first (the attempt tuple starts with the same
    // prefix as the slot index's message).
    if (isUniqueViolation(error, "executions.definition_revision, executions.attempt")) {
      throw new DuplicateAttemptError(value.runId, value.nodeId, value.attempt, { cause: error });
    }
    if (isUniqueViolation(error, "UNIQUE constraint failed: executions.run_id, executions.node_id")) {
      throw new ActiveAttemptConflictError(value.runId, value.nodeId, { cause: error });
    }
    throw error;
  }
  return {
    id: value.id,
    runId: value.runId,
    nodeId: value.nodeId,
    definitionRevision: value.definitionRevision,
    attempt: value.attempt,
    phase: value.phase,
    dispatchToken: value.dispatchToken,
    sessionId: value.sessionId,
    pidIdentity: null,
    createdAt: value.now,
    updatedAt: value.now
  };
}

/**
 * Reconcile-style phase update. The WHERE clause re-checks the target phase
 * of the row so a caller can, e.g., only interrupt an attempt that is still
 * active; zero affected rows raise `NoRowUpdatedError`.
 */
export function setAttemptPhase(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly phase: AttemptPhase;
    readonly wherePhaseIn?: readonly AttemptPhase[];
    readonly now: string;
  }
): void {
  const parsed = z
    .strictObject({
      id: IdSchema,
      phase: AttemptPhaseSchema,
      wherePhaseIn: z.array(AttemptPhaseSchema).max(ATTEMPT_PHASES.length).optional(),
      now: TimestampSchema
    })
    .parse(input);

  if (parsed.wherePhaseIn === undefined) {
    const result = db
      .prepare("UPDATE executions SET phase = ?, updated_at = ? WHERE id = ?")
      .run(parsed.phase, parsed.now, parsed.id);
    if (Number(result.changes) !== 1) {
      throw new NoRowUpdatedError(`execution "${parsed.id}" does not exist`);
    }
    return;
  }

  const phases = parsed.wherePhaseIn.map((phase) => `'${phase}'`).join(", ");
  const result = db
    .prepare(
      `UPDATE executions SET phase = ?, updated_at = ? WHERE id = ? AND phase IN (${phases})`
    )
    .run(parsed.phase, parsed.now, parsed.id);
  if (Number(result.changes) !== 1) {
    throw new NoRowUpdatedError(
      `execution "${parsed.id}" does not exist or its phase is not in [${parsed.wherePhaseIn.join(", ")}]`
    );
  }
}

/** Mark a still-active attempt INTERRUPTED (the reconcile step of A23/A22 flows). */
export function markAttemptInterrupted(
  db: DatabaseSync,
  input: { readonly id: string; readonly now: string }
): void {
  const parsed = z
    .strictObject({ id: IdSchema, now: TimestampSchema })
    .parse(input);
  setAttemptPhase(db, {
    id: parsed.id,
    phase: "INTERRUPTED",
    wherePhaseIn: [...ACTIVE_ATTEMPT_PHASES],
    now: parsed.now
  });
}

// ---------------------------------------------------------------------------
// Process-identity / session primitives (M1-03)
//
// contracts/runtime.ts defines `ProcessIdentity` (pid, creationTime,
// executionNonce, target). The launcher records it IMMEDIATELY after the
// child is spawned so the "process started but PID not yet recorded" window
// (A24) is as small as the platform allows; a later reconcile (M1-05) reads
// it back to identify the interrupted attempt instead of re-dispatching.
// ---------------------------------------------------------------------------

/**
 * Runtime body of the frozen contracts `ProcessIdentity` shape as stored in
 * `executions.pid_identity` (JSON). Structurally identical to the contracts
 * interface; `creationTime` semantics (engine-side observation vs OS query)
 * are a launcher concern, not a storage concern.
 */
export const ProcessIdentitySchema = z.strictObject({
  pid: z.number().int().min(1),
  creationTime: TimestampSchema,
  executionNonce: z.string().min(1).max(128),
  target: ExecutionTargetSchema
});

export type ProcessIdentityRecord = z.infer<typeof ProcessIdentitySchema>;

const SetPidIdentityInputSchema = z.strictObject({
  id: IdSchema,
  pidIdentity: ProcessIdentitySchema,
  wherePhaseIn: z.array(AttemptPhaseSchema).max(ATTEMPT_PHASES.length).optional(),
  now: TimestampSchema
});

export type SetExecutionPidIdentityInput = z.input<typeof SetPidIdentityInputSchema>;

/**
 * Record the launched process identity on an execution. Pass `wherePhaseIn`
 * to guard the write (e.g. only while STARTING); zero affected rows raise
 * `NoRowUpdatedError`, so a stale launcher can never stamp identity onto an
 * attempt that already moved on. Callers compose this with their other writes
 * inside one `withTransaction` when the write must be atomic with them.
 */
export function setExecutionPidIdentity(
  db: DatabaseSync,
  input: SetExecutionPidIdentityInput
): void {
  const parsed = SetPidIdentityInputSchema.parse(input);
  const pidJson = JSON.stringify(ProcessIdentitySchema.parse(parsed.pidIdentity));
  applyGuardedUpdate(
    db,
    "UPDATE executions SET pid_identity = ?, updated_at = ? WHERE id = ?",
    [pidJson, parsed.now, parsed.id],
    parsed.wherePhaseIn,
    parsed.id,
    "record pid identity"
  );
}

const SetSessionIdInputSchema = z.strictObject({
  id: IdSchema,
  /** The CLI-reported session/thread id; a non-empty locator, never a credential. */
  sessionId: z.string().min(1).max(256),
  wherePhaseIn: z.array(AttemptPhaseSchema).max(ATTEMPT_PHASES.length).optional(),
  now: TimestampSchema
});

export type SetExecutionSessionIdInput = z.input<typeof SetSessionIdInputSchema>;

/**
 * Record the CLI-reported session id (claude `session_id` / codex
 * `thread_id` from the normalized `started` event) on an execution, with the
 * same optional phase guard as `setExecutionPidIdentity`.
 */
export function setExecutionSessionId(
  db: DatabaseSync,
  input: SetExecutionSessionIdInput
): void {
  const parsed = SetSessionIdInputSchema.parse(input);
  applyGuardedUpdate(
    db,
    "UPDATE executions SET session_id = ?, updated_at = ? WHERE id = ?",
    [parsed.sessionId, parsed.now, parsed.id],
    parsed.wherePhaseIn,
    parsed.id,
    "record session id"
  );
}

function applyGuardedUpdate(
  db: DatabaseSync,
  sql: string,
  params: readonly (string | null)[],
  wherePhaseIn: readonly AttemptPhase[] | undefined,
  id: string,
  action: string
): void {
  if (wherePhaseIn === undefined) {
    const result = db.prepare(sql).run(...params);
    if (Number(result.changes) !== 1) {
      throw new NoRowUpdatedError(`execution "${id}" does not exist; cannot ${action}`);
    }
    return;
  }
  if (wherePhaseIn.length === 0) {
    throw new NoRowUpdatedError(
      `execution "${id}": wherePhaseIn was empty; refusing to build an IN () clause`
    );
  }
  const phaseList = wherePhaseIn.map((phase) => `'${phase}'`).join(", ");
  const result = db
    .prepare(`${sql} AND phase IN (${phaseList})`)
    .run(...params);
  if (Number(result.changes) !== 1) {
    throw new NoRowUpdatedError(
      `execution "${id}" does not exist or its phase is not in [${wherePhaseIn.join(", ")}]; cannot ${action}`
    );
  }
}

/**
 * Read back and revalidate a stored pid identity. Returns null when no
 * process was ever recorded; a stored value that no longer parses is a
 * tampering signal and raises (`StoreError` via Zod, wrapped with context).
 */
export function readExecutionPidIdentity(
  db: DatabaseSync,
  id: string
): ProcessIdentityRecord | null {
  const row = db.prepare("SELECT pid_identity FROM executions WHERE id = ?").get(IdSchema.parse(id));
  if (row === undefined) {
    throw new NoRowUpdatedError(`execution "${id}" does not exist; cannot read pid identity`);
  }
  const raw = optStr(row as Row, "pid_identity");
  if (raw === null) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new StoreError(`stored pid_identity of execution "${id}" is not valid JSON`, { cause: error });
  }
  const result = ProcessIdentitySchema.safeParse(parsedJson);
  if (!result.success) {
    throw new StoreError(
      `stored pid_identity of execution "${id}" does not match the ProcessIdentity contract`,
      { cause: result.error }
    );
  }
  return result.data;
}

/** Every attempt currently in an ACTIVE phase, across all slots (reconcile scan base). */
export function listActiveAttempts(db: DatabaseSync): readonly ExecutionRow[] {
  const phaseList = ACTIVE_ATTEMPT_PHASES.map((phase) => `'${phase}'`).join(", ");
  const rows = db
    .prepare(`SELECT * FROM executions WHERE phase IN (${phaseList}) ORDER BY created_at ASC, id ASC`)
    .all();
  return rows.map(mapExecutionRow);
}

/**
 * Every attempt in one exact phase, oldest first (M1-05 read primitive: the
 * interrupted list needs `phase = 'INTERRUPTED'`, which the ACTIVE-phase
 * helpers do not cover). Read-only small extension; phase value is validated
 * through the same enum as every writer.
 */
export function listExecutionsForPhase(db: DatabaseSync, phase: AttemptPhase): readonly ExecutionRow[] {
  const parsed = AttemptPhaseSchema.parse(phase);
  const rows = db
    .prepare("SELECT * FROM executions WHERE phase = ? ORDER BY created_at ASC, id ASC")
    .all(parsed);
  return rows.map(mapExecutionRow);
}

function mapExecutionRow(row: Row): ExecutionRow {
  return {
    id: reqStr(row, "id"),
    runId: reqStr(row, "run_id"),
    nodeId: reqStr(row, "node_id"),
    definitionRevision: reqStr(row, "definition_revision"),
    attempt: reqInt(row, "attempt"),
    phase: AttemptPhaseSchema.parse(reqStr(row, "phase")),
    dispatchToken: reqStr(row, "dispatch_token"),
    sessionId: optStr(row, "session_id"),
    pidIdentity: optStr(row, "pid_identity"),
    createdAt: reqStr(row, "created_at"),
    updatedAt: reqStr(row, "updated_at")
  };
}

export function getExecution(db: DatabaseSync, id: string): ExecutionRow | null {
  const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(id);
  return row === undefined ? null : mapExecutionRow(row);
}

/** All attempts for a slot, lowest attempt number first. */
export function listAttemptsForSlot(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): readonly ExecutionRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM executions WHERE run_id = ? AND node_id = ? ORDER BY attempt ASC"
    )
    .all(input.runId, input.nodeId);
  return rows.map(mapExecutionRow);
}

/**
 * All attempts of a run in creation order — the read-side view primitive the
 * local API (M1-04) serves for run detail. Read-only; exposes the raw rows,
 * so API-facing callers remain responsible for not leaking secret-ish fields
 * (dispatch_token, pid_identity nonce).
 */
export function listExecutionsForRun(db: DatabaseSync, runId: string): readonly ExecutionRow[] {
  const rows = db
    .prepare("SELECT * FROM executions WHERE run_id = ? ORDER BY created_at ASC, id ASC")
    .all(IdSchema.parse(runId));
  return rows.map(mapExecutionRow);
}

/** The single active attempt for a slot, if any (at most one exists by constraint). */
export function getActiveAttempt(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): ExecutionRow | null {
  const phaseList = ACTIVE_ATTEMPT_PHASES.map((phase) => `'${phase}'`).join(", ");
  const row = db
    .prepare(
      `SELECT * FROM executions WHERE run_id = ? AND node_id = ? AND phase IN (${phaseList})`
    )
    .get(input.runId, input.nodeId);
  return row === undefined ? null : mapExecutionRow(row);
}

export function getExecutionByDispatchToken(
  db: DatabaseSync,
  dispatchToken: string
): ExecutionRow | null {
  const row = db
    .prepare("SELECT * FROM executions WHERE dispatch_token = ?")
    .get(dispatchToken);
  return row === undefined ? null : mapExecutionRow(row);
}
