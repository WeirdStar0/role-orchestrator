/**
 * Read-only git state snapshots: the A11 user-repo status snapshot and the
 * porcelain parser it is built on. Parsing is NUL-delimited (`-z`) so paths
 * with spaces, CJK characters and quote-LOOKING characters arrive verbatim —
 * git disables its quote escaping in -z mode.
 */
import { createHash } from "node:crypto";
import type { GitRunner } from "./git.js";

export interface StatusEntry {
  /** Short index (staging-area) status letter, e.g. "M", "A", "?". */
  readonly indexStatus: string;
  /** Short worktree status letter, e.g. "M", "?". */
  readonly worktreeStatus: string;
  /** Repo-relative path of the changed file. */
  readonly path: string;
  /** Repo-relative ORIGINAL path for renames/copies, else null. */
  readonly origPath: string | null;
}

export interface RepositorySnapshot {
  /** Commit the user HEAD points at; null for an unborn branch. */
  readonly headSha: string | null;
  /** Current branch name ("HEAD" while detached); null for unborn HEAD. */
  readonly branch: string | null;
  readonly dirtyEntries: readonly StatusEntry[];
  readonly isDirty: boolean;
  /**
   * SHA-256 over the raw porcelain -z bytes: a stable fingerprint to prove
   * the user's dirty state is byte-identical before/after a lifecycle step.
   */
  readonly rawStatusSha256: string;
  readonly takenAt: string;
}

/**
 * Parse `git status --porcelain=v1 -z`. Format: entries separated by NUL;
 * each entry is `XY <path>`; rename/copy entries are followed by a second
 * NUL-terminated field with the original path.
 */
export function parseStatusPorcelainZ(raw: string): StatusEntry[] {
  const fields = raw.split("\0");
  // The output ends with a trailing NUL, which yields a final empty field.
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue; // "XY p" needs at least 4 chars
    const indexStatus = field.charAt(0);
    const worktreeStatus = field.charAt(1);
    if (field.charAt(2) !== " ") continue; // not a status entry
    const path = field.slice(3);
    const needsOrigPath = "RC".includes(indexStatus) || "RC".includes(worktreeStatus);
    if (needsOrigPath) {
      const origPath = fields[i + 1] ?? null;
      i += 1;
      entries.push({ indexStatus, worktreeStatus, path, origPath });
    } else {
      entries.push({ indexStatus, worktreeStatus, path, origPath: null });
    }
  }
  return entries;
}

/** SHA-256 of the raw porcelain output (UTF-8 bytes). */
export function statusFingerprint(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"] as const;

/**
 * Snapshot the FULL state of a user repository without changing anything:
 * every command here is read-only (`rev-parse`, `status`). This snapshot is
 * the A11 evidence artifact — `createWorktree` takes it BEFORE the first
 * mutating call and returns it so callers/tests can diff it afterwards.
 */
export async function snapshotRepositoryState(
  git: GitRunner,
  repoPath: string
): Promise<RepositorySnapshot> {
  const head = await git.tryRun(repoPath, ["rev-parse", "HEAD"]);
  const headSha = head.exitCode === 0 ? head.stdout.trim() : null;

  const branchRef = await git.tryRun(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRef.exitCode === 0 ? branchRef.stdout.trim() : null;

  const status = await git.run(repoPath, [...STATUS_ARGS]);
  const dirtyEntries = parseStatusPorcelainZ(status.stdout);

  return {
    headSha,
    branch: headSha === null ? null : branch,
    dirtyEntries,
    isDirty: dirtyEntries.length > 0,
    rawStatusSha256: statusFingerprint(status.stdout),
    takenAt: new Date().toISOString()
  };
}

/** Same argv the snapshot uses, exported for tests that re-snapshot manually. */
export function repositoryStatusArgs(): readonly string[] {
  return STATUS_ARGS;
}
