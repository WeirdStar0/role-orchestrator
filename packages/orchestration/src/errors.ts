/**
 * M10-02 M1 (driver-contract) — the orchestration package's OWN typed error
 * family (error-carrier inversion).
 *
 * Before M10-02 the run driver (local-api orchestrator.ts) refused with the
 * local-api `GraphEditRejectionError`, which made the pump depend on the HTTP
 * package that hosts it. The dependency now points the RIGHT way: the domain
 * refuses with `OrchestrationRejectionError` — same shape (HTTP status,
 * machine-readable code, human message, structured details) — and the serving
 * package maps it to its wire envelope VERBATIM (status, code, message text
 * and details all byte-identical; the runs-orchestration HTTP contract suite,
 * unchanged, is the regression anchor).
 *
 * The family covers exactly the refusal semantics the driver carries (each
 * code with its frozen status, as thrown by this package):
 *   400  PROJECT_DIR_NOT_ABSOLUTE / PROJECT_DIR_MISSING /
 *        PROJECT_DIR_NOT_DIRECTORY / PROJECT_DIR_NOT_GIT_REPOSITORY
 *        (fail-closed before anything is written)
 *   404  PROJECT_NOT_FOUND (binding configuration for an unknown project)
 *   409  PROFILE_DEFINITION_CONFLICT (the seven-field drift gate — drift is a
 *        deliberate human act, never an upsert)
 *   422  ROLE_BINDINGS_INCOMPLETE (M10-01: creation is READ-ONLY over role
 *        bindings), UNKNOWN_PROFILE, UNKNOWN_PROFILE_REVISION,
 *        EXECUTION_TARGET_MISMATCH (A29)
 * `PROFILE_SOURCE_ABSENT` stays a local-api carrier: the profiles config FILE
 * surface (view/atomic write-back) is an HTTP-preserved concern, not driver
 * semantics.
 */
export class OrchestrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrchestrationError";
  }
}

/**
 * A request was REFUSED by a typed domain rule of the run driver. The status
 * code and machine-readable code are decided by the DOMAIN (this package);
 * the HTTP layer only forwards them into its wire envelope. The original
 * typed error (runtime-profile/dag/...) rides along as `cause`; `details`
 * carries structured, machine-readable context beside the envelope (never a
 * substitute for the message, never a secret).
 */
export class OrchestrationRejectionError extends OrchestrationError {
  readonly statusCode: 400 | 403 | 404 | 409 | 422;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    statusCode: 400 | 403 | 404 | 409 | 422,
    code: string,
    message: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> }
  ) {
    super(message, options);
    this.name = "OrchestrationRejectionError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details ?? {};
  }
}

/**
 * M10-03 — a PUMP-CONTRACT violation discovered while DRIVING (never an HTTP
 * refusal): e.g. a multi-node run whose dispatch resolves no registered node
 * kind (a re-drive after a serve restart lost the in-memory kind registry).
 * Like the pump's other faults this rides the catch-per-run isolation (the
 * drive of THIS run ends, the serve process carries on) and leaves the
 * durable claim for the explicit recovery flow — nothing is silently
 * mis-dispatched as the wrong node kind.
 */
export class OrchestrationDriverError extends OrchestrationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OrchestrationDriverError";
  }
}
