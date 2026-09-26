/**
 * Typed error taxonomy for @role-orchestrator/approval (M4-01).
 *
 * Every class carries the decision-relevant facts and never guesses an
 * outcome. Grounding:
 * - docs/SECURITY_MODEL.md 人工审批: an approval binds the action digest, the
 *   target repo/baseSha, the profile revision, permission increments, the
 *   expiry and the one-shot consumption state; a changed action or baseline
 *   invalidates the original approval (A17 -> `ApprovalDigestMismatchError`).
 * - docs/ACCEPTANCE.md A18: a second consumption attempt is rejected, and a
 *   replayed idempotency key returns the SAME approval, never a new one.
 * - capability-gate registry `argv.permission-skip-flags`: the
 *   `--dangerously-*` family has `requiredControl: "forbidden"` — there is NO
 *   v1 authorization path, so `createApproval` refuses with
 *   `ApprovalForbiddenArgvError` instead of minting an approval for it.
 * - docs/DOMAIN_MODEL.md: consumption is a transactional compare-and-swap;
 *   expired approvals or a changed baseline are never consumable.
 */
export class ApprovalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApprovalError";
  }
}

/**
 * The action's argv matches a blocked pattern whose requiredControl is
 * "forbidden" (the `--dangerously-*` permission-skip family). No approval is
 * created: v1 has no authorization path for these patterns, so refusing at
 * creation is the only safe answer. The refusal is recorded nowhere except
 * the caller's error — minting a row would suggest an approvable action.
 */
export class ApprovalForbiddenArgvError extends ApprovalError {
  readonly patternIds: readonly string[];

  constructor(patternIds: readonly string[]) {
    super(
      `action argv matches forbidden blocked pattern(s) [${patternIds.join(", ")}] ` +
        'with requiredControl "forbidden" (capability-gate registry): ' +
        "there is no v1 authorization path, so no approval can be created for it",
      { cause: patternIds.join(", ") }
    );
    this.name = "ApprovalForbiddenArgvError";
    this.patternIds = [...patternIds];
  }
}

/**
 * An idempotency key was reused with a DIFFERENT action digest. Replay
 * semantics (A18) only absorb identical requests; a changed action under the
 * same key is a caller bug or an attempt to smuggle a second action through
 * an approved key — refused, never silently absorbed.
 */
export class IdempotencyKeyConflictError extends ApprovalError {
  readonly idempotencyKey: string;
  readonly existingApprovalId: string;
  readonly existingDigest: string;
  readonly presentedDigest: string;

  constructor(input: {
    readonly idempotencyKey: string;
    readonly existingApprovalId: string;
    readonly existingDigest: string;
    readonly presentedDigest: string;
  }) {
    super(
      `idempotency key "${input.idempotencyKey}" already created approval ` +
        `"${input.existingApprovalId}" for digest ${input.existingDigest}, but the new ` +
        `request presents digest ${input.presentedDigest}; replay only absorbs IDENTICAL ` +
        "requests (A18), a changed action needs a new idempotency key",
      { cause: `${input.existingDigest} != ${input.presentedDigest}` }
    );
    this.name = "IdempotencyKeyConflictError";
    this.idempotencyKey = input.idempotencyKey;
    this.existingApprovalId = input.existingApprovalId;
    this.existingDigest = input.existingDigest;
    this.presentedDigest = input.presentedDigest;
  }
}

/** No approval row exists for the requested identity. */
export class UnknownApprovalError extends ApprovalError {
  readonly detail: string;

  constructor(detail: string) {
    super(`no approval: ${detail}`);
    this.name = "UnknownApprovalError";
    this.detail = detail;
  }
}

/** A guarded transition hit a row that already left the expected state. */
export class ApprovalStateError extends ApprovalError {
  readonly approvalId: string;
  readonly expectedState: string;
  readonly actualState: string;

  constructor(input: {
    readonly approvalId: string;
    readonly expectedState: string;
    readonly actualState: string;
  }) {
    super(
      `approval "${input.approvalId}" is ${input.actualState}, expected ${input.expectedState}; ` +
        "refusing to apply a guarded transition from the wrong state",
      { cause: `${input.actualState} != ${input.expectedState}` }
    );
    this.name = "ApprovalStateError";
    this.approvalId = input.approvalId;
    this.expectedState = input.expectedState;
    this.actualState = input.actualState;
  }
}

/**
 * The approval's expires_at has passed: expired approvals are never
 * consumable (and a PENDING approval past its expiry can no longer be
 * approved — approving an expired request would mint a live permission from
 * a dead one).
 */
export class ApprovalExpiredError extends ApprovalError {
  readonly approvalId: string;
  readonly expiredAt: string;

  constructor(input: { readonly approvalId: string; readonly expiredAt: string }) {
    super(
      `approval "${input.approvalId}" expired at ${input.expiredAt}; ` +
        "expired approvals are never consumable (docs/DOMAIN_MODEL.md: 过期或基线改变不能消费)",
      { cause: input.expiredAt }
    );
    this.name = "ApprovalExpiredError";
    this.approvalId = input.approvalId;
    this.expiredAt = input.expiredAt;
  }
}

/**
 * A18: the approval was already consumed once. The one-shot guarantee means
 * the SECOND attempt is rejected even when the presented action is identical;
 * the record names the execution that consumed it.
 */
export class ApprovalAlreadyConsumedError extends ApprovalError {
  readonly approvalId: string;
  readonly consumedByExecutionId: string;
  readonly consumedAt: string;

  constructor(input: {
    readonly approvalId: string;
    readonly consumedByExecutionId: string;
    readonly consumedAt: string;
  }) {
    super(
      `approval "${input.approvalId}" was already consumed by execution ` +
        `"${input.consumedByExecutionId}" at ${input.consumedAt}; ` +
        "an approval is single-use (A18)",
      { cause: input.consumedByExecutionId }
    );
    this.name = "ApprovalAlreadyConsumedError";
    this.approvalId = input.approvalId;
    this.consumedByExecutionId = input.consumedByExecutionId;
    this.consumedAt = input.consumedAt;
  }
}

/**
 * A17: the action presented for consumption does not hash to the approved
 * digest. ANY element change (an argv element, the target SHA, the baseline,
 * the cwd, the permission increments, the profile revision...) produces a
 * different digest, and the original approval cannot be consumed for it.
 */
export class ApprovalDigestMismatchError extends ApprovalError {
  readonly approvalId: string;
  readonly approvedDigest: string;
  readonly presentedDigest: string;

  constructor(input: {
    readonly approvalId: string;
    readonly approvedDigest: string;
    readonly presentedDigest: string;
  }) {
    super(
      `approval "${input.approvalId}" was granted for digest ${input.approvedDigest}, ` +
        `but consumption presented digest ${input.presentedDigest}; the action changed after ` +
        "approval, so the original approval cannot be consumed (A17)",
      { cause: `${input.approvedDigest} != ${input.presentedDigest}` }
    );
    this.name = "ApprovalDigestMismatchError";
    this.approvalId = input.approvalId;
    this.approvedDigest = input.approvedDigest;
    this.presentedDigest = input.presentedDigest;
  }
}

/**
 * A persisted approval failed strict re-validation on read (descriptor JSON
 * invalid, stored digest disagrees with the recomputed one, risk grade
 * drifted from the recomputed assessment). Fail closed — never answer a
 * query from a record that cannot vouch for itself.
 */
export class ApprovalRecordCorruptError extends ApprovalError {
  readonly approvalId: string;
  readonly detail: string;

  constructor(input: { readonly approvalId: string; readonly detail: string }) {
    super(`approval record "${input.approvalId}" failed validation: ${input.detail}`, {
      cause: input.detail
    });
    this.name = "ApprovalRecordCorruptError";
    this.approvalId = input.approvalId;
    this.detail = input.detail;
  }
}
