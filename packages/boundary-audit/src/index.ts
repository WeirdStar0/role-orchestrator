/**
 * M7-04 open-core vs commercial control-plane boundary audit — public API.
 *
 * - {@link auditCommercialBoundary}: the audit itself (rules R1–R5).
 * - {@link findRuntimeCycles}: cycle detection over a workspace adjacency.
 * - Built-in inventories: {@link OPEN_CORE_PACKAGE_MANIFEST},
 *   {@link CORE_EXTERNAL_RUNTIME_ALLOWLIST}, {@link COMMERCIAL_MARKER_FIELD}.
 * - Pinned boundary statements (A01/A02 commercial-plane declarations and
 *   the design-only disclosure).
 */
export {
  auditCommercialBoundary,
  BoundaryAuditOptionsSchema,
  findRuntimeCycles,
  type BoundaryAuditInput,
  type BoundaryAuditResult,
  type BoundaryViolation,
  type BoundaryViolationRule
} from "./audit.js";
export {
  OPEN_CORE_PACKAGE_MANIFEST,
  CORE_EXTERNAL_RUNTIME_ALLOWLIST,
  COMMERCIAL_MARKER_FIELD
} from "./core-manifest.js";
export {
  COMMERCIAL_BOUNDARY_STATEMENT,
  A01_COMMERCIAL_STATEMENT,
  A02_COMMERCIAL_STATEMENT,
  DESIGN_ONLY_DISCLOSURE
} from "./statements.js";
export { parseWorkspaceManifest, type WorkspaceManifest, type DependencySection } from "./manifest.js";
export { BoundaryAuditError, AuditTargetMissingError, ManifestParseError } from "./errors.js";
