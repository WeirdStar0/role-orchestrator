/**
 * Typed errors of the remote-worker protocol simulation (M7-03).
 *
 * Every rejection path of the protocol has its own class so callers (and
 * tests) can distinguish WHY a write-back, a cancel or a posture claim was
 * refused — guessing from message strings is exactly what this package must
 * not require. Error messages carry structural facts only (ids, tokens,
 * reasons); they never embed event payloads or secret material (A42).
 */

/** Closed machine-readable reason for a refused fencing-checked write-back. */
export const FENCING_REJECT_REASONS = ["no-live-lease", "stale-token", "lease-expired"] as const;
export type FencingRejectReason = (typeof FENCING_REJECT_REASONS)[number];

export type RemoteWorkerErrorCode =
  | "transport-sealed"
  | "cancel-undeliverable"
  | "fencing-rejected"
  | "lease-not-held"
  | "foreign-execution"
  | "worker-already-assigned"
  | "hardened-posture-unavailable"
  | "secret-material-rejected"
  | "session-not-terminal-unknown";

export class RemoteWorkerProtocolError extends Error {
  readonly code: RemoteWorkerErrorCode;

  constructor(code: RemoteWorkerErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The (simulated) cable is cut; no message crosses in either direction. */
export class TransportSealedError extends RemoteWorkerProtocolError {
  constructor(direction: "orchestrator-to-worker" | "worker-to-orchestrator") {
    super("transport-sealed", `transport is sealed; ${direction} delivery is impossible until it heals`);
  }
}

/**
 * A cancel command could not be delivered (transport sealed). The caller MUST
 * treat the worker as uncancelled-and-unknown — never as terminated by
 * assumption (A26: "终止或明确报告未终止"; assuming is neither).
 */
export class CancelUndeliverableError extends RemoteWorkerProtocolError {
  constructor(readonly executionId: string) {
    super("cancel-undeliverable", `cancel for execution "${executionId}" could not be delivered; termination state is UNKNOWN`);
  }
}

/**
 * A fencing-checked write-back was refused. `reason` distinguishes the three
 * possible worlds; `currentToken` is the live token when one exists (never
 * leaked for a foreign execution — only for the same resourceKey).
 */
export class FencingRejectedError extends RemoteWorkerProtocolError {
  constructor(
    readonly reason: FencingRejectReason,
    readonly resourceKey: string,
    readonly presentedToken: number,
    readonly currentToken: number | null
  ) {
    super(
      "fencing-rejected",
      `write-back on "${resourceKey}" refused (${reason}): presented fencing token ${String(presentedToken)}` +
        (currentToken === null ? ", no live lease holds the resource" : `, current live token is ${String(currentToken)}`)
    );
  }
}

/** The execution has no live lease at all — it cannot hold or exercise one. */
export class LeaseNotHeldError extends RemoteWorkerProtocolError {
  constructor(readonly executionId: string) {
    super("lease-not-held", `execution "${executionId}" holds no live lease`);
  }
}

/** An event arrived for a different execution than the session's. */
export class ForeignExecutionError extends RemoteWorkerProtocolError {
  constructor(readonly expectedExecutionId: string, readonly observedExecutionId: string) {
    super("foreign-execution", `event belongs to execution "${observedExecutionId}", session owns "${expectedExecutionId}"`);
  }
}

/** The (simulated) worker was assigned while already holding an assignment. */
export class WorkerAlreadyAssignedError extends RemoteWorkerProtocolError {
  constructor(readonly heldExecutionId: string, readonly offeredExecutionId: string) {
    super(
      "worker-already-assigned",
      `worker already holds execution "${heldExecutionId}"; refusing assignment of "${offeredExecutionId}"`
    );
  }
}

/**
 * A31 posture gate: "hardened" was requested for a remote target whose
 * OS/container filesystem+network boundary evidence is unverified. Per
 * docs/SECURITY_MODEL.md the mode is then NOT selectable — this refusal is
 * the compliance posture, not an unfinished feature.
 */
export class HardenedPostureUnavailableError extends RemoteWorkerProtocolError {
  constructor(readonly target: string, readonly reason: string) {
    super("hardened-posture-unavailable", `hardened posture unavailable on target "${target}": ${reason}`);
  }
}

/** Secret-shaped material was found where only references are allowed (A42). */
export class SecretMaterialRejectedError extends RemoteWorkerProtocolError {
  constructor(readonly field: string, readonly rule: string) {
    super("secret-material-rejected", `field "${field}" rejected by secret-shape rule "${rule}"; only opaque references are accepted`);
  }
}

/** observeUnknownOutcome was called but the session is not in an unknown state. */
export class SessionNotTerminalUnknownError extends RemoteWorkerProtocolError {
  constructor(readonly executionId: string, readonly currentKind: string) {
    super(
      "session-not-terminal-unknown",
      `execution "${executionId}" cannot land on RECOVERY_REQUIRED from outcome "${currentKind}"`
    );
  }
}
