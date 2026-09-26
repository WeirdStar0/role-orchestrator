/**
 * @role-orchestrator/reconcile — public entry point (M1-05).
 *
 * Startup reconcile over the store's durable state (docs/ORCHESTRATION.md
 * section 7):
 *  - reconcileStartup: scan every ACTIVE attempt, decide per attempt from the
 *    recorded pid identity (alive-confirmed / interrupted / recovery-required,
 *    per A22/A23/A24/A27) and apply idempotent guarded dispositions;
 *  - listRecoveryItems: the interrupted list — every entry needing human or
 *    follow-up handling;
 *  - resolveRecoveryItem: the operator-side disposition of a
 *    RECOVERY_REQUIRED item (to INTERRUPTED, which frees the A23 slot for a
 *    NEW attempt; reconcile itself never re-dispatches or kills).
 *
 * RECOVERY_REQUIRED is a reconcile STATUS, not a new execution phase: the
 * frozen schema keeps its eight phases, the attempt row stays active while
 * recovery is required, and the A23 partial unique index is what blocks new
 * attempts at the constraint level. Full daemon wiring and the recovery
 * fault-injection matrix are M4-05.
 */
export * from "./errors.js";
export * from "./ids.js";
export * from "./probe.js";
export * from "./decide.js";
export * from "./apply.js";
export * from "./scan.js";
export * from "./list.js";
