/**
 * Typed error taxonomy for @role-orchestrator/local-api.
 *
 * Errors here mean "the local API could not start safely or a request was
 * refused by a security check" — never a guessed outcome. HTTP-level
 * refusals are NOT exceptions: the guard pipeline returns typed decisions
 * (see guard.ts) so every forged request produces an explicit status code
 * and reason. Exceptions are reserved for startup/configuration faults and
 * malformed durable state; each keeps its original error as `cause`.
 */
export class LocalApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalApiError";
  }
}

/**
 * Fail-closed configuration fault: a caller asked for something this server
 * must never do (for example binding a non-loopback address) or the runtime
 * environment cannot support a required guarantee.
 */
export class LocalApiConfigurationError extends LocalApiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalApiConfigurationError";
  }
}

/**
 * The session token file could not be created, read or verified with
 * current-user-only visibility. The server refuses to start instead of
 * falling back to a weaker transport of the token.
 */
export class TokenStoreError extends LocalApiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenStoreError";
  }
}

/**
 * Durable state read through the read-only API does not match the stored
 * contract (for example an events payload that is not valid JSON). Surfaced
 * as a 500-class failure with a redacted message, never as empty data.
 */
export class LocalApiStateError extends LocalApiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalApiStateError";
  }
}

/**
 * A request was REFUSED by a typed domain rule (M5-01/M5-02, A02/A04/A38;
 * since M9-01 also run creation, since M9-03 the profiles config write-back):
 * unknown run/node (404), a stale graphRevision (409
 * GRAPH_REVISION_CONFLICT), a running/finished node (409 NODE_NOT_EDITABLE),
 * a disabled expansion permission (403 EXPANSION_PERMISSION_DENIED), a
 * rejected post-change graph (400, the typed A08/A20 vocabulary), profiles
 * content that fails the frozen profiles schema (422
 * PROFILES_CONTENT_INVALID — the file-style "processable but refused" case:
 * the request shape was valid JSON, the CONTENT does not parse). The status
 * code and machine-readable code are decided by the DOMAIN mapping, not by
 * the HTTP layer; the original typed error rides along as `cause`.
 * Deliberately NOT used for guard rejections (those happen before routing)
 * or for malformed client input (plain 400s from schema parsing).
 */
export class GraphEditRejectionError extends LocalApiError {
  readonly statusCode: 400 | 403 | 404 | 409 | 422;
  readonly code: string;
  /**
   * Structured, machine-readable context for the rejection envelope — for
   * example `currentGraphRevision` on a 409 revision conflict (A38: the
   * client refreshes and retries against it). Never a substitute for the
   * message; never carries secrets.
   */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    statusCode: 400 | 403 | 404 | 409 | 422,
    code: string,
    message: string,
    options?: { cause?: unknown; details?: Readonly<Record<string, unknown>> }
  ) {
    super(message, options);
    this.name = "GraphEditRejectionError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details ?? {};
  }
}
