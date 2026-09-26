/**
 * Typed error taxonomy for @role-orchestrator/checkpoint (M4-02).
 *
 * Grounding:
 * - docs/CLI_ADAPTERS.md 审批能力不可假定一致: without a reliable
 *   interactiveApproval the node checkpoint applies — the CLI ends / safely
 *   stops, the system waits for the authorization decision, then a NEW
 *   execution continues. A checkpoint is therefore only ever opened against a
 *   TERMINAL attempt (`CheckpointExecutionNotEndedError`); a live process is
 *   never presented as "paused".
 * - docs/ACCEPTANCE.md A19: "使用检查点或拒绝，不伪造暂停能力" — an action
 *   type that RELIES on the CLI's mid-run interactive approval channel while
 *   the gate cell is unverified is refused outright
 *   (`UnverifiedApprovalChannelError`), never laundered into a checkpoint.
 * - docs/ACCEPTANCE.md A17/A18: continuation consumes the approval through
 *   the approval package's guarded CAS; digest mismatch, expiry, and
 *   double-consumption surface as typed errors.
 * - docs/ACCEPTANCE.md A34: continuation reads the FROZEN run snapshot
 *   (`readRunRoleProfile`); a frozen revision that disagrees with the
 *   approval's bound revision is `ContinuationProfileMismatchError`.
 */
export class CheckpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CheckpointError";
  }
}

/**
 * A checkpoint was requested for an attempt that is still in an ACTIVE phase.
 * Opening a checkpoint on a live process would fabricate a mid-run pause
 * (A19): the CLI must have safely ended first. No rows are written.
 */
export class CheckpointExecutionNotEndedError extends CheckpointError {
  readonly executionId: string;
  readonly phase: string;

  constructor(input: { readonly executionId: string; readonly phase: string }) {
    super(
      `execution "${input.executionId}" is still in the active phase "${input.phase}"; ` +
        "an approval checkpoint requires the CLI process to have safely ended first " +
        "(docs/CLI_ADAPTERS.md: 节点检查点 = CLI 结束/安全停止后等待决策)",
      { cause: input.phase }
    );
    this.name = "CheckpointExecutionNotEndedError";
    this.executionId = input.executionId;
    this.phase = input.phase;
  }
}

/**
 * A19 fail-closed refusal: the proposal's action type RELIES on the runtime's
 * mid-run interactive approval channel, and the capability-gate cell for that
 * channel is not `verified` (M0 evidence: for both bundled runtimes the
 * approval-channel cells are unverified — control_request / approval.requested
 * never appeared in real non-interactive runs). Executing that action type is
 * refused outright; no approval and no checkpoint row are created, because
 * either would pretend the unverified channel works.
 */
export class UnverifiedApprovalChannelError extends CheckpointError {
  readonly runtime: string;
  readonly capabilityStatuses: readonly {
    readonly capability: string;
    readonly status: string;
    readonly known: boolean;
  }[];

  constructor(input: {
    readonly runtime: string;
    readonly capabilityStatuses: readonly {
      readonly capability: string;
      readonly status: string;
      readonly known: boolean;
    }[];
  }) {
    const rendered = input.capabilityStatuses
      .map((entry) => `${entry.capability}=${entry.status}${entry.known ? "" : "(unknown)"}`)
      .join(", ");
    super(
      `runtime "${input.runtime}" has no verified interactive approval channel ` +
        `[${rendered}]; the proposal declares it relies on that channel, so the action ` +
        "type is refused (A19: 有通道但未被 M0 验证 → 拒绝执行该动作类型, fail-closed)",
      { cause: rendered }
    );
    this.name = "UnverifiedApprovalChannelError";
    this.runtime = input.runtime;
    this.capabilityStatuses = [...input.capabilityStatuses];
  }
}

/**
 * The runtime pins no node-checkpoint blocked assumption in the gate registry
 * and has no verified interactive channel either: its unattended execution
 * cannot be bounded by any control this package implements. docs/CLI_ADAPTERS.md:
 * 无法拦截或无法证明权限边界时不启动该动作.
 */
export class UnboundedRuntimeError extends CheckpointError {
  readonly runtime: string;

  constructor(input: { readonly runtime: string }) {
    super(
      `runtime "${input.runtime}" has neither a verified interactive approval channel ` +
        "nor a node-checkpoint blocked assumption in the capability gate; the boundary of " +
        "an unattended execution cannot be proven, so the action type is refused",
      { cause: input.runtime }
    );
    this.name = "UnboundedRuntimeError";
    this.runtime = input.runtime;
  }
}

/** The proposal cannot be turned into a strict ActionDescriptor (fail-closed). */
export class ProposalDescriptorInvalidError extends CheckpointError {
  readonly proposalId: string;

  constructor(input: { readonly proposalId: string; readonly cause: unknown }) {
    super(
      `proposal "${input.proposalId}" cannot be turned into a valid action descriptor; ` +
        "the action essentials are incomplete or out of range (fail-closed)",
      { cause: input.cause }
    );
    this.name = "ProposalDescriptorInvalidError";
    this.proposalId = input.proposalId;
  }
}

/** The proposal's checkpoint would land on a node in a state that cannot wait. */
export class CheckpointNodeStateError extends CheckpointError {
  readonly runId: string;
  readonly nodeId: string;
  readonly state: string;

  constructor(input: { readonly runId: string; readonly nodeId: string; readonly state: string }) {
    super(
      `node "${input.nodeId}" of run "${input.runId}" is "${input.state}"; a checkpoint can ` +
        "only wait on a RUNNING node (-> WAITING_APPROVAL) or an already-waiting one",
      { cause: input.state }
    );
    this.name = "CheckpointNodeStateError";
    this.runId = input.runId;
    this.nodeId = input.nodeId;
    this.state = input.state;
  }
}

/** No checkpoint row exists for the requested identity. */
export class UnknownCheckpointError extends CheckpointError {
  readonly checkpointId: string;

  constructor(input: { readonly checkpointId: string }) {
    super(`no approval checkpoint: "${input.checkpointId}"`);
    this.name = "UnknownCheckpointError";
    this.checkpointId = input.checkpointId;
  }
}

/**
 * A persisted checkpoint failed strict re-validation on read (proposal JSON
 * invalid, stored digest disagrees with the recomputed one). Fail closed.
 */
export class CheckpointRecordCorruptError extends CheckpointError {
  readonly checkpointId: string;
  readonly detail: string;

  constructor(input: { readonly checkpointId: string; readonly detail: string }) {
    super(`checkpoint record "${input.checkpointId}" failed validation: ${input.detail}`, {
      cause: input.detail
    });
    this.name = "CheckpointRecordCorruptError";
    this.checkpointId = input.checkpointId;
    this.detail = input.detail;
  }
}

/** The checkpoint is not in the state the operation requires (有限续行: one continuation). */
export class CheckpointStateError extends CheckpointError {
  readonly checkpointId: string;
  readonly expectedState: string;
  readonly actualState: string;

  constructor(input: {
    readonly checkpointId: string;
    readonly expectedState: string;
    readonly actualState: string;
  }) {
    super(
      `checkpoint "${input.checkpointId}" is ${input.actualState}, expected ${input.expectedState}; ` +
        "a checkpoint continues at most once (有限续行)",
      { cause: `${input.actualState} != ${input.expectedState}` }
    );
    this.name = "CheckpointStateError";
    this.checkpointId = input.checkpointId;
    this.expectedState = input.expectedState;
    this.actualState = input.actualState;
  }
}

/** 审批未批准: the approval is still PENDING (or was REJECTED) — nothing to consume. */
export class ContinuationNotApprovedError extends CheckpointError {
  readonly approvalId: string;
  readonly status: string;

  constructor(input: { readonly approvalId: string; readonly status: string }) {
    super(
      `approval "${input.approvalId}" is ${input.status}; continuation requires an APPROVED ` +
        "approval as the authorization credential (审批未批准 → 续行被拒)",
      { cause: input.status }
    );
    this.name = "ContinuationNotApprovedError";
    this.approvalId = input.approvalId;
    this.status = input.status;
  }
}

/** 过期: the APPROVED approval's expiry has passed — never consumable, never continuable. */
export class ContinuationApprovalExpiredError extends CheckpointError {
  readonly approvalId: string;
  readonly expiredAt: string;

  constructor(input: { readonly approvalId: string; readonly expiredAt: string }) {
    super(
      `approval "${input.approvalId}" expired at ${input.expiredAt}; expired approvals are ` +
        "never consumable, so the continuation is refused (过期 → 续行被拒)",
      { cause: input.expiredAt }
    );
    this.name = "ContinuationApprovalExpiredError";
    this.approvalId = input.approvalId;
    this.expiredAt = input.expiredAt;
  }
}

/** 已消费: the approval was already used by (another) execution — single-shot (A18). */
export class ContinuationApprovalAlreadyConsumedError extends CheckpointError {
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
        `"${input.consumedByExecutionId}" at ${input.consumedAt}; an approval authorizes ` +
        "exactly one continuation (已消费 → 续行被拒, A18)",
      { cause: input.consumedByExecutionId }
    );
    this.name = "ContinuationApprovalAlreadyConsumedError";
    this.approvalId = input.approvalId;
    this.consumedByExecutionId = input.consumedByExecutionId;
    this.consumedAt = input.consumedAt;
  }
}

/**
 * A34: the frozen run snapshot revision read for the continuation disagrees
 * with the profile revision bound into the approval's action digest. The
 * continuation would not run under the profile the user approved for.
 */
export class ContinuationProfileMismatchError extends CheckpointError {
  readonly approvalId: string;
  readonly approvalProfileRevision: string;
  readonly frozenProfileRevision: string;

  constructor(input: {
    readonly approvalId: string;
    readonly approvalProfileRevision: string;
    readonly frozenProfileRevision: string;
  }) {
    super(
      `approval "${input.approvalId}" binds profile revision "${input.approvalProfileRevision}", ` +
        `but the run's frozen snapshot reads "${input.frozenProfileRevision}"; a continuation ` +
        "must run under the SAME frozen profile revision (A34: 续行不改 Profile)",
      { cause: `${input.approvalProfileRevision} != ${input.frozenProfileRevision}` }
    );
    this.name = "ContinuationProfileMismatchError";
    this.approvalId = input.approvalId;
    this.approvalProfileRevision = input.approvalProfileRevision;
    this.frozenProfileRevision = input.frozenProfileRevision;
  }
}
