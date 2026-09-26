/**
 * Safe scalar schemas for SCM-facing inputs (M7-01).
 *
 * Every provider-facing string crosses an untrusted boundary TWICE: once from
 * the local caller (which may relay repository-controlled text) and once from
 * the remote provider (whose responses are attacker-influenced by any public
 * repository's content). The schemas here reject, never sanitize: control
 * characters, Trojan-Source bidi/zero-width overrides, oversized values and
 * non-conforming shapes fail closed. Where a value must still flow after a
 * rejection would be wrong (free-text bodies destined for audit sinks), the
 * caller scrubs via `scrubCredentialMaterial` in ./events.js instead.
 *
 * Timestamps follow the store-wide convention (packages/store/src/time.ts):
 * fixed-width UTC ISO strings from Date.prototype.toISOString(), compared
 * lexicographically. The pattern is pinned locally so this contracts package
 * does not depend on the store implementation for one regex.
 */
import { z } from "zod";
import { withUniqueItems } from "@role-orchestrator/contracts";

/** sha256 hex digest (64 lowercase hex chars). */
export const ScmDigestHexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "must be a 64-char lowercase hex sha256 digest"
});

/** Full lowercase 40-hex git commit SHA — same discipline as the integration manifest. */
export const ScmCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, {
  message: "must be a full lowercase 40-hex git commit SHA"
});

/** Fixed-width UTC ISO timestamp (packages/store/src/time.ts convention). */
export const ScmTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  { message: "timestamp must be a fixed-width UTC ISO string as produced by Date.prototype.toISOString()" }
);

/** One path segment of a repository slug (owner or repo name). */
export const ScmRepoSlugPartSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, {
    message: "repository slug part must start alphanumeric and contain only [A-Za-z0-9._-] (max 128)"
  })
  .check((ctx) => {
    if (ctx.value.endsWith(".") || ctx.value.endsWith(".git")) {
      ctx.issues.push({
        code: "custom",
        message: "repository slug part must not end with '.' or '.git'",
        input: ctx.value
      });
    }
  });

/**
 * A git ref name (branch or tag), restricted to the safe subset of git-check-ref-format:
 * no "..", no "//", no "@{", no leading/trailing "/", no trailing ".lock", and the
 * forbidden characters ~ ^ : ? * [ \ plus whitespace/control characters are excluded
 * by the character class itself.
 */
export const ScmGitRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9_-])?$/, {
    message:
      "git ref must start alphanumeric, contain only [A-Za-z0-9._/-] (max 255) and not end with '/'"
  })
  .check((ctx) => {
    const value = ctx.value;
    if (value.includes("..")) {
      ctx.issues.push({ code: "custom", message: "git ref must not contain '..'", input: value });
    }
    if (value.includes("//")) {
      ctx.issues.push({ code: "custom", message: "git ref must not contain '//'", input: value });
    }
    if (value.includes("@{")) {
      ctx.issues.push({ code: "custom", message: "git ref must not contain '@{'", input: value });
    }
    if (value.endsWith(".lock")) {
      ctx.issues.push({ code: "custom", message: "git ref must not end with '.lock'", input: value });
    }
  });

/** A commit-ish reference for read queries: a full 40-hex SHA or a safe ref name. */
export const ScmCommitishSchema = z.union([ScmCommitShaSchema, ScmGitRefSchema]);

/** Issue / pull request numbers as remote providers expose them. */
export const ScmIssueNumberSchema = z.number().int().min(1).max(10_000_000);

/**
 * Characters that make free text unsafe for this package's purposes: C0/C1
 * control characters (except \t \n \r), DEL, and the Unicode bidi/zero-width
 * override family used by Trojan-Source attacks (U+200B..U+200F, U+202A..U+202E,
 * U+2060..U+2064, U+2066..U+2069, U+FEFF).
 */
export const UNSAFE_TEXT_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function safeText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .check((ctx) => {
      if (UNSAFE_TEXT_PATTERN.test(ctx.value)) {
        ctx.issues.push({
          code: "custom",
          message:
            "text must not contain control characters, DEL, or bidi/zero-width override characters (Trojan-Source guard)",
          input: ctx.value
        });
      }
    });
}

/** A human-visible title (provider-issued or local). */
export const ScmTitleSchema = safeText(512);
/** A comment/PR body. Free text, but still bounded and control/bidi-free. */
export const ScmBodySchema = safeText(65_536);
/** A check-run name or commit-status context echoed by a provider. */
export const ScmProviderTextSchema = safeText(256);

/** Provider-issued opaque object id (comment id, external id). */
export const ScmExternalIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/, {
  message: "external id must contain only [A-Za-z0-9_.:-] (max 128)"
});

/** Re-exported so callers can build unique arrays without reaching into contracts. */
export { withUniqueItems };
