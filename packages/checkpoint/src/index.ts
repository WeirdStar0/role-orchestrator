/**
 * @role-orchestrator/checkpoint — M4-02 approval checkpoints + bounded
 * continuation.
 *
 * The node-checkpoint design of docs/CLI_ADAPTERS.md (审批能力不可假定一致):
 * an execution's structured action proposal is NEVER executed by the system
 * that received it and NEVER answered in-band. Depending on the capability
 * gate (A19):
 * - no verified interactive approval channel -> the current execution has
 *   safely ENDED already; `openApprovalCheckpoint` converts the proposal into
 *   a one-shot approval (@role-orchestrator/approval) and the node waits
 *   (WAITING_APPROVAL, dag state machine);
 * - a proposal whose action type relies on the mid-run channel while that
 *   channel is unverified -> typed refusal, zero writes (fail-closed).
 *
 * After a user approves, `continueAfterApproval` creates the ONE continuation
 * a checkpoint authorizes: a fresh attempt under the A23 single-active
 * constraint, running from the run's FROZEN profile snapshot (A34,
 * `readRunRoleProfile`), consuming the approval via the actionDigest CAS
 * (A17/A18), and emitting into the dispatch outbox. Launch itself stays with
 * the engine's claimed-attempt composition. Unapproved/expired/consumed
 * approvals refuse the continuation with distinct typed errors.
 */
export * from "./errors.js";
export * from "./proposal.js";
export * from "./channel.js";
export * from "./migration.js";
export * from "./service.js";
