/**
 * Execution worktree lifecycle (M2-03), per docs/GIT_AND_WORKSPACES.md and
 * ADR 003: every writing Execution gets its own branch + worktree created
 * from a FIXED base SHA, in an engine-managed directory OUTSIDE the user's
 * repository.
 *
 * Invariants (each pinned by a test):
 * - A11: the user repository is only ever READ (rev-parse/status); the single
 *   mutating call is `git worktree add -b <branch> <path> <baseSha>`, which
 *   creates one new branch and one new directory. No checkout/reset/clean or
 *   any other write ever targets the user working tree, and the pre-create
 *   status snapshot is returned so the caller can prove nothing moved.
 * - argv discipline: every git call is spawn(git, [argv...]) with cwd pinned
 *   to the user repo or the worktree — never a shell string.
 * - A40: nothing in this module ever deletes anything except the explicit
 *   `discardWorktree` call; any failure (spawn failure, git error, failed
 *   verification, injected fault) leaves worktrees on disk for manual
 *   handling, and default discard refuses worktrees with uncommitted changes.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import type { GitRunner } from "./git.js";
import {
  BaseShaNotFoundError,
  BranchAlreadyExistsError,
  DiscardBlockedByUncommittedChangesError,
  GitCommandError,
  NotGitRepositoryError,
  RepositoryPathError,
  UnsafeWorktreePathError,
  WorktreeDirectoryMissingError,
  WorktreeNotRegisteredError,
  WorktreePathConflictError,
  WorktreeVerificationError
} from "./errors.js";
import {
  parseStatusPorcelainZ,
  repositoryStatusArgs,
  snapshotRepositoryState,
  type RepositorySnapshot,
  type StatusEntry
} from "./status.js";
import { isInsidePath, samePath } from "./paths.js";
import { parseWorktreeListPorcelain, type WorktreeRegistration } from "./worktree-list.js";

/** Absolute filesystem path (worktree targets are never shell-relative). */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

/** Fixed baselines are full lowercase 40-hex commit SHAs (inputSha discipline). */
const BaseShaSchema = z.string().regex(/^[0-9a-f]{40}$/, {
  message: "must be a full lowercase 40-hex git commit SHA"
});

const CreateWorktreeInputSchema = z.strictObject({
  repoPath: AbsolutePathSchema,
  /** Engine-managed root directory; worktrees live here, never in the repo. */
  worktreesRoot: AbsolutePathSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  attempt: z.number().int().min(1).max(9999),
  baseSha: BaseShaSchema
});

const WorktreeTargetSchema = z.strictObject({
  repoPath: AbsolutePathSchema,
  worktreePath: AbsolutePathSchema
});

const DiscardWorktreeInputSchema = WorktreeTargetSchema.extend({
  /**
   * Explicit human authorization to discard a worktree that still has
   * uncommitted changes. Default false: A40 refuses to auto-clean
   * undelivered work.
   */
  force: z.boolean().default(false)
});

export type CreateWorktreeInput = z.input<typeof CreateWorktreeInputSchema>;
export type WorktreeTarget = z.input<typeof WorktreeTargetSchema>;
export type DiscardWorktreeInput = z.input<typeof DiscardWorktreeInputSchema>;

/** exec/<run-id>/<node-id>/<attempt> — one writer, one branch (frozen layout). */
export function branchNameFor(runId: string, nodeId: string, attempt: number): string {
  return `exec/${runId}/${nodeId}/${attempt}`;
}

/** Deterministic engine-managed directory for one writer attempt. */
export function worktreePathFor(
  worktreesRoot: string,
  runId: string,
  nodeId: string,
  attempt: number
): string {
  return path.join(worktreesRoot, runId, nodeId, String(attempt));
}

export interface CreateWorktreeResult {
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: string;
  /** HEAD of the new worktree; equals baseSha or verification failed. */
  readonly worktreeHeadSha: string;
  /**
   * The user-repository snapshot taken BEFORE any mutating git call — the A11
   * evidence that creation only ever adds a branch and a worktree directory.
   */
  readonly userRepoSnapshot: RepositorySnapshot;
  readonly createdAt: string;
}

export interface WorktreeStatusView {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly dirtyEntries: readonly StatusEntry[];
  readonly isDirty: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly isMainWorktree: boolean;
}

export interface DiscardWorktreeResult {
  readonly worktreePath: string;
  readonly removed: true;
  /** Whether the caller had to pass the A40 explicit-force gate. */
  readonly forced: boolean;
  readonly hadUncommittedChanges: boolean;
  /** The exec branch is deliberately KEPT after discard (traceability). */
  readonly retainedBranch: string | null;
}

/**
 * Create one writer's worktree: snapshot -> validate baseline -> refuse
 * existing branch/path -> `git worktree add -b <branch> <path> <baseSha>` ->
 * verify the new HEAD. On ANY failure the function throws with no local
 * cleanup: whatever git already put on disk stays there (A40).
 */
export async function createWorktree(
  git: GitRunner,
  input: CreateWorktreeInput
): Promise<CreateWorktreeResult> {
  const value = CreateWorktreeInputSchema.parse(input);
  await git.assertAvailable();

  assertRepositoryDirectory(value.repoPath);
  await assertStandaloneRepositoryRoot(git, value.repoPath);

  // ---- A11: snapshot the user repo BEFORE the first mutating call ----------
  const userRepoSnapshot = await snapshotRepositoryState(git, value.repoPath);

  // ---- fixed baseline must exist as a commit --------------------------------
  const baseResolves = await git.tryRun(value.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${value.baseSha}^{commit}`
  ]);
  if (baseResolves.exitCode !== 0) {
    throw new BaseShaNotFoundError(value.baseSha);
  }

  // ---- refuse to overwrite branches or paths -------------------------------
  const branch = branchNameFor(value.runId, value.nodeId, value.attempt);
  const branchExists = await git.tryRun(value.repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`
  ]);
  if (branchExists.exitCode === 0) {
    throw new BranchAlreadyExistsError(branch);
  }

  const worktreePath = worktreePathFor(value.worktreesRoot, value.runId, value.nodeId, value.attempt);
  if (isInsidePath(worktreePath, value.repoPath)) {
    throw new UnsafeWorktreePathError(worktreePath, value.repoPath);
  }
  if (existsSync(worktreePath)) {
    throw new WorktreePathConflictError(worktreePath);
  }

  // ---- the single mutating call: new branch + new worktree directory -------
  await git.run(value.repoPath, ["worktree", "add", "-b", branch, worktreePath, value.baseSha]);

  // ---- post-create verification (failures RETAIN the worktree, A40) --------
  let worktreeHeadSha: string;
  try {
    const head = await git.run(worktreePath, ["rev-parse", "HEAD"]);
    worktreeHeadSha = head.stdout.trim();
  } catch (error) {
    throw new WorktreeVerificationError(
      worktreePath,
      `rev-parse HEAD after creation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (worktreeHeadSha.toLowerCase() !== value.baseSha) {
    throw new WorktreeVerificationError(
      worktreePath,
      `worktree HEAD ${worktreeHeadSha} does not match the pinned base SHA ${value.baseSha}`
    );
  }

  return {
    worktreePath,
    branch,
    baseSha: value.baseSha,
    worktreeHeadSha,
    userRepoSnapshot,
    createdAt: new Date().toISOString()
  };
}

/**
 * Read-only view of one registered worktree: registration, HEAD, branch and
 * its uncommitted changes. Refuses unregistered paths and missing
 * directories instead of guessing.
 */
export async function getWorktreeStatus(
  git: GitRunner,
  input: WorktreeTarget
): Promise<WorktreeStatusView> {
  const value = WorktreeTargetSchema.parse(input);
  await git.assertAvailable();
  assertRepositoryDirectory(value.repoPath);

  const registration = await findRegistration(git, value.repoPath, value.worktreePath);
  if (!existsSync(value.worktreePath) || !statSync(value.worktreePath).isDirectory()) {
    throw new WorktreeDirectoryMissingError(value.worktreePath);
  }

  const head = await git.run(value.worktreePath, ["rev-parse", "HEAD"]);
  const status = await git.run(value.worktreePath, [...repositoryStatusArgs()]);
  const dirtyEntries = parseDirtyEntries(status.stdout);
  const branchRef = registration.branchRef;

  return {
    worktreePath: value.worktreePath,
    branch: branchRef === null ? null : branchRef.replace(/^refs\/heads\//, ""),
    headSha: head.stdout.trim(),
    dirtyEntries,
    isDirty: dirtyEntries.length > 0,
    locked: registration.locked,
    prunable: registration.prunable,
    isMainWorktree: registration.isMainWorktree
  };
}

/**
 * The ONLY cleanup entry in this package, and it is explicit by design:
 * 1. refuse unregistered paths (never delete a directory git doesn't own);
 * 2. refuse the user repository root / main worktree outright;
 * 3. refuse missing directories (manual handling, A40);
 * 4. refuse uncommitted changes unless `force: true` was explicitly passed;
 * 5. `git worktree remove [--force] <path>`, then verify from both sides.
 * The exec branch is kept — only the worktree directory is removed.
 */
export async function discardWorktree(
  git: GitRunner,
  input: DiscardWorktreeInput
): Promise<DiscardWorktreeResult> {
  const value = DiscardWorktreeInputSchema.parse(input);
  await git.assertAvailable();
  assertRepositoryDirectory(value.repoPath);

  if (samePath(value.worktreePath, value.repoPath)) {
    throw new UnsafeWorktreePathError(value.worktreePath, value.repoPath);
  }
  const registration = await findRegistration(git, value.repoPath, value.worktreePath);
  if (registration.isMainWorktree) {
    throw new UnsafeWorktreePathError(value.worktreePath, value.repoPath);
  }
  if (!existsSync(value.worktreePath)) {
    throw new WorktreeDirectoryMissingError(value.worktreePath);
  }

  const status = await git.run(value.worktreePath, [...repositoryStatusArgs()]);
  const dirtyEntries = parseDirtyEntries(status.stdout);
  const dirtyPaths = dirtyEntries.map((entry) => entry.path);
  if (dirtyPaths.length > 0 && !value.force) {
    throw new DiscardBlockedByUncommittedChangesError(value.worktreePath, dirtyPaths);
  }

  await git.run(value.repoPath, [
    "worktree",
    "remove",
    ...(value.force ? ["--force"] : []),
    value.worktreePath
  ]);

  // ---- post-discard verification: registration gone AND directory gone -----
  const stillRegistered = await findRegistrationOrNull(git, value.repoPath, value.worktreePath);
  if (stillRegistered !== null) {
    throw new WorktreeVerificationError(
      value.worktreePath,
      "worktree is still registered after `git worktree remove`"
    );
  }
  if (existsSync(value.worktreePath)) {
    throw new WorktreeVerificationError(
      value.worktreePath,
      "worktree directory still exists after `git worktree remove`"
    );
  }

  return {
    worktreePath: value.worktreePath,
    removed: true,
    forced: value.force,
    hadUncommittedChanges: dirtyPaths.length > 0,
    retainedBranch:
      registration.branchRef === null ? null : registration.branchRef.replace(/^refs\/heads\//, "")
  };
}

// ---- internal helpers --------------------------------------------------------

function assertRepositoryDirectory(repoPath: string): void {
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new RepositoryPathError(repoPath);
  }
}

/** The repo path must be the TOP LEVEL of a working repository (no subdirs). */
async function assertStandaloneRepositoryRoot(git: GitRunner, repoPath: string): Promise<void> {
  let toplevel: string;
  try {
    const result = await git.run(repoPath, ["rev-parse", "--show-toplevel"]);
    toplevel = result.stdout.trim();
  } catch (error) {
    // A git that could not RUN (spawn failure) is an availability problem,
    // not an answer about the directory: propagate the typed evidence.
    if (error instanceof GitCommandError && error.exitCode === null) throw error;
    throw new NotGitRepositoryError(
      repoPath,
      `git rev-parse --show-toplevel failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!samePath(toplevel, repoPath)) {
    throw new NotGitRepositoryError(
      repoPath,
      `it is not a repository top level (git reports "${toplevel}")`
    );
  }
}

async function listRegistrations(git: GitRunner, repoPath: string): Promise<WorktreeRegistration[]> {
  let raw: string;
  try {
    const result = await git.run(repoPath, ["worktree", "list", "--porcelain"]);
    raw = result.stdout;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode !== null) {
      throw new NotGitRepositoryError(repoPath, `git worktree list failed: ${error.stderrTail}`);
    }
    throw error;
  }
  return parseWorktreeListPorcelain(raw);
}

async function findRegistration(
  git: GitRunner,
  repoPath: string,
  worktreePath: string
): Promise<WorktreeRegistration> {
  const found = await findRegistrationOrNull(git, repoPath, worktreePath);
  if (found === null) {
    throw new WorktreeNotRegisteredError(worktreePath);
  }
  return found;
}

async function findRegistrationOrNull(
  git: GitRunner,
  repoPath: string,
  worktreePath: string
): Promise<WorktreeRegistration | null> {
  const registrations = await listRegistrations(git, repoPath);
  return registrations.find((registration) => samePath(registration.path, worktreePath)) ?? null;
}

function parseDirtyEntries(raw: string): StatusEntry[] {
  return parseStatusPorcelainZ(raw);
}
