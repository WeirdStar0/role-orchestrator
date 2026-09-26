import type { DatabaseSync } from "node:sqlite";
import type { ProfileSnapshot, RoleId } from "@role-orchestrator/contracts";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import { readRunRoleProfile, resolveRoleBinding } from "@role-orchestrator/runtime-profile";
import { RoleBindingResolutionError } from "@role-orchestrator/runtime-profile";
import { getTaskRun } from "@role-orchestrator/store";
import { PlanRoleResolutionError, UnknownRunError } from "./errors.js";
import type { ValidatedPlan } from "./graph.js";

/**
 * Plan-time role resolution (A03 + A01) over `@role-orchestrator/runtime-profile`.
 *
 * Every node's role is one of the four built-ins (enforced by the contracts
 * schema and re-checked by `validateWorkflowGraph`); this module pins each
 * role USED BY THE PLAN to one concrete ProfileRevision, in one of two modes:
 *
 * - bindings mode (`resolvePlanRolesFromBindings`): reads the project's
 *   CURRENT role bindings — the pre-run feasibility check for a proposed DAG;
 * - snapshot mode (`resolvePlanRolesFromRunSnapshot`): reads the run's FROZEN
 *   `run_profile_snapshots` rows only (A34) — the mode `createRunGraph` uses,
 *   so later binding changes can never affect an existing run.
 *
 * Resolution failures REUSE runtime-profile's typed rejection vocabulary:
 * the five `RoleBindingResolutionKind`s propagate as
 * `PlanRoleResolutionError` (same kind, original error as cause), and the
 * frozen-snapshot path's `UnknownRunSnapshotError` propagates unchanged.
 * Both happen strictly before any startup/spawn step.
 */

export interface PlanRoleResolution {
  readonly roleId: RoleId;
  readonly profileId: string;
  readonly profileRevision: number;
  /** The frozen contracts `ProfileSnapshot` for (profile, revision). */
  readonly snapshot: ProfileSnapshot;
}

/**
 * The distinct roles a plan uses, in the fixed ROLE_IDS order (deterministic,
 * independent of node order). A plan may legally use a subset of the roles.
 */
export function distinctRolesOf(plan: ValidatedPlan): readonly RoleId[] {
  const used = new Set<string>(plan.nodes.map((node) => node.role));
  return ROLE_IDS.filter((role) => used.has(role));
}

/**
 * Resolve every role used by the plan through the project's CURRENT bindings.
 * A01's five rejection kinds (missing/unbound/multiple/unknown-profile/
 * unknown-revision) surface as `PlanRoleResolutionError` with the same kind.
 */
export function resolvePlanRolesFromBindings(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly plan: ValidatedPlan }
): readonly PlanRoleResolution[] {
  const resolved: PlanRoleResolution[] = [];
  for (const roleId of distinctRolesOf(input.plan)) {
    let binding: ReturnType<typeof resolveRoleBinding>;
    try {
      binding = resolveRoleBinding(db, { projectId: input.projectId, roleId });
    } catch (error) {
      if (error instanceof RoleBindingResolutionError) {
        throw new PlanRoleResolutionError(error.kind, input.projectId, roleId, { cause: error });
      }
      throw error;
    }
    resolved.push({
      roleId,
      profileId: binding.snapshot.id,
      profileRevision: binding.snapshot.revision,
      snapshot: binding.snapshot
    });
  }
  return resolved;
}

/**
 * Resolve every role used by the plan through the run's FROZEN snapshots
 * (A34 service read path — never the current bindings). Requires the run to
 * exist (`UnknownRunError` otherwise); a missing snapshot row propagates
 * runtime-profile's typed `UnknownRunSnapshotError`.
 */
export function resolvePlanRolesFromRunSnapshot(
  db: DatabaseSync,
  input: { readonly runId: string; readonly plan: ValidatedPlan }
): readonly PlanRoleResolution[] {
  if (getTaskRun(db, input.runId) === null) {
    throw new UnknownRunError(input.runId);
  }
  const resolved: PlanRoleResolution[] = [];
  for (const roleId of distinctRolesOf(input.plan)) {
    const frozen = readRunRoleProfile(db, { runId: input.runId, roleId });
    resolved.push({
      roleId: frozen.roleId,
      profileId: frozen.snapshot.id,
      profileRevision: frozen.profileRevision,
      snapshot: frozen.snapshot
    });
  }
  return resolved;
}
