/**
 * The load decision contract (M7-02): every rejection branch of
 * `evaluatePluginLoad`, the accept path with its scope→control bindings, the
 * default-deny posture, the kill-switch precedence, the double integrity pin,
 * the host-input error surface, and the per-invocation re-evaluation seam
 * that implements disable disposal. All pure; hermetic by construction.
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_IDS } from "@role-orchestrator/contracts";
import {
  PLUGIN_SCOPES,
  SCOPE_CONTROL_BINDINGS,
  canonicalPluginManifestSha256,
  evaluatePluginLoad,
  type PluginLoadDecisionInput
} from "../src/index.js";
import { ARTIFACT_BYTES_A, DIGEST_A, DIGEST_B, inventoryFixture, inventoryFor, manifestFixture, PLUGIN_ID, sha256Hex } from "./helpers.js";

function decision(overrides: Partial<PluginLoadDecisionInput> = {}) {
  return evaluatePluginLoad({
    manifest: manifestFixture(),
    artifactSha256: DIGEST_A,
    inventoryRecord: inventoryFixture(),
    scopeAllowlist: ["repo.read", "repo.write", "git.read", "tests.run", "memory.propose"],
    ...overrides
  });
}

describe("accept path", () => {
  it("accepts a builtin plugin and echoes scope→control bindings as data", () => {
    const result = decision();
    expect(result.outcome).toBe("accept");
    if (result.outcome !== "accept") return;
    expect(result.pluginId).toBe(PLUGIN_ID);
    expect(result.tier).toBe("builtin");
    expect(result.grantedScopes).toEqual(["repo.read"]);
    expect(result.scopeBindings).toEqual([["repo.read", SCOPE_CONTROL_BINDINGS["repo.read"]]]);
    expect(result.integrityDigest).toBe(DIGEST_A);
  });

  it("accepts a verified plugin whose inventory pin matches the manifest digest", () => {
    const verifiedManifest = manifestFixture({ trust: "verified" });
    const result = decision({
      inventoryRecord: inventoryFor(verifiedManifest, { tier: "verified", recordedDigest: DIGEST_A }),
      manifest: verifiedManifest
    });
    expect(result.outcome).toBe("accept");
    if (result.outcome !== "accept") return;
    expect(result.tier).toBe("verified");
  });

  it("is pure: the same input yields an equal decision", () => {
    expect(decision()).toEqual(decision());
  });
});

describe("default deny and trust tiers", () => {
  it("refuses a plugin id absent from the inventory (default deny)", () => {
    const result = decision({ inventoryRecord: null });
    expect(result).toMatchObject({ outcome: "reject", reason: "untrusted-source" });
  });

  it("refuses an inventory record whose tier is untrusted", () => {
    const result = decision({
      inventoryRecord: inventoryFixture({ tier: "untrusted" }),
      manifest: manifestFixture({ trust: "untrusted" })
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "untrusted-source" });
  });

  it("refuses a manifest whose trust claim disagrees with the inventory (self-promotion / swap)", () => {
    const escalated = decision({
      inventoryRecord: inventoryFixture({ tier: "builtin", recordedDigest: null }),
      manifest: manifestFixture({ trust: "verified" })
    });
    expect(escalated).toMatchObject({ outcome: "reject", reason: "trust-claim-mismatch" });
    const demoted = decision({
      inventoryRecord: inventoryFixture({ tier: "verified", recordedDigest: DIGEST_A }),
      manifest: manifestFixture({ trust: "builtin" })
    });
    expect(demoted).toMatchObject({ outcome: "reject", reason: "trust-claim-mismatch" });
  });
});

describe("kill switch and disabled disposal", () => {
  it("the global kill switch refuses even a fully valid builtin plugin", () => {
    const result = decision({ killSwitchAll: true });
    expect(result).toMatchObject({ outcome: "reject", reason: "kill-switch" });
  });

  it("a per-id kill-switch entry refuses exactly that plugin", () => {
    const result = decision({ killSwitchIds: [PLUGIN_ID] });
    expect(result).toMatchObject({ outcome: "reject", reason: "kill-switch" });
    const other = decision({ killSwitchIds: ["other.plugin"] });
    expect(other.outcome).toBe("accept");
  });

  it("a disabled inventory record refuses", () => {
    const result = decision({ inventoryRecord: inventoryFixture({ disabled: true }) });
    expect(result).toMatchObject({ outcome: "reject", reason: "disabled" });
  });

  it("disable disposal: re-evaluating the SAME input after the kill switch flips refuses (no cached acceptance)", () => {
    const before = decision();
    expect(before.outcome).toBe("accept");
    const after = decision({ killSwitchIds: [PLUGIN_ID] });
    expect(after).toMatchObject({ outcome: "reject", reason: "kill-switch" });
  });
});

describe("integrity double pin", () => {
  it("refuses when the artifact bytes do not match the manifest digest", () => {
    const result = decision({ artifactSha256: sha256Hex("tampered-bytes") });
    expect(result).toMatchObject({ outcome: "reject", reason: "integrity-mismatch" });
  });

  it("refuses when the manifest digest drifts from the inventory pin (verified tier)", () => {
    const presented = manifestFixture({ trust: "verified", integrity: { algorithm: "sha256", digest: DIGEST_A } });
    const result = decision({
      // HARDENING-1: the record is pinned to the manifest AS APPROVED (the
      // presented canonical value); only the artifact digest pin disagrees.
      inventoryRecord: inventoryFor(presented, { tier: "verified", recordedDigest: DIGEST_B }),
      manifest: presented,
      artifactSha256: DIGEST_A
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "integrity-mismatch" });
  });

  it("accepts when BOTH pins hold", () => {
    const verifiedManifest = manifestFixture({ trust: "verified" });
    const result = decision({
      inventoryRecord: inventoryFor(verifiedManifest, {
        tier: "verified",
        recordedDigest: sha256Hex(ARTIFACT_BYTES_A)
      }),
      manifest: verifiedManifest,
      artifactSha256: sha256Hex(ARTIFACT_BYTES_A)
    });
    expect(result.outcome).toBe("accept");
  });
});

describe("manifest self-pin (canonical whole-manifest pin, HARDENING-1)", () => {
  it("THE original defect: editing manifest fields while keeping the artifact and its digest field is refused", () => {
    // Before the self-pin, every mutation below kept artifactSha256 ==
    // manifest.integrity.digest == (builtin: absent) inventory pin and was
    // ACCEPTED; the self-pin makes each one a manifest-pin-mismatch.
    for (const tampered of [
      manifestFixture({ scopes: ["repo.read", "repo.write"] }),
      manifestFixture({ scopes: [] }),
      manifestFixture({ name: "Renamed After Approval" }),
      manifestFixture({ entrypoint: "dist/other.js" }),
      manifestFixture({ version: "9.9.9" }),
      manifestFixture({ description: "post-approval description edit" })
    ]) {
      const result = decision({ manifest: tampered });
      expect(result).toMatchObject({ outcome: "reject", reason: "manifest-pin-mismatch" });
    }
  });

  it("HARDENING-2: the content-drift detail carries BOTH structural digests (presented canonical vs inventory pin)", () => {
    // Trigger step 8's content-drift branch: the inventory pin holds the
    // APPROVED manifest's canonical digest while the presented manifest is
    // tampered. The detail must name both sha256 hex facts — and nothing else.
    const approved = manifestFixture();
    const pinned = canonicalPluginManifestSha256(approved);
    const tampered = manifestFixture({ name: "Renamed After Approval" });
    const presented = canonicalPluginManifestSha256(tampered);
    expect(presented).not.toBe(pinned); // the drift is real, the test is not vacuous
    const result = decision({ manifest: tampered, inventoryRecord: inventoryFixture({ manifestSha256: pinned }) });
    expect(result).toMatchObject({ outcome: "reject", reason: "manifest-pin-mismatch" });
    if (result.outcome !== "reject") return;
    expect(result.detail).toContain(presented);
    expect(result.detail).toContain(pinned);
    expect(result.detail).toMatch(
      /^manifest as presented does not match the inventory canonical-manifest pin \(presented [0-9a-f]{64} vs pinned [0-9a-f]{64}\)$/
    );
    // A42/A36: the tampered manifest's free text stays out of the detail.
    expect(result.detail).not.toContain("Renamed After Approval");
  });

  it("editing the trust CLAIM after approval is refused by the self-pin (tier-consistent record)", () => {
    const approvedAsBuiltin = manifestFixture();
    const result = decision({
      manifest: manifestFixture({ trust: "verified" }),
      inventoryRecord: inventoryFixture({
        tier: "verified",
        recordedDigest: DIGEST_A,
        manifestSha256: canonicalPluginManifestSha256(approvedAsBuiltin)
      })
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "manifest-pin-mismatch" });
  });

  it("a structural key addition/removal on the manifest is refused by the self-pin", () => {
    const widened = manifestFixture();
    (widened as Record<string, unknown>).scopes = ["repo.read"];
    const widenedRecord = inventoryFixture({ manifestSha256: canonicalPluginManifestSha256(widened) });
    // The pin covers the manifest as approved; the presented manifest swaps a
    // scope AFTER approval -> mismatch even though both digests still agree.
    const swapped = manifestFixture({ scopes: ["repo.write"] });
    const result = decision({ manifest: swapped, inventoryRecord: widenedRecord });
    expect(result).toMatchObject({ outcome: "reject", reason: "manifest-pin-mismatch" });
  });

  it("a null (missing) self-pin refuses at EVERY tier — it is never an exemption", () => {
    for (const tier of ["builtin", "verified"] as const) {
      const result = decision({
        inventoryRecord: inventoryFixture({
          tier,
          recordedDigest: tier === "verified" ? DIGEST_A : null,
          manifestSha256: null
        }),
        manifest: manifestFixture({ trust: tier === "verified" ? "verified" : "builtin" })
      });
      expect(result).toMatchObject({ outcome: "reject", reason: "manifest-pin-mismatch" });
      if (result.outcome !== "reject") return;
      expect(result.detail).toContain("no canonical manifest self-pin");
    }
  });

  it("an inventory record without the manifestSha256 field is a host input error, not a skip", () => {
    const record = inventoryFixture();
    delete (record as Record<string, unknown>).manifestSha256;
    expect(() => decision({ inventoryRecord: record as never })).toThrow(/decision input failed its schema/);
  });

  it("accepts at every tier when the self-pin matches the presented canonical manifest", () => {
    const builtin = decision();
    expect(builtin.outcome).toBe("accept");
    const verified = decision({
      inventoryRecord: inventoryFixture({
        tier: "verified",
        recordedDigest: sha256Hex(ARTIFACT_BYTES_A),
        manifestSha256: canonicalPluginManifestSha256(manifestFixture({ trust: "verified" }))
      }),
      manifest: manifestFixture({ trust: "verified" })
    });
    expect(verified.outcome).toBe("accept");
  });

  it("the pin is over the CANONICAL value: key insertion order and property order do not matter", () => {
    // Same manifest content, keys inserted in reverse order: canonicalization
    // sorts recursively, so the approved pin still matches.
    const reordered: Record<string, unknown> = {};
    for (const key of [...Object.keys(manifestFixture())].reverse()) {
      reordered[key] = (manifestFixture() as Record<string, unknown>)[key];
    }
    expect(reordered).toEqual(manifestFixture());
    const result = decision({ manifest: reordered });
    expect(result.outcome).toBe("accept");
  });

  it("the self-pin outranks later steps: it refuses before the artifact and scope checks are consulted", () => {
    // Tampered manifest AND tampered artifact AND out-of-allowlist scope:
    // the manifest self-pin (step 8) names the refusal, not integrity/scope.
    const result = decision({
      manifest: manifestFixture({ scopes: ["repo.write"], trust: "verified" }),
      artifactSha256: sha256Hex("entirely-different-bytes"),
      inventoryRecord: inventoryFixture({ tier: "verified", recordedDigest: DIGEST_B })
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "manifest-pin-mismatch" });
  });
});

describe("declarative scope authorization", () => {
  it("refuses a declared scope outside the host allowlist (superset)", () => {
    // HARDENING-1: the record is pinned to the manifest AS PRESENTED so the
    // scope check itself (not the earlier self-pin) names the refusal.
    const presented = manifestFixture({ scopes: ["repo.read", "repo.write"] });
    const result = decision({
      manifest: presented,
      inventoryRecord: inventoryFor(presented),
      scopeAllowlist: ["repo.read", "tests.run"]
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "scope-not-allowlisted" });
    if (result.outcome !== "reject") return;
    expect(result.detail).toContain("repo.write");
    expect(result.detail).not.toContain("name");
  });

  it("accepts when declared scopes are a subset of the allowlist", () => {
    const presented = manifestFixture({ scopes: ["tests.run"] });
    const result = decision({
      manifest: presented,
      inventoryRecord: inventoryFor(presented),
      scopeAllowlist: ["repo.read", "tests.run"]
    });
    expect(result.outcome).toBe("accept");
  });

  it("empty allowlist refuses any non-empty scope declaration, but passes a scope-free plugin", () => {
    const refused = decision({ scopeAllowlist: [] });
    expect(refused).toMatchObject({ outcome: "reject", reason: "scope-not-allowlisted" });
    const presented = manifestFixture({ scopes: [] });
    const accepted = decision({
      manifest: presented,
      inventoryRecord: inventoryFor(presented),
      scopeAllowlist: []
    });
    expect(accepted.outcome).toBe("accept");
  });
});

describe("override-vocabulary refusal precedes schema evaluation", () => {
  it("a manifest injecting a model override key refuses with override-field, not schema-invalid", () => {
    const result = decision({
      manifest: manifestFixture({ model: "arbitrary-model", scopes: [] })
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "override-field" });
  });

  it("a manifest carrying profile/role/permission/budget vocabulary refuses", () => {
    for (const hostile of [
      { profileId: "claude-main" },
      { role: "developer" },
      { permissions: ["repo.write"] },
      { budget: { maxExecutions: 9999 } }
    ]) {
      const result = decision({ manifest: manifestFixture(hostile) });
      expect(result).toMatchObject({ outcome: "reject", reason: "override-field" });
    }
  });

  it("a permission-skip flag smuggled into free text refuses before the schema sees it", () => {
    const result = decision({
      manifest: manifestFixture({ description: "use --dangerously-bypass-approvals-and-sandbox" })
    });
    expect(result).toMatchObject({ outcome: "reject", reason: "override-field" });
  });
});

describe("schema-invalid branch of the decision", () => {
  it("refuses unknown fields, bad semver and duplicate scopes with schema-invalid", () => {
    expect(decision({ manifest: manifestFixture({ extra: 1 }) })).toMatchObject({
      outcome: "reject",
      reason: "schema-invalid"
    });
    expect(decision({ manifest: manifestFixture({ version: "not-a-version" }) })).toMatchObject({
      outcome: "reject",
      reason: "schema-invalid"
    });
    expect(
      decision({ manifest: manifestFixture({ scopes: ["repo.read", "repo.read"] }) })
    ).toMatchObject({ outcome: "reject", reason: "schema-invalid" });
  });

  it("a schema-invalid refusal never exposes the manifest id (unparsed data stays out)", () => {
    const result = decision({ manifest: manifestFixture({ extra: 1, id: "hostile.x" }) });
    if (result.outcome !== "reject") return;
    expect(result.pluginId).toBeNull();
  });
});

describe("host input errors are typed, expected refusals are values", () => {
  it("throws PluginDecisionInputError for a malformed artifact digest, bad inventory pin or unknown input field", () => {
    expect(() => decision({ artifactSha256: "zz" })).toThrow(/decision input failed its schema/);
    expect(() =>
      decision({ inventoryRecord: inventoryFixture({ tier: "verified", recordedDigest: null }) })
    ).toThrow(/decision input failed its schema/);
    expect(() => decision({ extra: true } as unknown as PluginLoadDecisionInput)).toThrow(
      /decision input failed its schema/
    );
  });

  it("expected refusals are VALUES — no branch of the decision throws for hostile manifests", () => {
    const hostile = [
      null,
      42,
      "string",
      {},
      manifestFixture({ scopes: ["exec.spawn"] }),
      manifestFixture({ id: "UPPER" })
    ];
    for (const manifest of hostile) {
      expect(() => decision({ manifest })).not.toThrow();
    }
  });
});

describe("scope vocabulary invariants (A35 pin)", () => {
  it("every scope maps onto the closed permission vocabulary and cites gate controls", () => {
    for (const scope of PLUGIN_SCOPES) {
      expect(PERMISSION_IDS).toContain(scope);
      const binding = SCOPE_CONTROL_BINDINGS[scope];
      expect(binding.permissionId).toBe(scope);
      expect(binding.requiredControls.length).toBeGreaterThan(0);
      expect(binding.budgetMetered).toBe(true);
    }
    expect(PLUGIN_SCOPES).not.toContain("dag.propose");
    expect(PLUGIN_SCOPES).not.toContain("decision.propose");
    expect(PLUGIN_SCOPES).not.toContain("exec.spawn");
  });
});
