import type { ReconcileOutcome } from "@role-orchestrator/reconcile";
import { RECONCILE_OUTCOMES } from "@role-orchestrator/reconcile";
import type { NodeState } from "./states.js";
import { UnknownReconcileOutcomeError } from "./errors.js";

/**
 * Bridge from `@role-orchestrator/reconcile` decisions to NODE-state
 * transitions (A22 landing spot).
 *
 * Reconcile decides about EXECUTIONS (attempts); its `recovery-required`
 * outcome deliberately leaves the attempt row in its active phase. This
 * module is where that decision lands on the NODE layer, where
 * RECOVERY_REQUIRED IS a first-class state (ORCHESTRATION.md section 3):
 *
 *   interrupted        -> node RUNNING     -> INTERRUPTED
 *   recovery-required  -> node INTERRUPTED -> RECOVERY_REQUIRED
 *   observed-running   -> no node change
 *
 * The DECISION logic (probe, pid identity, side-effect evidence) lives
 * entirely in @role-orchestrator/reconcile; only the state mapping lives
 * here. M4 wiring composes scan -> decide -> applyReconcileOutcomeToNode.
 */

export interface ReconcileNodeAction {
  readonly outcome: ReconcileOutcome;
  /** Target node state; null for observed-running (no node change). */
  readonly nodeTo: NodeState | null;
  /** The only node states the action may fire from (the optimistic guard). */
  readonly fromStates: readonly NodeState[];
}

const INTERRUPTED_ACTION: ReconcileNodeAction = {
  outcome: "interrupted",
  nodeTo: "INTERRUPTED",
  fromStates: ["RUNNING"]
};

const RECOVERY_REQUIRED_ACTION: ReconcileNodeAction = {
  outcome: "recovery-required",
  nodeTo: "RECOVERY_REQUIRED",
  fromStates: ["INTERRUPTED"]
};

const OBSERVED_RUNNING_ACTION: ReconcileNodeAction = {
  outcome: "observed-running",
  nodeTo: null,
  fromStates: []
};

/**
 * Map a reconcile outcome to the node action it implies. Unknown outcome
 * values are a typed rejection (`UnknownReconcileOutcomeError`), never a
 * guessed no-op.
 */
export function nodeActionForReconcileOutcome(outcome: ReconcileOutcome): ReconcileNodeAction {
  if (!(RECONCILE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new UnknownReconcileOutcomeError(String(outcome));
  }
  switch (outcome) {
    case "interrupted":
      return INTERRUPTED_ACTION;
    case "recovery-required":
      return RECOVERY_REQUIRED_ACTION;
    case "observed-running":
      return OBSERVED_RUNNING_ACTION;
  }
}
