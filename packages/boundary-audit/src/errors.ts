/**
 * Typed error taxonomy for @role-orchestrator/boundary-audit (M7-04).
 *
 * Repo convention (typed errors + `cause`): audit preconditions that the
 * API cannot proceed under throw; audit OUTCOMES (a boundary violation, a
 * malformed marker, manifest drift) are RESULTS carried in
 * {@link BoundaryAuditResult.violations}, never exceptions.
 */
export class BoundaryAuditError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BoundaryAuditError";
  }
}

/** The caller pointed the audit at a root or packages directory that is not usable. */
export class AuditTargetMissingError extends BoundaryAuditError {
  readonly missingPaths: readonly string[];

  constructor(missingPaths: readonly string[], options?: { cause?: unknown }) {
    super(
      `boundary audit target is missing required paths (${missingPaths.join(", ")}); ` +
        "point the audit at a repository root that contains the workspace packages directory",
      options
    );
    this.name = "AuditTargetMissingError";
    this.missingPaths = missingPaths;
  }
}

/** A workspace package.json exists but cannot be parsed into an auditable shape. */
export class ManifestParseError extends BoundaryAuditError {
  readonly manifestPath: string;

  constructor(manifestPath: string, detail: string, options?: { cause?: unknown }) {
    super(`workspace manifest "${manifestPath}" could not be audited: ${detail}`, options);
    this.name = "ManifestParseError";
    this.manifestPath = manifestPath;
  }
}
