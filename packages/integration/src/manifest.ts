/**
 * The integration manifest (M2-04) — the durable description of ONE baseline
 * assembly, written into `integration_records.manifest` BEFORE the integration
 * commits exist and re-validated strictly on every read (A25: reconcile
 * compares git reality against THIS document, so it must be tamper-evident
 * through strict parsing, never guessed).
 *
 * Structure (docs/GIT_AND_WORKSPACES.md 提交与集成 + A25):
 * - repoPath / integrationBranch / integrationWorktreePath — where the single
 *   writer (IntegrationService, sole writer of the `task/<run-id>` branch)
 *   operates;
 * - parents — the STRUCTURED inputSha set: the accepted output commit of every
 *   parent node, in the caller's topological order (A09: 后继 inputSha 同时
 *   包含全部父输出). Order is part of the identity;
 * - deterministic commit identity — the merge commits are produced under a
 *   FIXED author/committer/date environment, so the whole integration is a
 *   pure function of (base tree, parent set, order). That is what makes a
 *   crashed integration safely RETRYABLE without any duplicate commit: the
 *   retry reproduces byte-identical commits, and git's object database
 *   absorbs them ("Already up to date").
 */
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";

/** Full lowercase 40-hex git commit SHA (the inputSha/candidateSha discipline). */
export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, {
  message: "must be a full lowercase 40-hex git commit SHA"
});

/** One accepted parent output: the structured element of the inputSha set. */
export const ParentCommitSchema = z.strictObject({
  /** Producing node id. */
  nodeId: IdSchema,
  /** The exec branch the output lives on (`exec/<run>/<node>/<attempt>`). */
  branch: z.string().min(1).max(256),
  /** Accepted output commit SHA (the node's outputSha). */
  headSha: CommitShaSchema
});

export type ParentCommit = z.output<typeof ParentCommitSchema>;

export const INTEGRATION_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Identity used for every integration commit in this run+node assembly.
 * Fixed dates are the A25 determinism anchor: identical (tree, parents,
 * message) always hashes to the identical commit, so retries and reconciles
 * can never double-commit.
 */
export const DETERMINISTIC_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "role-orchestrator-integration",
  GIT_AUTHOR_EMAIL: "integration@role-orchestrator.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "role-orchestrator-integration",
  GIT_COMMITTER_EMAIL: "integration@role-orchestrator.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

export const IntegrationManifestSchema = z.strictObject({
  schemaVersion: z.literal(INTEGRATION_MANIFEST_SCHEMA_VERSION),
  /** Derived deterministic id: derivedId("integ", run, node, ordered parent shas). */
  integrationId: IdSchema,
  runId: IdSchema,
  /** The SUCCESSOR node this baseline is assembled for. */
  nodeId: IdSchema,
  repoPath: z.string().min(1).max(2048),
  /** `task/<run-id>` — the branch ONLY the integration writer may move. */
  integrationBranch: z.string().min(1).max(256),
  integrationWorktreePath: z.string().min(1).max(2048),
  /** The run's pinned base commit (fixed baseline discipline). */
  baseSha: CommitShaSchema,
  parents: z.array(ParentCommitSchema).min(1).max(64),
  /**
   * The expected tip after the LAST merge of the sequence. Null until the
   * merges have produced it; once recorded it is the A25 comparison anchor
   * ("预期 commit SHA"): reconcile treats branch-head == candidateSha as
   * "committed", which is the exact commit-done/DB-not-updated window.
   */
  candidateSha: CommitShaSchema.nullable(),
  createdAt: z.string().min(1).max(64)
});

export type IntegrationManifest = z.output<typeof IntegrationManifestSchema>;

/** Frozen task-branch layout of docs/GIT_AND_WORKSPACES.md. */
export function integrationBranchName(runId: string): string {
  return `task/${IdSchema.parse(runId)}`;
}

/**
 * Engine-managed integration worktree location. It lives under
 * `<worktreesRoot>/_integration/<run-id>` — the leading underscore can never
 * collide with a run or node id (ids start `[a-z]`), so an exec worktree
 * (`<worktreesRoot>/<run>/<node>/<attempt>`) and the integration worktree can
 * never share a directory prefix by accident.
 */
export function integrationWorktreePathFor(worktreesRoot: string, runId: string): string {
  return (
    worktreesRoot.replace(/[\\/]+$/, "") + "/_integration/" + IdSchema.parse(runId)
  ).replace(/\\/g, "/");
}

/**
 * Deterministic merge-commit message for one parent step. Position is part
 * of the message so the commit chain is fully described by its own history.
 */
export function mergeCommitMessage(
  manifest: Pick<IntegrationManifest, "runId" | "nodeId" | "integrationId">,
  parent: ParentCommit,
  index: number,
  total: number
): string {
  return (
    `integrate ${manifest.runId}/${manifest.nodeId} ` +
    `step ${String(index + 1)}/${String(total)} ` +
    `parent ${parent.nodeId} ${parent.headSha} ` +
    `[${manifest.integrationId}]`
  );
}
