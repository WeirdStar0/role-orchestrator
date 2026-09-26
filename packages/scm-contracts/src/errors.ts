/**
 * Typed error taxonomy for @role-orchestrator/scm-contracts (M7-01).
 *
 * Two invariants hold for EVERY message and field here:
 * - No request content, provider response content, or credential material is
 *   ever embedded. Errors carry structural facts only (operation names, ids,
 *   digests, rule names, zod issue paths+codes) because error text is the
 *   easiest accidental exfiltration channel (A42).
 * - Refusal reasons map 1:1 onto the audit refusal-code vocabulary in
 *   ./events.js, so a refusal can be logged and audited without re-deriving
 *   why it happened.
 *
 * Approval-lifecycle errors from @role-orchestrator/approval (UnknownApproval,
 * ApprovalState, ApprovalExpired, ApprovalAlreadyConsumed, ApprovalDigestMismatch)
 * are deliberately NOT wrapped: they propagate unchanged through the controlled
 * write client so the host sees the exact single-consumption failure mode.
 */
import { z } from "zod";

export class ScmContractsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScmContractsError";
  }
}

/**
 * A controlled write was called without its ApprovalRef argument. The
 * dedicated refusal for the missing-authorization case: it fires BEFORE any
 * schema parse, verification lookup or transport touch, so an untyped caller
 * omitting the argument can never reach provider I/O.
 */
export class ScmApprovalRequiredError extends ScmContractsError {
  readonly operation: string;

  constructor(input: { readonly operation: string }) {
    super(
      `SCM write "${input.operation}" requires an ApprovalRef argument bound to the exact ` +
        "command digest (A17 by analogy); refusing before any validation, verification or I/O",
      { cause: input.operation }
    );
    this.name = "ScmApprovalRequiredError";
    this.operation = input.operation;
  }
}

/**
 * The provider surface (read or controlledWrite) is not verified in the
 * compatibility matrix lookup. The shipped matrix pins every cell to
 * `unverified`, so with the default lookup NO client can be constructed at
 * all — remote SCM stays fail-closed OFF until evidence exists.
 */
export class ScmProviderNotVerifiedError extends ScmContractsError {
  readonly provider: string;
  readonly surface: string;
  readonly status: string;

  constructor(input: {
    readonly provider: string;
    readonly surface: string;
    readonly status: string;
  }) {
    super(
      `provider "${input.provider}" surface "${input.surface}" is "${input.status}" in the ` +
        "compatibility matrix; unverified integrations are refused (Unknown 不视作允许)",
      { cause: `${input.provider}/${input.surface}=${input.status}` }
    );
    this.name = "ScmProviderNotVerifiedError";
    this.provider = input.provider;
    this.surface = input.surface;
    this.status = input.status;
  }
}

/**
 * The operation is not declared in the provider capability's reads/writes
 * lists — a caller/config disagreement caught before any I/O.
 */
export class ScmOperationNotDeclaredError extends ScmContractsError {
  readonly provider: string;
  readonly operation: string;
  readonly surface: string;

  constructor(input: {
    readonly provider: string;
    readonly operation: string;
    readonly surface: string;
  }) {
    super(
      `provider "${input.provider}" capability does not declare operation "${input.operation}" ` +
        `for surface "${input.surface}"; refusing to call an undeclared operation`,
      { cause: `${input.provider}/${input.operation}` }
    );
    this.name = "ScmOperationNotDeclaredError";
    this.provider = input.provider;
    this.operation = input.operation;
    this.surface = input.surface;
  }
}

/**
 * The ApprovalRef presented with a write command does not hash to the command
 * as presented: the write target or content changed after the approval was
 * minted (A17 by analogy). The approval itself is NOT consumed by this
 * refusal — a failed attempt never burns it.
 */
export class ScmApprovalDigestMismatchError extends ScmContractsError {
  readonly approvalId: string;
  readonly operation: string;
  readonly boundDigest: string;
  readonly presentedDigest: string;

  constructor(input: {
    readonly approvalId: string;
    readonly operation: string;
    readonly boundDigest: string;
    readonly presentedDigest: string;
  }) {
    super(
      `approval "${input.approvalId}" is bound to digest ${input.boundDigest}, but the ` +
        `${input.operation} command as presented hashes to ${input.presentedDigest}; the write ` +
        "changed after approval (target PR/issue/SHA/content/binding) and the original approval " +
        "cannot be consumed for it (A17 by analogy)",
      { cause: `${input.boundDigest} != ${input.presentedDigest}` }
    );
    this.name = "ScmApprovalDigestMismatchError";
    this.approvalId = input.approvalId;
    this.operation = input.operation;
    this.boundDigest = input.boundDigest;
    this.presentedDigest = input.presentedDigest;
  }
}

/** A credentialRef or ResolvedCredentialHandle carries forbidden material/shape. */
export class ScmCredentialShapeError extends ScmContractsError {
  readonly detail: string;
  readonly matchedRules: readonly string[];

  constructor(input: { readonly detail: string; readonly matchedRules?: readonly string[] }) {
    super(input.detail, { cause: input.matchedRules?.join(",") ?? "" });
    this.name = "ScmCredentialShapeError";
    this.detail = input.detail;
    this.matchedRules = input.matchedRules ?? [];
  }
}

/** Local caller input (query/command/ref) failed a strict schema. */
export class ScmRequestValidationError extends ScmContractsError {
  readonly context: string;
  /** Paths + zod issue CODES only — never the offending values. */
  readonly issues: readonly { readonly path: string; readonly code: string }[];

  constructor(
    input: { readonly context: string },
    error: z.ZodError
  ) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code
    }));
    super(
      `${input.context} failed strict schema validation (${issues.length} issue(s)); ` +
        "unknown fields are rejected, not ignored",
      { cause: issues.map((issue) => `${issue.path}:${issue.code}`).join(",") }
    );
    this.name = "ScmRequestValidationError";
    this.context = input.context;
    this.issues = issues;
  }
}

/**
 * The transport (adapter seam) returned a payload that does not satisfy the
 * strict projection schema for the operation. Adapters MUST project provider
 * responses (drop unknown fields, drop malformed items while counting them in
 * `malformedDropped`) BEFORE returning; this error means projection was
 * skipped or hostile content slipped through.
 */
export class ScmTransportContractError extends ScmContractsError {
  readonly operation: string;
  readonly issues: readonly { readonly path: string; readonly code: string }[];

  constructor(input: { readonly operation: string }, error: z.ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code
    }));
    super(
      `transport response for "${input.operation}" violated the strict projection schema ` +
        `(${issues.length} issue(s)); adapters must project provider responses before returning`,
      { cause: issues.map((issue) => `${issue.path}:${issue.code}`).join(",") }
    );
    this.name = "ScmTransportContractError";
    this.operation = input.operation;
    this.issues = issues;
  }
}

/** An internal invariant was violated (a bug, not an input problem). */
export class ScmInvariantViolationError extends ScmContractsError {
  readonly detail: string;

  constructor(detail: string) {
    super(`invariant violation: ${detail}`, { cause: detail });
    this.name = "ScmInvariantViolationError";
    this.detail = detail;
  }
}
