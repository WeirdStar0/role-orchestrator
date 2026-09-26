/**
 * Shared hermetic test plumbing for the M7-02 plugin-registry suite.
 *
 * Everything is pure or local: sha256 fixtures computed in-process with
 * node:crypto, raw manifest objects as plain records (the schema/scan is the
 * boundary). No filesystem, no processes, no network, no real plugins — the
 * "artifact" is just the byte string hashed here.
 */
import { createHash } from "node:crypto";
import { canonicalPluginManifestSha256, type PluginInventoryRecord, type PluginTrustTier } from "../src/index.js";

/** Deterministic artifact digests (computed, not invented). */
export const ARTIFACT_BYTES_A = "plugin-artifact-bytes-a";
export const ARTIFACT_BYTES_B = "plugin-artifact-bytes-b";
export const sha256Hex = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
export const DIGEST_A = sha256Hex(ARTIFACT_BYTES_A);
export const DIGEST_B = sha256Hex(ARTIFACT_BYTES_B);
export const OTHER_DIGEST = "c".repeat(64);

export const T0 = "2026-09-24T00:00:00.000Z";

export const PLUGIN_ID = "example-tools.text-lint";
export const VALID_SEMVER = "1.2.3";
export const PRERELEASE_SEMVER = "2.0.0-rc.1+build.7";

/**
 * A raw, schema-valid manifest record. Overrides are applied last so tests
 * can inject hostile fields (the strict schema/scan is the thing under test).
 */
export function manifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: PLUGIN_ID,
    name: "Example Text Lint",
    version: VALID_SEMVER,
    description: "Read-only lint hints for markdown files.",
    entrypoint: "dist/index.js",
    integrity: { algorithm: "sha256", digest: DIGEST_A },
    scopes: ["repo.read"],
    trust: "builtin",
    ...overrides
  };
}

/**
 * A host inventory record agreeing with the default fixture manifest. The
 * canonical-manifest self-pin (`manifestSha256`) is computed over the DEFAULT
 * fixture manifest — a test that tampers with the manifest (any field, any
 * nesting) while reusing this record exercises the self-pin refusal, exactly
 * the defect shape HARDENING-1 closes.
 */
export function inventoryFixture(overrides: Partial<PluginInventoryRecord> = {}): PluginInventoryRecord {
  return {
    id: PLUGIN_ID,
    tier: "builtin" as PluginTrustTier,
    disabled: false,
    recordedDigest: null,
    manifestSha256: canonicalPluginManifestSha256(manifestFixture()),
    source: "builtin:example-tools",
    ...overrides
  };
}

/**
 * An inventory record whose self-pin is computed over the EXACT manifest a
 * test presents (HARDENING-1: the pin covers the whole canonical manifest,
 * including `trust`, so a record must always be pinned to the manifest as
 * approved). Tier/digest adjustments ride on top.
 */
export function inventoryFor(
  manifest: unknown,
  overrides: Partial<PluginInventoryRecord> = {}
): PluginInventoryRecord {
  return inventoryFixture({ manifestSha256: canonicalPluginManifestSha256(manifest), ...overrides });
}
