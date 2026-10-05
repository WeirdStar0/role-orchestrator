/**
 * M10-02 M11 (recovery-driver) — the startup-recovery scan as an EXPLICIT,
 * STANDALONE entry (strategy ④: recovery is the exception among the optional
 * phases — never folded into the pump loop). The production pump NEVER calls
 * into this module (structure guard: run-driver/node-driver/approval-driver
 * hold no import edge here); an operator or composition root invokes the
 * scan deliberately, and A22 holds either way: nothing auto re-runs.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  listRecoveryItems,
  reconcileStartup,
  resolveRecoveryItem,
  type ReconcileScanResult,
  type ReconcileStartupInput
} from "@role-orchestrator/reconcile";
import { applyReconcileOutcomeToNode, type TaskNodeRow } from "@role-orchestrator/dag";

/**
 * The operator-facing recovery surface (the explicit entry's other half):
 * list the items a human must resolve, and record a human resolution. Both
 * are re-exported HERE so a composition root consumes the whole recovery
 * story through this module; the pump loop never touches them.
 */
export { listRecoveryItems, resolveRecoveryItem };

/**
 * The REAL startup scan over the durable A24 evidence (attempt rows, outbox,
 * pid identity). Probe injection exists for test composition roots; the
 * default is the reconcile package's real process probe.
 */
export async function scanStartupRecovery(
  db: DatabaseSync,
  input: ReconcileStartupInput = {}
): Promise<ReconcileScanResult> {
  return await reconcileStartup(db, input);
}

/** One reconcile decision landed on the NODE layer through the dag bridge. */
export function landRecoveryOutcome(
  db: DatabaseSync,
  input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly outcome: "interrupted" | "recovery-required";
    readonly now: string;
  }
): TaskNodeRow {
  return applyReconcileOutcomeToNode(db, input);
}
