/**
 * Typed error taxonomy for @role-orchestrator/worktree.
 *
 * Every error means "the requested worktree state change could not be
 * performed" — never a guessed outcome. None of these errors is ever handled
 * internally by deleting anything: A40 makes retention the default on every
 * failure path, so cleanup happens ONLY through an explicit, successful
 * `discardWorktree` call.
 */
export class WorktreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

/**
 * Fail-closed gate: the `git` executable is missing, could not be spawned, or
 * reported a version this package refuses to build on (unparseable output or
 * older than the worktree-era 2.x line). Nothing is read, created or removed
 * once this fires.
 */
export class GitUnavailableError extends WorktreeError {
  readonly gitPath: string;
  readonly detail: string;

  constructor(gitPath: string, detail: string, options?: { cause?: unknown }) {
    super(
      `git is not usable (gitPath "${gitPath}"): ${detail}; refusing to run any ` +
        "git-backed lifecycle step (fail-closed)",
      options
    );
    this.name = "GitUnavailableError";
    this.gitPath = gitPath;
    this.detail = detail;
  }
}

/**
 * A git invocation exited nonzero. Carries the exact argv array, the pinned
 * cwd and the stderr tail so the caller can audit what ran — argv is always
 * an array because no shell is ever involved.
 */
export class GitCommandError extends WorktreeError {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** null when the process could not be spawned at all. */
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(
    argv: readonly string[],
    cwd: string,
    exitCode: number | null,
    stderrTail: string,
    options?: { cause?: unknown }
  ) {
    const kind = exitCode === null ? "spawn failed" : `exit ${exitCode}`;
    super(
      `git ${JSON.stringify(argv)} in "${cwd}" failed (${kind}): ${stderrTail || "(no stderr)"}`,
      options
    );
    this.name = "GitCommandError";
    this.argv = argv;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** The caller-supplied repository path does not exist or is not a directory. */
export class RepositoryPathError extends WorktreeError {
  readonly repoPath: string;

  constructor(repoPath: string) {
    super(`repository path "${repoPath}" does not exist or is not a directory`);
    this.name = "RepositoryPathError";
    this.repoPath = repoPath;
  }
}

/** The path exists but is not usable as a standalone git working repository. */
export class NotGitRepositoryError extends WorktreeError {
  readonly repoPath: string;
  readonly detail: string;

  constructor(repoPath: string, detail: string) {
    super(`"${repoPath}" is not a usable git working repository: ${detail}`);
    this.name = "NotGitRepositoryError";
    this.repoPath = repoPath;
    this.detail = detail;
  }
}

/** The pinned base SHA does not resolve to a commit in the user repository. */
export class BaseShaNotFoundError extends WorktreeError {
  readonly baseSha: string;

  constructor(baseSha: string) {
    super(`base SHA "${baseSha}" does not resolve to a commit; refusing to guess a baseline`);
    this.name = "BaseShaNotFoundError";
    this.baseSha = baseSha;
  }
}

/**
 * The deterministic exec branch name already exists. Branches are never
 * overwritten or reused (docs/GIT_AND_WORKSPACES.md: 生成工作树时不覆盖同名分支).
 */
export class BranchAlreadyExistsError extends WorktreeError {
  readonly branch: string;

  constructor(branch: string) {
    super(
      `branch "${branch}" already exists; refusing to overwrite — a new attempt ` +
        "must use a fresh attempt number"
    );
    this.name = "BranchAlreadyExistsError";
    this.branch = branch;
  }
}

/** The engine-managed worktree path already exists on disk. */
export class WorktreePathConflictError extends WorktreeError {
  readonly worktreePath: string;

  constructor(worktreePath: string) {
    super(`worktree path "${worktreePath}" already exists; refusing to reuse or merge directories`);
    this.name = "WorktreePathConflictError";
    this.worktreePath = worktreePath;
  }
}

/**
 * A worktree path would sit inside the user repository (or discard would
 * target the repository root itself). docs/GIT_AND_WORKSPACES.md: worktree
 * 位于用户数据目录，不放在会被 Agent 扫描/提交的源目录内部.
 */
export class UnsafeWorktreePathError extends WorktreeError {
  readonly worktreePath: string;
  readonly repoPath: string;

  constructor(worktreePath: string, repoPath: string) {
    super(
      `worktree path "${worktreePath}" must live OUTSIDE the repository "${repoPath}" ` +
        "(never inside the user's source tree)"
    );
    this.name = "UnsafeWorktreePathError";
    this.worktreePath = worktreePath;
    this.repoPath = repoPath;
  }
}

/** The registered worktree directory is gone from disk (manual handling). */
export class WorktreeDirectoryMissingError extends WorktreeError {
  readonly worktreePath: string;

  constructor(worktreePath: string) {
    super(
      `worktree "${worktreePath}" is registered but its directory is missing from disk; ` +
        "retained for manual handling (A40) — repair or prune by hand, not automatically"
    );
    this.name = "WorktreeDirectoryMissingError";
    this.worktreePath = worktreePath;
  }
}

/** getStatus/discard named a path that git does not know as a worktree. */
export class WorktreeNotRegisteredError extends WorktreeError {
  readonly worktreePath: string;

  constructor(worktreePath: string) {
    super(
      `worktree "${worktreePath}" is not registered in the repository; refusing to ` +
        "touch unregistered directories"
    );
    this.name = "WorktreeNotRegisteredError";
    this.worktreePath = worktreePath;
  }
}

/**
 * A40: discard was called without `force` on a worktree that still has
 * uncommitted changes. The worktree is retained untouched.
 */
export class DiscardBlockedByUncommittedChangesError extends WorktreeError {
  readonly worktreePath: string;
  readonly dirtyPaths: readonly string[];

  constructor(worktreePath: string, dirtyPaths: readonly string[]) {
    super(
      `worktree "${worktreePath}" has ${dirtyPaths.length} uncommitted change(s); ` +
        "default discard refuses to auto-clean undelivered work (A40). " +
        "Pass force:true only after a human confirmed the changes are disposable",
      { cause: dirtyPaths.join(", ") }
    );
    this.name = "DiscardBlockedByUncommittedChangesError";
    this.worktreePath = worktreePath;
    this.dirtyPaths = [...dirtyPaths];
  }
}

/**
 * A post-create or post-discard verification step disagreed with the expected
 * state. Whatever exists on disk is RETAINED (A40) — the error never triggers
 * compensating deletes.
 */
export class WorktreeVerificationError extends WorktreeError {
  readonly worktreePath: string;
  readonly detail: string;

  constructor(worktreePath: string, detail: string, options?: { cause?: unknown }) {
    super(
      `worktree "${worktreePath}" failed post-operation verification: ${detail}; ` +
        "the worktree is retained for manual handling (A40)",
      options
    );
    this.name = "WorktreeVerificationError";
    this.worktreePath = worktreePath;
    this.detail = detail;
  }
}
