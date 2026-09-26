/**
 * @role-orchestrator/store — public entry point (M1-01).
 *
 * SQLite persistence for the orchestrator daemon:
 *  - versioned, checksummed migrations with verify + backup/restore;
 *  - core tables (projects, task_runs, executions, leases, events, outbox)
 *    with the A23 active-attempt constraint;
 *  - transactional outbox dispatch with lease-based claims.
 *
 * Built on `node:sqlite` (Node >= 25); no native addon dependencies.
 * See README.md for transaction boundaries, lease semantics, backup/restore
 * steps and known boundaries.
 */
export * from "./connection.js";
export * from "./errors.js";
export * from "./json.js";
export * from "./migrations.js";
export * from "./backup.js";
export * from "./restore.js";
export * from "./rows.js";
export * from "./schema.js";
export * from "./time.js";
export * from "./transactions.js";
export * from "./entities/events.js";
export * from "./entities/executions.js";
export * from "./entities/leases.js";
export * from "./entities/outbox.js";
export * from "./entities/projects.js";
export * from "./entities/task-runs.js";
