/**
 * @role-orchestrator/approval — M4-01 risk grading + one-shot approvals.
 *
 * Fail-closed posture (docs/SECURITY_MODEL.md, R19, ACCEPTANCE A17/A18/A19):
 * - gradeRisk: actions are graded from their declared effect dimensions,
 *   derived permission increments and capability-gate state — never from
 *   command-name whitelists. High risk requires a user approval BEFORE the
 *   action runs; forbidden argv patterns refuse approval creation outright.
 * - actionDigest: canonical sha256 over the complete action essentials; any
 *   element change produces a different digest (A17).
 * - the lifecycle: PENDING -> APPROVED -> CONSUMED with guarded CAS
 *   transitions, idempotency-key replays returning the SAME row (A18), and
 *   expiry guards so expired approvals are never consumable.
 * - unattended writes surface the gate's node-checkpoint requirement (A19);
 *   nothing here fakes a mid-run approval pause.
 */
export * from "./errors.js";
export * from "./risk.js";
export * from "./digest.js";
export * from "./migration.js";
export * from "./lifecycle.js";
