/**
 * A42 for the SCM surface: credential material never reaches events, receipts
 * or exports. Structural redaction (the event schema has no credential field
 * at all), content digests instead of content, and the deep scrubber as
 * defense in depth for free text that must flow.
 */
import { describe, expect, it } from "vitest";
import {
  SCM_CREDENTIAL_PLACEHOLDER,
  ScmIssueCommentReceiptSchema,
  buildScmAuditEvent,
  containsCredentialMaterial,
  findCredentialMaterial,
  scrubCredentialMaterial,
  scrubCredentialText,
  serializeScmAuditEvent
} from "../src/index.js";

describe("credential shape detection", () => {
  it("detects known token shapes and names the rules", () => {
    expect(findCredentialMaterial("token ghp_1234567890abcdefghij")).toContain("github-classic-pat");
    expect(findCredentialMaterial("glpat-1234567890abcdefgh")).toContain("gitlab-pat");
    expect(findCredentialMaterial("Authorization: Bearer abcdef123456")).toContain("bearer-header");
    expect(findCredentialMaterial("api_key=1234567890abcdef")).toContain("key-value-secret");
    expect(findCredentialMaterial("nothing to see here")).toEqual([]);
  });

  it("scrubbing replaces shapes with the placeholder and is idempotent", () => {
    const text = "lease ghp_1234567890abcdefghij and glpat-1234567890abcdefgh alone";
    const once = scrubCredentialText(text);
    expect(once.text).not.toContain("ghp_");
    expect(once.text).toContain(SCM_CREDENTIAL_PLACEHOLDER);
    expect(containsCredentialMaterial(once.text)).toBe(false);
    const twice = scrubCredentialText(once.text);
    expect(twice.text).toBe(once.text);
  });
});

describe("scrubCredentialMaterial deep walk", () => {
  it("scrubs strings inside nested objects/arrays and reports counts", () => {
    const input = {
      note: "see ghp_1234567890abcdefghij",
      nested: { list: ["clean", { token: "Bearer abcdef123456" }] },
      count: 3,
      flag: true,
      nil: null
    };
    const result = scrubCredentialMaterial(input);
    expect(result.redactedCount).toBe(2);
    expect(result.rules).toContain("github-classic-pat");
    expect(result.rules).toContain("bearer-header");
    expect(JSON.stringify(result.value)).not.toContain("ghp_");
    expect(JSON.stringify(result.value)).toContain("clean");
  });

  it("leaves clean values untouched", () => {
    const result = scrubCredentialMaterial({ a: ["b", { c: "d" }], n: 1 });
    expect(result.redactedCount).toBe(0);
    expect(result.value).toEqual({ a: ["b", { c: "d" }], n: 1 });
  });
});

describe("audit events carry no credential material (structural redaction)", () => {
  const base = {
    kind: "scm.write" as const,
    provider: "github" as const,
    operation: "createIssueComment" as const,
    outcome: "success" as const,
    refusalCode: null,
    approvalId: "approval-abc",
    actionDigest: "1".repeat(64),
    repo: { owner: "example-org", name: "example-repo" },
    contentSha256: "2".repeat(64),
    executionId: "exec-1",
    at: "2026-09-24T00:00:01.000Z",
    detail: "write completed"
  };

  it("builds a strict event whose serialization contains no token shapes", () => {
    const event = buildScmAuditEvent(base);
    const serialized = serializeScmAuditEvent(event);
    expect(serialized).toContain("approval-abc");
    expect(containsCredentialMaterial(serialized)).toBe(false);
    // determinism:
    expect(serializeScmAuditEvent(event)).toBe(serialized);
  });

  it("scrubs a detail that smuggled a token", () => {
    const event = buildScmAuditEvent({
      ...base,
      detail: "provider echoed ghp_1234567890abcdefghij back"
    });
    expect(event.detail).toContain(SCM_CREDENTIAL_PLACEHOLDER);
    expect(event.detail).not.toContain("ghp_");
  });

  it("rejects oversized details and unknown fields", () => {
    expect(() => buildScmAuditEvent({ ...base, detail: "d".repeat(513) })).toThrow();
    const smuggled: Record<string, unknown> = { ...base, password: "super-secret-123456" };
    expect(() => buildScmAuditEvent(smuggled as typeof base)).toThrow();
  });
});

describe("receipts carry digests, never content", () => {
  it("accepts the projected receipt shape and rejects content-bearing extras", () => {
    const receipt = {
      provider: "github",
      operation: "createIssueComment",
      repo: { owner: "example-org", name: "example-repo" },
      issueNumber: 42,
      commentId: "c-1",
      contentSha256: "3".repeat(64),
      createdAt: "2026-09-24T00:00:01.000Z"
    };
    expect(ScmIssueCommentReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      ScmIssueCommentReceiptSchema.safeParse({
        ...receipt,
        body: "the full comment text somehow"
      }).success
    ).toBe(false);
    expect(
      ScmIssueCommentReceiptSchema.safeParse({ ...receipt, authorization: "Bearer abcdef123456" })
        .success
    ).toBe(false);
  });
});
