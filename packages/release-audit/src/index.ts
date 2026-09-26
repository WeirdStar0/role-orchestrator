/**
 * M6-03 release security and licensing audit — public API.
 *
 * - {@link scanSecrets}: repo-wide secret scan with known-reservation
 *   classification (A42/A36).
 * - {@link auditDependencies}: lockfile vs package.json dependency source,
 *   registry, integrity and license audit with THIRD_PARTY_NOTICES coverage.
 * - {@link checkLicenseCandidate}: Apache-2.0 candidate text verification.
 * - {@link inventoryGovernance}: maintainer-gated governance inventory.
 */
export {
  KNOWN_FAKE_SENTINELS,
  KNOWN_RESERVATIONS,
  VALUE_PATTERN_RULES,
  ASSIGNMENT_RULE,
  CONFIG_EXTENSIONS,
  scanSecrets,
  SecretScanOptionsSchema,
  type SecretScanInput,
  type SecretScanResult,
  type SecretFinding,
  type FindingClassification,
  type FindingKind,
  type KnownReservation,
  type ReservationKind
} from "./secrets-scan.js";
export {
  DEFAULT_REGISTRY,
  auditDependencies,
  DependencyAuditOptionsSchema,
  type DependencyAuditInput,
  type DependencyAuditResult,
  type ExternalDependency,
  type LicensePolicyClass,
  type LicenseSource
} from "./dependency-audit.js";
export {
  CANONICAL_APACHE_2_0_SHA256,
  canonicalApacheFixturePath,
  checkLicenseCandidate,
  normalizeWording,
  sha256Of,
  LicenseCheckOptionsSchema,
  type LicenseCheckInput,
  type LicenseCandidateCheck
} from "./license-check.js";
export {
  inventoryGovernance,
  GovernanceOptionsSchema,
  type GovernanceInput,
  type GovernanceInventory,
  type CodeownersInventory,
  type PrivateChannelInventory
} from "./governance.js";
export { ReleaseAuditError, AuditTargetMissingError, LockfileParseError } from "./errors.js";
