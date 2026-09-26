import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ProfileSnapshot, RoleId } from "@role-orchestrator/contracts";
import { ROLE_IDS, RoleIdSchema } from "@role-orchestrator/contracts";
import { NoRowUpdatedError } from "@role-orchestrator/store";
import type { Row } from "@role-orchestrator/store";
import { optStr, reqInt, reqStr, TimestampSchema } from "@role-orchestrator/store";
import {
  RoleBindingResolutionError,
  RoleBindingsNotReadyError,
  UnknownProfileError,
  UnknownProfileRevisionError,
  UnknownRoleError
} from "../errors.js";
import { checkExecutionTarget } from "../target.js";
import type { ProfileRevisionRow } from "./profile-revisions.js";
import { getLatestProfileRevision, getProfileRevision, profileRevisionToSnapshot } from "./profile-revisions.js";
import type { ProfileRow } from "./profiles.js";
import { getProfile } from "./profiles.js";
import { requireProject } from "./project-lookup.js";

/**
 * `role_bindings` — the A01/A03 service. The four built-in roles are the only
 * legal role_id values (CHECK constraint + typed guard); each (project, role)
 * has at most one binding row (UNIQUE); a binding points at an existing
 * profile revision (composite FK) or is unbound (NULL/NULL).
 *
 * Precedence is Project RoleBinding only: there is deliberately no
 * task/node/workflow-level override surface (R13, ADR 001).
 */
export interface RoleBindingRow {
  readonly projectId: string;
  readonly roleId: RoleId;
  readonly profileId: string | null;
  readonly profileRevision: number | null;
  readonly permissionsRevision: string;
  readonly canCreateSubtasks: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const InitializeProjectRoleBindingsInputSchema = z.strictObject({
  projectId: z.string().min(1).max(64),
  /** Opaque reference to the policies revision this initial state follows. */
  permissionsRevision: z.string().min(1).max(128).default("0"),
  now: TimestampSchema
});

export type InitializeProjectRoleBindingsInput = z.input<typeof InitializeProjectRoleBindingsInputSchema>;

/**
 * Create the four fixed binding rows for a project (one per built-in role),
 * all initially UNBOUND. Idempotent: existing rows (already-bound ones
 * included) are left untouched, so re-running initialization never resets a
 * binding. Requires the project to exist.
 */
export function initializeProjectRoleBindings(
  db: DatabaseSync,
  input: InitializeProjectRoleBindingsInput
): readonly RoleBindingRow[] {
  const value = InitializeProjectRoleBindingsInputSchema.parse(input);
  requireProject(db, value.projectId);
  const insert = db.prepare(
    "INSERT INTO role_bindings(project_id, role_id, profile_id, profile_revision, permissions_revision, can_create_subtasks, created_at, updated_at) " +
      "SELECT ?, ?, NULL, NULL, ?, 0, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM role_bindings WHERE project_id = ? AND role_id = ?)"
  );
  for (const roleId of ROLE_IDS) {
    insert.run(
      value.projectId,
      roleId,
      value.permissionsRevision,
      value.now,
      value.now,
      value.projectId,
      roleId
    );
  }
  return listRoleBindings(db, value.projectId);
}

const SetRoleBindingInputSchema = z.strictObject({
  projectId: z.string().min(1).max(64),
  /** Validated manually (not via RoleIdSchema) so unknown roles get a typed error. */
  roleId: z.string().min(1).max(64),
  profileId: z.string().min(1).max(64),
  /** Defaults to the profile's latest revision at bind time. */
  profileRevision: z.number().int().min(1).optional(),
  canCreateSubtasks: z.boolean().default(false),
  permissionsRevision: z.string().min(1).max(128).default("0"),
  now: TimestampSchema
});

export type SetRoleBindingInput = z.input<typeof SetRoleBindingInputSchema>;

/** A role binding fully resolved to its pinned profile revision. */
export interface ResolvedRoleBinding {
  readonly roleId: RoleId;
  readonly binding: RoleBindingRow;
  readonly profile: ProfileRow;
  readonly revision: ProfileRevisionRow;
  /** The frozen contracts `ProfileSnapshot` for (profile, revision). */
  readonly snapshot: ProfileSnapshot;
}

export interface SetRoleBindingResult {
  readonly binding: RoleBindingRow;
  readonly profile: ProfileRow;
  readonly revision: ProfileRevisionRow;
  readonly snapshot: ResolvedRoleBinding["snapshot"];
}

/**
 * Bind or re-bind one of the four fixed roles to an EXISTING profile revision
 * (A01). Rejects, before any write:
 * - unknown role ids (`UnknownRoleError`, A03 — roles are lowercase, exact);
 * - unknown project (`UnknownProjectError`);
 * - a role row that was never initialized (`missing`);
 * - unknown profiles (`UnknownProfileError`) and unknown revisions
 *   (`UnknownProfileRevisionError`, including "profile has no revisions");
 * - a profile whose executionTarget or path forms do not match the project's
 *   target (`ExecutionTargetMismatchError`, A29 — rejected at bind time, the
 *   earliest possible point).
 */
export function setRoleBinding(db: DatabaseSync, input: SetRoleBindingInput): SetRoleBindingResult {
  const value = SetRoleBindingInputSchema.parse(input);
  assertKnownRoleId(value.roleId);
  const project = requireProject(db, value.projectId);
  ensureBindingRowExists(db, value.projectId, value.roleId);

  const profile = getProfile(db, value.profileId);
  if (profile === null) {
    throw new UnknownProfileError(value.profileId);
  }

  const revisionRow =
    value.profileRevision === undefined
      ? getLatestProfileRevision(db, value.profileId)
      : getProfileRevision(db, value.profileId, value.profileRevision);
  if (revisionRow === null) {
    throw new UnknownProfileRevisionError(value.profileId, value.profileRevision ?? null);
  }

  checkExecutionTarget({
    projectTarget: project.executionTarget,
    profileTarget: profile.executionTarget,
    executable: profile.executable,
    configDir: profile.configDir
  });

  const result = db
    .prepare(
      "UPDATE role_bindings SET profile_id = ?, profile_revision = ?, can_create_subtasks = ?, permissions_revision = ?, updated_at = ? " +
        "WHERE project_id = ? AND role_id = ?"
    )
    .run(
      value.profileId,
      revisionRow.revision,
      value.canCreateSubtasks ? 1 : 0,
      value.permissionsRevision,
      value.now,
      value.projectId,
      value.roleId
    );
  if (Number(result.changes) !== 1) {
    throw new NoRowUpdatedError(
      `role binding for project "${value.projectId}" role "${value.roleId}" was not updated`
    );
  }
  const binding = requireBindingRow(db, value.projectId, value.roleId);
  return {
    binding,
    profile,
    revision: revisionRow,
    snapshot: profileRevisionToSnapshot(profile, revisionRow)
  };
}

export function listRoleBindings(db: DatabaseSync, projectId: string): readonly RoleBindingRow[] {
  const rows = db
    .prepare("SELECT * FROM role_bindings WHERE project_id = ? ORDER BY role_id ASC")
    .all(projectId);
  return rows.map(mapRoleBindingRow);
}

/** A03 guard: exactly the four built-in role ids, case-sensitive. */
export function assertKnownRoleId(roleId: string): asserts roleId is RoleId {
  const parsed = RoleIdSchema.safeParse(roleId);
  if (!parsed.success) {
    throw new UnknownRoleError(roleId);
  }
}

function mapRoleBindingRow(row: Row): RoleBindingRow {
  const roleId = reqStr(row, "role_id");
  const parsedRole = RoleIdSchema.safeParse(roleId);
  if (!parsedRole.success) {
    // Only reachable if the CHECK constraint was removed by direct tampering.
    throw new UnknownRoleError(roleId);
  }
  return {
    projectId: reqStr(row, "project_id"),
    roleId: parsedRole.data,
    profileId: optStr(row, "profile_id"),
    profileRevision: row["profile_revision"] === null || row["profile_revision"] === undefined
      ? null
      : reqInt(row, "profile_revision"),
    permissionsRevision: reqStr(row, "permissions_revision"),
    canCreateSubtasks: reqInt(row, "can_create_subtasks") === 1,
    createdAt: reqStr(row, "created_at"),
    updatedAt: reqStr(row, "updated_at")
  };
}

function requireBindingRow(db: DatabaseSync, projectId: string, roleId: RoleId): RoleBindingRow {
  const row = db
    .prepare("SELECT * FROM role_bindings WHERE project_id = ? AND role_id = ?")
    .get(projectId, roleId);
  if (row === undefined) {
    throw new RoleBindingResolutionError(
      "missing",
      projectId,
      roleId,
      `no role binding row for project "${projectId}" role "${roleId}"; run initializeProjectRoleBindings first`
    );
  }
  return mapRoleBindingRow(row);
}

function ensureBindingRowExists(db: DatabaseSync, projectId: string, roleId: RoleId): void {
  const row = db
    .prepare("SELECT 1 AS present FROM role_bindings WHERE project_id = ? AND role_id = ?")
    .get(projectId, roleId);
  if (row === undefined) {
    throw new RoleBindingResolutionError(
      "missing",
      projectId,
      roleId,
      `no role binding row for project "${projectId}" role "${roleId}"; run initializeProjectRoleBindings first`
    );
  }
}

/**
 * Resolve ONE role binding to its pinned profile revision. Fails with typed
 * `RoleBindingResolutionError` for every A01 reason:
 * missing (never initialized), unbound, multiple (constraint tampered),
 * unknown-profile, unknown-revision.
 */
export function resolveRoleBinding(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly roleId: string }
): ResolvedRoleBinding {
  assertKnownRoleId(input.roleId);
  requireProject(db, input.projectId);
  const rows = db
    .prepare("SELECT * FROM role_bindings WHERE project_id = ? AND role_id = ?")
    .all(input.projectId, input.roleId);
  if (rows.length === 0) {
    throw new RoleBindingResolutionError(
      "missing",
      input.projectId,
      input.roleId,
      `no role binding row for project "${input.projectId}" role "${input.roleId}"`
    );
  }
  if (rows.length > 1) {
    throw new RoleBindingResolutionError(
      "multiple",
      input.projectId,
      input.roleId,
      `${String(rows.length)} binding rows exist for project "${input.projectId}" role "${input.roleId}"; ` +
        "the UNIQUE(project_id, role_id) constraint has been removed — refusing to guess"
    );
  }
  const singleRow = rows[0];
  if (singleRow === undefined) {
    throw new RoleBindingResolutionError(
      "missing",
      input.projectId,
      input.roleId,
      `no role binding row for project "${input.projectId}" role "${input.roleId}"`
    );
  }
  const binding = mapRoleBindingRow(singleRow);
  if (binding.profileId === null || binding.profileRevision === null) {
    throw new RoleBindingResolutionError(
      "unbound",
      input.projectId,
      input.roleId,
      `role "${input.roleId}" of project "${input.projectId}" has no profile bound`
    );
  }
  const profile = getProfile(db, binding.profileId);
  if (profile === null) {
    throw new RoleBindingResolutionError(
      "unknown-profile",
      input.projectId,
      input.roleId,
      `role "${input.roleId}" of project "${input.projectId}" points at unknown profile "${binding.profileId}"`
    );
  }
  const revision = getProfileRevision(db, binding.profileId, binding.profileRevision);
  if (revision === null) {
    throw new RoleBindingResolutionError(
      "unknown-revision",
      input.projectId,
      input.roleId,
      `role "${input.roleId}" of project "${input.projectId}" points at profile "${binding.profileId}" revision ${String(binding.profileRevision)} which does not exist`
    );
  }
  return {
    roleId: input.roleId,
    binding,
    profile,
    revision,
    snapshot: profileRevisionToSnapshot(profile, revision)
  };
}

export interface ReadyBindings {
  readonly projectId: string;
  /** Exactly four entries, in ROLE_IDS order: coordinator, architect, developer, reviewer. */
  readonly resolved: readonly ResolvedRoleBinding[];
}

/**
 * A01 pre-start check: ALL FOUR roles must resolve to an existing profile
 * revision. Aggregates every failure into one `RoleBindingsNotReadyError`
 * (so startup reports the complete picture); returns the four resolved
 * bindings on success.
 */
export function validateRoleBindingsReady(
  db: DatabaseSync,
  input: { readonly projectId: string }
): ReadyBindings {
  requireProject(db, input.projectId);
  const resolved: ResolvedRoleBinding[] = [];
  const failures: { readonly roleId: string; readonly kind: RoleBindingResolutionError["kind"] }[] = [];
  for (const roleId of ROLE_IDS) {
    try {
      resolved.push(resolveRoleBinding(db, { projectId: input.projectId, roleId }));
    } catch (error) {
      if (error instanceof RoleBindingResolutionError) {
        failures.push({ roleId, kind: error.kind });
      } else {
        throw error;
      }
    }
  }
  if (failures.length > 0) {
    throw new RoleBindingsNotReadyError(input.projectId, failures);
  }
  return { projectId: input.projectId, resolved };
}
