/**
 * Strict-schema behavior of every scm-contracts boundary (M7-01):
 * unknown fields rejected, unexpected enum values rejected, oversized strings
 * rejected, control/bidi (Trojan-Source) text rejected, and credential
 * references that smuggle plaintext token shapes rejected (A42).
 */
import { describe, expect, it } from "vitest";
import {
  ScmApprovalRefSchema,
  ScmBaseUrlSchema,
  ScmBodySchema,
  ScmCommitShaSchema,
  ScmCredentialRefSchema,
  ScmCreateIssueCommentCommandSchema,
  ScmCreatePullRequestCommandSchema,
  ScmGitRefSchema,
  ScmIssuePageSchema,
  ScmListIssuesQuerySchema,
  ScmProviderCapabilitySchema,
  ScmRepoSlugPartSchema,
  ScmTitleSchema,
  ScmAuditEventSchema
} from "../src/index.js";
import {
  SHA_BASE,
  bindingFixture,
  createPullRequestCommand,
  githubCapability,
  issueCommentCommand
} from "./helpers.js";

describe("strict schemas reject unknown fields", () => {
  it("issue comment command rejects an extra field and a 'token' field", () => {
    expect(ScmCreateIssueCommentCommandSchema.safeParse(issueCommentCommand()).success).toBe(true);
    expect(
      ScmCreateIssueCommentCommandSchema.safeParse(issueCommentCommand({ extra: 1 })).success
    ).toBe(false);
    expect(
      ScmCreateIssueCommentCommandSchema.safeParse(issueCommentCommand({ token: "ghp_abc" })).success
    ).toBe(false);
  });

  it("create PR command rejects an extra field", () => {
    expect(ScmCreatePullRequestCommandSchema.safeParse(createPullRequestCommand()).success).toBe(true);
    expect(
      ScmCreatePullRequestCommandSchema.safeParse(createPullRequestCommand({ merge: true })).success
    ).toBe(false);
  });

  it("read query, capability, page and audit event reject extra fields", () => {
    expect(
      ScmListIssuesQuerySchema.safeParse({ repo: { owner: "o", name: "r" }, state: "open", x: 1 })
        .success
    ).toBe(false);
    expect(ScmProviderCapabilitySchema.safeParse({ ...githubCapability(), admin: true }).success).toBe(
      false
    );
    expect(
      ScmIssuePageSchema.safeParse({
        items: [{ number: 1, state: "open", title: "t" }],
        malformedDropped: 0,
        nextPage: "cursor"
      }).success
    ).toBe(false);
    expect(
      ScmAuditEventSchema.safeParse({
        schemaVersion: 1,
        kind: "scm.write",
        provider: "github",
        operation: "createIssueComment",
        outcome: "success",
        refusalCode: null,
        approvalId: "approval-1",
        actionDigest: "0".repeat(64),
        repo: { owner: "o", name: "r" },
        contentSha256: "0".repeat(64),
        executionId: "exec-1",
        at: "2026-09-24T00:00:00.000Z",
        detail: "",
        credential: "ghp_secret"
      }).success
    ).toBe(false);
  });
});

describe("unexpected enum values are rejected", () => {
  it("provider enum is closed (github | gitlab)", () => {
    expect(
      ScmProviderCapabilitySchema.safeParse({ ...githubCapability(), provider: "sourcehut" }).success
    ).toBe(false);
  });

  it("operation enums are closed — no delete/merge operations exist in v1", () => {
    expect(
      ScmCreateIssueCommentCommandSchema.safeParse(
        issueCommentCommand({ operation: "deleteIssue" })
      ).success
    ).toBe(false);
    expect(
      ScmProviderCapabilitySchema.safeParse({
        ...githubCapability(),
        writes: ["createIssueComment", "mergePullRequest"]
      }).success
    ).toBe(false);
  });

  it("query state enums are closed", () => {
    expect(
      ScmListIssuesQuerySchema.safeParse({ repo: { owner: "o", name: "r" }, state: "deleted" }).success
    ).toBe(false);
  });
});

describe("malicious / hostile repo input is rejected (never sanitized)", () => {
  it("slug parts reject control characters, unicode, overlong values, dot endings", () => {
    expect(ScmRepoSlugPartSchema.safeParse("ok-name_1.2").success).toBe(true);
    expect(ScmRepoSlugPartSchema.safeParse("bad\u0000name").success).toBe(false);
    expect(ScmRepoSlugPartSchema.safeParse("bad\u001Fname").success).toBe(false);
    expect(ScmRepoSlugPartSchema.safeParse("имя").success).toBe(false);
    expect(ScmRepoSlugPartSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(ScmRepoSlugPartSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(ScmRepoSlugPartSchema.safeParse("repo.git").success).toBe(false);
    expect(ScmRepoSlugPartSchema.safeParse("repo.").success).toBe(false);
    expect(ScmRepoSlugPartSchema.safeParse("..").success).toBe(false);
  });

  it("git refs reject traversal and git-forbidden shapes", () => {
    expect(ScmGitRefSchema.safeParse("feature/ok-name_1.2").success).toBe(true);
    expect(ScmGitRefSchema.safeParse("release-1.0.0").success).toBe(true);
    expect(ScmGitRefSchema.safeParse("a..b").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("feature//x").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("refs@{0}").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("branch.lock").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad~ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad^ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad:ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad*ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad?ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad[ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad\\ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("bad ref").success).toBe(false);
    expect(ScmGitRefSchema.safeParse("/leading-slash").success).toBe(false);
    expect(ScmGitRefSchema.safeParse(`a${"a".repeat(255)}`).success).toBe(false);
  });

  it("text fields reject control characters and Trojan-Source bidi/zero-width overrides", () => {
    expect(ScmTitleSchema.safeParse("正常标题 with CJK").success).toBe(true);
    expect(ScmTitleSchema.safeParse("newlines\tpass\r\nthrough").success).toBe(true);
    expect(ScmBodySchema.safeParse("multi\nline\tbody\r\n").success).toBe(true);
    expect(ScmBodySchema.safeParse("null\u0000byte").success).toBe(false);
    expect(ScmBodySchema.safeParse("bell\u0007char").success).toBe(false);
    expect(ScmBodySchema.safeParse("esc\u001B[31m").success).toBe(false);
    expect(ScmBodySchema.safeParse("rtl\u202Eoverride").success).toBe(false);
    expect(ScmBodySchema.safeParse("zero\u200Bwidth").success).toBe(false);
    expect(ScmBodySchema.safeParse("bom\uFEFFmark").success).toBe(false);
    expect(ScmBodySchema.safeParse("b".repeat(65_537)).success).toBe(false);
    expect(ScmBodySchema.safeParse("b".repeat(65_536)).success).toBe(true);
  });

  it("digests and SHAs are shape-pinned", () => {
    expect(ScmCommitShaSchema.safeParse(SHA_BASE).success).toBe(true);
    expect(ScmCommitShaSchema.safeParse(SHA_BASE.toUpperCase()).success).toBe(false);
    expect(ScmCommitShaSchema.safeParse(SHA_BASE.slice(1)).success).toBe(false);
    expect(ScmApprovalRefSchema.safeParse({ approvalId: "approval-1", actionDigest: "0".repeat(64) }).success).toBe(true);
    expect(ScmApprovalRefSchema.safeParse({ approvalId: "approval-1", actionDigest: "0".repeat(63) }).success).toBe(false);
    expect(ScmApprovalRefSchema.safeParse({ approvalId: "approval-1", actionDigest: SHA_BASE }).success).toBe(false);
    expect(
      ScmApprovalRefSchema.safeParse({ approvalId: "bad id!", actionDigest: "0".repeat(64) }).success
    ).toBe(false);
  });

  it("binding requires a full valid context (a write without a head SHA cannot be expressed)", () => {
    const missingHead = issueCommentCommand();
    (missingHead.binding as Record<string, unknown>).headSha = "short";
    expect(ScmCreateIssueCommentCommandSchema.safeParse(missingHead).success).toBe(false);
  });
});

describe("credentialRef: references only, plaintext tokens rejected (A42)", () => {
  it("accepts env / keyring / file reference shapes", () => {
    expect(ScmCredentialRefSchema.safeParse({ source: "env", envVar: "GITHUB_TOKEN" }).success).toBe(true);
    expect(
      ScmCredentialRefSchema.safeParse({ source: "keyring", service: "role-orchestrator", account: "github" })
        .success
    ).toBe(true);
    expect(
      ScmCredentialRefSchema.safeParse({ source: "file", path: "/run/secrets/github_token" }).success
    ).toBe(true);
  });

  it("rejects plaintext token material in ANY field, across known shapes", () => {
    const smuggles: readonly [string, Record<string, unknown>][] = [
      ["github classic PAT as envVar", { source: "env", envVar: "ghp_1234567890abcdefghij" }],
      ["gitlab PAT as path", { source: "file", path: "glpat-1234567890abcdefgh" }],
      ["bearer header as keyring service", { source: "keyring", service: "Bearer abcdefghijklmn", account: "x" }],
      [
        "token=... key-value form as account",
        { source: "keyring", service: "s", account: "token=1234567890abcdef" }
      ]
    ];
    for (const [label, ref] of smuggles) {
      const result = ScmCredentialRefSchema.safeParse(ref);
      expect(result.success, label).toBe(false);
      if (result.success === false) {
        const messages = result.error.issues.map((issue) => issue.message).join("\n");
        expect(messages, label).toContain("plaintext credential material");
      }
    }
  });

  it("rejects unknown sources and extra fields (a raw token field cannot be expressed)", () => {
    expect(ScmCredentialRefSchema.safeParse({ source: "inline", token: "ghp_1234567890abcdefghij" }).success).toBe(false);
    expect(ScmCredentialRefSchema.safeParse({ source: "env", envVar: "GITHUB_TOKEN", token: "x" }).success).toBe(false);
    expect(ScmCredentialRefSchema.safeParse({ source: "env", envVar: "lowercase_name" }).success).toBe(false);
  });
});

describe("base URL SSRF guards", () => {
  it("accepts https DNS hosts (with optional port), rejects everything smuggler-shaped", () => {
    expect(ScmBaseUrlSchema.safeParse("https://github.example.invalid").success).toBe(true);
    expect(ScmBaseUrlSchema.safeParse("https://ghe.corp.example:8443").success).toBe(true);
    expect(ScmBaseUrlSchema.safeParse("http://github.example.invalid").success).toBe(false);
    expect(ScmBaseUrlSchema.safeParse("https://user:pass@github.example.invalid").success).toBe(false);
    expect(ScmBaseUrlSchema.safeParse("https://github.example.invalid/api/v3").success).toBe(false);
    expect(ScmBaseUrlSchema.safeParse("https://github.example.invalid/?x=1").success).toBe(false);
    expect(ScmBaseUrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
    expect(ScmBaseUrlSchema.safeParse(`https://${"a".repeat(300)}`).success).toBe(false);
  });
});

describe("binding fixture consistency", () => {
  it("head/base SHAs and binding are shared by both command fixtures", () => {
    expect(bindingFixture().baseSha).toBe(SHA_BASE);
    expect(issueCommentCommand().binding).toEqual(createPullRequestCommand().binding);
  });
});
