/**
 * Read-only git probes shared by the integrate service and the reconcile
 * module (kept dependency-free so the two never import each other).
 */
import { GitRunner } from "@role-orchestrator/worktree";

/** Resolve a fully-qualified ref to a 40-hex SHA, or null when absent. */
export async function tryResolveRef(
  git: GitRunner,
  repoPath: string,
  ref: string
): Promise<string | null> {
  const result = await git.tryRun(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** True when `ancestor` is reachable from `descendant` (or equal to it). */
export async function isAncestorOrEqual(
  git: GitRunner,
  repoPath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const result = await git.tryRun(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.exitCode === 0;
}

/** Merge scenes: the unmerged index entries, sorted (empty when none). */
export async function listUnmergedFiles(git: GitRunner, worktreePath: string): Promise<string[]> {
  const diff = await git.tryRun(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  return diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}
