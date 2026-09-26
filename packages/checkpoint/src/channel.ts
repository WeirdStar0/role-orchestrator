/**
 * The A19 channel decision (M4-02) — which path a structured action
 * proposal must take, decided from capability-gate DATA only.
 *
 * Grounding (docs/CLI_ADAPTERS.md 审批能力不可假定一致):
 * - 优先采用各 CLI 经过验证的原生结构化审批/控制通道 — a runtime may use its
 *   native interactive approval machinery ONLY where the gate cell for that
 *   channel is `verified`. The relevant matrix cells are pinned per runtime
 *   in `INTERACTIVE_APPROVAL_CAPABILITY_IDS`:
 *     claude -> `claude.permission-approval-behavior` (unverified: control_request
 *               审批事件在全部真实调用中从未出现)
 *     codex  -> `codex.approval-sandbox-rejection-path` (unverified: 真实形态未观察)
 *   The mapping names the CELLS; the decision reads their statuses live via
 *   `statusOf`, so a future M0 verification flips the decision without a code
 *   change. Unknown ids report unverified (denied by default).
 * - 没有可靠 interactiveApproval 时采用"节点检查点" — a runtime whose
 *   unattended execution carries a node-checkpoint blocked assumption
 *   (`checkpointAssumptionIdsFor`, e.g. codex.default-mode-unattended-write,
 *   claude.mid-run-approval-in-noninteractive) takes the checkpoint path: the
 *   current execution safely ends, the proposal becomes an approval request,
 *   the system waits, then a NEW execution continues. A mid-run pause is never
 *   faked.
 * - 有通道但未被 M0 验证 → 拒绝执行该动作类型 (fail-closed): a proposal whose
 *   action RELIES on the interactive channel (`requiresInteractiveApproval`)
 *   is refused outright while that channel is unverified — no approval, no
 *   checkpoint, no continuation. Laundering it into a checkpoint would pretend
 *   the channel semantics work.
 * - A runtime with NEITHER a verified channel NOR a checkpoint assumption
 *   cannot prove its execution boundary (无法拦截或无法证明权限边界时不启动
 *   该动作) and is refused too.
 */
import { statusOf, type CapabilityStatus } from "@role-orchestrator/capability-gate";
import { checkpointAssumptionIdsFor } from "@role-orchestrator/approval";
import type { ActionProposal, Runtime } from "./proposal.js";

/**
 * The capability-matrix cell ids that describe each runtime's native
 * interactive approval channel. Data, not policy: the DISPOSITION follows the
 * gate status of these cells at decision time.
 */
export const INTERACTIVE_APPROVAL_CAPABILITY_IDS: Readonly<Record<Runtime, readonly string[]>> = {
  claude: ["claude.permission-approval-behavior"],
  codex: ["codex.approval-sandbox-rejection-path"]
};

export interface ChannelCapabilityStatus {
  readonly capability: string;
  readonly status: CapabilityStatus;
  readonly known: boolean;
}

export interface InteractiveApprovalChannel {
  readonly runtime: Runtime;
  readonly capabilityIds: readonly string[];
  /** True only when at least one channel cell is `verified` (能力未知绝不标记支持). */
  readonly verified: boolean;
  readonly statuses: readonly ChannelCapabilityStatus[];
}

export function interactiveApprovalChannel(runtime: Runtime): InteractiveApprovalChannel {
  const ids = INTERACTIVE_APPROVAL_CAPABILITY_IDS[runtime] ?? [];
  const statuses = ids.map((capability) => {
    const lookup = statusOf(capability);
    return { capability, status: lookup.status, known: lookup.known };
  });
  return {
    runtime,
    capabilityIds: ids,
    verified: statuses.some((entry) => entry.status === "verified"),
    statuses
  };
}

export const PROPOSAL_DISPOSITIONS = [
  "checkpoint",
  "reject-unverified-channel",
  "reject-unbounded-runtime"
] as const;
export type ProposalDisposition = (typeof PROPOSAL_DISPOSITIONS)[number];

export interface ProposalDispositionDecision {
  readonly disposition: ProposalDisposition;
  readonly runtime: Runtime;
  readonly reason: string;
  /** Gate node-checkpoint assumption ids pinning the checkpoint path (A19). */
  readonly checkpointAssumptionIds: readonly string[];
  readonly channel: InteractiveApprovalChannel;
}

/**
 * Decide how one proposal must be handled. Pure and total over its input;
 * the caller turns the refusal dispositions into typed errors and performs
 * NO writes for them.
 */
export function decideProposalDisposition(input: {
  readonly runtime: Runtime;
  readonly proposal: ActionProposal;
}): ProposalDispositionDecision {
  const channel = interactiveApprovalChannel(input.runtime);
  const assumptions = checkpointAssumptionIdsFor(input.runtime);
  if (input.proposal.action.requiresInteractiveApproval) {
    if (!channel.verified) {
      return {
        disposition: "reject-unverified-channel",
        runtime: input.runtime,
        reason:
          "the action type relies on the runtime's mid-run interactive approval channel, " +
          "but no channel cell is verified in the capability matrix (A19: 拒绝执行该动作类型)",
        checkpointAssumptionIds: assumptions,
        channel
      };
    }
    // A verified native channel exists; in this release the mediation is still
    // the bounded checkpoint (end -> approval -> new execution), which is safe
    // under either channel and never answers a control request in-band.
    return {
      disposition: "checkpoint",
      runtime: input.runtime,
      reason:
        "the runtime's interactive approval channel is verified, but this release mediates " +
        "proposals exclusively through the bounded node checkpoint; the action never runs " +
        "in the proposing execution",
      checkpointAssumptionIds: assumptions,
      channel
    };
  }
  if (assumptions.length > 0) {
    return {
      disposition: "checkpoint",
      runtime: input.runtime,
      reason:
        `no reliable interactive approval channel; the gate pins the node-checkpoint ` +
        `control (${assumptions.join(", ")}) — the proposal is mediated by end -> approval -> new execution`,
      checkpointAssumptionIds: assumptions,
      channel
    };
  }
  return {
    disposition: "reject-unbounded-runtime",
    runtime: input.runtime,
    reason:
      "the runtime has neither a verified interactive approval channel nor a node-checkpoint " +
      "blocked assumption; the unattended execution boundary cannot be proven",
    checkpointAssumptionIds: assumptions,
    channel
  };
}
