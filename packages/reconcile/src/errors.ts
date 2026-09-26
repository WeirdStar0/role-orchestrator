/**
 * Typed error taxonomy for @role-orchestrator/reconcile.
 *
 * Reconcile never guesses outcomes: when the state of the world cannot be
 * determined (probe failure, impossible timestamps) the DECISION is
 * "recovery-required", not an exception. Errors here mean the reconcile
 * itself could not be performed or an operator request was malformed.
 */
import { StoreError } from "@role-orchestrator/store";

export class ReconcileError extends StoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReconcileError";
  }
}

/**
 * An operator action (for example resolving a RECOVERY_REQUIRED item) named
 * an execution that does not exist, is not in an active phase, or does not
 * carry the marker the action requires. Nothing was changed.
 */
export class ReconcileTargetStateError extends ReconcileError {
  readonly executionId: string;

  constructor(executionId: string, message: string) {
    super(`execution "${executionId}": ${message}`);
    this.name = "ReconcileTargetStateError";
    this.executionId = executionId;
  }
}
