import { z } from "zod";
import { ConcurrencyPolicySchema, type ConcurrencyPolicy } from "@role-orchestrator/contracts";
import { isUsable, statusOf, type CapabilityStatus } from "@role-orchestrator/capability-gate";
import { InvalidConcurrencyPolicyError } from "./errors.js";

/**
 * Quota policy resolution (M2-02).
 *
 * The three concurrency levels and the credential lock draw from exactly two
 * sources, both validated strictly:
 *
 * 1. `policies.concurrency` (frozen contracts `ConcurrencyPolicySchema`,
 *    strict): `globalMax`, `projectMax`, and `unverifiedCredentialGroupMax`
 *    (a `z.literal(1)` — A33 pins unverified groups at 1; it is a governance
 *    constant, NOT a knob).
 * 2. `profiles.max_concurrency` (1..32, store-enforced) for the per-profile
 *    level.
 *
 * ORCHESTRATION.md section 4 forbids collapsing the levels into
 * `min(global, project, profile)`: each level is enforced as its OWN counted
 * resource key, checked simultaneously by one claim transaction.
 */

/** Strict parse of the raw policies `concurrency` section (unknown fields rejected). */
export function parseConcurrencyPolicy(raw: unknown): ConcurrencyPolicy {
  const result = ConcurrencyPolicySchema.safeParse(raw);
  if (!result.success) {
    throw new InvalidConcurrencyPolicyError({ cause: result.error });
  }
  return result.data;
}

const CredentialGroupMaxInputSchema = z.strictObject({
  runtime: z.enum(["claude", "codex"]),
  /** From the strict-parsed policy; 1 by the frozen contract's `z.literal(1)`. */
  unverifiedCredentialGroupMax: z.literal(1)
});

/**
 * The effective credentialGroup lock for one profile runtime, or `null` when
 * the dimension adds no restriction.
 *
 * A33 semantics: "Profile 目录分开但凭据共享 → 不标记 verified，认证锁限制并
 * 发". The isolation status is read from the capability-gate registry —
 * `<runtime>.credential-isolation` — and ONLY a `verified` status (real,
 * accepted M0+ evidence) lifts the lock. Unknown capability ids report
 * `unverified` via the gate's fail-closed `statusOf`, so an unknown runtime is
 * locked too, never unlocked by absence of data.
 *
 * Returns `unverifiedCredentialGroupMax` (always 1 by contract) while the
 * isolation is unverified; `null` once verified (the three-level quota then
 * already caps the profile; the credential dimension does not double-count).
 */
export function credentialGroupMax(
  runtime: z.infer<typeof CredentialGroupMaxInputSchema>["runtime"],
  unverifiedCredentialGroupMax: ConcurrencyPolicy["unverifiedCredentialGroupMax"]
): number | null {
  CredentialGroupMaxInputSchema.parse({ runtime, unverifiedCredentialGroupMax });
  const lookup = statusOf(credentialIsolationCapabilityId(runtime));
  if (isUsable(lookup.status) && lookup.known) {
    return null;
  }
  return unverifiedCredentialGroupMax;
}

/** Capability-matrix cell id for a runtime's noninteractive entry point. */
export function entryCapabilityId(runtime: string): string {
  return `${runtime}.noninteractive-entry`;
}

/** Capability-matrix cell id for a runtime's credential isolation status (A33). */
export function credentialIsolationCapabilityId(runtime: string): string {
  return `${runtime}.credential-isolation`;
}

/** The gate decision for one dispatch: fail-closed, typed, recorded verbatim. */
export interface DispatchGateDecision {
  readonly allowed: boolean;
  /** The capability id that decided the outcome (the failing one when blocked). */
  readonly capability: string;
  /** The registry status that decided the outcome; `"unverified"` for unknown ids. */
  readonly status: CapabilityStatus;
  /** Human-readable reason when `allowed === false`; null otherwise. */
  readonly reason: string | null;
}

/**
 * Pre-dispatch capability gate (A33-consistent wiring of
 * `@role-orchestrator/capability-gate`):
 *
 * 1. the profile runtime's noninteractive entry capability
 *    (`<runtime>.noninteractive-entry`) must be `verified`;
 * 2. the entry's optional `requiredCapability` (a capability-matrix cell id
 *    carried on the queue row) must ALSO be `verified`.
 *
 * Unknown capability ids are rejected (`statusOf` reports them as unverified
 * with `known: false` — "Unknown 能力不视作允许"), never silently skipped.
 */
export function evaluateDispatchGate(
  runtime: string,
  requiredCapability: string | null
): DispatchGateDecision {
  const entryId = entryCapabilityId(runtime);
  const entry = statusOf(entryId);
  if (!isUsable(entry.status)) {
    return {
      allowed: false,
      capability: entryId,
      status: entry.status,
      reason: entry.known
        ? `capability "${entryId}" is ${entry.status} in the capability matrix; dispatching would run without a verified entry point`
        : `capability "${entryId}" is unknown to the capability matrix; denied by default`
    };
  }
  if (requiredCapability === null) {
    return { allowed: true, capability: entryId, status: entry.status, reason: null };
  }
  const required = statusOf(requiredCapability);
  if (!isUsable(required.status)) {
    return {
      allowed: false,
      capability: requiredCapability,
      status: required.status,
      reason: required.known
        ? `required capability "${requiredCapability}" is ${required.status} in the capability matrix`
        : `required capability "${requiredCapability}" is unknown to the capability matrix; denied by default`
    };
  }
  return { allowed: true, capability: requiredCapability, status: required.status, reason: null };
}
