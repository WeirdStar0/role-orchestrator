/**
 * Typed error taxonomy for @role-orchestrator/runtime-profile.
 *
 * Every error is a typed, precondition failure — never a guessed outcome.
 * Drift FINDINGS (external config changed, binding changed) are deliberately
 * NOT errors: they are structured results returned to the caller, because a
 * detected drift is information, not an exception. Errors here mean "the
 * requested state change or read could not be performed".
 */
export class RuntimeProfileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeProfileError";
  }
}

/**
 * Why a role binding could not be resolved. These are the A01 pre-start
 * rejection reasons (plus the unknown-revision case):
 * - missing           : no binding row for (project, role) — initialize not run
 * - unbound           : binding row exists but no profile is bound yet
 * - multiple          : more than one row for (project, role) — impossible
 *                       while the UNIQUE constraint exists; only reachable if
 *                       the database was tampered with
 * - unknown-profile   : bound profile id does not exist in `profiles`
 * - unknown-revision  : bound revision does not exist in `profile_revisions`,
 *                       or the profile has no revision at all
 */
export type RoleBindingResolutionKind =
  | "missing"
  | "unbound"
  | "multiple"
  | "unknown-profile"
  | "unknown-revision";

export class RoleBindingResolutionError extends RuntimeProfileError {
  readonly kind: RoleBindingResolutionKind;
  readonly projectId: string;
  readonly roleId: string;

  constructor(
    kind: RoleBindingResolutionKind,
    projectId: string,
    roleId: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "RoleBindingResolutionError";
    this.kind = kind;
    this.projectId = projectId;
    this.roleId = roleId;
  }
}

/**
 * A01: thrown by `validateRoleBindingsReady` when ANY of the four roles fails
 * to resolve; `failures` lists every (roleId, kind) pair so a startup check
 * reports the full picture instead of only the first problem.
 */
export class RoleBindingsNotReadyError extends RuntimeProfileError {
  readonly projectId: string;
  readonly failures: readonly { readonly roleId: string; readonly kind: RoleBindingResolutionKind }[];

  constructor(
    projectId: string,
    failures: readonly { readonly roleId: string; readonly kind: RoleBindingResolutionKind }[]
  ) {
    super(
      `role bindings for project "${projectId}" are not ready: ` +
        failures.map((f) => `${f.roleId} (${f.kind})`).join(", ") +
        "; refusing to start a run with incomplete bindings"
    );
    this.name = "RoleBindingsNotReadyError";
    this.projectId = projectId;
    this.failures = failures;
  }
}

/** A03: a role id outside the four fixed built-in roles was requested. */
export class UnknownRoleError extends RuntimeProfileError {
  readonly roleId: string;

  constructor(roleId: string, options?: { cause?: unknown }) {
    super(
      `unknown role "${roleId}"; only the four built-in roles ` +
        "(coordinator, architect, developer, reviewer) are accepted",
      options
    );
    this.name = "UnknownRoleError";
    this.roleId = roleId;
  }
}

export class UnknownProjectError extends RuntimeProfileError {
  readonly projectId: string;

  constructor(projectId: string, options?: { cause?: unknown }) {
    super(`project "${projectId}" does not exist`, options);
    this.name = "UnknownProjectError";
    this.projectId = projectId;
  }
}

export class UnknownProfileError extends RuntimeProfileError {
  readonly profileId: string;

  constructor(profileId: string, options?: { cause?: unknown }) {
    super(`profile "${profileId}" does not exist`, options);
    this.name = "UnknownProfileError";
    this.profileId = profileId;
  }
}

/** A01 (unknown revision) and the "profile has no revision" bind refusal. */
export class UnknownProfileRevisionError extends RuntimeProfileError {
  readonly profileId: string;
  /** null when the profile has no revisions at all. */
  readonly revision: number | null;

  constructor(
    profileId: string,
    revision: number | null,
    options?: { cause?: unknown }
  ) {
    super(
      revision === null
        ? `profile "${profileId}" has no revisions; create one before binding (a binding must point at an existing profile revision)`
        : `profile "${profileId}" has no revision ${String(revision)}`,
      options
    );
    this.name = "UnknownProfileRevisionError";
    this.profileId = profileId;
    this.revision = revision;
  }
}

export class DuplicateProfileError extends RuntimeProfileError {
  readonly profileId: string;

  constructor(profileId: string, options?: { cause?: unknown }) {
    super(`profile "${profileId}" already exists`, options);
    this.name = "DuplicateProfileError";
    this.profileId = profileId;
  }
}

export class ProfileRevisionConflictError extends RuntimeProfileError {
  readonly profileId: string;
  readonly revision: number;

  constructor(profileId: string, revision: number, options?: { cause?: unknown }) {
    super(
      `profile "${profileId}" already has revision ${String(revision)}; ` +
        "profile revisions are immutable and append-only",
      options
    );
    this.name = "ProfileRevisionConflictError";
    this.profileId = profileId;
    this.revision = revision;
  }
}

/** A run id was used twice for snapshot creation. */
export class DuplicateRunError extends RuntimeProfileError {
  readonly runId: string;

  constructor(runId: string, options?: { cause?: unknown }) {
    super(`task run "${runId}" already exists`, options);
    this.name = "DuplicateRunError";
    this.runId = runId;
  }
}

/** The run has no frozen snapshot rows to read (A34 service reads fail closed). */
export class UnknownRunSnapshotError extends RuntimeProfileError {
  readonly runId: string;
  readonly roleId: string | null;

  constructor(runId: string, roleId: string | null, options?: { cause?: unknown }) {
    super(
      roleId === null
        ? `task run "${runId}" has no profile snapshot rows`
        : `task run "${runId}" has no profile snapshot for role "${roleId}"`,
      options
    );
    this.name = "UnknownRunSnapshotError";
    this.runId = runId;
    this.roleId = roleId;
  }
}

/** The stored snapshot JSON does not match its recorded hash or row key. */
export class SnapshotIntegrityError extends RuntimeProfileError {
  readonly runId: string;
  readonly roleId: string;

  constructor(runId: string, roleId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SnapshotIntegrityError";
    this.runId = runId;
    this.roleId = roleId;
  }
}

export type ExecutionTargetMismatchKind = "target-differ" | "path-form";

/**
 * A29: a typed, PRE-execution error. No implicit path/target conversion is
 * ever attempted; the caller must fix the configuration.
 */
export class ExecutionTargetMismatchError extends RuntimeProfileError {
  readonly kind: ExecutionTargetMismatchKind;
  readonly expectedTarget: string;
  readonly actualTarget: string;
  /** Which field carried the offending value, e.g. "executable" or "requestTarget". */
  readonly field: string;

  constructor(
    kind: ExecutionTargetMismatchKind,
    expectedTarget: string,
    actualTarget: string,
    field: string,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ExecutionTargetMismatchError";
    this.kind = kind;
    this.expectedTarget = expectedTarget;
    this.actualTarget = actualTarget;
    this.field = field;
  }
}

/**
 * Why a file was refused from an external-config manifest. Registration-time
 * refusals throw; drift-time occurrences appear as structured per-file
 * statuses with the same vocabulary.
 */
export type ExternalConfigViolationKind =
  | "credential-pattern"
  | "absolute-path"
  | "path-escape"
  | "invalid-path"
  | "symlink"
  | "not-regular-file"
  | "too-large"
  | "missing-file"
  | "unreadable";

export class ExternalConfigViolationError extends RuntimeProfileError {
  readonly kind: ExternalConfigViolationKind;
  /** Workspace/config-relative path (never absolute) of the refused file. */
  readonly path: string;

  constructor(
    kind: ExternalConfigViolationKind,
    path: string,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? `external config file "${path}" refused (${kind})`, options);
    this.name = "ExternalConfigViolationError";
    this.kind = kind;
    this.path = path;
  }
}

/**
 * A02: a node/task/workflow-level model or profile override field was found on
 * an input that must never carry one. `paths` lists every offending location
 * (e.g. "$.definitions[0].model").
 */
export class NodeOverrideRejectedError extends RuntimeProfileError {
  readonly context: string;
  readonly paths: readonly string[];

  constructor(context: string, paths: readonly string[]) {
    super(
      `node/task/workflow-level profile or model override is not allowed (A02): ` +
        `${context} carries forbidden fields: ${paths.join(", ")}. ` +
        "Profile/model selection exists only in Project RoleBindings; there is no node-level override entry."
    );
    this.name = "NodeOverrideRejectedError";
    this.context = context;
    this.paths = paths;
  }
}
