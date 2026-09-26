/**
 * Multi-parent baseline integration (M2-04) — the IntegrationService of
 * docs/GIT_AND_WORKSPACES.md, the SINGLE writer of a run's `task/<run-id>`
 * branch.
 *
 * Protocol per docs (提交与集成) and the A09/A10/A25 acceptance rows:
 *
 *   认领 (record IN_PROGRESS + manifest) -> 校验目标旧 SHA (parent tips +
 *   branch/baseSha lineage) -> 按既定顺序合并候选输出 (topological merge
 *   chain, deterministic identity) -> 保存集成记录与新 candidateSha ->
 *   (Reviewer trigger is a later milestone).
 *
 * A09 — the successor's inputSha set is the ORDERED list of accepted parent
 * output commits; every parent is merged onto the integration branch, so the
 * final candidateSha contains ALL parent outputs (ancestry + content).
 *
 * A10 — a conflicting merge NEVER resolves itself: no `--ours`/`--theirs`, no
 * abort, no branch deletion. The record goes PAUSED_CONFLICT with the unmerged
 * file list and the conflict scene stays in the integration worktree; the
 * typed `IntegrationConflictError` is thrown only AFTER the pause is durable.
 * No branch of any parent is ever touched by this module.
 *
 * A25 — merge commits are created under a FIXED author/committer/date env
 * (`DETERMINISTIC_COMMIT_ENV`), so the whole integration is a pure function of
 * (base tree, ordered parents). The windows between "git committed" and "the
 * DB says so" converge through `reconcileIntegration` without any duplicate
 * commit: a retry re-merges already-ancestor parents ("Already up to date" is
 * a no-op) and reproduces the identical candidateSha.
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import { derivedId } from "@role-orchestrator/scheduler";
import {
  GitCommandError,
  GitRunner,
  WorktreePathConflictError,
  parseWorktreeListPorcelain
} from "@role-orchestrator/worktree";
import {
  CommitShaSchema,
  DETERMINISTIC_COMMIT_ENV,
  IntegrationManifestSchema,
  ParentCommitSchema,
  integrationBranchName,
  integrationWorktreePathFor,
  mergeCommitMessage,
  type IntegrationManifest,
  type ParentCommit
} from "./manifest.js";
import {
  completeIntegrationRecord,
  createIntegrationRecord,
  getIntegrationRecord,
  pauseIntegrationRecord,
  updateIntegrationManifest
} from "./record.js";
import {
  IntegrationBranchContradictionError,
  IntegrationConflictError,
  IntegrationMergeStateLeftError,
  ParentOutputMovedError
} from "./errors.js";
import { reconcileProbe } from "./reconcile.js";
import { isAncestorOrEqual, listUnmergedFiles, tryResolveRef } from "./probe.js";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

const ParentOutputSchema = ParentCommitSchema;

const IntegrateInputSchema = z.strictObject({
  /** The USER repository (bare metadata owner of all branches/worktrees). */
  repoPath: AbsolutePathSchema,
  /** Engine-managed worktrees root; the integration worktree lives under it. */
  worktreesRoot: AbsolutePathSchema,
  runId: IdSchema,
  /** The SUCCESSOR node whose baseline is being assembled. */
  nodeId: IdSchema,
  /** The run's pinned base commit. */
  baseSha: CommitShaSchema,
  /**
   * Accepted parent outputs in the plan's topological order. Order is part of
   * the integration identity and of the inputSha set (A09).
   */
  parents: z.array(ParentOutputSchema).min(1).max(64),
  now: z.string().min(1).max(64)
});

export type IntegrateParentsInput = z.input<typeof IntegrateInputSchema>;

export interface IntegratedOutcome {
  readonly kind: "integrated";
  readonly candidateSha: string;
  /** The structured inputSha set actually integrated (ordered). */
  readonly inputShaSet: readonly ParentCommit[];
  readonly integrationBranch: string;
  readonly integrationWorktreePath: string;
  readonly integrationId: string;
}

export interface AlreadyIntegratedOutcome {
  readonly kind: "already-integrated";
  readonly candidateSha: string;
  readonly integrationId: string;
  /** How the completion state was (re)established. */
  readonly via: "record" | "reconcile";
}

export type IntegrateOutcome = IntegratedOutcome | AlreadyIntegratedOutcome;

export interface IntegrateParentsDeps {
  readonly db: DatabaseSync;
  readonly git: GitRunner;
}

/**
 * Integrate the ordered parent output set into the run's task branch and
 * record the successor's inputSha set + candidateSha. Idempotent: a COMPLETED
 * record (candidateSha still an ancestor of the branch head) is absorbed as
 * `already-integrated`; an IN_PROGRESS record is first pushed through the
 * reconcile probe, which either completes it, stops on an unresolved merge
 * scene, or clears it as safe-to-retry.
 */
export async function integrateParents(
  deps: IntegrateParentsDeps,
  input: IntegrateParentsInput
): Promise<IntegrateOutcome> {
  const { db, git } = deps;
  const value = IntegrateInputSchema.parse(input);
  await git.assertAvailable();

  const integrationId = derivedId(
    "integ",
    value.runId,
    value.nodeId,
    ...value.parents.map((parent) => `${parent.nodeId}@${parent.headSha}`)
  );
  const branch = integrationBranchName(value.runId);
  const worktreePath = integrationWorktreePathFor(value.worktreesRoot, value.runId);

  // ---- 认领: existing record decides the entry path -------------------------
  const existing = getIntegrationRecord(db, { runId: value.runId, nodeId: value.nodeId });
  if (existing !== undefined && existing !== null) {
    if (existing.state === "PAUSED_CONFLICT") {
      // A10 is terminal in this milestone: queryable, never auto-resumed.
      throw new IntegrationConflictError({
        runId: existing.runId,
        nodeId: existing.nodeId,
        integrationId: existing.integrationId,
        conflictFiles: existing.conflictFiles ?? [],
        conflictParentNodeId: existing.conflictParentNodeId ?? ""
      });
    }
    if (existing.state === "COMPLETED") {
      if (existing.integrationId !== integrationId) {
        throw new IntegrationBranchContradictionError({
          branch,
          headSha: null,
          detail: `COMPLETED record holds a different parent set (${existing.integrationId}) than this call (${integrationId}); one successor node has exactly one integration — recovery is an explicit later milestone`
        });
      }
      const candidate = existing.candidateSha;
      if (candidate === null) {
        throw new IntegrationBranchContradictionError({
          branch,
          headSha: null,
          detail: "record is COMPLETED but carries no candidateSha (corrupt record)"
        });
      }
      const head = await tryResolveRef(git, value.repoPath, `refs/heads/${branch}`);
      if (head === null || !(await isAncestorOrEqual(git, value.repoPath, candidate, head))) {
        throw new IntegrationBranchContradictionError({
          branch,
          headSha: head,
          detail: `recorded candidateSha ${candidate} is no longer reachable from the branch head`
        });
      }
      return {
        kind: "already-integrated",
        candidateSha: candidate,
        integrationId: existing.integrationId,
        via: "record"
      };
    }
    // IN_PROGRESS: a previous attempt died somewhere. Reconcile decides.
    const verdict = await reconcileProbe(git, { record: existing });
    if (verdict.kind === "committed") {
      completeIntegrationRecord(db, {
        runId: value.runId,
        nodeId: value.nodeId,
        candidateSha: verdict.candidateSha,
        now: value.now
      });
      return {
        kind: "already-integrated",
        candidateSha: verdict.candidateSha,
        integrationId: existing.integrationId,
        via: "reconcile"
      };
    }
    if (verdict.kind === "merge-in-progress") {
      throw new IntegrationMergeStateLeftError({
        worktreePath,
        conflictFiles: verdict.conflictFiles
      });
    }
    // verdict.kind === "safe-to-retry": fall through; the merge loop below
    // re-executes and every already-merged parent is a git no-op.
  }

  // ---- worktree acquisition: reuse the registered one or create fresh ------
  await acquireIntegrationWorktree(git, {
    repoPath: value.repoPath,
    worktreePath,
    branch,
    baseSha: value.baseSha
  });

  // ---- 校验目标旧 SHA: every parent tip must still be the accepted output --
  for (const parent of value.parents) {
    const tip = await tryResolveRef(git, value.repoPath, `refs/heads/${parent.branch}`);
    if (tip === null || tip !== parent.headSha) {
      throw new ParentOutputMovedError({
        parentNodeId: parent.nodeId,
        branch: parent.branch,
        expectedHeadSha: parent.headSha,
        actualHeadSha: tip
      });
    }
  }

  // ---- the durable claim (manifest with candidateSha: null, A25 anchor) ----
  let manifest: IntegrationManifest;
  if (existing !== null && existing.state === "IN_PROGRESS") {
    if (existing.integrationId !== integrationId) {
      throw new IntegrationBranchContradictionError({
        branch,
        headSha: null,
        detail: `IN_PROGRESS record holds a different parent set (${existing.integrationId}) than this call (${integrationId}); refusing to redefine an open integration`
      });
    }
    manifest = existing.manifest; // keeps createdAt; candidateSha stays null on the safe-to-retry path
  } else {
    manifest = IntegrationManifestSchema.parse({
      schemaVersion: 1,
      integrationId,
      runId: value.runId,
      nodeId: value.nodeId,
      repoPath: value.repoPath,
      integrationBranch: branch,
      integrationWorktreePath: worktreePath,
      baseSha: value.baseSha,
      parents: value.parents,
      candidateSha: null,
      createdAt: value.now
    });
    createIntegrationRecord(db, { id: integrationId, manifest, now: value.now });
  }

  // ---- 按既定顺序合并候选输出 (deterministic identity per merge) ------------
  for (const [index, parent] of value.parents.entries()) {
    const message = mergeCommitMessage(manifest, parent, index, value.parents.length);
    const merge = await git.tryRun(
      worktreePath,
      ["merge", "--no-ff", "-m", message, parent.headSha],
      { env: { ...DETERMINISTIC_COMMIT_ENV } }
    );
    if (merge.exitCode !== 0) {
      const conflictFiles = await listUnmergedFiles(git, worktreePath);
      if (conflictFiles.length > 0) {
        // A10: persist the pause FIRST, then signal. No ours/theirs, no abort,
        // no cleanup — the scene (MERGE_HEAD + unmerged index) stays as-is.
        pauseIntegrationRecord(db, {
          runId: value.runId,
          nodeId: value.nodeId,
          conflictFiles,
          conflictParentNodeId: parent.nodeId,
          now: value.now
        });
        throw new IntegrationConflictError({
          runId: value.runId,
          nodeId: value.nodeId,
          integrationId,
          conflictFiles,
          conflictParentNodeId: parent.nodeId
        });
      }
      throw new GitCommandError(
        merge.argv,
        merge.cwd,
        merge.exitCode,
        merge.stderr.trim().slice(-400)
      );
    }
  }

  // ---- candidateSha + the two A25-separated DB writes ----------------------
  const finalHead = await git.run(worktreePath, ["rev-parse", "HEAD"]);
  const candidateSha = CommitShaSchema.parse(finalHead.stdout.trim());
  manifest = IntegrationManifestSchema.parse({ ...manifest, candidateSha });
  // DB write #1 — the manifest now carries the "预期 commit SHA" (A25).
  updateIntegrationManifest(db, {
    runId: value.runId,
    nodeId: value.nodeId,
    manifest,
    now: value.now
  });
  // DB write #2 — the completion. A crash before THIS line is the A25 window;
  // reconcileIntegration compares the branch head against the recorded
  // candidateSha and backfills without ever committing again.
  const record = completeIntegrationRecord(db, {
    runId: value.runId,
    nodeId: value.nodeId,
    candidateSha,
    now: value.now
  });

  return {
    kind: "integrated",
    candidateSha: record.candidateSha ?? candidateSha,
    inputShaSet: record.inputShaSet,
    integrationBranch: branch,
    integrationWorktreePath: worktreePath,
    integrationId
  };
}

// ---------------------------------------------------------------------------
// Worktree acquisition
// ---------------------------------------------------------------------------

async function acquireIntegrationWorktree(
  git: GitRunner,
  input: {
    readonly repoPath: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseSha: string;
  }
): Promise<void> {
  const dirExists = existsSync(input.worktreePath);
  const registrations = parseWorktreeListPorcelain(
    (await git.run(input.repoPath, ["worktree", "list", "--porcelain"])).stdout
  );
  const registration = registrations.find(
    (entry) => entry.path.replace(/\\/g, "/").toLowerCase() === input.worktreePath.replace(/\\/g, "/").toLowerCase()
  );

  if (dirExists && registration === undefined) {
    // An unregistered directory at the managed path: never adopt it (the same
    // fail-closed rule as M2-03's createWorktree).
    throw new WorktreePathConflictError(input.worktreePath);
  }

  if (registration !== undefined) {
    if (registration.branchRef !== `refs/heads/${input.branch}`) {
      throw new IntegrationBranchContradictionError({
        branch: input.branch,
        headSha: null,
        detail: `integration worktree is registered for ${registration.branchRef ?? "(no branch)"}, expected refs/heads/${input.branch}`
      });
    }
    return; // reuse: the single-writer worktree for this run's task branch
  }

  const branchExists = await git.tryRun(input.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${input.branch}`
  ]);
  if (branchExists.exitCode !== 0) {
    // Fresh assembly: new branch from the pinned base (M2-03's exact shape).
    await assertResolves(git, input.repoPath, `${input.baseSha}^{commit}`, "baseSha");
    await git.run(input.repoPath, [
      "worktree",
      "add",
      "-b",
      input.branch,
      input.worktreePath,
      input.baseSha
    ]);
    const head = await git.run(input.worktreePath, ["rev-parse", "HEAD"]);
    if (head.stdout.trim() !== input.baseSha) {
      throw new IntegrationBranchContradictionError({
        branch: input.branch,
        headSha: head.stdout.trim(),
        detail: `fresh integration worktree head does not match the pinned base ${input.baseSha}`
      });
    }
    return;
  }

  // Branch survived (previous attempt), worktree does not: re-attach WITHOUT
  // rewriting anything, after proving the branch still descends from base.
  const head = await tryResolveRef(git, input.repoPath, `refs/heads/${input.branch}`);
  if (head === null || !(await isAncestorOrEqual(git, input.repoPath, input.baseSha, head))) {
    throw new IntegrationBranchContradictionError({
      branch: input.branch,
      headSha: head,
      detail: `branch does not descend from the run base ${input.baseSha}; refusing to attach or overwrite`
    });
  }
  await git.run(input.repoPath, ["worktree", "add", input.worktreePath, input.branch]);
}

async function assertResolves(
  git: GitRunner,
  repoPath: string,
  ref: string,
  label: string
): Promise<void> {
  if ((await git.tryRun(repoPath, ["rev-parse", "--verify", "--quiet", ref])).exitCode !== 0) {
    throw new IntegrationBranchContradictionError({
      branch: label,
      headSha: null,
      detail: `${label} "${ref}" does not resolve to a commit`
    });
  }
}
