import type { DatabaseSync } from "node:sqlite";
import type { ProjectRow } from "@role-orchestrator/store";
import { getProject } from "@role-orchestrator/store";
import { UnknownProjectError } from "../errors.js";

/**
 * Shared project lookup over the store's `projects` table (M1-01). Centralized
 * so every service in this package reports the same typed error when the
 * project does not exist.
 */
export type { ProjectRow };

export function requireProject(db: DatabaseSync, projectId: string): ProjectRow {
  const project = getProject(db, projectId);
  if (project === null) {
    throw new UnknownProjectError(projectId);
  }
  return project;
}
