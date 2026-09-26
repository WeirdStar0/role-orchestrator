import { describe, expect, it } from "vitest";
import {
  credentialGroupMax,
  credentialIsolationCapabilityId,
  entryCapabilityId,
  evaluateDispatchGate,
  parseConcurrencyPolicy
} from "../src/index.js";
import { InvalidConcurrencyPolicyError } from "../src/errors.js";
import { expectError } from "./helpers.js";

describe("parseConcurrencyPolicy (strict)", () => {
  it("accepts the documented defaults", () => {
    const policy = parseConcurrencyPolicy({
      globalMax: 4,
      projectMax: 3,
      unverifiedCredentialGroupMax: 1
    });
    expect(policy).toEqual({ globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 1 });
  });

  it("rejects unknown fields, wrong maxima and a credential max other than 1", () => {
    expect(() =>
      parseConcurrencyPolicy({ globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 1, extra: true })
    ).toThrowError();
    expect(() =>
      parseConcurrencyPolicy({ globalMax: 0, projectMax: 3, unverifiedCredentialGroupMax: 1 })
    ).toThrowError();
    expect(() =>
      parseConcurrencyPolicy({ globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 2 })
    ).toThrowError();
    expectError(
      () => parseConcurrencyPolicy({ globalMax: 4, projectMax: 3 }),
      InvalidConcurrencyPolicyError
    );
    // The typed wrapper keeps the zod issue as cause.
    try {
      parseConcurrencyPolicy("not an object");
      expect.unreachable("parse should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidConcurrencyPolicyError);
      expect((error as { cause?: unknown }).cause).toBeDefined();
    }
  });
});

describe("capability ids", () => {
  it("names the matrix cells by runtime", () => {
    expect(entryCapabilityId("claude")).toBe("claude.noninteractive-entry");
    expect(credentialIsolationCapabilityId("codex")).toBe("codex.credential-isolation");
  });
});

describe("credentialGroupMax (A33)", () => {
  it("is 1 while credential isolation is unverified — the state both bundled CLIs are in", () => {
    // Both registries report unverified (M0-06); the lock stays until real
    // dual-account evidence marks a runtime verified.
    expect(credentialGroupMax("claude", 1)).toBe(1);
    expect(credentialGroupMax("codex", 1)).toBe(1);
  });
});

describe("evaluateDispatchGate", () => {
  it("allows dispatch on a verified noninteractive entry with no extra requirement", () => {
    const decision = evaluateDispatchGate("claude", null);
    expect(decision.allowed).toBe(true);
    expect(decision.status).toBe("verified");
    expect(decision.reason).toBeNull();
  });

  it("allows dispatch when the additionally required capability is verified", () => {
    const decision = evaluateDispatchGate("codex", "codex.resume");
    expect(decision.allowed).toBe(true);
    expect(decision.capability).toBe("codex.resume");
  });

  it("rejects when the additionally required capability is unverified (A33 posture)", () => {
    const decision = evaluateDispatchGate("claude", "claude.credential-isolation");
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe("unverified");
    expect(decision.reason).toContain("unverified");
  });

  it("rejects UNKNOWN capability ids — denied by default, never treated as usable", () => {
    const decision = evaluateDispatchGate("claude", "madeup.capability.does-not-exist");
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe("unverified");
    expect(decision.reason).toContain("unknown to the capability matrix");
  });
});
