import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { TimestampSchema, ACTIVE_ATTEMPT_PHASES } from "@role-orchestrator/store";
import type { GitRunner } from "@role-orchestrator/worktree";
import {
  isInsidePath,
  parseStatusPorcelainZ,
  parseWorktreeListPorcelain,
  repositoryStatusArgs,
  samePath
} from "@role-orchestrator/worktree";
import { DatabaseSchemaError, MaintenanceError } from "./errors.js";
import { cleanupItemId } from "./chain.js";

/**
 * The cleanup inventory (A40 direction, M6-02).
 *
 * `planCleanup` scans every cleanable object class and annotates each with a
 * SAFETY LEVEL; it deletes nothing:
 *
 * - `auto`             — routine residue the daemon may clean without a human
 *                        (terminal clean worktrees, delivered-run integration
 *                        worktrees, completed validation workspaces, engine-
 *                        prefixed temp databases, published outbox rows when
 *                        explicitly enabled).
 * - `require-confirm`  — DEFAULT-REFUSED objects that are only removable when
 *                        the operator passes the item id in `confirmations`:
 *                        undelivered worktree changes (A40), unconsumed
 *                        approvals, undelivered outbox rows, unattributed
 *                        directories, non-delivered integration worktrees.
 * - `retain`           — never cleanable through this API: active attempts'
 *                        worktrees, in-progress review sessions, conflict-
 *                        paused integration scenes, approval audit records,
 *                        the live database, stale registrations.
 *
 * docs/GIT_AND_WORKSPACES.md 交付和清理: "只有已完成、已归档、没有未提交修改
 * 且没有活动引用的 worktree 可自动清理。中断/失败/待审批工作树默认保留。清理
 * 先 dry-run 展示，再执行受管路径内删除。" The plan IS the dry-run display;
 * `executeCleanup` (cleanup.ts) performs the guarded execution.
 *
 * Safety property: the sweeper only ever proposes objects it can attribute to
 * the engine — a git registration, an engine-prefixed temp path, a row in a
 * table it owns, or a directory inside an explicitly configured root. Unknown
 * files under the OS temp root are never enumerated.
 */

// ---- vocabulary ---------------------------------------------------------------

export const CLEANUP_OBJECT_KINDS = [
  "execution-worktree",
  "integration-worktree",
  "unregistered-worktree-directory",
  "validation-workspace",
  "evidence-directory",
  "temp-database",
  "outbox-row",
  "approval-row"
] as const;
export type CleanupObjectKind = (typeof CLEANUP_OBJECT_KINDS)[number];

export const CLEANUP_SAFETY_LEVELS = ["auto", "require-confirm", "retain"] as const;
export type CleanupSafetyLevel = (typeof CLEANUP_SAFETY_LEVELS)[number];

export const CLEANUP_ACTIONS = [
  "git-worktree-remove",
  "remove-directory",
  "delete-outbox-row",
  "delete-approval-row",
  "manual"
] as const;
export type CleanupAction = (typeof CLEANUP_ACTIONS)[number];

export const CLEANUP_OUTCOMES = [
  "removed",
  "deleted",
  "already-absent",
  "refused",
  "failed"
] as const;
export type CleanupOutcome = (typeof CLEANUP_OUTCOMES)[number];

export const CleanupItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(CLEANUP_OBJECT_KINDS),
  /** Absolute path (filesystem objects) or row id (database rows). */
  target: z.string().min(1),
  action: z.enum(CLEANUP_ACTIONS),
  safety: z.enum(CLEANUP_SAFETY_LEVELS),
  /** Why this safety level was assigned (policy reasons, human-readable). */
  reasons: z.array(z.string().min(1)).min(1),
  /** One-line human summary shown in the dry-run display. */
  detail: z.string().min(1),
  /** Worktree cleanups keep the exec/task branch (traceability, A40). */
  retainedBranch: z.string().nullable(),
  /** Approval rows only: the audit snapshot preserved in the receipt. */
  snapshot: z
    .strictObject({
      actionDigest: z.string().min(1),
      riskGrade: z.string().min(1),
      runtime: z.string().min(1),
      argv: z.array(z.string())
    })
    .nullable()
    .default(null)
});
export type CleanupItem = z.output<typeof CleanupItemSchema>;

export const CleanupPlanSchema = z.strictObject({
  planId: z.string().min(1),
  createdAt: TimestampSchema,
  databasePath: z.string().min(1),
  scanRoots: z.strictObject({
    repoPath: z.string().nullable(),
    worktreesRoot: z.string().nullable(),
    tempRoot: z.string(),
    evidenceRoots: z.array(z.string())
  }),
  cleanPublishedOutboxRows: z.boolean(),
  items: z.array(CleanupItemSchema),
  counts: z.strictObject({
    auto: z.number().int().min(0),
    requireConfirm: z.number().int().min(0),
    retain: z.number().int().min(0)
  })
});
export type CleanupPlan = z.output<typeof CleanupPlanSchema>;

// ---- scan input ---------------------------------------------------------------

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" });

export const PlanCleanupInputSchema = z.strictObject({
  now: TimestampSchema,
  /** User repository (git metadata owner). Required for worktree scanning. */
  repoPath: AbsolutePathSchema.optional(),
  /** Engine-managed worktrees root. Required for worktree scanning. */
  worktreesRoot: AbsolutePathSchema.optional(),
  /** OS temp root to scan for validation workspaces / temp databases. */
  tempRoot: AbsolutePathSchema.optional(),
  /** Explicit roots whose DIRECT children are treated as audit evidence. */
  evidenceRoots: z.array(AbsolutePathSchema).optional(),
  /** Published (= delivered) outbox rows stay put unless this is set. */
  cleanPublishedOutboxRows: z.boolean().optional()
});

export interface PlanCleanupInput {
  readonly now: string;
  readonly repoPath?: string | undefined;
  readonly worktreesRoot?: string | undefined;
  readonly tempRoot?: string | undefined;
  readonly evidenceRoots?: readonly string[] | undefined;
  readonly cleanPublishedOutboxRows?: boolean | undefined;
}

// ---- schema sufficiency -------------------------------------------------------

/** table -> migration version that introduced it (cleanup reads these). */
const REQUIRED_TABLES: readonly (readonly [string, number])[] = [
  ["outbox", 1],
  ["task_runs", 1],
  ["executions", 1],
  ["integration_records", 5],
  ["review_records", 6],
  ["approvals", 11]
];

/**
 * Fail closed when the database predates a table cleanup reads. The fix is
 * applying the composed chain — never silently skipping an object class.
 */
export function assertCleanupSchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all();
  const present = new Set(rows.map((row) => String(row.name)));
  const missing = REQUIRED_TABLES.filter(([table]) => !present.has(table)).map(
    ([, version]) => version
  );
  if (missing.length > 0) {
    throw new DatabaseSchemaError([...new Set(missing)].sort((a, b) => a - b));
  }
}

// ---- helpers ------------------------------------------------------------------

/**
 * Canonical form for path SET membership (worktree-package `samePath`
 * semantics: resolved, unified separators, case-folded on Windows). Git
 * prints worktree paths with forward slashes while node builds them with
 * backslashes, and Windows is case-insensitive.
 */
function canonicalPath(value: string): string {
  const resolved = path.resolve(value.trim());
  const unified = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

function listDirectoryEntries(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** Best-effort recursive size of a file tree (0 for missing paths). */
export function treeBytes(target: string): number {
  let stats;
  try {
    stats = statSync(target, { throwIfNoEntry: false });
  } catch {
    return 0;
  }
  if (stats === undefined) return 0;
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of listDirectoryEntries(target)) {
    total += treeBytes(path.join(target, entry));
  }
  return total;
}

function makeItem(
  kind: CleanupObjectKind,
  identity: string,
  target: string,
  action: CleanupAction,
  safety: CleanupSafetyLevel,
  reasons: readonly string[],
  detail: string,
  retainedBranch: string | null = null,
  snapshot: CleanupItem["snapshot"] = null
): CleanupItem {
  const parsed = CleanupItemSchema.parse({
    id: cleanupItemId(kind, identity),
    kind,
    target,
    action,
    safety,
    reasons: [...reasons],
    detail,
    retainedBranch,
    snapshot: snapshot ?? null
  });
  return parsed;
}

interface RawRow {
  [column: string]: unknown;
}

// ---- worktree scanning ----------------------------------------------------------

const EXEC_BRANCH_PREFIX = "exec/";
const TASK_BRANCH_PREFIX = "task/";
/** The frozen integration layout directory under the engine worktrees root. */
const INTEGRATION_LAYOUT_DIR = "_integration";

interface WorktreeClassification {
  readonly items: readonly CleanupItem[];
}

interface DirtyInfo {
  readonly exists: boolean;
  readonly dirtyCount: number;
}

async function readDirtyInfo(git: GitRunner, worktreePath: string): Promise<DirtyInfo> {
  if (!existsSync(worktreePath)) {
    return { exists: false, dirtyCount: 0 };
  }
  let raw = "";
  try {
    const result = await git.run(worktreePath, [...repositoryStatusArgs()]);
    raw = result.stdout;
  } catch (error) {
    throw new MaintenanceError(
      `cleanup scan: git status failed inside worktree "${worktreePath}"`,
      { cause: error }
    );
  }
  return { exists: true, dirtyCount: parseStatusPorcelainZ(raw).length };
}

function executionPhaseFor(
  db: DatabaseSync,
  runId: string,
  nodeId: string,
  attempt: number
): { readonly found: boolean; readonly activePhase: string | null; readonly terminal: string | null } {
  const rows = db
    .prepare("SELECT phase FROM executions WHERE run_id = ? AND node_id = ? AND attempt = ?")
    .all(runId, nodeId, attempt) as readonly RawRow[];
  if (rows.length === 0) return { found: false, activePhase: null, terminal: null };
  const active = rows.find((row) =>
    (ACTIVE_ATTEMPT_PHASES as readonly string[]).includes(String(row.phase))
  );
  if (active !== undefined) {
    return { found: true, activePhase: String(active.phase), terminal: null };
  }
  return { found: true, activePhase: null, terminal: String(rows[0]?.phase ?? "UNKNOWN") };
}

function taskRunStatus(db: DatabaseSync, runId: string): string | null {
  const row = db.prepare("SELECT status FROM task_runs WHERE id = ?").get(runId) as RawRow | undefined;
  return row === undefined ? null : String(row.status);
}

function integrationRecordStates(db: DatabaseSync, runId: string): readonly string[] {
  const rows = db
    .prepare("SELECT state FROM integration_records WHERE run_id = ?")
    .all(runId) as readonly RawRow[];
  return rows.map((row) => String(row.state));
}

function reviewRecordStateForTempRoot(
  db: DatabaseSync,
  tempRootPath: string
): string | null {
  // Path comparison is tolerant (case/separators) because the recorded root
  // and the scanned root may normalize differently across callers.
  const rows = db
    .prepare("SELECT validation_temp_root, state FROM review_records")
    .all() as readonly RawRow[];
  const matching = rows.filter((row) => samePath(String(row.validation_temp_root), tempRootPath));
  if (matching.length === 0) return null;
  // Any non-terminal session for this temp root keeps it retained.
  const inProgress = matching.find((row) => String(row.state) === "IN_PROGRESS");
  return inProgress === undefined ? String(matching[0]?.state ?? "UNKNOWN") : "IN_PROGRESS";
}

async function listRegisteredWorktrees(git: GitRunner, repoPath: string) {
  const result = await git.run(repoPath, ["worktree", "list", "--porcelain"]);
  return parseWorktreeListPorcelain(result.stdout);
}

async function scanWorktrees(
  db: DatabaseSync,
  git: GitRunner,
  repoPath: string,
  worktreesRoot: string,
  registeredPaths: Set<string>
): Promise<WorktreeClassification> {
  const items: CleanupItem[] = [];
  const registrations = await listRegisteredWorktrees(git, repoPath);

  for (const registration of registrations) {
    if (registration.isMainWorktree) continue;
    const worktreePath = registration.path;
    registeredPaths.add(canonicalPath(worktreePath));
    const branch = registration.branchRef?.replace(/^refs\/heads\//, "") ?? null;
    const dirty = await readDirtyInfo(git, worktreePath);

    if (!dirty.exists) {
      // Registered but the directory is gone: the worktree package treats
      // this as manual handling (A40) — so does maintenance, whether or not
      // git has flagged the registration prunable yet.
      items.push(
        makeItem(
          "execution-worktree",
          worktreePath,
          worktreePath,
          "manual",
          "retain",
          ["stale registration: worktree directory is missing; `git worktree prune` is a maintainer decision, not automated cleanup"],
          `stale registration ${worktreePath}${branch === null ? "" : ` (${branch})`}`,
          branch
        )
      );
      continue;
    }

    if (registration.locked) {
      items.push(
        makeItem(
          "execution-worktree",
          worktreePath,
          worktreePath,
          "git-worktree-remove",
          "retain",
          ["worktree is LOCKED — an explicit unlock is a maintainer decision, never automatic cleanup"],
          `locked worktree ${worktreePath}${branch === null ? "" : ` (${branch})`}`,
          branch
        )
      );
      continue;
    }

    const underRoot = isInsidePath(worktreePath, worktreesRoot);
    if (branch !== null && branch.startsWith(TASK_BRANCH_PREFIX)) {
      // ---- integration worktree (task/<run-id>, IntegrationService-owned) ---
      const runId = branch.slice(TASK_BRANCH_PREFIX.length);
      const states = integrationRecordStates(db, runId);
      if (states.includes("IN_PROGRESS")) {
        items.push(
          makeItem(
            "integration-worktree",
            worktreePath,
            worktreePath,
            "git-worktree-remove",
            "retain",
            ["integration record IN_PROGRESS: the single-writer IntegrationService owns this worktree"],
            `integration worktree for run ${runId} (branch ${branch})`,
            branch
          )
        );
        continue;
      }
      if (states.includes("PAUSED_CONFLICT")) {
        items.push(
          makeItem(
            "integration-worktree",
            worktreePath,
            worktreePath,
            "git-worktree-remove",
            "retain",
            ["integration paused on conflict: docs/GIT_AND_WORKSPACES.md requires preserving the conflict scene for the rework node"],
            `integration worktree with preserved conflict scene for run ${runId}`,
            branch
          )
        );
        continue;
      }
      const status = taskRunStatus(db, runId);
      const reasons: string[] = [];
      let safety: CleanupSafetyLevel;
      if (status === null) {
        safety = "require-confirm";
        reasons.push("no task_runs row for this run id — unattributed integration worktree");
      } else if (status === "DELIVERED" || status === "CANCELLED") {
        safety = dirty.exists && dirty.dirtyCount > 0 ? "require-confirm" : "auto";
        if (safety === "auto") {
          reasons.push(`run is ${status} and the worktree has no uncommitted changes; branch ${branch} is retained`);
        } else {
          reasons.push(`run is ${status} but the worktree has uncommitted changes (undelivered work, A40)`);
        }
      } else {
        safety = "require-confirm";
        reasons.push(`run is not delivered yet (status ${status}) — delivery may still need this worktree`);
      }
      items.push(
        makeItem(
          "integration-worktree",
          worktreePath,
          worktreePath,
          "git-worktree-remove",
          safety,
          reasons,
          `integration worktree for run ${runId} (branch ${branch}, run status ${status ?? "unknown"}, ${String(dirty.dirtyCount)} uncommitted)`,
          branch
        )
      );
      continue;
    }

    if (
      underRoot &&
      branch !== null &&
      branch.startsWith(EXEC_BRANCH_PREFIX)
    ) {
      // ---- execution worktree (<root>/<run>/<node>/<attempt>) ---------------
      const relative = path.relative(worktreesRoot, worktreePath);
      const segments = relative.split(/[\\/]/);
      const runId = segments[0] ?? "";
      const nodeId = segments[1] ?? "";
      const attempt = Number(segments[2] ?? "0");
      if (runId === "" || nodeId === "" || !Number.isInteger(attempt) || attempt < 1) {
        items.push(
          makeItem(
            "execution-worktree",
            worktreePath,
            worktreePath,
            "git-worktree-remove",
            "require-confirm",
            [`branch ${branch} is under the engine root but its path does not decode to <run>/<node>/<attempt>`],
            `unattributed exec worktree ${worktreePath}`,
            branch
          )
        );
        continue;
      }
      const phase = executionPhaseFor(db, runId, nodeId, attempt);
      if (phase.activePhase !== null) {
        items.push(
          makeItem(
            "execution-worktree",
            worktreePath,
            worktreePath,
            "git-worktree-remove",
            "retain",
            [`an ACTIVE attempt (phase ${phase.activePhase}) owns this worktree — deleting under a live writer is never allowed (A23)`],
            `execution worktree ${runId}/${nodeId}/${String(attempt)} (phase ${phase.activePhase})`,
            branch
          )
        );
        continue;
      }
      if (!phase.found) {
        items.push(
          makeItem(
            "execution-worktree",
            worktreePath,
            worktreePath,
            "git-worktree-remove",
            "require-confirm",
            ["no executions row for this run/node/attempt — orphaned worktree with unknown owner"],
            `execution worktree ${runId}/${nodeId}/${String(attempt)} (no execution record)`,
            branch
          )
        );
        continue;
      }
      const clean = dirty.dirtyCount === 0;
      items.push(
        makeItem(
          "execution-worktree",
          worktreePath,
          worktreePath,
          "git-worktree-remove",
          clean ? "auto" : "require-confirm",
          clean
            ? [`attempt ended in phase ${phase.terminal ?? "UNKNOWN"} with no uncommitted changes; branch ${branch} is retained (A40 traceability)`]
            : [`attempt ended in phase ${phase.terminal ?? "UNKNOWN"} but the worktree holds ${String(dirty.dirtyCount)} uncommitted change(s) — undelivered work is refused by default (A40)`],
          `execution worktree ${runId}/${nodeId}/${String(attempt)} (phase ${phase.terminal ?? "UNKNOWN"}, ${String(dirty.dirtyCount)} uncommitted)`,
          branch
        )
      );
      continue;
    }

    // Registered engine worktree outside the known layout.
    items.push(
      makeItem(
        "execution-worktree",
        worktreePath,
        worktreePath,
        "git-worktree-remove",
        "require-confirm",
        [
          underRoot
            ? "registered worktree under the engine root with an unknown branch layout"
            : `registered worktree OUTSIDE the engine worktrees root (${worktreesRoot})`
        ],
        `registered worktree ${worktreePath}${branch === null ? " (detached)" : ` (${branch})`}`,
        branch
      )
    );
  }

  // A40 containment (scan-time half): a directory that is an ANCESTOR of a
  // registered worktree path is a structural container of the standard
  // layout (<run>, <run>/<node>) — removing it would take the registered
  // worktree inside it with it, so it is never proposed as a cleanup item.
  // The comparison is the samePath/isInsidePath semantics on canonical
  // forms (resolved, unified separators, case-folded on Windows): purely
  // string-based, so it cannot misjudge paths that do not exist on disk.
  const isAncestorOfRegisteredWorktree = (candidate: string): boolean => {
    const canonicalCandidate = canonicalPath(candidate);
    for (const registered of registeredPaths) {
      if (registered === canonicalCandidate) continue; // exact match handled above
      if (isInsidePath(registered, candidate)) return true;
    }
    return false;
  };

  // Directories under the engine root that git does NOT know about: the
  // A40 leftovers of a crashed create. Only ever removed with confirmation.
  // Registered worktrees are never descended into — their content belongs
  // to the worktree itself. Ancestors of registered worktrees are not
  // cleanup objects either (structural containers), but they are still
  // scanned so that a failed create INSIDE a live run directory stays
  // visible. `_integration` is the engine's own layout directory: never an
  // item itself, but scanned for stray run directories.
  const scanDir = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of listDirectoryEntries(dir)) {
      const entryPath = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(entryPath, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (stats === undefined || !stats.isDirectory()) continue;
      if (entry === INTEGRATION_LAYOUT_DIR) {
        scanDir(entryPath, depth + 1);
        continue;
      }
      if (registeredPaths.has(canonicalPath(entryPath))) continue;
      if (isAncestorOfRegisteredWorktree(entryPath)) {
        scanDir(entryPath, depth + 1);
        continue;
      }
      items.push(
        makeItem(
          "unregistered-worktree-directory",
          entryPath,
          entryPath,
          "remove-directory",
          "require-confirm",
          ["directory exists under the engine worktrees root but git does not know it — leftover of a failed create (A40 keeps failures on disk)"],
          `unregistered directory ${entryPath}`
        )
      );
      scanDir(entryPath, depth + 1);
    }
  };
  if (existsSync(worktreesRoot)) {
    scanDir(worktreesRoot, 0);
  }

  return { items };
}

// ---- temp-root scanning ---------------------------------------------------------

const VALIDATION_WORKSPACE_PREFIX = "ro-review-validation-";
const TEMP_DB_PREFIXES = ["ro-store-", "ro-maintenance-"];
const TEMP_DB_SUFFIXES = [".db", ".db-wal", ".db-shm"];

function scanTempRoot(
  db: DatabaseSync,
  tempRoot: string,
  liveDatabasePath: string
): readonly CleanupItem[] {
  const items: CleanupItem[] = [];

  // The live database and its sidecars are always enumerated as RETAIN so the
  // receipt shows they were deliberately excluded.
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const livePath = `${liveDatabasePath}${suffix}`;
    if (existsSync(livePath)) {
      items.push(
        makeItem(
          "temp-database",
          livePath,
          livePath,
          "manual",
          "retain",
          ["the live daemon database — restoration target, never a cleanup object"],
          `live database${suffix === "" ? "" : ` (${suffix} sidecar)`} ${livePath}`
        )
      );
    }
  }

  for (const entry of listDirectoryEntries(tempRoot)) {
    const entryPath = path.join(tempRoot, entry);
    let stats;
    try {
      stats = statSync(entryPath, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (stats === undefined) continue;

    if (stats.isDirectory() && entry.startsWith(VALIDATION_WORKSPACE_PREFIX)) {
      const state = reviewRecordStateForTempRoot(db, entryPath);
      if (state === "IN_PROGRESS") {
        items.push(
          makeItem(
            "validation-workspace",
            entryPath,
            entryPath,
            "remove-directory",
            "retain",
            ["a review session is IN_PROGRESS for this workspace — the Reviewer is using it"],
            `validation workspace ${entry} (review IN_PROGRESS)`
          )
        );
      } else if (state !== null) {
        items.push(
          makeItem(
            "validation-workspace",
            entryPath,
            entryPath,
            "remove-directory",
            "auto",
            [`review session is terminal (${state}) and its evidence lives in review_records; the disposable workspace itself can go`],
            `validation workspace ${entry} (review ${state})`
          )
        );
      } else {
        items.push(
          makeItem(
            "validation-workspace",
            entryPath,
            entryPath,
            "remove-directory",
            "require-confirm",
            ["no review_records row records this workspace — unattributed directory, confirm before removal"],
            `validation workspace ${entry} (unattributed)`
          )
        );
      }
      continue;
    }

    if (stats.isDirectory() && TEMP_DB_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      items.push(
        makeItem(
          "temp-database",
          entryPath,
          entryPath,
          "remove-directory",
          "auto",
          ["engine-prefixed temp store directory — disposable by construction"],
          `temp database directory ${entry}`
        )
      );
      continue;
    }

    if (
      stats.isFile() &&
      TEMP_DB_PREFIXES.some((prefix) => entry.startsWith(prefix)) &&
      TEMP_DB_SUFFIXES.some((suffix) => entry.endsWith(suffix)) &&
      !samePath(entryPath, liveDatabasePath)
    ) {
      items.push(
        makeItem(
          "temp-database",
          entryPath,
          entryPath,
          "remove-directory",
          "auto",
          ["engine-prefixed temp database file — disposable by construction"],
          `temp database file ${entry}`
        )
      );
    }
    // Anything else under the OS temp root is NEVER enumerated.
  }
  return items;
}

// ---- evidence roots -------------------------------------------------------------

function scanEvidenceRoots(evidenceRoots: readonly string[]): readonly CleanupItem[] {
  const items: CleanupItem[] = [];
  for (const root of evidenceRoots) {
    if (!existsSync(root)) continue;
    for (const entry of listDirectoryEntries(root)) {
      const entryPath = path.join(root, entry);
      items.push(
        makeItem(
          "evidence-directory",
          entryPath,
          entryPath,
          "remove-directory",
          "require-confirm",
      [
        "audit evidence: verdicts are bound to it (A12/A13) — confirm only after the maintainer has archived it"
      ],
          `evidence directory ${entry}`
        )
      );
    }
  }
  return items;
}

// ---- database rows --------------------------------------------------------------

function scanOutboxRows(
  db: DatabaseSync,
  cleanPublishedOutboxRows: boolean
): readonly CleanupItem[] {
  const rows = db
    .prepare(
      "SELECT id, aggregate_id, type, published_at, created_at FROM outbox ORDER BY created_at ASC, id ASC"
    )
    .all() as readonly RawRow[];
  return rows.map((row) => {
    const id = String(row.id);
    const published = row.published_at !== null && row.published_at !== undefined;
    if (!published) {
      return makeItem(
        "outbox-row",
        id,
        id,
        "delete-outbox-row",
        "require-confirm",
        ["undelivered outbox message (published_at IS NULL) — deleting it loses the message; dispatch is at-least-once, so fix delivery instead"],
        `pending outbox message ${id} (${String(row.type)} for ${String(row.aggregate_id)})`
      );
    }
    return makeItem(
      "outbox-row",
      id,
      id,
      "delete-outbox-row",
      cleanPublishedOutboxRows ? "auto" : "retain",
      cleanPublishedOutboxRows
        ? ["published (= delivered) residue; receivers dedup by message id so removal cannot double-deliver"]
        : ["published (= delivered) residue — retained because cleanPublishedOutboxRows was not enabled"],
      `published outbox message ${id} (${String(row.type)} for ${String(row.aggregate_id)})`
    );
  });
}

function scanApprovalRows(db: DatabaseSync, now: string): readonly CleanupItem[] {
  const rows = db
    .prepare(
      "SELECT id, status, action_digest, risk_grade, runtime, argv, expires_at FROM approvals ORDER BY created_at ASC, id ASC"
    )
    .all() as readonly RawRow[];
  const items: CleanupItem[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const status = String(row.status);
    if (status !== "PENDING") {
      items.push(
        makeItem(
          "approval-row",
          id,
          id,
          "manual",
          "retain",
          [`approval record in terminal status ${status} is an audit record — never deleted through the cleanup API`],
          `approval ${id} (${status})`
        )
      );
      continue;
    }
    const expired = String(row.expires_at) <= now;
    let argvJson: unknown = [];
    try {
      argvJson = JSON.parse(String(row.argv));
    } catch {
      argvJson = [];
    }
    items.push(
      makeItem(
        "approval-row",
        id,
        id,
        "delete-approval-row",
        "require-confirm",
        [
          expired
            ? "UNCONSUMED approval (status PENDING) — protected by default; confirm only if this request will never be granted"
            : "UNCONSUMED approval (status PENDING, not yet expired) — protected by default; prefer letting it expire"
        ],
        `pending approval ${id} (${String(row.risk_grade)} risk${expired ? ", expired" : ""})`,
        null,
        {
          actionDigest: String(row.action_digest),
          riskGrade: String(row.risk_grade),
          runtime: String(row.runtime),
          argv: Array.isArray(argvJson) ? argvJson.map((entry) => String(entry)) : []
        }
      )
    );
  }
  return items;
}

// ---- the plan ------------------------------------------------------------------

/** The dry-run display: every cleanable object with its safety annotation. */
export async function planCleanup(
  db: DatabaseSync,
  git: GitRunner,
  input: PlanCleanupInput
): Promise<CleanupPlan> {
  const value = PlanCleanupInputSchema.parse(input);
  assertCleanupSchema(db);

  const dbLocation = db.location();
  if (dbLocation === null || dbLocation === "" || dbLocation === ":memory:") {
    throw new MaintenanceError(
      "planCleanup: the maintenance connection must be a file database (:memory: has no cleanup surface)"
    );
  }
  const liveDatabasePath = canonicalPath(dbLocation);
  const tempRoot = value.tempRoot ?? os.tmpdir();
  const evidenceRoots = value.evidenceRoots ?? [];
  const cleanPublishedOutboxRows = value.cleanPublishedOutboxRows ?? false;

  if ((value.repoPath === undefined) !== (value.worktreesRoot === undefined)) {
    throw new MaintenanceError(
      "planCleanup: repoPath and worktreesRoot must be given together (worktree scanning needs both)"
    );
  }

  let items: CleanupItem[] = [];
  if (value.repoPath !== undefined && value.worktreesRoot !== undefined) {
    if (!existsSync(value.worktreesRoot)) {
      throw new MaintenanceError(
        `planCleanup: worktreesRoot does not exist (${value.worktreesRoot})`
      );
    }
    const registeredPaths = new Set<string>();
    const worktrees = await scanWorktrees(
      db,
      git,
      value.repoPath,
      value.worktreesRoot,
      registeredPaths
    );
    items = items.concat(worktrees.items);
  }
  items = items.concat(scanTempRoot(db, tempRoot, liveDatabasePath));
  items = items.concat(scanEvidenceRoots(evidenceRoots));
  items = items.concat(scanOutboxRows(db, cleanPublishedOutboxRows));
  items = items.concat(scanApprovalRows(db, value.now));

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new MaintenanceError(`planCleanup: duplicate cleanup item id ${item.id}`);
    }
    seen.add(item.id);
  }

  const counts = {
    auto: items.filter((item) => item.safety === "auto").length,
    requireConfirm: items.filter((item) => item.safety === "require-confirm").length,
    retain: items.filter((item) => item.safety === "retain").length
  };
  const planId = `plan-${createHash("sha256")
    .update(
      JSON.stringify({
        databasePath: liveDatabasePath,
        createdAt: value.now,
        items: items.map((item) => item.id)
      })
    )
    .digest("hex")
    .slice(0, 16)}`;

  return CleanupPlanSchema.parse({
    planId,
    createdAt: value.now,
    databasePath: liveDatabasePath,
    scanRoots: {
      repoPath: value.repoPath ?? null,
      worktreesRoot: value.worktreesRoot ?? null,
      tempRoot,
      evidenceRoots
    },
    cleanPublishedOutboxRows,
    items,
    counts
  });
}
