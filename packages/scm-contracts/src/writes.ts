/**
 * Controlled write commands, the ApprovalRef, and receipts (M7-01).
 *
 * A write COMMAND is the complete A17-bound unit: the operation payload (what)
 * plus the run binding (where/under what authority it was prepared). The
 * binding is part of the schema, not a side channel, because every binding
 * field feeds the actionDigest (see ./write-binding.js): runtime, frozen
 * profile revision, repo root, managed worktree, baseline SHA, head SHA and
 * the acting role's granted permissions. Changing ANY of them after approval
 * changes the digest and the original approval becomes unconsumable — the
 * same "过期或基线改变不能消费" discipline as the local approval lifecycle.
 *
 * The ApprovalRef travels as a SEPARATE method argument (never inside the
 * command) so that omitting it is a compile-time arity error for typed callers
 * and a dedicated runtime error (ScmApprovalRequiredError) for untyped ones.
 *
 * Receipts carry structural facts plus content DIGESTS only — never content,
 * never credentials (A42).
 */
import { z } from "zod";
import { IdSchema, PermissionIdSchema, RuntimeSchema } from "@role-orchestrator/contracts";
import {
  ScmBodySchema,
  ScmCommitShaSchema,
  ScmDigestHexSchema,
  ScmExternalIdSchema,
  ScmGitRefSchema,
  ScmIssueNumberSchema,
  ScmTimestampSchema,
  ScmTitleSchema
} from "./input.js";
import { ScmProviderSchema } from "./capability.js";
import { ScmRepoRefSchema, type ScmRepoRef } from "./reads.js";

/** Run-context facts that bind a remote write to the execution preparing it. */
export const ScmWriteBindingSchema = z.strictObject({
  /** The bundled CLI runtime of the execution requesting the write (closed R02 vocabulary). */
  runtime: RuntimeSchema,
  /** The frozen ProfileSnapshot revision the action runs under. */
  profileRevision: z.string().min(1).max(128),
  /** Canonical local repository root the write derives from. */
  repoRoot: z.string().min(1).max(2048),
  /** Managed execution worktree the write was prepared in. */
  worktreePath: z.string().min(1).max(2048),
  /** The run's pinned baseline commit. */
  baseSha: ScmCommitShaSchema,
  /** The candidate commit this write publishes/updates. */
  headSha: ScmCommitShaSchema,
  /** Permissions the acting role currently holds (increments derive from this). */
  grantedPermissions: z.array(PermissionIdSchema).max(16).check((ctx) => {
    if (new Set(ctx.value).size !== ctx.value.length) {
      ctx.issues.push({ code: "custom", message: "grantedPermissions items must be unique", input: ctx.value });
    }
  })
});
export type ScmWriteBinding = z.output<typeof ScmWriteBindingSchema>;

// ---------------------------------------------------------------------------
// Write commands (one schema per operation — the closed operation enum lives
// in ./capability.js; adding an operation means adding a schema here too)
// ---------------------------------------------------------------------------

export const ScmCreateIssueCommentCommandSchema = z.strictObject({
  repo: ScmRepoRefSchema,
  issueNumber: ScmIssueNumberSchema,
  body: ScmBodySchema,
  binding: ScmWriteBindingSchema
});
export type ScmCreateIssueCommentCommand = z.output<typeof ScmCreateIssueCommentCommandSchema>;

export const ScmCreatePullRequestCommandSchema = z.strictObject({
  repo: ScmRepoRefSchema,
  title: ScmTitleSchema,
  body: ScmBodySchema,
  sourceBranch: ScmGitRefSchema,
  targetBranch: ScmGitRefSchema,
  binding: ScmWriteBindingSchema
});
export type ScmCreatePullRequestCommand = z.output<typeof ScmCreatePullRequestCommandSchema>;

export const ScmUpdatePullRequestTextCommandSchema = z.strictObject({
  repo: ScmRepoRefSchema,
  pullRequestNumber: ScmIssueNumberSchema,
  title: ScmTitleSchema,
  body: ScmBodySchema,
  binding: ScmWriteBindingSchema
});
export type ScmUpdatePullRequestTextCommand = z.output<typeof ScmUpdatePullRequestTextCommandSchema>;

// ---------------------------------------------------------------------------
// ApprovalRef — the caller-held proof that THIS command digest was approved
// ---------------------------------------------------------------------------

export const ScmApprovalRefSchema = z.strictObject({
  approvalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, {
    message: "approvalId must start alphanumeric and contain only [A-Za-z0-9_-] (max 128)"
  }),
  /** sha256 of the approved write command's canonical action descriptor. */
  actionDigest: ScmDigestHexSchema
});
export type ScmApprovalRef = z.output<typeof ScmApprovalRefSchema>;

// ---------------------------------------------------------------------------
// Transport projections (what an adapter returns) and receipts (what this
// package emits after merging projection + structural facts)
// ---------------------------------------------------------------------------

export const ScmIssueCommentProjectionSchema = z.strictObject({
  commentId: ScmExternalIdSchema,
  createdAt: ScmTimestampSchema
});
export type ScmIssueCommentProjection = z.output<typeof ScmIssueCommentProjectionSchema>;

export const ScmPullRequestProjectionSchema = z.strictObject({
  pullRequestNumber: ScmIssueNumberSchema,
  headSha: ScmCommitShaSchema.nullable(),
  updatedAt: ScmTimestampSchema
});
export type ScmPullRequestProjection = z.output<typeof ScmPullRequestProjectionSchema>;

export const ScmIssueCommentReceiptSchema = z.strictObject({
  provider: ScmProviderSchema,
  operation: z.literal("createIssueComment"),
  repo: ScmRepoRefSchema,
  issueNumber: ScmIssueNumberSchema,
  commentId: ScmExternalIdSchema,
  /** sha256 of the content AS SENT — computed here, never trusted from the wire. */
  contentSha256: ScmDigestHexSchema,
  createdAt: ScmTimestampSchema
});
export type ScmIssueCommentReceipt = z.output<typeof ScmIssueCommentReceiptSchema>;

export const ScmPullRequestReceiptSchema = z.strictObject({
  provider: ScmProviderSchema,
  operation: z.enum(["createPullRequest", "updatePullRequestText"]),
  repo: ScmRepoRefSchema,
  pullRequestNumber: ScmIssueNumberSchema,
  headSha: ScmCommitShaSchema.nullable(),
  contentSha256: ScmDigestHexSchema,
  updatedAt: ScmTimestampSchema
});
export type ScmPullRequestReceipt = z.output<typeof ScmPullRequestReceiptSchema>;

/** What the host's consume callback must return (verified against the store). */
export const ScmConsumptionEvidenceSchema = z.strictObject({
  approvalId: z.string().min(1).max(128),
  actionDigest: ScmDigestHexSchema,
  consumedByExecutionId: IdSchema,
  consumedAt: ScmTimestampSchema
});
export type ScmConsumptionEvidence = z.output<typeof ScmConsumptionEvidenceSchema>;

/** Narrow the repo field of any command/receipt schema instance. */
export type ScmWriteRepo = ScmRepoRef;
