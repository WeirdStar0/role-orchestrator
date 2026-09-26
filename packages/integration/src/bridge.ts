/**
 * The dag-side bridge of M2-04: how an integration record constrains NODE
 * states (docs/ORCHESTRATION.md section 3 machine, applied via dag's guarded
 * `transitionNodeState`).
 *
 * Contract pinned here (ask: "集成 PAUSED 时节点不判 SUCCEEDED"):
 * - `applyIntegrationOutcomeToNode` — after an integration concludes:
 *     PAUSED_CONFLICT  -> the successor's baseline assembly failed, so the
 *                         successor must NOT become dispatchable with a
 *                         non-existent baseline: PENDING/READY moves to
 *                         BLOCKED (a legal FSM edge; BLOCKED deliberately has
 *                         no outgoing edges — recovery is an explicit later
 *                         milestone, never an automatic resume).
 *     COMPLETED        -> no node transition: node success still belongs to
 *                         the node's own execution lifecycle, and readiness
 *                         propagation stays dag's job. The bridge only ever
 *                         RESTRICTS, never promotes.
 *     IN_PROGRESS/none -> untouched.
 * - `assertNodeNotIntegrationPaused` — the gate any SUCCEEDED-marking caller
 *   must pass first; a paused integration makes it impossible to judge the
 *   node SUCCEEDED through this layer, and the FSM itself agrees: BLOCKED has
 *   no edge to SUCCEEDED.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  getNodeState,
  transitionNodeState,
  type NodeState,
  type TaskNodeRow
} from "@role-orchestrator/dag";
import { getIntegrationRecord } from "./record.js";
import { IntegrationPausedError } from "./errors.js";

const BridgeInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  now: z.string().min(1).max(64)
});

export type ApplyIntegrationOutcomeToNodeInput = z.input<typeof BridgeInputSchema>;

export interface ApplyIntegrationOutcomeToNodeResult {
  readonly node: TaskNodeRow;
  /**
   * What the bridge did: "blocked-successor" (paused record moved a
   * PENDING/READY node to BLOCKED), "left-unchanged" (nothing applicable or
   * node already outside the movable states), "guarded" (informational for
   * COMPLETED records).
   */
  readonly action:
    | "blocked-successor"
    | "left-unchanged"
    | "no-record"
    | "integration-open";
}

/**
 * Apply the integration record's consequence to the SUCCESSOR node row.
 * See the module contract. The transition is guarded (`whereStateIn`) so a
 * concurrent scheduler decision is never overwritten.
 */
export function applyIntegrationOutcomeToNode(
  db: DatabaseSync,
  input: ApplyIntegrationOutcomeToNodeInput
): ApplyIntegrationOutcomeToNodeResult {
  const value = BridgeInputSchema.parse(input);
  const record = getIntegrationRecord(db, { runId: value.runId, nodeId: value.nodeId });
  if (record === null) {
    return { node: requireNode(db, value.runId, value.nodeId), action: "no-record" };
  }

  if (record.state !== "PAUSED_CONFLICT") {
    return {
      node: requireNode(db, value.runId, value.nodeId),
      action: record.state === "IN_PROGRESS" ? "integration-open" : "left-unchanged"
    };
  }

  const node = requireNode(db, value.runId, value.nodeId);
  const movable: readonly NodeState[] = ["PENDING", "READY"];
  if (!movable.includes(node.state)) {
    // Already RUNNING (or terminal): the orchestrator must resolve through the
    // recovery path later; the bridge never rewrites a running/terminal row.
    return { node, action: "left-unchanged" };
  }
  const blocked = transitionNodeState(db, {
    runId: value.runId,
    nodeId: value.nodeId,
    to: "BLOCKED",
    whereStateIn: [...movable],
    now: value.now
  });
  return { node: blocked, action: "blocked-successor" };
}

/**
 * Fail-closed gate for any caller about to judge a node SUCCEEDED: throws
 * `IntegrationPausedError` while the node's integration is PAUSED_CONFLICT.
 * A node whose baseline assembly is paused must never be recorded as a
 * successful output.
 */
export function assertNodeNotIntegrationPaused(
  db: DatabaseSync,
  input: { readonly runId: string; readonly nodeId: string }
): void {
  const runId = IdSchema.parse(input.runId);
  const nodeId = IdSchema.parse(input.nodeId);
  const record = getIntegrationRecord(db, { runId, nodeId });
  if (record !== null && record.state === "PAUSED_CONFLICT") {
    throw new IntegrationPausedError({
      runId,
      nodeId,
      conflictFiles: record.conflictFiles ?? []
    });
  }
}

function requireNode(db: DatabaseSync, runId: string, nodeId: string): TaskNodeRow {
  const node = getNodeState(db, { runId, nodeId });
  if (node === null) {
    throw new Error(`node "${nodeId}" does not exist in run "${runId}"`);
  }
  return node;
}
