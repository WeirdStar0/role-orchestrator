/**
 * @role-orchestrator/runtime-profile — public entry point (M1-02).
 *
 * Profile and role-binding snapshots:
 *  - migration 0002 (profiles, immutable profile_revisions, four fixed
 *    role_bindings, run_profile_snapshots) — apply via
 *    `applyRuntimeProfileMigrations` / `RUNTIME_PROFILE_MIGRATIONS`;
 *  - binding service with the A01 pre-start rejection and the A03 four-role
 *    guard;
 *  - frozen run reads (`readRunRoleProfile`) plus drift queries
 *    (`getRunBindingDrift`, `checkRunProfileDrift`) — A34;
 *  - external host-config drift detection with credential exclusion — A34;
 *  - executionTarget checks, no implicit conversion — A29;
 *  - the node/task/workflow override guard (type + runtime layers) — A02.
 *
 * Security boundaries (credential exclusion list, size cap, symlink refusal,
 * explicit-manifest-only hashing) are documented in README.md and pinned by
 * tests. Built on `@role-orchestrator/store` (node:sqlite, Node >= 25).
 */
export * from "./errors.js";
export * from "./hashing.js";
export * from "./migration.js";
export * from "./target.js";
export * from "./no-override.js";
export * from "./drift.js";
export {
  appliedMigrationRecords,
  applyMigrations,
  verifyMigrations,
  migrationChecksum,
  type MigrationDefinition,
  type ApplyMigrationsResult,
  type AppliedMigrationRecord,
  type VerifyMigrationsResult
} from "@role-orchestrator/store";
export * from "./entities/project-lookup.js";
export * from "./entities/profiles.js";
export * from "./entities/profile-revisions.js";
export * from "./entities/role-bindings.js";
export * from "./entities/run-snapshots.js";
