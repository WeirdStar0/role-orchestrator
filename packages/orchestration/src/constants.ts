/**
 * M10-02 M1 (driver-contract) — the frozen constant groups of the formal run
 * driver. Values are the M5-05/M6-05 pump values and the M9-01 production
 * choices, carried over VERBATIM (production parity is the M10-02 step-1
 * hard constraint — a changed constant here is a changed product behavior).
 */

/** The single fixed node of an M9-01 run graph (the user's objective). */
export const EXECUTE_NODE_ID = "execute";

/** The frozen graph definition revision the M9-01 workflow is created under. */
export const GRAPH_DEFINITION_REVISION = "1";

/** Queue/poll knobs — the M5-05/M6-05 pump values, unchanged. */
export const POLL_LEASE_MS = 600_000;
export const POLL_RETRY_WINDOW_MS = 50;
export const POLL_STARVATION_MS = 600_000;
export const POLL_LIMIT = 8;
/**
 * The scheduler's own quota machinery stays exactly as shipped (M9-01
 * decision). Since M10-04 the parallel dispatchJoin actually EXERCISES these
 * slots (a workflow's READY siblings claim up to globalMax 4 / projectMax 4
 * / per-profile maxConcurrency / unverifiedCredentialGroupMax 1); the values
 * themselves stay frozen.
 */
export const PUMP_CONCURRENCY = { globalMax: 4, projectMax: 4, unverifiedCredentialGroupMax: 1 };

/** Approval checkpoints opened for proposals: 30 days, as the M6-05 driver. */
export const APPROVAL_TTL_SECONDS = 2_592_000;

/** Fail-safe round bound for the pump (never expected to be reached). */
export const MAX_PUMP_ROUNDS = 32;

/** Graceful-close bound: chains settle their DB writes before the store closes. */
export const SHUTDOWN_GRACE_MS = 15_000;
