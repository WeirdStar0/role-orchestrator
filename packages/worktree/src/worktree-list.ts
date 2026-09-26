/**
 * `git worktree list --porcelain` parsing. This is the registry view the
 * lifecycle guards on: a directory that is not REGISTERED here is never
 * touched by discard (A40: cleanup only ever targets git-managed worktrees).
 *
 * Porcelain format: records separated by blank lines; each record has
 * `worktree <path>`, then `HEAD <sha>` and/or `branch <ref>` and attribute
 * lines (`bare`, `detached`, `locked [reason]`, `prunable [reason]`). Paths
 * are printed raw (no quoting) in porcelain mode.
 */
export interface WorktreeRegistration {
  /** Absolute path of the worktree as git reports it. */
  readonly path: string;
  /** Commit HEAD of that worktree points at; null when unborn/missing. */
  readonly headSha: string | null;
  /** Branch ref ("refs/heads/…"); null when detached or bare. */
  readonly branchRef: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
  /** True for the FIRST record — the main working tree of the repository. */
  readonly isMainWorktree: boolean;
}

export function parseWorktreeListPorcelain(raw: string): WorktreeRegistration[] {
  const records = raw.split(/\r?\n\r?\n/);
  const registrations: WorktreeRegistration[] = [];
  for (const record of records) {
    const lines = record.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) continue;
    const first = lines[0] ?? "";
    if (!first.startsWith("worktree ")) continue;
    const path = first.slice("worktree ".length);
    let headSha: string | null = null;
    let branchRef: string | null = null;
    let bare = false;
    let detached = false;
    let locked = false;
    let prunable = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        branchRef = line.slice("branch ".length).trim();
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        detached = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        locked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        prunable = true;
      }
    }
    registrations.push({
      path,
      headSha,
      branchRef,
      bare,
      detached,
      locked,
      prunable,
      isMainWorktree: registrations.length === 0
    });
  }
  return registrations;
}
