/**
 * Versioned plugin manifest + host-side trust inventory records (M7-02).
 *
 * The manifest is what a plugin SHIPS; the inventory record is what the HOST
 * records about a source after explicit management (capability-gate
 * requiredControl "explicit-management": inventory + hash + explicit
 * trust/disable before execution). Trust is NEVER taken from the manifest
 * alone: the publisher states a claim and the inventory must AGREE, otherwise
 * the load decision refuses (`trust-claim-mismatch`) — a swapped or
 * self-promoting manifest under a trusted id fails closed.
 *
 * Schema discipline (mirrors the frozen bundle + scm-contracts):
 * - every object is strict; unknown fields are rejected, never ignored;
 * - every text field rejects control characters and Trojan-Source bidi
 *   overrides (fail closed, no sanitization);
 * - closed enums everywhere; new scopes/tiers are schema changes that need
 *   review, not data edits.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { withUniqueItems } from "@role-orchestrator/contracts";
import { PluginScopeSchema } from "./scope.js";

/** The only manifest shape v1 understands; bumping is a breaking schema change. */
export const PLUGIN_MANIFEST_VERSION = 1;

/** Plugin ids share the gate id shape but are their own namespace. */
export const PluginIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/, {
  message: "plugin id must match ^[a-z][a-z0-9.-]{1,79}$"
});
export type PluginId = z.output<typeof PluginIdSchema>;

/**
 * Strict SemVer 2.0.0 (no leading zeros, optional prerelease/build) —
 * implemented locally; the repository adds no external dependency for it.
 */
const SEMVER_SOURCE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const SemVerSchema = z.string().min(5).max(64).regex(SEMVER_SOURCE, {
  message: "version must be a strict SemVer 2.0.0 string (MAJOR.MINOR.PATCH[-prerelease][+build])"
});
export type SemVer = z.output<typeof SemVerSchema>;

/** sha256 content digests: 64 LOWERCASE hex chars (uppercase is rejected). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "digest must be 64 lowercase hex characters"
});
export type Sha256Hex = z.output<typeof Sha256HexSchema>;

/** Content integrity block of the artifact the manifest describes. */
export const PluginIntegritySchema = z.strictObject({
  algorithm: z.literal("sha256"),
  digest: Sha256HexSchema
});

/** Trust tiers. "untrusted" is the DEFAULT: an unlisted plugin is untrusted. */
export const PLUGIN_TRUST_TIERS = ["builtin", "verified", "untrusted"] as const;
export const PluginTrustTierSchema = z.enum(PLUGIN_TRUST_TIERS);
export type PluginTrustTier = (typeof PLUGIN_TRUST_TIERS)[number];

/**
 * Manifest free text: short, printable, no control characters and no
 * Trojan-Source bidi/zero-width overrides (U+200B–200F, U+202A–202E,
 * U+2060–2069, U+FEFF). Rejected, never sanitized.
 */
const BIDI_OVERRIDES = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
const ManifestTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001F\u007F]*$/, {
      message: "manifest text must not contain control characters"
    })
    .refine((value) => !BIDI_OVERRIDES.test(value), {
      message: "manifest text must not contain bidi/zero-width override characters"
    });

/**
 * Entrypoint: a RELATIVE posix-style path with no `.`/`..` segments, no
 * leading slash, no backslash, no drive letters. DESIGN ONLY — the future
 * real loader must additionally resolve and re-verify against the actual
 * filesystem; this schema only makes traversal shapes inexpressible.
 */
export const PluginEntrypointSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, {
    message: "entrypoint must be a relative posix-style path (no leading slash, no backslash)"
  })
  .check((ctx) => {
    if (ctx.value.split("/").some((segment) => segment === "." || segment === "..")) {
      ctx.issues.push({
        code: "custom",
        message: "entrypoint must not contain . or .. segments",
        input: ctx.value
      });
    }
  });

/**
 * The versioned plugin manifest. NOTE what does NOT exist here: there is NO
 * field that can carry a model, Profile, role, permission grant, budget,
 * quota, approval, argv, env or hook definition — override vocabulary cannot
 * be expressed even before the strict unknown-field rejection fires (the
 * dedicated injection scan in ./override-scan.js runs first and names it).
 */
export const PluginManifestSchema = z.strictObject({
  manifestVersion: z.literal(PLUGIN_MANIFEST_VERSION),
  id: PluginIdSchema,
  name: ManifestTextSchema(128),
  version: SemVerSchema,
  description: ManifestTextSchema(512),
  entrypoint: PluginEntrypointSchema,
  integrity: PluginIntegritySchema,
  /** Declared scopes; duplicates rejected. An empty list is LEGAL and is the least-privilege floor (a capability-free plugin). */
  scopes: withUniqueItems(z.array(PluginScopeSchema).max(16)),
  /** Publisher trust claim; must EQUAL the host inventory tier or the load refuses. */
  trust: PluginTrustTierSchema
});
export type PluginManifest = z.output<typeof PluginManifestSchema>;

/**
 * One host inventory record: the result of explicit source management.
 * - `tier` is the authoritative trust decision (default deny: absent id ⇒
 *   untrusted, see ./decision.js).
 * - `disabled: true` is the per-plugin disable flag (complementing the
 *   runtime kill switch in the decision input).
 * - `recordedDigest` pins the EXACT artifact the tier was granted to; a
 *   "verified" tier MUST carry the pin (schema-checked below), so swapping
 *   the artifact under an unchanged manifest id fails the integrity check.
 * - `manifestSha256` pins the ENTIRE canonical manifest (HARDENING-1 / review
 *   minor #1/#27): sha256 over the deterministic canonical serialization of
 *   the whole approved manifest value, NOT just its `integrity.digest` field.
 *   The load decision re-computes this digest for EVERY tier and refuses with
 *   `manifest-pin-mismatch` on any difference — so editing scopes/entrypoint/
 *   name/... while keeping the digest fields can no longer slip a tampered
 *   manifest past the pins. Unlike `recordedDigest` (whose null is a builtin-
 *   tier artifact-pin exemption), this pin is NEVER skippable: `null` is a
 *   decision rejection, not an exemption.
 * - `source` is a structural provenance label (e.g. "builtin:core-tools"),
 *   constrained by the same text rules as manifest text.
 */
export const PluginInventoryRecordSchema = z
  .strictObject({
    id: PluginIdSchema,
    tier: PluginTrustTierSchema,
    disabled: z.boolean(),
    recordedDigest: Sha256HexSchema.nullable(),
    manifestSha256: Sha256HexSchema.nullable(),
    source: ManifestTextSchema(128)
  })
  .check((ctx) => {
    if (ctx.value.tier === "verified" && ctx.value.recordedDigest === null) {
      ctx.issues.push({
        code: "custom",
        message: 'inventory tier "verified" requires a recordedDigest pin',
        input: ctx.value.tier,
        path: ["recordedDigest"]
      });
    }
  });
export type PluginInventoryRecord = z.output<typeof PluginInventoryRecordSchema>;

/**
 * Deterministic canonical JSON serialization: object keys recursively sorted
 * by UTF-16 code-unit order (NOT locale-aware — the digest must be identical
 * on every host), arrays in order, no whitespace. This — not the file's byte
 * layout — is the content the manifest self-pin covers, so re-serialization
 * or key reordering of the SAME approved manifest keeps the pin, while ANY
 * value change (a scope, the entrypoint, the name, the version, ...) breaks
 * it. Defined here next to the schema it digests; used by the load decision.
 */
export function canonicalPluginManifestJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) as string;
    if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
  };
  return encode(value);
}

/**
 * The manifest self-pin value for an approved manifest: sha256 (lowercase hex)
 * over {@link canonicalPluginManifestJson} of the manifest as it was approved
 * at explicit-management time. The load decision re-computes exactly this over
 * the manifest as presented and requires equality — see ./decision.js.
 */
export function canonicalPluginManifestSha256(manifest: unknown): string {
  return createHash("sha256").update(canonicalPluginManifestJson(manifest), "utf8").digest("hex");
}
