/**
 * THE load decision (M7-02): one pure function, one choke point.
 *
 * `evaluatePluginLoad` is the ONLY way anything in this package says "yes"
 * to a plugin. It is pure (no I/O, no clock, no randomness), so the host can
 * — and must — re-run it for EVERY plugin tool invocation, not only once at
 * load time. That per-invocation re-evaluation IS the disable-disposal seam:
 * when the kill switch engages or an inventory record is flipped to
 * disabled/untrusted, the very next invocation is refused; there is no cached
 * acceptance to invalidate because none exists (DESIGN ONLY: the real loader
 * that would drive this loop is future work — see the M7-02 design document).
 *
 * Check order is CONTRACT (each step has a test):
 *   1. override-vocabulary injection scan on the RAW input   -> override-field
 *   2. strict manifest schema parse (incl. semver/integrity) -> schema-invalid
 *   3. global / per-id kill switch                            -> kill-switch
 *   4. inventory presence (default deny)                      -> untrusted-source
 *   5. inventory disabled flag                                -> disabled
 *   6. inventory tier is untrusted                            -> untrusted-source
 *   7. manifest trust claim must EQUAL inventory tier         -> trust-claim-mismatch
 *   8. manifest self-pin: recomputed canonical-manifest sha256
 *      vs the inventory `manifestSha256` pin (EVERY tier — a
 *      null pin is a rejection, never an exemption)           -> manifest-pin-mismatch
 *   9. integrity: artifact bytes vs manifest digest, manifest
 *      digest vs inventory pin                                -> integrity-mismatch
 *  10. every declared scope within the host allowlist         -> scope-not-allowlisted
 *  11. accept, carrying the scope→control bindings as data.
 *
 * Step 8 exists because steps 2+9 alone pin only the ARTIFACT bytes: a
 * manifest whose scopes/entrypoint/name were edited while keeping its
 * `integrity.digest` field (and artifact) unchanged used to pass every pin.
 * The self-pin covers the WHOLE canonical manifest value instead, so any
 * content drift from the approved manifest is a rejection in its own right
 * (HARDENING-1, review minor #1/#27).
 *
 * Rejection details are STRUCTURAL ONLY (closed-vocabulary tokens, zod issue
 * paths + codes): manifest name/description/free text never reaches a detail
 * string, an error message, or an audit event (A42/A36/A16 discipline).
 */
import { z } from "zod";
import { withUniqueItems } from "@role-orchestrator/contracts";
import { PluginDecisionInputError } from "./errors.js";
import { PluginIdSchema, PluginManifestSchema, PluginInventoryRecordSchema, Sha256HexSchema, canonicalPluginManifestSha256, type PluginId, type PluginManifest, type PluginInventoryRecord, type PluginTrustTier, type SemVer } from "./manifest.js";
import { PluginScopeSchema, SCOPE_CONTROL_BINDINGS, type PluginScope, type ScopeControlBinding } from "./scope.js";
import { scanForOverrideInjection } from "./override-scan.js";

/** Closed rejection vocabulary; 1:1 with the check-order steps above. */
export const PLUGIN_LOAD_REJECTION_REASONS = [
  "override-field",
  "schema-invalid",
  "kill-switch",
  "disabled",
  "untrusted-source",
  "trust-claim-mismatch",
  "manifest-pin-mismatch",
  "integrity-mismatch",
  "scope-not-allowlisted"
] as const;
export const PluginRejectionReasonSchema = z.enum(PLUGIN_LOAD_REJECTION_REASONS);
export type PluginRejectionReason = (typeof PLUGIN_LOAD_REJECTION_REASONS)[number];

const DecisionInputSchema = z.strictObject({
  /** RAW manifest value (untyped on purpose: malformed manifests are a rejection, not a host error). */
  manifest: z.unknown(),
  /** sha256 over the ACTUAL artifact bytes, computed by the host BEFORE deciding. */
  artifactSha256: Sha256HexSchema,
  /** Host inventory record for the plugin id; null = unlisted = untrusted (default deny). */
  inventoryRecord: PluginInventoryRecordSchema.nullable(),
  /** The host-configured scope allowlist for this run/role (closed vocabulary, exact match). */
  scopeAllowlist: withUniqueItems(z.array(PluginScopeSchema)),
  /** EMERGENCY stop: refuse every plugin regardless of anything else. */
  killSwitchAll: z.boolean().default(false),
  /** EMERGENCY stop for specific plugin ids. */
  killSwitchIds: z.array(PluginIdSchema).default([])
});

export type PluginLoadDecisionInput = {
  manifest: unknown;
  artifactSha256: string;
  inventoryRecord: PluginInventoryRecord | null;
  scopeAllowlist: readonly PluginScope[];
  killSwitchAll?: boolean;
  killSwitchIds?: readonly PluginId[];
};

export interface PluginLoadAccept {
  readonly outcome: "accept";
  readonly pluginId: PluginId;
  readonly version: SemVer;
  /** Effective tier — builtin or verified only; never untrusted. */
  readonly tier: Exclude<PluginTrustTier, "untrusted">;
  readonly integrityDigest: string;
  readonly grantedScopes: readonly PluginScope[];
  /** Scope → existing-control bindings (data for the execution layer). */
  readonly scopeBindings: readonly (readonly [PluginScope, ScopeControlBinding])[];
}

export interface PluginLoadReject {
  readonly outcome: "reject";
  readonly reason: PluginRejectionReason;
  /** Structural facts only — never manifest free text. */
  readonly detail: string;
  /** Set only when the manifest schema parse had already succeeded. */
  readonly pluginId: PluginId | null;
  readonly version: SemVer | null;
  readonly integrityDigest: string | null;
}

export type PluginLoadDecision = PluginLoadAccept | PluginLoadReject;

function reject(
  reason: PluginRejectionReason,
  detail: string,
  parsed: PluginManifest | null
): PluginLoadReject {
  return {
    outcome: "reject",
    reason,
    detail,
    pluginId: parsed?.id ?? null,
    version: parsed?.version ?? null,
    integrityDigest: parsed?.integrity.digest ?? null
  };
}

/** Structural zod issue summary: path + code, never the received value. */
function schemaIssueSummary(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return "unknown schema issue";
  return `${first.path.join(".") || "<root>"}: ${first.code}`;
}

export function evaluatePluginLoad(input: PluginLoadDecisionInput): PluginLoadDecision {
  const parsedInput = DecisionInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new PluginDecisionInputError(parsedInput.error);
  }
  const options = parsedInput.data;

  // 1. Override vocabulary — on the raw value, before any schema parse.
  const injection = scanForOverrideInjection(options.manifest);
  if (injection.detected) {
    return reject(
      "override-field",
      `forbidden override vocabulary at: ${injection.paths.slice(0, 4).join(", ")}`,
      null
    );
  }

  // 2. Strict manifest schema (unknown fields, semver, integrity shape, enums).
  const parsedManifest = PluginManifestSchema.safeParse(options.manifest);
  if (!parsedManifest.success) {
    return reject("schema-invalid", `manifest failed strict schema: ${schemaIssueSummary(parsedManifest.error)}`, null);
  }
  const manifest = parsedManifest.data;

  // 3. Kill switch — emergency stop wins over every other fact about the plugin.
  if (options.killSwitchAll) {
    return reject("kill-switch", "global kill switch engaged; every plugin is refused", manifest);
  }
  if (options.killSwitchIds.includes(manifest.id)) {
    return reject("kill-switch", "plugin id is on the kill-switch list", manifest);
  }

  // 4. Default deny: an id absent from the inventory is untrusted.
  const record = options.inventoryRecord;
  if (record === null) {
    return reject("untrusted-source", "plugin id is absent from the trust inventory (default deny)", manifest);
  }

  // 5. Explicitly disabled in the inventory.
  if (record.disabled) {
    return reject("disabled", "inventory record is disabled", manifest);
  }

  // 6. Untrusted tier never loads — including a record that exists but was
  //    never promoted.
  if (record.tier === "untrusted") {
    return reject("untrusted-source", "inventory tier is untrusted", manifest);
  }

  // 7. The publisher's trust claim must agree with the inventory; a
  //    self-promoting or swapped manifest fails closed.
  if (manifest.trust !== record.tier) {
    return reject(
      "trust-claim-mismatch",
      `manifest claims trust "${manifest.trust}" but inventory records "${record.tier}"`,
      manifest
    );
  }

  // 8. Manifest self-pin — the WHOLE canonical manifest is pinned by the
  //    inventory, at EVERY tier: a null pin refuses (it is a broken record,
  //    not a builtin exemption), and any content drift from the approved
  //    manifest (scopes, entrypoint, name, version, ...) refuses even when
  //    the artifact digest fields still agree. The digest is recomputed over
  //    the parsed manifest, so it tracks the value actually presented.
  if (record.manifestSha256 === null) {
    return reject("manifest-pin-mismatch", "inventory record carries no canonical manifest self-pin", manifest);
  }
  const presentedPin = canonicalPluginManifestSha256(manifest);
  if (presentedPin !== record.manifestSha256) {
    // Both sides of the pin comparison are sha256 hex STRUCTURAL facts (same
    // discipline as `integrityDigest`): no manifest free text reaches the
    // detail (A42/A36). The null-pin branch above has no "both sides".
    return reject(
      "manifest-pin-mismatch",
      `manifest as presented does not match the inventory canonical-manifest pin ` +
        `(presented ${presentedPin} vs pinned ${record.manifestSha256})`,
      manifest
    );
  }

  // 9. Content integrity — two independent artifact pins must both hold.
  if (record.recordedDigest !== null && record.recordedDigest !== manifest.integrity.digest) {
    return reject("integrity-mismatch", "manifest digest does not match the inventory pin", manifest);
  }
  if (options.artifactSha256 !== manifest.integrity.digest) {
    return reject("integrity-mismatch", "artifact bytes do not match the manifest integrity digest", manifest);
  }

  // 10. Declarative, minimal scope authorization: every declared scope must be
  //    in the host allowlist (exact membership, closed vocabulary).
  const outside = manifest.scopes.filter((scope) => !options.scopeAllowlist.includes(scope));
  if (outside.length > 0) {
    return reject(
      "scope-not-allowlisted",
      `declared scope(s) outside the host allowlist: ${outside.join(", ")}`,
      manifest
    );
  }

  // 11. Accept. Scope bindings ride along as data; enforcement stays with the
  //     execution layer, which re-consults this decision per invocation.
  return {
    outcome: "accept",
    pluginId: manifest.id,
    version: manifest.version,
    tier: record.tier,
    integrityDigest: manifest.integrity.digest,
    grantedScopes: [...manifest.scopes],
    scopeBindings: manifest.scopes.map((scope) => [scope, SCOPE_CONTROL_BINDINGS[scope]] as const)
  };
}
