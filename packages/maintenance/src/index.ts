/**
 * @role-orchestrator/maintenance — public entry point (M6-02).
 *
 * Backup, migration-upgrade recovery and safe cleanup for the orchestrator
 * daemon database:
 *  - the composed daemon migration chain (versioned definitions in
 *    `chain.ts` — this entry stays version-agnostic on purpose) with a
 *    conflict-safe union primitive (`composeMigrationUnion` /
 *    `DAEMON_MIGRATIONS`);
 *  - the executable upgrade-failure recovery drill proving both A41 branches
 *    (`runUpgradeRecoveryDrill`) — see README.md for the human runbook;
 *  - the A40 cleanup inventory (`planCleanup`) with per-object safety levels
 *    and the guarded executor (`executeCleanup`) returning an itemized
 *    receipt: undelivered worktree changes, unconsumed approvals and
 *    undelivered outbox rows are refused by default and only removed behind
 *    an explicit per-item confirmation.
 *
 * Restore-side pre-verification of backup files (truncation / tampering /
 * wrong-lineage refusal) lives in @role-orchestrator/store (`restoreBackup`,
 * `inspectBackupFile`) where the backup primitives live.
 */
export * from "./errors.js";
export * from "./chain.js";
export * from "./inventory.js";
export * from "./cleanup.js";
export * from "./backup-drill.js";
