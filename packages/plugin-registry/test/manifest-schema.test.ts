/**
 * Strict-schema behavior of the plugin manifest and the trust inventory
 * record (M7-02): unknown fields rejected, strict SemVer enforced, integrity
 * shape enforced, closed scope/trust enums, duplicate scopes rejected,
 * hostile text rejected, entrypoint traversal shapes rejected, verified-tier
 * digest pin required.
 */
import { describe, expect, it } from "vitest";
import {
  PluginInventoryRecordSchema,
  PluginManifestSchema
} from "../src/index.js";
import { DIGEST_A, inventoryFixture, manifestFixture } from "./helpers.js";

describe("manifest strict schema", () => {
  it("accepts the valid fixture, including prerelease/build semver", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture()).success).toBe(true);
    expect(
      PluginManifestSchema.safeParse(manifestFixture({ version: "2.0.0-rc.1+build.7" })).success
    ).toBe(true);
  });

  it("rejects unknown fields at the top level and in nested objects", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ extra: 1 })).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse(
        manifestFixture({ integrity: { algorithm: "sha256", digest: DIGEST_A, note: "x" } })
      ).success
    ).toBe(false);
  });

  it("rejects illegal semver shapes (strict SemVer 2.0.0)", () => {
    for (const bad of ["1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.3-01", "1.2.3.4", "1.2.3+", ""].map(
      (version) => manifestFixture({ version })
    )) {
      expect(PluginManifestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects malformed integrity blocks", () => {
    const digest = (d: string) => manifestFixture({ integrity: { algorithm: "sha256", digest: d } });
    expect(PluginManifestSchema.safeParse(digest(DIGEST_A.toUpperCase())).success).toBe(false);
    expect(PluginManifestSchema.safeParse(digest("a".repeat(63))).success).toBe(false);
    expect(PluginManifestSchema.safeParse(digest("a".repeat(65))).success).toBe(false);
    expect(PluginManifestSchema.safeParse(digest("g".repeat(64))).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse(manifestFixture({ integrity: { algorithm: "sha512", digest: DIGEST_A } }))
        .success
    ).toBe(false);
  });

  it("rejects duplicate scopes and out-of-vocabulary scopes (closed enum)", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ scopes: ["repo.read", "repo.read"] })).success).toBe(
      false
    );
    expect(PluginManifestSchema.safeParse(manifestFixture({ scopes: ["dag.propose"] })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ scopes: ["exec.spawn"] })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ scopes: ["repo.read "] })).success).toBe(false);
  });

  it("allows an empty scope list (least-privilege floor: a capability-free plugin)", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ scopes: [] })).success).toBe(true);
  });

  it("rejects unknown trust tiers and wrong manifest versions", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ trust: "self-attested" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ manifestVersion: 2 })).success).toBe(false);
  });

  it("rejects malformed ids", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ id: "1abc" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ id: "UPPER.x" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ id: "a b" })).success).toBe(false);
  });

  it("rejects control characters and Trojan-Source bidi overrides in text fields", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ name: "bad\u0000name" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ name: "bad\u202Ename" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ description: "ok\u200Bbidi" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ description: "a".repeat(513) })).success).toBe(false);
  });

  it("rejects entrypoint traversal and absolute shapes", () => {
    expect(PluginManifestSchema.safeParse(manifestFixture({ entrypoint: "../escape.js" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ entrypoint: "/abs/path.js" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ entrypoint: "C:\\x.js" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ entrypoint: "a/../b.js" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ entrypoint: "a//b.js" })).success).toBe(false);
    expect(PluginManifestSchema.safeParse(manifestFixture({ entrypoint: "dist/index.js" })).success).toBe(true);
  });
});

describe("inventory record schema", () => {
  it("accepts builtin with or without a digest pin", () => {
    expect(PluginInventoryRecordSchema.safeParse(inventoryFixture()).success).toBe(true);
    expect(
      PluginInventoryRecordSchema.safeParse(inventoryFixture({ recordedDigest: DIGEST_A })).success
    ).toBe(true);
  });

  it("requires a recordedDigest pin for the verified tier (fail closed)", () => {
    expect(
      PluginInventoryRecordSchema.safeParse(
        inventoryFixture({ tier: "verified", recordedDigest: null })
      ).success
    ).toBe(false);
    expect(
      PluginInventoryRecordSchema.safeParse(
        inventoryFixture({ tier: "verified", recordedDigest: DIGEST_A })
      ).success
    ).toBe(true);
  });

  it("rejects unknown fields and malformed digests", () => {
    expect(
      PluginInventoryRecordSchema.safeParse({ ...inventoryFixture(), extra: true }).success
    ).toBe(false);
    expect(
      PluginInventoryRecordSchema.safeParse(inventoryFixture({ recordedDigest: "zz" })).success
    ).toBe(false);
  });

  it("HARDENING-1: the canonical-manifest self-pin is a nullable sha256 field, never skippable by omission", () => {
    expect(
      PluginInventoryRecordSchema.safeParse(inventoryFixture({ manifestSha256: DIGEST_A })).success
    ).toBe(true);
    expect(
      PluginInventoryRecordSchema.safeParse(inventoryFixture({ manifestSha256: null })).success
    ).toBe(true); // parseable; the load decision refuses a null pin
    // Garbage pins fail the schema; an ABSENT pin fails strict schema (the
    // host input error), so an old pre-HARDENING-1 record cannot silently
    // evaluate.
    expect(
      PluginInventoryRecordSchema.safeParse(inventoryFixture({ manifestSha256: "zz" })).success
    ).toBe(false);
    const withoutField = inventoryFixture();
    delete (withoutField as Record<string, unknown>).manifestSha256;
    expect(PluginInventoryRecordSchema.safeParse(withoutField).success).toBe(false);
  });
});
