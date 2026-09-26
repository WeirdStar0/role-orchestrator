import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXECUTION_TARGETS } from "@role-orchestrator/contracts";
import {
  AUTH_SCHEME_PROFILES,
  resolveTransportAuthScheme,
  TransportAuthSchemeSchema
} from "../src/auth.js";
import {
  BOUNDARY_EVIDENCE_BY_TARGET,
  GrantedPostureSchema,
  hardeningRefusalReason,
  REQUESTABLE_POSTURES,
  resolvePosture
} from "../src/posture.js";
import { HardenedPostureUnavailableError } from "../src/errors.js";
import { NOT_MULTI_TENANT_MARKER, SIMULATION_DISCLOSURE, TENANCY_BOUNDARY_STATEMENT } from "../src/tenancy.js";
import { assertNoSecretMaterial, SecretRefSchema, secretFreeText, SECRET_SHAPE_RULES } from "../src/secrets.js";
import { sampleAssignCommand } from "./helpers.js";

/**
 * Posture / auth / tenancy / secret discipline (M7-03): the A31 Hardened
 * refusal per target, the transport-auth comparison data, the pinned
 * NOT-multi-tenant boundary, and the secret-reference-only surface.
 */
describe("A31 posture gate per target", () => {
  it("boundary evidence is literally unverified for every target and boundary", () => {
    for (const target of EXECUTION_TARGETS) {
      const evidence = BOUNDARY_EVIDENCE_BY_TARGET[target];
      expect(evidence.filesystem).toEqual({ verification: "unverified", evidence: null });
      expect(evidence.network).toEqual({ verification: "unverified", evidence: null });
      expect(evidence.remoteCancellation).toEqual({ verification: "unverified", evidence: null });
      expect(evidence.note.length).toBeGreaterThan(20);
    }
  });

  it("requesting hardened throws per target with the target named and A31 cited", () => {
    for (const target of EXECUTION_TARGETS) {
      expect(() => resolvePosture("hardened", target)).toThrow(HardenedPostureUnavailableError);
      try {
        resolvePosture("hardened", target);
        expect.unreachable("hardened must be refused");
      } catch (error) {
        expect(error).toBeInstanceOf(HardenedPostureUnavailableError);
        const typed = error as HardenedPostureUnavailableError;
        expect(typed.code).toBe("hardened-posture-unavailable");
        expect(typed.target).toBe(target);
        expect(typed.reason).toBe(hardeningRefusalReason(target));
        expect(typed.message).toContain("not selectable");
      }
    }
  });

  it("the granted-posture vocabulary cannot carry hardened; local-trusted grants carry mandatory caveats", () => {
    expect(() => GrantedPostureSchema.parse("hardened")).toThrow(z.ZodError);
    expect(REQUESTABLE_POSTURES).toEqual(["local-trusted", "hardened"]);
    for (const target of EXECUTION_TARGETS) {
      const resolved = resolvePosture("local-trusted", target);
      expect(resolved.granted).toBe("local-trusted");
      expect(resolved.caveats.length).toBeGreaterThanOrEqual(3);
      expect(resolved.caveats.some((line) => line.includes("NOT multi-tenant security"))).toBe(true);
      expect(resolved.caveats.some((line) => line.includes("unverified"))).toBe(true);
    }
  });

  it("resolvePosture validates the target against the closed contract enum", () => {
    expect(() => resolvePosture("local-trusted", "haiku-native")).toThrow(z.ZodError);
  });
});

describe("transport auth scheme comparison (design data, all unverified)", () => {
  it("exactly the three schemes, every verification cell literal-unverified with null evidence", () => {
    expect(Object.keys(AUTH_SCHEME_PROFILES).sort()).toEqual(["lease-token", "loopback-token", "mtls"]);
    for (const profile of Object.values(AUTH_SCHEME_PROFILES)) {
      expect(profile.verification).toEqual({ verification: "unverified", evidence: null });
      expect(profile.threatSurface.length).toBeGreaterThan(0);
      expect(profile.designRole.length).toBeGreaterThan(20);
    }
  });

  it("the lease-token recommendation is fenced by design; loopback is same-host only; mtls names its key lifecycle", () => {
    expect(AUTH_SCHEME_PROFILES["lease-token"].designRole).toContain("RECOMMENDATION");
    expect(AUTH_SCHEME_PROFILES["lease-token"].designRole).toContain("fencing");
    expect(AUTH_SCHEME_PROFILES["loopback-token"].designRole).toContain("SAME-HOST");
    expect(AUTH_SCHEME_PROFILES["loopback-token"].threatSurface.some((line) => line.includes("meaningless across hosts"))).toBe(true);
    expect(AUTH_SCHEME_PROFILES.mtls.revocation).toContain("revocation");
    expect(AUTH_SCHEME_PROFILES.mtls.threatSurface.some((line) => line.includes("long-lived key material"))).toBe(true);
  });

  it("scheme resolution rejects unknown schemes (closed enum)", () => {
    expect(() => TransportAuthSchemeSchema.parse("openid")).toThrow(z.ZodError);
    expect(resolveTransportAuthScheme("mtls").scheme).toBe("mtls");
  });
});

describe("tenancy boundary is pinned data", () => {
  it("the statements say NOT multi-tenant and disclose simulation-only evidence", () => {
    expect(TENANCY_BOUNDARY_STATEMENT.includes(NOT_MULTI_TENANT_MARKER)).toBe(true);
    expect(TENANCY_BOUNDARY_STATEMENT.includes("local-trusted")).toBe(true);
    expect(SIMULATION_DISCLOSURE.includes("protocol-level simulation")).toBe(true);
    expect(SIMULATION_DISCLOSURE.includes("NEVER")).toBe(true);
    expect(SIMULATION_DISCLOSURE.includes("container runtime")).toBe(true);
  });
});

describe("secret-reference surface", () => {
  it("secret refs are reference-shaped only; values and paths are rejected", () => {
    expect(SecretRefSchema.parse("ref:remote-cli-credential")).toBe("ref:remote-cli-credential");
    expect(() => SecretRefSchema.parse("sk-ant-SENTINELSENTINELSENTINEL")).toThrow(z.ZodError);
    expect(() => SecretRefSchema.parse("C:\\Users\\star\\.claude\\.credentials.json")).toThrow(z.ZodError);
    expect(() => SecretRefSchema.parse("ref:UPPERCASE")).toThrow(z.ZodError);
    expect(() => assertNoSecretMaterial("note", "password=hunter2hunter2hunter2")).toThrow();
  });

  it("free text rejects control characters, bidi overrides, and credential shapes", () => {
    const text = secretFreeText(64);
    expect(text.parse("plain progress note")).toBe("plain progress note");
    expect(() => text.parse("line\nbreak")).toThrow(z.ZodError);
    expect(() => text.parse("override\u202Ereversed")).toThrow(z.ZodError);
    expect(() => text.parse("token xoxb-SENTINELSENTINELSENT")).toThrow(z.ZodError);
  });

  it("the sentinel rule registry is closed and every rule self-detects", () => {
    expect(SECRET_SHAPE_RULES.map((entry) => entry.rule).sort()).toEqual([
      "anthropic-key",
      "aws-access-key",
      "bearer-credential",
      "credential-assignment",
      "github-fine-grained-pat",
      "github-pat",
      "gitlab-pat",
      "openai-style-key",
      "private-key-block",
      "slack-token"
    ]);
  });

  it("the assign command keeps the secret surface at references only", () => {
    const command = sampleAssignCommand();
    expect(command.secretRefs).toEqual(["ref:remote-cli-credential"]);
    expect(JSON.stringify(command).includes("AKIA")).toBe(false);
    // posture/authScheme ride along as closed enums.
    expect(command.posture).toBe("local-trusted");
    expect(command.authScheme).toBe("lease-token");
  });
});
