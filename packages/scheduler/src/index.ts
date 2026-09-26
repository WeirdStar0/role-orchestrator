/**
 * @role-orchestrator/scheduler — public entry point (M2-02).
 *
 * Three-level concurrency, the credentialGroup lock and the fair READY
 * queue (A07/A33):
 *  - `parseConcurrencyPolicy` — strict parse of `policies.concurrency` via
 *    the frozen contracts schema; the scheduler never runs on an unvalidated
 *    quota;
 *  - quota grants (`quota_grants`, migration 004) — counted, all-or-nothing,
 *    one `BEGIN IMMEDIATE` transaction per acquisition, per-key monotonic
 *    fencing tokens (`MAX+1`, uniqueness constraint-backed); expiry never
 *    auto-steals: `releaseExpiredQuotaGrants` is the explicit reconcile step;
 *  - credentialGroup lock (A33) — while `<runtime>.credential-isolation` is
 *    not `verified` in the capability-gate registry, same-group executions
 *    are capped at `unverifiedCredentialGroupMax` (= 1, a contract literal);
 *    different groups never block each other;
 *  - the fair queue — READY nodes enqueue in order (`UNIQUE(run, node)`:
 *    re-enqueue absorbs duplicates), poll in priority-then-wait-time order
 *    with a starvation bound; quota-rejected entries stay WAITING with an
 *    attempts/not_before retry window — nothing is lost or duplicated;
 *  - the dispatch claim — one transaction per entry: grants -> active
 *    attempt -> READY->RUNNING -> queue DISPATCHED -> dispatch outbox;
 *  - the capability gate wiring — every dispatch proves its runtime's
 *    noninteractive entry (and any required capability cell) is `verified`;
 *    unknown capability ids are denied by default.
 *
 * Migration 004 assumes 001-003 are applied: apply via
 * `applySchedulerMigrations` / `SCHEDULER_MIGRATIONS`.
 */
export * from "./errors.js";
export * from "./ids.js";
export * from "./keys.js";
export * from "./policy.js";
export * from "./migration.js";
export * from "./entities/quota-grants.js";
export * from "./entities/queue.js";
export * from "./entities/holds.js";
export * from "./entities/requeue.js";
