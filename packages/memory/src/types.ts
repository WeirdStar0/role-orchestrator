/**
 * Memory vocabulary (M3-02) — types, statuses, lifecycle transitions, actor
 * identities and the per-type write-permission matrix of
 * `docs/MEMORY_AND_CONTEXT.md` section 2 ("记忆类型与权限").
 *
 * Everything here is DECISION-FREE data: the matrix below is a frozen
 * constant transcribed from the doc's 可提交者 column, not something content
 * or context can influence (A16). The API canonical types are the singular
 * forms (temporary/fact/discovery/decision/project_rule); the doc's table
 * headers use the plural set names (facts/discoveries/...) for the same sets.
 */
import { z } from "zod";
import type { RoleId } from "@role-orchestrator/contracts";
import { IdSchema, ROLE_IDS, RoleIdSchema } from "@role-orchestrator/contracts";
import { TimestampSchema } from "@role-orchestrator/store";

/** API canonical memory types (docs/MEMORY_AND_CONTEXT.md section 2). */
export const MEMORY_TYPES = ["temporary", "fact", "discovery", "decision", "project_rule"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);

/**
 * Memory statuses (docs/MEMORY_AND_CONTEXT.md section 3):
 * proposed / verified / disputed / superseded / expired, plus `active` —
 * the state ONLY a project_rule reaches, and only through the user promotion
 * entry point (`promoteProjectRule`).
 *
 * `superseded` is doc vocabulary kept for the M3-03 replacement flow; at this
 * milestone the superseded RELATION of an in-place update is carried by
 * `supersedes_version` + the append-only `memory_revisions` history, which is
 * why no M3-02 transition produces the status yet (documented, not faked).
 */
export const MEMORY_STATUSES = [
  "proposed",
  "verified",
  "active",
  "disputed",
  "superseded",
  "expired"
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export const MemoryStatusSchema = z.enum(MEMORY_STATUSES);

/** Statuses that participate in the content-dedupe partial unique index. */
export const LIVE_MEMORY_STATUSES: readonly MemoryStatus[] = ["proposed", "verified", "active"];

/** Revision-history transition kinds (one per lifecycle move). */
export const MEMORY_TRANSITIONS = [
  "propose",
  "verify",
  "promote",
  "dispute",
  "update",
  "expire"
] as const;
export type MemoryTransition = (typeof MEMORY_TRANSITIONS)[number];
export const MemoryTransitionSchema = z.enum(MEMORY_TRANSITIONS);

/** Audit event kinds persisted in `memory_events`. */
export const MEMORY_EVENT_TYPES = [
  "proposed",
  "verified",
  "promoted",
  "disputed",
  "updated",
  "expired",
  "promotion-rejected",
  "cas-conflict"
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];
export const MemoryEventTypeSchema = z.enum(MEMORY_EVENT_TYPES);

/** Types whose proposals must cite at least one evidence ref (contracts `MemoryProposalSchema`). */
export const EVIDENCE_REQUIRED_TYPES: readonly MemoryType[] = ["fact", "decision", "project_rule"];

export function requiresEvidence(type: MemoryType): boolean {
  return EVIDENCE_REQUIRED_TYPES.includes(type);
}

/**
 * The 可提交者 column of docs/MEMORY_AND_CONTEXT.md section 2, transcribed:
 * - temporary / fact / discovery: all four roles;
 * - decision: Architect (Coordinator may raise process decisions);
 * - project_rule: Coordinator may propose — only the USER may promote.
 * Updates are writes too: the same matrix governs `updateMemory` role actors.
 */
export const PROPOSABLE_ROLES: Readonly<Record<MemoryType, readonly RoleId[]>> = Object.freeze({
  temporary: [...ROLE_IDS],
  fact: [...ROLE_IDS],
  discovery: [...ROLE_IDS],
  decision: ["architect", "coordinator"],
  project_rule: ["coordinator"]
});

export function canPropose(type: MemoryType, roleId: RoleId): boolean {
  return PROPOSABLE_ROLES[type].includes(roleId);
}

/**
 * Who may verify a proposed memory. docs section 4 routes proposals through
 * deterministic checks "必要时由既有 Coordinator 处理"; combined with the
 * reviewer discipline (AGENTS.md: 不自审自批) verification duty lands on
 * reviewer/architect/coordinator — never the proposing role itself, never
 * developer (whose channel is proposing/implementation), never the user actor
 * (whose authority is promotion, not verification).
 */
export const VERIFIER_ROLES: readonly RoleId[] = ["reviewer", "architect", "coordinator"];

/**
 * Actor identity crossing the memory API boundary.
 * - `role` actors are the four built-in roles acting inside an execution
 *   (roleId required; executionId records authorExecutionId when known);
 * - `user` actors are the human operator (displayName required — the audit
 *   identity the promotion entry point records). There is deliberately no way
 *   for content, context or memory state to mint a user actor.
 */
export const MemoryActorSchema = z
  .strictObject({
    kind: z.enum(["user", "role"]),
    roleId: RoleIdSchema.optional(),
    displayName: z.string().trim().min(1).max(128).optional(),
    executionId: IdSchema.optional()
  })
  .check((ctx) => {
    if (ctx.value.kind === "role" && ctx.value.roleId === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "role actors must carry roleId",
        input: ctx.value,
        path: ["roleId"]
      });
    }
    if (ctx.value.kind === "user" && ctx.value.displayName === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "user actors must carry displayName (audit identity)",
        input: ctx.value,
        path: ["displayName"]
      });
    }
  });

export type MemoryActor = z.output<typeof MemoryActorSchema>;

/** Stable audit label stored in proposed_by / verified_by / promoted_by / actor columns. */
export function actorLabel(actor: MemoryActor): string {
  return actor.kind === "user" ? `user:${actor.displayName}` : `role:${actor.roleId}`;
}

export const MemoryContentSchema = z.string().min(1).max(10000);
export const MemoryEvidenceRefsSchema = z.array(IdSchema).max(32);
export const DisputeReasonSchema = z.string().trim().min(1).max(512);
export const ExpectedVersionSchema = z.number().int().min(1);

export { IdSchema, RoleIdSchema, TimestampSchema };

/**
 * The explicit promotion entry point recorded in `promoted_via`. Promotion of
 * a project_rule to active is accepted ONLY from this entry, ONLY for a
 * `user` actor — the caller identity plus this audit marker is the whole
 * authorization story; nothing in memory content participates (A16).
 */
export const PROJECT_RULE_PROMOTION_ENTRY = "memory.promoteProjectRule";

/** A memory entry as read back from the store (current state, hash-verified). */
export interface MemoryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly scope: "project";
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly version: number;
  readonly content: string;
  readonly contentHash: string;
  readonly evidenceRefs: readonly string[];
  readonly authorExecutionId: string | null;
  readonly proposedBy: string;
  readonly proposedByRole: RoleId;
  readonly expiresAt: string | null;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
  readonly disputedBy: string | null;
  readonly disputedAt: string | null;
  readonly promotedBy: string | null;
  readonly promotedVia: string | null;
  readonly promotedAt: string | null;
  readonly supersedesVersion: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One entry of the append-only revision history. */
export interface MemoryRevisionRecord {
  readonly memoryId: string;
  readonly version: number;
  readonly status: MemoryStatus;
  readonly content: string;
  readonly contentHash: string;
  readonly transition: MemoryTransition;
  readonly actor: string;
  readonly occurredAt: string;
}

/** One audit event (including refusal audits: promotion-rejected, cas-conflict). */
export interface MemoryEventRecord {
  readonly id: string;
  readonly memoryId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly type: MemoryEventType;
  readonly actor: string;
  readonly payload: Record<string, string | number>;
  readonly occurredAt: string;
}
