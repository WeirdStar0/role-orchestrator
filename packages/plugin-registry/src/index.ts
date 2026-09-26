/**
 * @role-orchestrator/plugin-registry — M7-02 controlled plugin/tool extension
 * contracts. DESIGN ONLY: this repository contains NO plugin loader — nothing
 * here reads a plugin from disk, spawns a process, opens a connection, or
 * executes anything. What ships is the versioned manifest contract, the
 * trust inventory record, and ONE pure load-decision function that a future
 * loader must consult for every invocation.
 *
 * Fail-closed posture (docs/SECURITY_MODEL.md: CLI 插件不是权限来源;
 * capability-gate requiredControl "explicit-management"):
 * - default deny — a plugin id absent from the trust inventory is untrusted
 *   and refused; tiers are builtin > verified > untrusted, and the manifest's
 *   trust CLAIM must equal the inventory tier or the load refuses;
 * - the kill switch and the disabled flag refuse before any trust or scope
 *   logic; there is no cached acceptance, so the next invocation after a
 *   disable is refused (per-invocation re-evaluation of this pure function);
 * - content integrity is a triple pin: artifact bytes must match the
 *   manifest digest, the manifest digest must match the inventory pin, and
 *   the WHOLE canonical manifest value must match the inventory
 *   `manifestSha256` self-pin at every tier (`manifest-pin-mismatch`
 *   otherwise) — editing manifest fields while keeping the digest fields can
 *   no longer slip through (HARDENING-1, review minor #1/#27);
 * - declared scopes live in a closed vocabulary that maps 1:1 onto the
 *   contracts permission ids and cites capability-gate REQUIRED_CONTROLS as
 *   data; every scope is budget-metered (A35) and anything outside the host
 *   allowlist refuses;
 * - override vocabulary (model/Profile/role/permission/budget/approval/argv/
 *   env keys, permission-skip flag text) is scanned on the raw input first
 *   and refuses with a dedicated reason (A02/A16 by analogy);
 * - audit events are a closed field set — manifest free text is structurally
 *   unreachable (A42/A36).
 */
export * from "./errors.js";
export * from "./scope.js";
export * from "./manifest.js";
export * from "./override-scan.js";
export * from "./decision.js";
export * from "./events.js";
