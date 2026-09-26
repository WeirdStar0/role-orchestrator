import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTarget } from "@role-orchestrator/contracts";
import { ExecutionTargetSchema, IdSchema } from "@role-orchestrator/contracts";
import { DuplicateRepoRootError, NoRowUpdatedError, isUniqueViolation } from "../errors.js";
import type { Row } from "../rows.js";
import { reqStr } from "../rows.js";
import { TimestampSchema } from "../time.js";

export interface ProjectRow {
  readonly id: string;
  readonly repoRoot: string;
  readonly executionTarget: ExecutionTarget;
  readonly trustStatus: string;
  readonly createdAt: string;
}

const CreateProjectInputSchema = z.strictObject({
  id: IdSchema,
  repoRoot: z.string().min(1).max(2048),
  executionTarget: ExecutionTargetSchema,
  // Closed vocabulary lands with M1-02 (Profile/trust work); stored verbatim
  // for now and validated as a short opaque string.
  trustStatus: z.string().min(1).max(64),
  now: TimestampSchema
});

export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;

/**
 * Create a project. `repo_root` is unique (canonical repo root invariant), so
 * adding the same repository twice raises `DuplicateRepoRootError`.
 */
export function createProject(db: DatabaseSync, input: CreateProjectInput): ProjectRow {
  const value = CreateProjectInputSchema.parse(input);
  try {
    db.prepare(
      "INSERT INTO projects(id, repo_root, execution_target, trust_status, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(value.id, value.repoRoot, value.executionTarget, value.trustStatus, value.now);
  } catch (error) {
    if (isUniqueViolation(error, "projects.repo_root")) {
      throw new DuplicateRepoRootError(value.repoRoot, { cause: error });
    }
    throw error;
  }
  return {
    id: value.id,
    repoRoot: value.repoRoot,
    executionTarget: value.executionTarget,
    trustStatus: value.trustStatus,
    createdAt: value.now
  };
}

function mapProjectRow(row: Row): ProjectRow {
  return {
    id: reqStr(row, "id"),
    repoRoot: reqStr(row, "repo_root"),
    executionTarget: ExecutionTargetSchema.parse(reqStr(row, "execution_target")),
    trustStatus: reqStr(row, "trust_status"),
    createdAt: reqStr(row, "created_at")
  };
}

export function getProject(db: DatabaseSync, id: string): ProjectRow | null {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return row === undefined ? null : mapProjectRow(row);
}

export function getProjectByRepoRoot(db: DatabaseSync, repoRoot: string): ProjectRow | null {
  const row = db.prepare("SELECT * FROM projects WHERE repo_root = ?").get(repoRoot);
  return row === undefined ? null : mapProjectRow(row);
}

export function deleteProject(db: DatabaseSync, id: string): void {
  const result = db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (Number(result.changes) !== 1) {
    throw new NoRowUpdatedError(`project "${id}" does not exist`);
  }
}
