/**
 * Read models for the SCMProvider read-only surface (M7-01).
 *
 * Read operations need NO approval (低风险只读分析) but they are where
 * repository-controlled content enters the orchestrator, so every echoed text
 * field is bounded and control/bidi-free, every page is a strict object with a
 * CLOSED field set (unknown fields are rejected), and each page carries
 * `malformedDropped` — the adapter's OBLIGATION to drop (and count) provider
 * items that do not project cleanly instead of failing a whole page. The
 * client in ./clients.js still strict-parses what the transport returns, so a
 * skipped projection fails loudly as a ScmTransportContractError.
 *
 * Bodies are deliberately NOT part of the v1 read models: issue/PR text is
 * untrusted free text with no decision value for CI/DAG use, and not modeling
 * it is the strongest redaction. Fetching text is future work with its own
 * scrubbing pipeline.
 */
import { z } from "zod";
import {
  ScmCommitShaSchema,
  ScmCommitishSchema,
  ScmIssueNumberSchema,
  ScmProviderTextSchema,
  ScmRepoSlugPartSchema,
  ScmTitleSchema
} from "./input.js";

export const ScmRepoRefSchema = z.strictObject({
  owner: ScmRepoSlugPartSchema,
  name: ScmRepoSlugPartSchema
});
export type ScmRepoRef = z.output<typeof ScmRepoRefSchema>;

// ---------------------------------------------------------------------------
// Queries (local caller input)
// ---------------------------------------------------------------------------

export const ScmListIssuesQuerySchema = z.strictObject({
  repo: ScmRepoRefSchema,
  state: z.enum(["open", "closed", "all"]),
  limit: z.number().int().min(1).max(100).optional()
});
export type ScmListIssuesQuery = z.output<typeof ScmListIssuesQuerySchema>;

export const ScmListPullRequestsQuerySchema = z.strictObject({
  repo: ScmRepoRefSchema,
  state: z.enum(["open", "closed", "merged", "all"]),
  limit: z.number().int().min(1).max(100).optional()
});
export type ScmListPullRequestsQuery = z.output<typeof ScmListPullRequestsQuerySchema>;

export const ScmListChecksQuerySchema = z.strictObject({
  repo: ScmRepoRefSchema,
  /** The commit (SHA) or ref whose checks are listed. */
  ref: ScmCommitishSchema,
  limit: z.number().int().min(1).max(100).optional()
});
export type ScmListChecksQuery = z.output<typeof ScmListChecksQuerySchema>;

export const ScmListStatusesQuerySchema = z.strictObject({
  repo: ScmRepoRefSchema,
  ref: ScmCommitishSchema,
  limit: z.number().int().min(1).max(100).optional()
});
export type ScmListStatusesQuery = z.output<typeof ScmListStatusesQuerySchema>;

// ---------------------------------------------------------------------------
// Projected provider items
// ---------------------------------------------------------------------------

export const ScmIssueSchema = z.strictObject({
  number: ScmIssueNumberSchema,
  state: z.enum(["open", "closed"]),
  title: ScmTitleSchema
});
export type ScmIssue = z.output<typeof ScmIssueSchema>;

export const ScmPullRequestSchema = z.strictObject({
  number: ScmIssueNumberSchema,
  state: z.enum(["open", "closed", "merged"]),
  title: ScmTitleSchema,
  /** Head commit as echoed by the provider; null when the provider reports none. */
  headSha: ScmCommitShaSchema.nullable()
});
export type ScmPullRequest = z.output<typeof ScmPullRequestSchema>;

export const ScmCheckRunSchema = z.strictObject({
  name: ScmProviderTextSchema,
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"])
    .nullable()
});
export type ScmCheckRun = z.output<typeof ScmCheckRunSchema>;

export const ScmCommitStatusSchema = z.strictObject({
  context: ScmProviderTextSchema,
  state: z.enum(["error", "failure", "pending", "success"])
});
export type ScmCommitStatus = z.output<typeof ScmCommitStatusSchema>;

// ---------------------------------------------------------------------------
// Pages — strict envelopes with the adapter's drop-obligation counter
// ---------------------------------------------------------------------------

function pageOf<ItemSchema extends z.ZodType>(item: ItemSchema) {
  return z.strictObject({
    items: z.array(item).max(100),
    /** Items the adapter dropped because they failed strict projection. */
    malformedDropped: z.number().int().min(0)
  });
}

export const ScmIssuePageSchema = pageOf(ScmIssueSchema);
export type ScmIssuePage = z.output<typeof ScmIssuePageSchema>;

export const ScmPullRequestPageSchema = pageOf(ScmPullRequestSchema);
export type ScmPullRequestPage = z.output<typeof ScmPullRequestPageSchema>;

export const ScmChecksPageSchema = pageOf(ScmCheckRunSchema);
export type ScmChecksPage = z.output<typeof ScmChecksPageSchema>;

export const ScmStatusesPageSchema = pageOf(ScmCommitStatusSchema);
export type ScmStatusesPage = z.output<typeof ScmStatusesPageSchema>;
