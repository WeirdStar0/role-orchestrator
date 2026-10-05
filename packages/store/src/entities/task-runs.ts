import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { NoRowUpdatedError } from "../errors.js";
import type { Row } from "../rows.js";
import { reqInt, reqStr } from "../rows.js";
import { TimestampSchema } from "../time.js";

/**
 * TaskRun aggregate statuses (ORCHESTRATION.md section 3): a run's status is
 * the aggregation of its node states — never inferred from a CLI exit code.
 */
export const TASK_RUN_STATUSES = [
  "PLANNED",
  "RUNNING",
  "READY_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED"
] as const;

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export const TaskRunStatusSchema = z.enum(TASK_RUN_STATUSES);

/**
 * M10-04 — the TaskRun outcome vocabulary (external evaluation's P1
 * status+outcome model). The status column stays the FROZEN aggregation
 * vocabulary; `outcome` carries the presentation-facing terminality:
 * failed/blocked stay on a RUNNING run (the UI shows 失败/阻塞 instead of a
 * fake 执行中), cancelled pairs with the CANCELLED status, success is
 * reserved for the delivery flow, NULL = in progress. Aggregation semantics:
 * the orchestration run driver's settleRunStatus.
 */
export const TASK_RUN_OUTCOMES = ["success", "failed", "cancelled", "blocked"] as const;

export type TaskRunOutcome = (typeof TASK_RUN_OUTCOMES)[number];

export const TaskRunOutcomeSchema = z.enum(TASK_RUN_OUTCOMES);

export interface TaskRunRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly graphRevision: number;
  readonly configSnapshotHash: string;
  readonly baseSha: string;
  readonly status: TaskRunStatus;
  /** The presentation outcome (migration 018); NULL = in progress. */
  readonly outcome: TaskRunOutcome | null;
  readonly createdAt: string;
}

const CreateTaskRunInputSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  // No `tasks` table in the M1-01 minimal set, so this is a plain reference,
  // not a foreign key (documented in the migration and README).
  taskId: z.string().min(1).max(128),
  graphRevision: z.number().int().min(0),
  configSnapshotHash: z.string().min(1).max(256),
  baseSha: z.string().min(1).max(256),
  status: TaskRunStatusSchema.default("PLANNED"),
  now: TimestampSchema
});

export type CreateTaskRunInput = z.input<typeof CreateTaskRunInputSchema>;

/**
 * Create a TaskRun with its frozen configuration snapshot fields. Requires an
 * existing project (foreign key enforced on this connection).
 */
export function createTaskRun(db: DatabaseSync, input: CreateTaskRunInput): TaskRunRow {
  const value = CreateTaskRunInputSchema.parse(input);
  try {
    db.prepare(
      "INSERT INTO task_runs(id, project_id, task_id, graph_revision, config_snapshot_hash, base_sha, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      value.id,
      value.projectId,
      value.taskId,
      value.graphRevision,
      value.configSnapshotHash,
      value.baseSha,
      value.status,
      value.now
    );
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
      throw new NoRowUpdatedError(`project "${value.projectId}" does not exist (foreign key)`, {
        cause: error
      });
    }
    throw error;
  }
  return {
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    graphRevision: value.graphRevision,
    configSnapshotHash: value.configSnapshotHash,
    baseSha: value.baseSha,
    status: value.status,
    outcome: null,
    createdAt: value.now
  };
}

function mapTaskRunRow(row: Row): TaskRunRow {
  const rawOutcome = row["outcome"];
  return {
    id: reqStr(row, "id"),
    projectId: reqStr(row, "project_id"),
    taskId: reqStr(row, "task_id"),
    graphRevision: reqInt(row, "graph_revision"),
    configSnapshotHash: reqStr(row, "config_snapshot_hash"),
    baseSha: reqStr(row, "base_sha"),
    status: TaskRunStatusSchema.parse(reqStr(row, "status")),
    outcome: rawOutcome === null || rawOutcome === undefined
      ? null
      : TaskRunOutcomeSchema.parse(reqStr(row, "outcome")),
    createdAt: reqStr(row, "created_at")
  };
}

export function getTaskRun(db: DatabaseSync, id: string): TaskRunRow | null {
  const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(id);
  return row === undefined ? null : mapTaskRunRow(row);
}

export function setTaskRunStatus(
  db: DatabaseSync,
  input: { readonly id: string; readonly status: TaskRunStatus }
): void {
  const parsed = z
    .strictObject({ id: IdSchema, status: TaskRunStatusSchema })
    .parse(input);
  const result = db
    .prepare("UPDATE task_runs SET status = ? WHERE id = ?")
    .run(parsed.status, parsed.id);
  if (Number(result.changes) !== 1) {
    throw new NoRowUpdatedError(`task run "${parsed.id}" does not exist`);
  }
}

/**
 * M10-04 — write the presentation outcome (migration 018's column). The
 * aggregation rules live in the orchestration run driver's settleRunStatus:
 * failed node -> 'failed' (run stays RUNNING), approval park -> 'blocked',
 * cancellation -> 'cancelled' (paired with status CANCELLED by the cancel
 * surface), full success -> NULL at READY_FOR_DELIVERY. NULL resets to
 * in-progress; an unknown run is a typed NoRowUpdatedError, never a silent
 * no-op.
 */
export function setTaskRunOutcome(
  db: DatabaseSync,
  input: { readonly id: string; readonly outcome: TaskRunOutcome | null }
): void {
  const parsed = z
    .strictObject({ id: IdSchema, outcome: TaskRunOutcomeSchema.nullable() })
    .parse(input);
  const result = db
    .prepare("UPDATE task_runs SET outcome = ? WHERE id = ?")
    .run(parsed.outcome, parsed.id);
  if (Number(result.changes) !== 1) {
    throw new NoRowUpdatedError(`task run "${parsed.id}" does not exist`);
  }
}
