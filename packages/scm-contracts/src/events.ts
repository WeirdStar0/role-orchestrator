/**
 * Audit events for SCM operations + credential scrubbing (M7-01, A42).
 *
 * Structural redaction first: ScmAuditEventSchema is a strict object with a
 * CLOSED field set that has NO credential-shaped field at all — there is no
 * place to put a token, so a leaked token cannot be serialized by a valid
 * event. Events carry content DIGESTS (sha256), never content: the text of a
 * comment body is not auditable material, its hash is.
 *
 * Defense in depth second: `scrubCredentialMaterial` deep-walks any JSON value
 * and replaces every known credential-shaped substring (./credential.js rule
 * list) with the fixed placeholder, so provider-echoed strings or free-text
 * details that smuggle a token are neutralized before they reach a sink.
 * `assertEventCarriesNoCredential` is the post-condition helper for hosts.
 */
import { z } from "zod";
import type { JsonValue } from "@role-orchestrator/contracts";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  SCM_CREDENTIAL_PLACEHOLDER,
  containsCredentialMaterial,
  scrubCredentialText
} from "./credential.js";
import {
  SCM_PROVIDERS,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  ScmOperationSchema,
  ScmProviderSchema
} from "./capability.js";
import { ScmDigestHexSchema, ScmTimestampSchema } from "./input.js";
import { ScmRepoRefSchema } from "./reads.js";

export const SCM_AUDIT_EVENT_SCHEMA_VERSION = 1 as const;

/** Closed refusal vocabulary — one code per typed refusal path in ./clients.js. */
export const SCM_AUDIT_REFUSAL_CODES = [
  "approval-required",
  "approval-ref-shape",
  "provider-not-verified",
  "operation-not-declared",
  "request-schema",
  "approval-digest-mismatch",
  "unknown-approval",
  "approval-state",
  "approval-expired",
  "approval-already-consumed",
  "consume-evidence-shape",
  "transport-contract",
  "invariant-violation"
] as const;
export const ScmAuditRefusalCodeSchema = z.enum(SCM_AUDIT_REFUSAL_CODES);
export type ScmAuditRefusalCode = (typeof SCM_AUDIT_REFUSAL_CODES)[number];

export const ScmAuditEventSchema = z.strictObject({
  schemaVersion: z.literal(SCM_AUDIT_EVENT_SCHEMA_VERSION),
  kind: z.enum(["scm.read", "scm.write"]),
  provider: ScmProviderSchema,
  operation: ScmOperationSchema,
  outcome: z.enum(["success", "refused", "failed"]),
  refusalCode: ScmAuditRefusalCodeSchema.nullable(),
  approvalId: z.string().min(1).max(128).nullable(),
  /** The presented command digest — a hash, safe for audit display. */
  actionDigest: ScmDigestHexSchema.nullable(),
  repo: ScmRepoRefSchema.nullable(),
  contentSha256: ScmDigestHexSchema.nullable(),
  executionId: IdSchema.nullable(),
  at: ScmTimestampSchema,
  /** Short structural detail; scrubbed against credential shapes on build. */
  detail: z.string().min(0).max(512)
});
export type ScmAuditEvent = z.output<typeof ScmAuditEventSchema>;

export const ScmAuditEventInputSchema = z.strictObject({
  kind: z.enum(["scm.read", "scm.write"]),
  provider: ScmProviderSchema,
  operation: ScmOperationSchema,
  outcome: z.enum(["success", "refused", "failed"]),
  refusalCode: ScmAuditRefusalCodeSchema.nullable(),
  approvalId: z.string().min(1).max(128).nullable(),
  actionDigest: ScmDigestHexSchema.nullable(),
  repo: ScmRepoRefSchema.nullable(),
  contentSha256: ScmDigestHexSchema.nullable(),
  executionId: IdSchema.nullable(),
  at: ScmTimestampSchema,
  detail: z.string().max(512)
});

/**
 * Build one audit event from structural facts. The detail string is scrubbed
 * against credential shapes; every other field is a closed enum, id, digest
 * or timestamp by schema construction.
 */
export function buildScmAuditEvent(input: z.input<typeof ScmAuditEventInputSchema>): ScmAuditEvent {
  const parsed = ScmAuditEventInputSchema.parse(input);
  const detail = scrubCredentialText(parsed.detail).text;
  return Object.freeze(
    ScmAuditEventSchema.parse({
      schemaVersion: SCM_AUDIT_EVENT_SCHEMA_VERSION,
      kind: parsed.kind,
      provider: parsed.provider,
      operation: parsed.operation,
      outcome: parsed.outcome,
      refusalCode: parsed.refusalCode,
      approvalId: parsed.approvalId,
      actionDigest: parsed.actionDigest,
      repo: parsed.repo,
      contentSha256: parsed.contentSha256,
      executionId: parsed.executionId,
      at: parsed.at,
      detail
    })
  );
}

/** Deterministic serialization (sorted keys) for sinks and tests. */
export function serializeScmAuditEvent(event: ScmAuditEvent): string {
  return JSON.stringify(event, [...Object.keys(event)].sort());
}

// ---------------------------------------------------------------------------
// Deep scrubbing (defense in depth for free-text that must flow)
// ---------------------------------------------------------------------------

export interface ScrubResult {
  readonly value: JsonValue;
  readonly redactedCount: number;
  readonly rules: readonly string[];
}

function scrubValue(value: JsonValue, result: { redactedCount: number; rules: Set<string> }): JsonValue {
  if (typeof value === "string") {
    if (!containsCredentialMaterial(value)) {
      return value;
    }
    const scrubbed = scrubCredentialText(value);
    result.redactedCount += 1;
    for (const rule of scrubbed.rules) {
      result.rules.add(rule);
    }
    return scrubbed.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, result));
  }
  if (value !== null && typeof value === "object") {
    const entries: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      entries[key] = scrubValue(item, result);
    }
    return entries;
  }
  return value;
}

/**
 * Deep-replace every credential-shaped substring in a JSON value with
 * `SCM_CREDENTIAL_PLACEHOLDER`. Idempotent (the placeholder matches no rule).
 */
export function scrubCredentialMaterial(value: JsonValue): ScrubResult {
  const result = { redactedCount: 0, rules: new Set<string>() };
  return {
    value: scrubValue(value, result),
    redactedCount: result.redactedCount,
    rules: [...result.rules].sort()
  };
}

/** Post-condition for hosts: true when serialized JSON carries no known credential shape. */
export function assertEventCarriesNoCredential(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return true;
  }
  return !containsCredentialMaterial(serialized);
}

/** Re-exports for sink wiring convenience. */
export { SCM_CREDENTIAL_PLACEHOLDER, SCM_PROVIDERS, READ_OPERATIONS, WRITE_OPERATIONS };
