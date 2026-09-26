/**
 * Plugin audit events (M7-02) — structural facts only (A42/A36/A16).
 *
 * The event schema is a CLOSED field set with no field that could carry
 * manifest free text, credentials, or instruction-like content: id, version,
 * digest, tier, decision, reason, timestamp. `pluginLoadAuditEvent` is a pure
 * projection from a {@link PluginLoadDecision} + inventory tier, so the
 * hostile name/description strings a manifest may carry are structurally
 * unreachable from the audit surface — not scrubbed, UNREACHABLE (the same
 * "closed schema is the redaction" posture as scm-contracts events).
 *
 * For rejections that happen before the manifest schema parse succeeds
 * (`override-field`, `schema-invalid`), the id/version/digest fields are
 * null: unparseable attacker-controlled data is never copied into audit
 * records, not even its id field.
 */
import { z } from "zod";
import {
  PluginIdSchema,
  PluginTrustTierSchema,
  SemVerSchema,
  Sha256HexSchema,
  type PluginTrustTier
} from "./manifest.js";
import { PluginRejectionReasonSchema, type PluginLoadDecision } from "./decision.js";

export const PLUGIN_AUDIT_EVENT_KINDS = ["plugin.load"] as const;
export const PluginAuditEventKindSchema = z.enum(PLUGIN_AUDIT_EVENT_KINDS);

/** ISO-8601 UTC timestamp (the repo's canonical event timestamp shape). */
const IsoUtcSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, {
  message: "timestamp must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SS[.mmm]Z)"
});

export const PluginAuditEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: PluginAuditEventKindSchema,
  pluginId: PluginIdSchema.nullable(),
  version: SemVerSchema.nullable(),
  integrityDigest: Sha256HexSchema.nullable(),
  /** Inventory tier when known; null when the manifest never parsed. */
  tier: PluginTrustTierSchema.nullable(),
  decision: z.enum(["accept", "reject"]),
  /** null exactly when decision is "accept". */
  reason: PluginRejectionReasonSchema.nullable(),
  at: IsoUtcSchema
});
export type PluginAuditEvent = z.output<typeof PluginAuditEventSchema>;

/** Pure projection decision → audit event. Deterministic; no manifest text in, none out. */
export function pluginLoadAuditEvent(input: {
  readonly decision: PluginLoadDecision;
  /** The authoritative inventory tier, when the decision consulted one. */
  readonly tier: PluginTrustTier | null;
  readonly at: string;
}): PluginAuditEvent {
  const decision = input.decision;
  const event: PluginAuditEvent = {
    schemaVersion: 1,
    kind: "plugin.load",
    pluginId: decision.pluginId,
    version: decision.version,
    integrityDigest: decision.integrityDigest,
    tier: input.tier,
    decision: decision.outcome,
    reason: decision.outcome === "reject" ? decision.reason : null,
    at: input.at
  };
  return PluginAuditEventSchema.parse(event);
}
