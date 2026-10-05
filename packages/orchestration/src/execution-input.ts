/**
 * M10-02 M6 (execution-input) — the pure node -> execution-input mapping.
 *
 * Everything the engine launcher needs that is DERIVED (not stored): the
 * prompt a node runs under, the profile's timeout/invocation-arg settings,
 * the durable objective/repo-root reads, and the persisted-event views the
 * approval miner consumes. This module is the seam where M10-03's role
 * context injection will extend the mapping (v1 deliberately does NOT
 * implement it — the seam only exists).
 */
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, RoleId } from "@role-orchestrator/contracts";
import type { ProtocolEventView } from "@role-orchestrator/checkpoint";
import { listEventsForExecution } from "@role-orchestrator/store";
import { getLatestGraphRevision } from "@role-orchestrator/dag";
import type { ProfileDefinition } from "./driver-contract.js";
import { EXECUTE_NODE_ID } from "./constants.js";

/**
 * The launch-facing description of ONE execution — what node-driver hands to
 * the engine (via launchExecution) and what the approval continuation mints.
 */
export interface ExecutionLaunchInput {
  readonly executionId: string;
  readonly runId: string;
  readonly roleId: RoleId;
  readonly nodeId: string;
  readonly definitionRevision: string;
  readonly attempt: number;
  readonly dispatchToken: string;
  readonly cwd: string;
  readonly profileId: string;
  readonly objective: string | null;
}

/**
 * The profile's launch settings: the frozen timeout, plus the
 * composition-root invocationArgs extension (never persisted in the profile
 * FILE; defaults match the M9-01 driver: 600 s, no extra args).
 * M10-03 seam: role-context injection would extend the derived input here.
 */
export function resolveExecutionSettings(
  profilesById: ReadonlyMap<string, ProfileDefinition>,
  profileId: string
): { readonly timeoutSeconds: number; readonly invocationArgs: readonly string[] } {
  const definition = profilesById.get(profileId);
  return {
    timeoutSeconds: definition?.timeoutSeconds ?? 600,
    invocationArgs: definition?.invocationArgs ?? []
  };
}

/** The child's stdin prompt: the objective, or the honest synthetic fallback. */
export function executionPrompt(input: Pick<ExecutionLaunchInput, "objective" | "runId" | "nodeId">): string {
  return input.objective ?? `run ${input.runId} node ${input.nodeId}`;
}

/** The run objective comes from the frozen graph revision (durable). */
export function objectiveOfRun(db: DatabaseSync, runId: string): string | null {
  const revision = getLatestGraphRevision(db, runId);
  return revision?.workflow.nodes.find((node) => node.id === EXECUTE_NODE_ID)?.objective ?? null;
}

/** The project row always exists for a run created here; read its repoRoot. */
export function repoRootOf(db: DatabaseSync, projectId: string): string {
  const row = db.prepare("SELECT repo_root FROM projects WHERE id = ?").get(projectId) as
    | { repo_root: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`project "${projectId}" vanished while driving its run`);
  }
  return row.repo_root;
}

/**
 * The persisted (already engine-redacted) event stream as the checkpoint
 * miner's ProtocolEventViews — the exact mapping the former local-api
 * orchestrator and the dogfood driver both carried (two verbatim copies; the
 * convergence of the dogfood copy is step 2).
 */
export function storedEventViews(db: DatabaseSync, executionId: string): readonly ProtocolEventView[] {
  return listEventsForExecution(db, executionId).map((row) => ({
    type: row.type,
    sourceType: null,
    seq: row.seq,
    payload: JSON.parse(row.payload) as Record<string, JsonValue>
  }));
}
