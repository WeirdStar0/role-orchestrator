/**
 * @role-orchestrator/scm-contracts — M7-01 controlled GitHub/GitLab
 * integration contracts. DESIGN ONLY: no live provider is contacted by this
 * package (there is no transport implementation and no network code); the
 * shipped compatibility matrix pins every provider cell to `unverified`, so
 * with the default lookup neither a read nor a write client can even be
 * constructed.
 *
 * Fail-closed posture (docs/SECURITY_MODEL.md; ACCEPTANCE A17/A42):
 * - read/write separation as a DOUBLE fact — the read-only client and its
 *   transport have no write members at the type level (compile-time
 *   assertions in ./clients.js), and runtime guards re-check the surface;
 * - remote writes REQUIRE an ApprovalRef carrying the approval package's
 *   actionDigest of the EXACT command: post-approval changes to the target
 *   PR/issue/SHA/content/binding recompute a different digest and the
 *   original approval becomes unconsumable (A17 by analogy), while
 *   consumption stays the approval lifecycle's guarded single-shot CAS;
 * - credentials exist only as references (ScmCredentialRef) and opaque
 *   secret-free handles — plaintext token shapes are rejected at the schema
 *   and scrubbed at every audit sink (A42);
 * - every input crosses a strict zod schema: unknown fields are rejected,
 *   oversized strings, control characters and Trojan-Source bidi overrides
 *   fail closed.
 */
export * from "./errors.js";
export * from "./input.js";
export * from "./capability.js";
export * from "./credential.js";
export * from "./reads.js";
export * from "./writes.js";
export * from "./write-binding.js";
export * from "./events.js";
export * from "./clients.js";
