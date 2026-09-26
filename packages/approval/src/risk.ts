/**
 * Action descriptor + risk grading (M4-01).
 *
 * Grading rules are pinned HERE as a strict schema + a total function, and
 * their semantics come from exactly two sources:
 *
 * - docs/SECURITY_MODEL.md 风险分级 (lines 23-27): grading is a BUSINESS
 *   decision mechanism, NOT a shell-command-name whitelist. 低风险:
 *   authorized read-only analysis and controlled local modification.
 *   中风险: technical choices with alternatives, decided and recorded by the
 *   Coordinator. 高风险: permission elevation, broad network access, external
 *   side effects, main-branch delivery, irreversible deletion — user approval
 *   required. A medium decision that carries a new permission MUST go through
 *   user authorization; a Coordinator can never self-approve an elevation.
 * - the capability-gate registry (packages/capability-gate): blocked argv
 *   patterns and blocked assumptions. A forbidden pattern (the
 *   `--dangerously-*` permission-skip family) has no v1 authorization path.
 *   An explicit-authorization pattern (codex environment-gate bypass) grades
 *   high and is recorded for the one approval that authorizes it. Unverified
 *   or unknown capability ids grade high — Unknown 能力不视作允许.
 *
 * The grader is fail-closed by construction: the dimension vocabulary is a
 * closed enum, so an undeclared effect cannot be expressed; every dangerous
 * dimension forces grade "high"; unknown/unverified capabilities force high.
 * R19 (风险分级介入: 低风险 Agent，中风险 Coordinator，高风险用户) maps
 * requiresApproval to exactly grade === "high".
 *
 * A19 note: unattended writes are inherent to this product (both bundled CLIs
 * run non-interactive). The gate registry pins `node-checkpoint` as the
 * required control for BOTH runtimes' unattended-write claims — the
 * assessment surfaces `requiresCheckpoint` + the assumption ids instead of
 * pretending a mid-run approval pause exists. No state or field in this
 * package models "pause the CLI mid-run".
 */
import { z } from "zod";
import { PermissionIdSchema, RuntimeSchema } from "@role-orchestrator/contracts";
import {
  BLOCKED_ASSUMPTIONS,
  blockedPatternFor,
  isUsable,
  statusOf
} from "@role-orchestrator/capability-gate";
import { CommitShaSchema } from "@role-orchestrator/integration";

/** The contracts runtime/permission vocabularies as static types (derived). */
export type Runtime = z.output<typeof RuntimeSchema>;
export type PermissionId = z.output<typeof PermissionIdSchema>;

/** Effect dimensions of an action (closed vocabulary — fail-closed grading). */
export const RISK_DIMENSIONS = [
  "readonly",
  "write",
  "network",
  "delete",
  "external-side-effect",
  "main-branch-delivery"
] as const;
export type RiskDimension = (typeof RISK_DIMENSIONS)[number];
export const RiskDimensionSchema = z.enum(RISK_DIMENSIONS);

/**
 * Where a `write` dimension may land. The first two are the controlled local
 * modifications of docs/SECURITY_MODEL.md 低风险 (validation temp dirs per
 * D10, the managed execution worktree); `task-branch` is the tool-hosted task
 * branch (an integration-style technical choice — Coordinator records it,
 * R19 中风险); `unscoped` is everything else and grades HIGH as an external
 * side effect.
 */
export const WRITE_SCOPES = ["validation-temp", "managed-worktree", "task-branch", "unscoped"] as const;
export type WriteScope = (typeof WRITE_SCOPES)[number];
export const WriteScopeSchema = z.enum(WRITE_SCOPES);

/** Risk grades (R19: 低风险 Agent，中风险 Coordinator，高风险用户). */
export const RISK_GRADES = ["low", "medium", "high"] as const;
export type RiskGrade = (typeof RISK_GRADES)[number];
export const RiskGradeSchema = z.enum(RISK_GRADES);

/** Stable reason codes; graders and UI may rely on this vocabulary. */
export const RISK_REASON_CODES = [
  "argv-forbidden-pattern",
  "argv-explicit-authorization",
  "permission-elevation",
  "network",
  "delete",
  "external-side-effect",
  "main-branch-delivery",
  "capability-not-verified",
  "write-unscoped",
  "coordinator-decision",
  "controlled-local-modification",
  "readonly-analysis"
] as const;
export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];
export const RiskReasonCodeSchema = z.enum(RISK_REASON_CODES);

export const RiskReasonSchema = z.strictObject({
  code: RiskReasonCodeSchema,
  detail: z.string().min(1).max(512)
});
export interface RiskReason {
  readonly code: RiskReasonCode;
  readonly detail: string;
}

/** Attaches a uniqueness check, mirroring contracts' withUniqueItems. */
function uniqueItems<T extends z.ZodType>(schema: z.ZodArray<T>): z.ZodArray<T> {
  return schema.check((ctx) => {
    if (new Set(ctx.value).size !== ctx.value.length) {
      ctx.issues.push({
        code: "custom",
        message: "array items must be unique",
        input: ctx.value
      });
    }
  });
}

/**
 * The COMPLETE, exact description of the action an approval would authorize.
 * Every field here feeds the actionDigest, so any element change (an argv
 * element, the target SHA, the baseline, the cwd, a permission, the frozen
 * profile revision...) produces a different digest (A17).
 */
export const ActionDescriptorSchema = z
  .strictObject({
    /** The bundled CLI runtime (contracts R02 vocabulary). */
    runtime: RuntimeSchema,
    /**
     * The FULL child process argument vector INCLUDING argv[0]
     * (the executable). Order is semantic: the digest hashes the array
     * as-is, so a permutation is a different action.
     */
    argv: z.array(z.string().min(1).max(4096)).min(1).max(128),
    /** Working directory the action runs in. Presented verbatim (no
     * normalization — normalization is the execution layer's job and must be
     * stable before grading, not inside the digest). */
    cwd: z.string().min(1).max(2048),
    /** Target repository: canonical root + baseline + target SHA. */
    repo: z.strictObject({
      root: z.string().min(1).max(2048),
      baseSha: CommitShaSchema,
      /** The candidate SHA the action produces/consumes; null when the
       * action genuinely has no target commit (e.g. pure analysis). */
      targetSha: CommitShaSchema.nullable()
    }),
    /** The frozen ProfileSnapshot revision the action runs under. */
    profileRevision: z.string().min(1).max(128),
    /** Permissions the action needs (contracts closed vocabulary). */
    requiredPermissions: uniqueItems(z.array(PermissionIdSchema).max(16)),
    /** Permissions the acting role currently holds. */
    grantedPermissions: uniqueItems(z.array(PermissionIdSchema).max(16)),
    /** Declared effect dimensions (closed enum — unknown effects cannot be
     * expressed, which is the fail-closed default). */
    dimensions: uniqueItems(z.array(RiskDimensionSchema).min(1).max(RISK_DIMENSIONS.length)),
    /** Required exactly when the `write` dimension is declared. */
    writeScope: WriteScopeSchema.nullable(),
    /** capability-gate capability ids this action relies on; any id whose
     * matrix cell is not `verified` (including unknown ids) grades high. */
    requiredCapabilities: uniqueItems(z.array(z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/)).max(32))
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

export interface ActionDescriptor {
  readonly runtime: Runtime;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly repo: {
    readonly root: string;
    readonly baseSha: string;
    readonly targetSha: string | null;
  };
  readonly profileRevision: string;
  readonly requiredPermissions: readonly PermissionId[];
  readonly grantedPermissions: readonly PermissionId[];
  readonly dimensions: readonly RiskDimension[];
  readonly writeScope: WriteScope | null;
  readonly requiredCapabilities: readonly string[];
}

/**
 * The permission increments the action needs BEYOND the acting role's current
 * grant — the 权限增量 of docs/SECURITY_MODEL.md 人工审批. Derived (not
 * declared) so it cannot drift from the two permission lists; returned as a
 * sorted unique set (set identity: order is not a permission property).
 */
export function permissionIncrementsOf(action: ActionDescriptor): readonly PermissionId[] {
  const granted = new Set<string>(action.grantedPermissions);
  return [...new Set(action.requiredPermissions)]
    .filter((permission) => !granted.has(permission))
    .sort();
}

/**
 * Blocked argv patterns whose matched element carries the given control.
 * Matching is PER ELEMENT (patterns name single flags; joining elements with
 * spaces could manufacture matches across argument boundaries).
 */
export function matchedBlockedArgvPatterns(action: ActionDescriptor): readonly {
  readonly id: string;
  readonly requiredControl: string;
}[] {
  const seen = new Map<string, { readonly id: string; readonly requiredControl: string }>();
  for (const element of action.argv) {
    const pattern = blockedPatternFor(element);
    if (pattern !== null) {
      seen.set(pattern.id, { id: pattern.id, requiredControl: pattern.requiredControl });
    }
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The gate blocked assumptions that require a NODE CHECKPOINT for this
 * runtime's unattended execution (A19). Both bundled runtimes have exactly
 * such an assumption (codex.default-mode-unattended-write,
 * claude.mid-run-approval-in-noninteractive); ids are read from the gate
 * registry data, never hardcoded here.
 */
export function checkpointAssumptionIdsFor(runtime: Runtime): readonly string[] {
  return BLOCKED_ASSUMPTIONS
    .filter(
      (assumption) =>
        assumption.requiredControl === "node-checkpoint" && assumption.id.startsWith(`${runtime}.`)
    )
    .map((assumption) => assumption.id)
    .sort();
}

/** The graded outcome for one action. Pure: same input, same assessment. */
export interface RiskAssessment {
  readonly grade: RiskGrade;
  /** R19 mapping: exactly grade === "high" (高风险用户批准). */
  readonly requiresApproval: boolean;
  /** Unattended write + the runtime's gate node-checkpoint assumption. */
  readonly requiresCheckpoint: boolean;
  readonly checkpointAssumptionIds: readonly string[];
  readonly reasons: readonly RiskReason[];
  /** Matched blocked argv patterns (forbidden ones make creation refuse). */
  readonly blockedPatterns: readonly {
    readonly id: string;
    readonly requiredControl: string;
  }[];
  /** Derived permission increments (the 权限增量 the approval would grant). */
  readonly permissionIncrements: readonly PermissionId[];
}

const HIGH_REASON_CODES: readonly RiskReasonCode[] = [
  "argv-forbidden-pattern",
  "argv-explicit-authorization",
  "permission-elevation",
  "network",
  "delete",
  "external-side-effect",
  "main-branch-delivery",
  "capability-not-verified",
  "write-unscoped"
];
const MEDIUM_REASON_CODES: readonly RiskReasonCode[] = ["coordinator-decision"];

/**
 * Grade one action. Total and pure; throws only on a schema-invalid
 * descriptor (which callers should never hold — validate at the boundary).
 */
export function gradeRisk(action: ActionDescriptor): RiskAssessment {
  const parsed = ActionDescriptorSchema.parse(action);
  const reasons: RiskReason[] = [];
  const increments = permissionIncrementsOf(parsed);
  const blockedPatterns = matchedBlockedArgvPatterns(parsed);
  const checkpointIds = checkpointAssumptionIdsFor(parsed.runtime);
  const requiresCheckpoint = parsed.dimensions.includes("write") && checkpointIds.length > 0;

  for (const pattern of blockedPatterns) {
    if (pattern.requiredControl === "forbidden") {
      reasons.push({
        code: "argv-forbidden-pattern",
        detail: `argv element matches blocked pattern ${pattern.id} (requiredControl: forbidden — no v1 authorization path)`
      });
    } else {
      reasons.push({
        code: "argv-explicit-authorization",
        detail: `argv element matches blocked pattern ${pattern.id} (requiredControl: ${pattern.requiredControl} — one explicit, recorded user authorization per action)`
      });
    }
  }
  if (increments.length > 0) {
    reasons.push({
      code: "permission-elevation",
      detail: `action needs permissions beyond the acting role's grant: ${increments.join(", ")} (docs/SECURITY_MODEL.md: 权限提升由用户批准)`
    });
  }
  if (parsed.dimensions.includes("network")) {
    reasons.push({ code: "network", detail: "network access is broad-network risk until scoped otherwise (高风险: 广泛网络访问)" });
  }
  if (parsed.dimensions.includes("delete")) {
    reasons.push({ code: "delete", detail: "deletion graded as irreversible deletion (高风险: 不可逆删除) — fail-closed, reversibility is never assumed" });
  }
  if (parsed.dimensions.includes("external-side-effect")) {
    reasons.push({ code: "external-side-effect", detail: "external side effect outside the managed workspaces (高风险: 外部副作用)" });
  }
  if (parsed.dimensions.includes("main-branch-delivery")) {
    reasons.push({ code: "main-branch-delivery", detail: "delivery to the main branch requires explicit user confirmation (D05, 高风险: 主分支交付)" });
  }
  for (const capability of parsed.requiredCapabilities) {
    const lookup = statusOf(capability);
    if (!isUsable(lookup.status)) {
      reasons.push({
        code: "capability-not-verified",
        detail: `capability "${capability}" is ${lookup.status}${lookup.known ? "" : " (unknown id)"} — Unknown 能力不视作允许`
      });
    }
  }
  const readonlyOnly = parsed.dimensions.every((dimension) => dimension === "readonly");
  if (parsed.dimensions.includes("write")) {
    if (parsed.writeScope === "unscoped") {
      reasons.push({ code: "write-unscoped", detail: "write scope is unscoped — treated as an external side effect" });
    } else if (parsed.writeScope === "task-branch") {
      reasons.push({ code: "coordinator-decision", detail: "commit on the tool-hosted task branch is a technical choice with alternatives; the Coordinator records it (R19 中风险)" });
    } else {
      reasons.push({
        code: "controlled-local-modification",
        detail: `controlled local modification (writeScope: ${parsed.writeScope ?? "n/a"}) within the authorized scope (低风险: 受控局部修改)`
      });
    }
  } else if (readonlyOnly) {
    reasons.push({ code: "readonly-analysis", detail: "read-only analysis within the authorized scope (低风险: 只读分析)" });
  }

  const grade: RiskGrade = reasons.some((reason) => HIGH_REASON_CODES.includes(reason.code))
    ? "high"
    : reasons.some((reason) => MEDIUM_REASON_CODES.includes(reason.code))
      ? "medium"
      : "low";

  return {
    grade,
    requiresApproval: grade === "high",
    requiresCheckpoint,
    checkpointAssumptionIds: checkpointIds,
    reasons,
    blockedPatterns,
    permissionIncrements: increments
  };
}
