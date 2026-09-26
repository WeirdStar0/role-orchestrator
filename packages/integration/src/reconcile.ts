/**
 * `reconcileIntegration` (M2-04, A25) — converge a crashed integration.
 *
 * The dangerous window of docs/ACCEPTANCE.md A25: "Git commit 后 DB 更新前
 * 崩溃 -> 根据 manifest/SHA 核对，不重复提交". This module NEVER commits,
 * merges, or moves a ref. It compares the PERSISTED manifest against real git
 * state and reports exactly one verdict:
 *
 *   committed             — branch head == the manifest's candidateSha (or the
 *                           candidate is already reachable from it): the git
 *                           half of the integration is done, so the only
 *                           missing step is the DB half, which is applied
 *                           under the IN_PROGRESS optimistic guard (补记 DB).
 *                           The merge commits are NEVER re-created: the
 *                           verdict is reached by reading, and the completion
 *                           write is idempotent (guarded UPDATE).
 *   already-recorded      — COMPLETED record whose candidateSha is still
 *                           reachable: verified, nothing to do.
 *   conflict-paused       — PAUSED_CONFLICT record: queryable A10 state, no
 *                           git action, no verdict change.
 *   merge-in-progress     — IN_PROGRESS with an unresolved merge scene
 *                           (unmerged entries and/or MERGE_HEAD): possibly an
 *                           UNRECORDED A10 conflict, so this is deliberately
 *                           NOT auto-resolved (manual inspection; nothing is
 *                           lost by waiting).
 *   safe-to-retry         — IN_PROGRESS with a clean worktree and either no
 *                           candidateSha yet (crash between merges) or none of
 *                           the commit's traces: retrying the integration
 *                           re-merges already-ancestor parents as git no-ops
 *                           and reproduces the byte-identical commits, so the
 *                           retry can never double-commit.
 *
 * When the recorded candidateSha exists as an object but is NOT reachable from
 * the branch head, the branch contradicts the record (external rewrite) and
 * the typed `IntegrationBranchContradictionError` stops everything — never a
 * forced overwrite.
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import type { GitRunner } from "@role-orchestrator/worktree";
import {
  completeIntegrationRecord,
  getIntegrationRecord,
  type IntegrationRecord
} from "./record.js";
import {
  IntegrationBranchContradictionError,
  UnknownIntegrationRecordError
} from "./errors.js";
import { isAncestorOrEqual, listUnmergedFiles } from "./probe.js";

export type ReconcileVerdict =
  | {
      readonly kind: "committed";
      readonly candidateSha: string;
    }
  | {
      readonly kind: "already-recorded";
      readonly candidateSha: string;
    }
  | {
      readonly kind: "conflict-paused";
      readonly conflictFiles: readonly string[];
      readonly conflictParentNodeId: string | null;
    }
  | {
      readonly kind: "merge-in-progress";
      readonly safeToRetry: false;
      readonly conflictFiles: readonly string[];
    }
  | {
      readonly kind: "safe-to-retry";
      readonly safeToRetry: true;
      readonly reason: string;
    };

const ReconcileInputSchema = z.strictObject({
  runId: IdSchema,
  nodeId: IdSchema,
  now: z.string().min(1).max(64)
});

export type ReconcileIntegrationInput = z.input<typeof ReconcileInputSchema>;

export interface ReconcileIntegrationDeps {
  readonly db: DatabaseSync;
  readonly git: GitRunner;
}

export interface ReconcileIntegrationResult {
  readonly verdict: ReconcileVerdict;
  readonly record: IntegrationRecord;
}

/**
 * Read-only git probe + guarded DB backfill. See the module contract for the
 * verdict vocabulary; the ONLY write this function ever performs is the
 * idempotent IN_PROGRESS -> COMPLETED completion of an integration whose git
 * commits verifiably landed.
 */
export async function reconcileIntegration(
  deps: ReconcileIntegrationDeps,
  input: ReconcileIntegrationInput
): Promise<ReconcileIntegrationResult> {
  const { db, git } = deps;
  const value = ReconcileInputSchema.parse(input);
  const record = getIntegrationRecord(db, { runId: value.runId, nodeId: value.nodeId });
  if (record === null) {
    throw new UnknownIntegrationRecordError(value.runId, value.nodeId);
  }

  const verdict = await reconcileProbe(git, { record });
  let current = record;

  if (verdict.kind === "committed" && record.state === "IN_PROGRESS") {
    current = completeIntegrationRecord(db, {
      runId: value.runId,
      nodeId: value.nodeId,
      candidateSha: verdict.candidateSha,
      now: value.now
    });
  }

  return { verdict, record: current };
}

/**
 * The shared probe used by BOTH `reconcileIntegration` (operator entry) and
 * `integrateParents` (re-entry onto an IN_PROGRESS record). Pure reads plus
 * the verdict logic; the callers decide what to persist.
 */
export async function reconcileProbe(
  git: GitRunner,
  input: {
    readonly record: IntegrationRecord;
  }
): Promise<ReconcileVerdict> {
  const { record } = input;
  const branch = record.integrationBranch;
  const head = await resolveBranchHead(git, record, `refs/heads/${branch}`);

  if (record.state === "PAUSED_CONFLICT") {
    return {
      kind: "conflict-paused",
      conflictFiles: record.conflictFiles ?? [],
      conflictParentNodeId: record.conflictParentNodeId
    };
  }

  if (record.state === "COMPLETED") {
    const candidate = record.candidateSha;
    if (candidate === null || head === null || !(await isAncestorOrEqual(git, record.manifest.repoPath, candidate, head))) {
      throw new IntegrationBranchContradictionError({
        branch,
        headSha: head,
        detail: `COMPLETED record's candidateSha ${candidate ?? "(missing)"} is not reachable from the branch head`
      });
    }
    return { kind: "already-recorded", candidateSha: candidate };
  }

  // ---- IN_PROGRESS: the A25 territory --------------------------------------
  const scene = await probeMergeScene(git, record);

  // An unresolved merge scene is possibly an UNRECORDED A10 conflict: never
  // auto-resolved, never aborted — report it and keep every branch involved.
  if (scene.unmergedFiles.length > 0 || scene.mergeHeadPresent) {
    if (scene.unmergedFiles.length > 0) {
      return { kind: "merge-in-progress", safeToRetry: false, conflictFiles: scene.unmergedFiles };
    }
    // MERGE_HEAD without unmerged entries and with no recorded candidate:
    // still an unfinished merge bookkeeping the retry path refuses to walk
    // over — keep it a human decision.
    if (record.manifest.candidateSha === null) {
      return { kind: "merge-in-progress", safeToRetry: false, conflictFiles: [] };
    }
  }

  const candidateSha = record.manifest.candidateSha;
  if (candidateSha !== null) {
    if (head === null) {
      throw new IntegrationBranchContradictionError({
        branch,
        headSha: null,
        detail: "the integration branch no longer resolves while a candidateSha is recorded"
      });
    }
    if (await isAncestorOrEqual(git, record.manifest.repoPath, candidateSha, head)) {
      return { kind: "committed", candidateSha };
    }
    // The commit object exists (it was recorded), but the branch head does not
    // contain it: the branch was moved backwards or rewritten externally.
    throw new IntegrationBranchContradictionError({
      branch,
      headSha: head,
      detail: `recorded candidateSha ${candidateSha} is not reachable from the branch head; the branch contradicts the manifest and will not be forced`
    });
  }

  return {
    kind: "safe-to-retry",
    safeToRetry: true,
    reason: scene.mergeHeadPresent
      ? "merge bookkeeping present but the recorded manifest carries no candidateSha"
      : "no candidateSha recorded yet and the worktree is clean; re-merging is a no-op for already-merged parents"
  };
}

async function resolveBranchHead(
  git: GitRunner,
  record: IntegrationRecord,
  ref: string
): Promise<string | null> {
  const result = await git.tryRun(record.manifest.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    ref
  ]);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

interface MergeScene {
  readonly unmergedFiles: readonly string[];
  readonly mergeHeadPresent: boolean;
}

async function probeMergeScene(git: GitRunner, record: IntegrationRecord): Promise<MergeScene> {
  const worktreePath = record.integrationWorktreePath;
  if (!existsSync(worktreePath)) {
    return { unmergedFiles: [], mergeHeadPresent: false };
  }
  const unmergedFiles = await listUnmergedFiles(git, worktreePath);
  const mergeHead = await git.tryRun(worktreePath, [
    "rev-parse",
    "--verify",
    "--quiet",
    "MERGE_HEAD"
  ]);
  return { unmergedFiles, mergeHeadPresent: mergeHead.exitCode === 0 };
}
