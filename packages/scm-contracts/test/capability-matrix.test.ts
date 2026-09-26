/**
 * The compatibility matrix ships FAIL-CLOSED OFF (M7-01): every provider cell
 * is pinned to verification status literal "unverified" with null evidence —
 * the shipped schema cannot even EXPRESS "verified". With the default lookup,
 * neither a read client nor a write client can be constructed; only the
 * explicitly injected verification seam (used by tests, and by a future
 * evidence-backed integration task via code change) opens the surface.
 */
import { describe, expect, it } from "vitest";
import {
  SCM_PROVIDER_COMPAT_MATRIX,
  SCM_PROVIDERS,
  ScmCompatCellSchema,
  ScmProviderCapabilitySchema,
  ScmShippedVerificationSchema,
  assertBaseUrlAllowed,
  assertSurfaceVerified,
  matrixVerificationLookup
} from "../src/index.js";
import { ScmProviderNotVerifiedError } from "../src/index.js";
import { githubCapability } from "./helpers.js";

describe("shipped compatibility matrix: design-only posture", () => {
  it("covers exactly github and gitlab, every cell unverified with null evidence", () => {
    expect(Object.keys(SCM_PROVIDER_COMPAT_MATRIX).sort()).toEqual([...SCM_PROVIDERS].sort());
    for (const provider of SCM_PROVIDERS) {
      const cell = SCM_PROVIDER_COMPAT_MATRIX[provider];
      expect(cell.verification.status).toBe("unverified");
      expect(cell.verification.evidence).toBeNull();
      // The schema cannot express "verified":
      expect(
        ScmShippedVerificationSchema.safeParse({ status: "verified", evidence: "x" }).success
      ).toBe(false);
      expect(ScmCompatCellSchema.safeParse({ ...cell, verification: { status: "verified", evidence: "x" } }).success).toBe(
        false
      );
    }
  });

  it("pins apiFlavor and auth header form per provider", () => {
    expect(SCM_PROVIDER_COMPAT_MATRIX.github.apiFlavor).toBe("github-rest-v3");
    expect(SCM_PROVIDER_COMPAT_MATRIX.github.authHeaderForm).toBe("token");
    expect(SCM_PROVIDER_COMPAT_MATRIX.gitlab.apiFlavor).toBe("gitlab-rest-v4");
    expect(SCM_PROVIDER_COMPAT_MATRIX.gitlab.authHeaderForm).toBe("private-token");
  });

  it("pins the PROPOSED minimal scope sets exactly (minimization: read scopes carry no write)", () => {
    expect(SCM_PROVIDER_COMPAT_MATRIX.github.proposedMinimalScopes.read).toEqual([
      "metadata:read",
      "contents:read",
      "issues:read",
      "pull-requests:read"
    ]);
    expect(SCM_PROVIDER_COMPAT_MATRIX.github.proposedMinimalScopes.write).toEqual([
      "metadata:read",
      "contents:read",
      "issues:write",
      "pull-requests:write"
    ]);
    expect(SCM_PROVIDER_COMPAT_MATRIX.gitlab.proposedMinimalScopes.read).toEqual(["read_api"]);
    expect(SCM_PROVIDER_COMPAT_MATRIX.gitlab.proposedMinimalScopes.write).toEqual(["api"]);
    for (const scope of SCM_PROVIDER_COMPAT_MATRIX.github.proposedMinimalScopes.read) {
      expect(scope.includes("write") || scope.includes("admin")).toBe(false);
    }
  });

  it("is frozen against mutation", () => {
    expect(Object.isFrozen(SCM_PROVIDER_COMPAT_MATRIX)).toBe(true);
    expect(Object.isFrozen(SCM_PROVIDER_COMPAT_MATRIX.github)).toBe(true);
  });
});

describe("verification lookup + gate", () => {
  it("the default (matrix) lookup answers unverified for every provider/surface", () => {
    for (const provider of SCM_PROVIDERS) {
      for (const surface of ["read", "controlledWrite"] as const) {
        expect(matrixVerificationLookup({ provider, surface })).toEqual({
          status: "unverified",
          evidence: null
        });
      }
    }
  });

  it("assertSurfaceVerified throws the typed error on unverified, passes on verified injection", () => {
    expect(() =>
      assertSurfaceVerified(matrixVerificationLookup, "github", "controlledWrite")
    ).toThrow(ScmProviderNotVerifiedError);
    expect(() =>
      assertSurfaceVerified(() => ({ status: "verified", evidence: "e" }), "github", "controlledWrite")
    ).not.toThrow();
  });
});

describe("capability declaration schema", () => {
  it("accepts a well-formed github declaration", () => {
    expect(ScmProviderCapabilitySchema.safeParse(githubCapability()).success).toBe(true);
  });

  it("rejects apiFlavor/provider mismatch", () => {
    expect(
      ScmProviderCapabilitySchema.safeParse(githubCapability({ apiFlavor: "gitlab-rest-v4" })).success
    ).toBe(false);
    expect(
      ScmProviderCapabilitySchema.safeParse(githubCapability({ provider: "gitlab" })).success
    ).toBe(false);
  });

  it("rejects duplicate operations", () => {
    expect(
      ScmProviderCapabilitySchema.safeParse(
        githubCapability({ reads: ["listIssues", "listIssues"] })
      ).success
    ).toBe(false);
  });
});

describe("base-url allowlist (exact hosts, no suffix tricks)", () => {
  it("passes an exact host and rejects non-allowlisted and suffix-spoofing hosts", () => {
    expect(() => assertBaseUrlAllowed("https://github.example.invalid", ["github.example.invalid"])).not.toThrow();
    expect(() => assertBaseUrlAllowed("https://evil.example", ["github.example.invalid"])).toThrow(
      ScmProviderNotVerifiedError
    );
    expect(() =>
      assertBaseUrlAllowed("https://github.example.invalid.evil.example", ["github.example.invalid"])
    ).toThrow(ScmProviderNotVerifiedError);
    expect(() => assertBaseUrlAllowed("not-a-url", ["github.example.invalid"])).toThrow(
      ScmProviderNotVerifiedError
    );
  });
});
