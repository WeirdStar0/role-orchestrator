/**
 * @role-orchestrator/worktree — M2-03 Execution worktree lifecycle.
 *
 * Public surface: one GitRunner (the only spawn point, argv arrays only),
 * the A11 user-repo status snapshot, and the three lifecycle operations
 * createWorktree / getWorktreeStatus / discardWorktree.
 */
export {
  GitRunner,
  type GitRunResult,
  type GitVersion
} from "./git.js";
export {
  parseStatusPorcelainZ,
  repositoryStatusArgs,
  snapshotRepositoryState,
  statusFingerprint,
  type RepositorySnapshot,
  type StatusEntry
} from "./status.js";
export {
  parseWorktreeListPorcelain,
  type WorktreeRegistration
} from "./worktree-list.js";
export {
  branchNameFor,
  createWorktree,
  discardWorktree,
  getWorktreeStatus,
  worktreePathFor,
  type CreateWorktreeInput,
  type CreateWorktreeResult,
  type DiscardWorktreeInput,
  type DiscardWorktreeResult,
  type WorktreeStatusView
} from "./lifecycle.js";
export { isInsidePath, samePath } from "./paths.js";
export {
  BaseShaNotFoundError,
  BranchAlreadyExistsError,
  DiscardBlockedByUncommittedChangesError,
  GitCommandError,
  GitUnavailableError,
  NotGitRepositoryError,
  RepositoryPathError,
  UnsafeWorktreePathError,
  WorktreeDirectoryMissingError,
  WorktreeError,
  WorktreeNotRegisteredError,
  WorktreePathConflictError,
  WorktreeVerificationError
} from "./errors.js";
