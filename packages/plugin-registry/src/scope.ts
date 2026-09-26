/**
 * Plugin permission scope vocabulary (M7-02) — CLOSED, declarative, mapped to
 * EXISTING control-plane checks.
 *
 * Three properties hold by construction and are pinned by tests:
 *
 * 1. CLOSED ENUM. The v1 scope set is exactly these five; a manifest asking
 *    for anything else fails the strict schema (`schema-invalid`), and the
 *    vocabulary can only grow by a reviewed schema change — never by data.
 *    Deliberately ABSENT (see the M7-02 design document §3.1): `dag.propose`,
 *    `decision.propose`, and anything execution-shaped (spawn/process/MCP
 *    connect). A plugin tool consumes capabilities; it never acquires the
 *    right to CREATE executions (A35) or to propose graph/decision changes.
 *
 * 2. IDENTITY MAPPING ONTO THE CLOSED v1 PERMISSION VOCABULARY. Every scope
 *    id IS a `PERMISSION_IDS` member from @role-orchestrator/contracts, so a
 *    granted plugin scope intersects with role permissions exactly like any
 *    other permission (docs/SECURITY_MODEL.md: 有效权限是交集). A plugin can
 *    never hold a scope the binding role does not have — the intersection is
 *    computed by the execution layer, this package only guarantees that the
 *    vocabulary is the same closed set.
 *
 * 3. SCOPE → EXISTING CAPABILITY-GATE CHECKS, AS DATA. Each binding cites
 *    `REQUIRED_CONTROLS` vocabulary from @role-orchestrator/capability-gate
 *    (the same controls the M0-06 matrix demands) and states whether the
 *    surface needs a user approval and whether it is budget-metered.
 *    `budgetMetered` is true for EVERY scope: A35 boundary — plugin tool
 *    invocations are metered DAG-visible activity; no declaration can escape
 *    the quota. Enforcement lives in the execution layer; this package makes
 *    the obligation inexpressible to omit.
 */
import { z } from "zod";
import { PERMISSION_IDS, PermissionIdSchema, withUniqueItems } from "@role-orchestrator/contracts";
import { REQUIRED_CONTROLS, RequiredControlSchema } from "@role-orchestrator/capability-gate";

export const PLUGIN_SCOPES = [
  "repo.read",
  "repo.write",
  "git.read",
  "tests.run",
  "memory.propose"
] as const;
export const PluginScopeSchema = z.enum(PLUGIN_SCOPES);
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

/** One scope's mapping onto existing control-plane checks (data, not enforcement). */
export interface ScopeControlBinding {
  /** The closed-v1 permission id this scope exercises (identity mapping). */
  readonly permissionId: (typeof PERMISSION_IDS)[number];
  /** capability-gate REQUIRED_CONTROLS the execution layer must apply. */
  readonly requiredControls: readonly (typeof REQUIRED_CONTROLS)[number][];
  /** True when exercising this scope requires a user-approved approval. */
  readonly approvalRequired: boolean;
  /** Always true in v1 (A35): every invocation counts against DAG budget. */
  readonly budgetMetered: boolean;
}

const ScopeControlBindingSchema = z.strictObject({
  permissionId: PermissionIdSchema,
  requiredControls: withUniqueItems(z.array(RequiredControlSchema).min(1)),
  approvalRequired: z.boolean(),
  budgetMetered: z.literal(true)
});

/**
 * The frozen scope → control map. `budgetMetered: z.literal(true)` in the
 * schema makes an unmetered scope INEXPRESSIBLE — the A35 boundary is a type
 * error, not a review reminder.
 */
export const SCOPE_CONTROL_BINDINGS: Readonly<Record<PluginScope, ScopeControlBinding>> = Object.freeze({
  "repo.read": {
    permissionId: "repo.read",
    requiredControls: ["verified-only"],
    approvalRequired: false,
    budgetMetered: true
  },
  "repo.write": {
    permissionId: "repo.write",
    requiredControls: ["node-checkpoint", "explicit-authorization", "verified-only"],
    approvalRequired: true,
    budgetMetered: true
  },
  "git.read": {
    permissionId: "git.read",
    requiredControls: ["verified-only"],
    approvalRequired: false,
    budgetMetered: true
  },
  "tests.run": {
    permissionId: "tests.run",
    requiredControls: ["full-success-conditions", "verified-only"],
    approvalRequired: false,
    budgetMetered: true
  },
  "memory.propose": {
    permissionId: "memory.propose",
    requiredControls: ["explicit-authorization"],
    approvalRequired: false,
    budgetMetered: true
  }
});

// Fail fast at module load if the map ever drifts from its own schema
// (same "registry data parses at load" discipline as capability-gate).
for (const scope of PLUGIN_SCOPES) {
  ScopeControlBindingSchema.parse(SCOPE_CONTROL_BINDINGS[scope]);
}
