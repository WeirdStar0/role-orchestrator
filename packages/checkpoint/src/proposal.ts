/**
 * The structured action proposal protocol (M4-02, A19).
 *
 * docs/CLI_ADAPTERS.md 审批能力不可假定一致: "Agent 输出结构化 action
 * proposal -> CLI 结束/安全停止 -> 系统等待用户/授权决策 -> 创建有限授权的
 * 新 Execution." This module owns the FIRST step: proposals arrive inside
 * protocol events (from the persisted event stream or a result payload) and
 * must be extracted STRICTLY — an unparseable proposal is never silently
 * turned into an approvable action.
 *
 * Two carriers exist in the normalized vocabulary:
 * - `approval_requested` events (claude `control_request can_use_tool`,
 *   codex `approval.requested`): the proposal lives in the event payload's
 *   `toolInput.actionProposal`. M0 evidence pins that in REAL non-interactive
 *   runs these events never appear at all — a live one is treated as a
 *   checkpoint proposal, never answered in-band (no verified channel).
 * - `result_reported` events: the business payload may carry a top-level
 *   `actionProposal` (the agent finished its turn and proposes the action for
 *   a follow-up execution).
 *
 * Fail-closed properties pinned here:
 * - the proposal schema is STRICT (unknown fields rejected) so an
 *   undeclared effect cannot ride along inside the payload;
 * - `extractActionProposals` NEVER throws: anything malformed is reported in
 *   `unparsable` with the reason and simply cannot become an approval;
 * - the proposed action's argv is the COMPLETE vector including argv[0],
 *   which later feeds the A17 actionDigest verbatim.
 */
import { z } from "zod";
import type { JsonValue } from "@role-orchestrator/contracts";
import { PermissionIdSchema, RuntimeSchema, withUniqueItems } from "@role-orchestrator/contracts";
import { CommitShaSchema } from "@role-orchestrator/integration";
import { RiskDimensionSchema, WriteScopeSchema, type RiskDimension, type WriteScope } from "@role-orchestrator/approval";

/** Bumped only when the proposal wire shape changes deliberately. */
export const PROPOSAL_SCHEMA_VERSION = 1;

/**
 * The action essentials a proposal carries. Together with the run context
 * (runtime, cwd, repo root/baseSha, frozen profile revision, granted
 * permissions) these determine the complete ActionDescriptor and therefore
 * the A17 actionDigest.
 */
export const ProposedActionSchema = z
  .strictObject({
    /** FULL child command vector INCLUDING argv[0]; order is semantic. */
    argv: withUniqueItems(z.array(z.string().min(1).max(4096)).min(1).max(128)),
    /** Declared effect dimensions (closed enum — fail-closed grading). */
    dimensions: withUniqueItems(z.array(RiskDimensionSchema).min(1).max(6)),
    /** Required exactly when the write dimension is declared. */
    writeScope: WriteScopeSchema.nullable(),
    /** Permissions the action needs (contracts closed vocabulary). */
    requiredPermissions: withUniqueItems(z.array(PermissionIdSchema).max(16)),
    /** capability-gate capability ids the action relies on. */
    requiredCapabilities: withUniqueItems(
      z.array(z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/)).max(32)
    ),
    /** The candidate SHA the action produces/consumes; null when none. */
    targetSha: CommitShaSchema.nullable(),
    /**
     * True when the action type RELIES on the CLI's mid-run interactive
     * approval channel (i.e. it expects the CLI to pause until the system
     * answers in-band). Under A19 such a proposal is refused unless the
     * gate cell for that channel is `verified` — which is true for NO
     * bundled runtime in v1.
     */
    requiresInteractiveApproval: z.boolean()
  })
  .check((ctx) => {
    const value = ctx.value;
    if (value.dimensions.includes("write") && value.writeScope === null) {
      ctx.issues.push({
        code: "custom",
        message: "writeScope is required when the write dimension is declared",
        input: value,
        path: ["writeScope"]
      });
    }
    if (!value.dimensions.includes("write") && value.writeScope !== null) {
      ctx.issues.push({
        code: "custom",
        message: "writeScope must be null unless the write dimension is declared",
        input: value,
        path: ["writeScope"]
      });
    }
  });

/** The contracts permission/runtime vocabularies as static types (derived, like approval's). */
export type PermissionId = z.output<typeof PermissionIdSchema>;
export type Runtime = z.output<typeof RuntimeSchema>;

export interface ProposedAction {
  readonly argv: readonly string[];
  readonly dimensions: readonly RiskDimension[];
  readonly writeScope: WriteScope | null;
  readonly requiredPermissions: readonly PermissionId[];
  readonly requiredCapabilities: readonly string[];
  readonly targetSha: string | null;
  readonly requiresInteractiveApproval: boolean;
}

export const ActionProposalSchema = z.strictObject({
  schemaVersion: z.literal(PROPOSAL_SCHEMA_VERSION),
  proposalId: z.string().min(1).max(128),
  action: ProposedActionSchema,
  /** Where the proposal was seen; traceability only, never digest-bearing. */
  source: z.strictObject({
    eventType: z.string().min(1).max(64),
    sourceType: z.string().max(128).nullable(),
    eventSeq: z.number().int().min(0).nullable(),
    requestId: z.string().min(1).max(256).nullable()
  })
});

export interface ActionProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly action: ProposedAction;
  readonly source: {
    readonly eventType: string;
    readonly sourceType: string | null;
    readonly eventSeq: number | null;
    readonly requestId: string | null;
  };
}

/**
 * The minimal event view extraction operates on. Both a contracts
 * `NormalizedEvent` and a stored `events` row (payload JSON.parse-ed) satisfy
 * it, so extraction works identically on live pipelines and persisted replay.
 */
export interface ProtocolEventView {
  readonly type: string;
  readonly sourceType?: string | null | undefined;
  readonly seq?: number | null | undefined;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface UnparsableProposal {
  readonly eventId: string;
  readonly eventType: string;
  readonly sourceType: string | null;
  readonly reason: string;
}

export interface ExtractionResult {
  readonly proposals: readonly { readonly eventId: string; readonly proposal: ActionProposal }[];
  readonly unparsable: readonly UnparsableProposal[];
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

/**
 * Parse one candidate payload field into a strict ActionProposal.
 * Returns null when the field is absent; returns { error } when present but
 * invalid (the caller records an unparsable entry instead of guessing).
 */
function parseProposalField(
  raw: JsonValue | undefined,
  fallback: {
    eventType: string;
    sourceType: string | null;
    eventSeq: number | null;
    requestId: string | null;
  }
): { proposal: ActionProposal } | { error: string } | null {
  if (raw === undefined) return null;
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return { error: "proposal field is not a JSON object" };
  }
  const withSource = { ...candidate, source: fallback };
  const result = ActionProposalSchema.safeParse(withSource);
  return result.success
    ? { proposal: result.data as ActionProposal }
    : { error: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}

/**
 * Scan protocol events for structured action proposals. Never throws.
 * `approval_requested` events MUST carry a structured proposal to be
 * actionable (an unparseable one is reported, never approximated); result
 * payloads without an `actionProposal` field are ordinary results and are
 * ignored silently.
 */
export function extractActionProposals(events: readonly ProtocolEventView[]): ExtractionResult {
  const proposals: { eventId: string; proposal: ActionProposal }[] = [];
  const unparsable: UnparsableProposal[] = [];
  for (const event of events) {
    const sourceType = event.sourceType ?? null;
    const seq = event.seq ?? null;
    if (event.type === "approval_requested") {
      const requestId =
        typeof event.payload["requestId"] === "string" ? event.payload["requestId"] : null;
      const toolInput = asRecord(event.payload["toolInput"]);
      const parsed = parseProposalField(toolInput?.["actionProposal"], {
        eventType: event.type,
        sourceType,
        eventSeq: seq,
        requestId
      });
      if (parsed === null) {
        unparsable.push({
          eventId: eventIdentifier(event),
          eventType: event.type,
          sourceType,
          reason:
            "approval_requested without a structured actionProposal; the action cannot be " +
            "digested, so it can never be approved or executed (fail-closed)"
        });
      } else if ("error" in parsed) {
        unparsable.push({
          eventId: eventIdentifier(event),
          eventType: event.type,
          sourceType,
          reason: parsed.error
        });
      } else {
        proposals.push({ eventId: eventIdentifier(event), proposal: parsed.proposal });
      }
      continue;
    }
    if (event.type === "result_reported") {
      const businessResult = asRecord(event.payload["businessResult"]);
      if (businessResult === undefined) continue;
      const parsed = parseProposalField(businessResult["actionProposal"], {
        eventType: event.type,
        sourceType,
        eventSeq: seq,
        requestId: null
      });
      if (parsed === null) continue;
      if ("error" in parsed) {
        unparsable.push({
          eventId: eventIdentifier(event),
          eventType: event.type,
          sourceType,
          reason: parsed.error
        });
      } else {
        proposals.push({ eventId: eventIdentifier(event), proposal: parsed.proposal });
      }
    }
  }
  return { proposals, unparsable };
}

/**
 * Stable identity for an event view. Stored rows key by their id; in-memory
 * normalized events key by seq + type.
 */
function eventIdentifier(event: ProtocolEventView): string {
  const id = (event.payload as Record<string, JsonValue>)["eventId"];
  if (typeof id === "string" && id.length > 0) return id;
  return `seq-${String(event.seq ?? "unknown")}:${event.type}`;
}

/** Narrow a raw runtime value; used by callers that read runtimes from rows. */
export function parseRuntime(value: string): Runtime {
  return RuntimeSchema.parse(value);
}
