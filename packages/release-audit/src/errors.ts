/**
 * Typed error taxonomy for @role-orchestrator/release-audit (M6-03).
 *
 * Repo convention (typed errors + `cause`): audit preconditions that the
 * API cannot proceed under throw; audit OUTCOMES (a found secret shape, a
 * license gap, a governance pending item) are RESULTS, never exceptions.
 */
export class ReleaseAuditError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReleaseAuditError";
  }
}

/** The caller pointed the audit at a repository root that is not usable. */
export class AuditTargetMissingError extends ReleaseAuditError {
  readonly missingPaths: readonly string[];

  constructor(missingPaths: readonly string[], options?: { cause?: unknown }) {
    super(
      `audit target is missing required paths (${missingPaths.join(", ")}); ` +
        "point the audit at the repository root that contains them",
      options
    );
    this.name = "AuditTargetMissingError";
    this.missingPaths = missingPaths;
  }
}

/** The pnpm lockfile cannot be parsed into the shape the audit requires. */
export class LockfileParseError extends ReleaseAuditError {
  readonly lockfilePath: string;

  constructor(lockfilePath: string, detail: string, options?: { cause?: unknown }) {
    super(`lockfile "${lockfilePath}" could not be audited: ${detail}`, options);
    this.name = "LockfileParseError";
    this.lockfilePath = lockfilePath;
  }
}
