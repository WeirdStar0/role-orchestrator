/**
 * Typed error taxonomy for @role-orchestrator/integration (M2-04).
 *
 * Two properties shape every class here (docs/GIT_AND_WORKSPACES.md 冲突与返工):
 * - A10: a merge conflict NEVER picks a side and NEVER discards a branch.
 *   `IntegrationConflictError` is thrown AFTER the PAUSED_CONFLICT record has
 *   been persisted — the error is the signal, the record is the state.
 * - A25: a crash between "git commit" and "DB update" must converge through
 *   `reconcileIntegration` without ever creating a duplicate commit. The
 *   reconcile verdicts are RESULT kinds (not errors); the errors here mean
 *   "the on-disk git state contradicts the recorded one — stop, never force".
 */
import type { IntegrationManifest } from "./manifest.js";

export class IntegrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntegrationError";
  }
}

/**
 * A10: merging a parent produced file-level conflicts. Thrown only AFTER the
 * integration record is persisted as PAUSED_CONFLICT with the full conflict
 * file list — nothing was committed, no branch was touched, no side was
 * chosen. Recovery is deliberately out of scope for M2-04 (暂停态可查询即可).
 */
export class IntegrationConflictError extends IntegrationError {
  readonly runId: string;
  readonly nodeId: string;
  readonly integrationId: string;
  /** Unmerged paths, sorted, as reported by `git diff --name-only --diff-filter=U`. */
  readonly conflictFiles: readonly string[];
  /** The parent whose merge produced the conflict. */
  readonly conflictParentNodeId: string;

  constructor(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly integrationId: string;
    readonly conflictFiles: readonly string[];
    readonly conflictParentNodeId: string;
  }) {
    super(
      `integration of node "${input.nodeId}" in run "${input.runId}" is PAUSED: ` +
        `merging parent "${input.conflictParentNodeId}" conflicts on ` +
        `${input.conflictFiles.length} file(s) [${input.conflictFiles.join(", ")}]. ` +
        "No side was chosen and no branch was discarded; the conflict scene is " +
        "preserved in the integration worktree and queryable via the integration record",
      { cause: input.conflictFiles.join("\n") }
    );
    this.name = "IntegrationConflictError";
    this.runId = input.runId;
    this.nodeId = input.nodeId;
    this.integrationId = input.integrationId;
    this.conflictFiles = [...input.conflictFiles];
    this.conflictParentNodeId = input.conflictParentNodeId;
  }
}

/**
 * A parent's recorded output SHA no longer matches the tip of its exec branch
 * (docs/GIT_AND_WORKSPACES.md: 校验目标旧 SHA … 若分支头与预期不符则停止).
 * The integration stops BEFORE any merge; nothing on the task branch changed.
 */
export class ParentOutputMovedError extends IntegrationError {
  readonly parentNodeId: string;
  readonly branch: string;
  readonly expectedHeadSha: string;
  readonly actualHeadSha: string | null;

  constructor(input: {
    readonly parentNodeId: string;
    readonly branch: string;
    readonly expectedHeadSha: string;
    readonly actualHeadSha: string | null;
  }) {
    super(
      `parent "${input.parentNodeId}" output moved: branch "${input.branch}" tip is ` +
        `${input.actualHeadSha ?? "(unresolvable)"}, the accepted output was ` +
        `${input.expectedHeadSha}; refusing to integrate a moving target`,
      { cause: input.expectedHeadSha }
    );
    this.name = "ParentOutputMovedError";
    this.parentNodeId = input.parentNodeId;
    this.branch = input.branch;
    this.expectedHeadSha = input.expectedHeadSha;
    this.actualHeadSha = input.actualHeadSha;
  }
}

/**
 * The task/integration branch tip contradicts the recorded state (diverged
 * from the run baseSha, or does not contain the recorded candidateSha).
 * Per GIT_AND_WORKSPACES the answer is to STOP — never force-overwrite.
 */
export class IntegrationBranchContradictionError extends IntegrationError {
  readonly branch: string;
  readonly headSha: string | null;
  readonly detail: string;

  constructor(input: { readonly branch: string; readonly headSha: string | null; readonly detail: string }) {
    super(
      `integration branch "${input.branch}" contradicts the recorded state ` +
        `(head ${input.headSha ?? "(unresolvable)"}): ${input.detail}; ` +
        "stopping without overwriting anything",
      { cause: input.detail }
    );
    this.name = "IntegrationBranchContradictionError";
    this.branch = input.branch;
    this.headSha = input.headSha;
    this.detail = input.detail;
  }
}

/**
 * The integration worktree still holds an unfinished merge scene (MERGE_HEAD
 * and/or unmerged index entries) while its record is IN_PROGRESS — a crash
 * window this package deliberately does NOT auto-resolve, because the scene
 * may be an unrecorded A10 conflict. Manual inspection (or a future recovery
 * milestone) decides; nothing is aborted or cleaned automatically.
 */
export class IntegrationMergeStateLeftError extends IntegrationError {
  readonly worktreePath: string;
  readonly conflictFiles: readonly string[];

  constructor(input: { readonly worktreePath: string; readonly conflictFiles: readonly string[] }) {
    super(
      `integration worktree "${input.worktreePath}" still holds an unfinished merge ` +
        `scene (${input.conflictFiles.length} unmerged file(s)); refusing to auto-resolve ` +
        "— the scene may be an unrecorded conflict (A10). Inspect manually or run " +
        "reconcileIntegration for the recorded verdict",
      { cause: input.conflictFiles.join(", ") }
    );
    this.name = "IntegrationMergeStateLeftError";
    this.worktreePath = input.worktreePath;
    this.conflictFiles = [...input.conflictFiles];
  }
}

/** reconcileIntegration / integrate named a run+node with no integration record. */
export class UnknownIntegrationRecordError extends IntegrationError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(runId: string, nodeId: string) {
    super(
      `no integration record exists for run "${runId}" node "${nodeId}"; ` +
        "reconcile needs a persisted manifest to compare git state against"
    );
    this.name = "UnknownIntegrationRecordError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/**
 * The persisted manifest failed strict re-validation on read — the record is
 * corrupt or was written by an incompatible schema. Fail closed.
 */
export class IntegrationManifestIntegrityError extends IntegrationError {
  readonly runId: string;
  readonly nodeId: string;
  readonly detail: string;

  constructor(input: { readonly runId: string; readonly nodeId: string; readonly detail: string }) {
    super(
      `integration manifest for run "${input.runId}" node "${input.nodeId}" failed ` +
        `validation: ${input.detail}`,
      { cause: input.detail }
    );
    this.name = "IntegrationManifestIntegrityError";
    this.runId = input.runId;
    this.nodeId = input.nodeId;
    this.detail = input.detail;
  }
}

/** Guard: a node whose integration is PAUSED_CONFLICT must not be judged SUCCEEDED. */
export class IntegrationPausedError extends IntegrationError {
  readonly runId: string;
  readonly nodeId: string;
  readonly conflictFiles: readonly string[];

  constructor(input: { readonly runId: string; readonly nodeId: string; readonly conflictFiles: readonly string[] }) {
    super(
      `integration of node "${input.nodeId}" (run "${input.runId}") is PAUSED_CONFLICT; ` +
        "the node must not be judged SUCCEEDED while its baseline assembly is paused",
      { cause: input.conflictFiles.join(", ") }
    );
    this.name = "IntegrationPausedError";
    this.runId = input.runId;
    this.nodeId = input.nodeId;
    this.conflictFiles = [...input.conflictFiles];
  }
}

/** Exposed for typed catches around reconcile results that became fatal. */
export type IntegrationManifestValue = IntegrationManifest;
