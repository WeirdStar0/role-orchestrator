import {
  chmodSync,
  existsSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { TimestampSchema, withTransaction } from "@role-orchestrator/store";
import type { GitRunner } from "@role-orchestrator/worktree";
import {
  DiscardBlockedByUncommittedChangesError,
  isInsidePath,
  parseWorktreeListPorcelain,
  WorktreeDirectoryMissingError,
  WorktreeNotRegisteredError,
  discardWorktree
} from "@role-orchestrator/worktree";
import { UnknownCleanupItemError } from "./errors.js";
import {
  CLEANUP_ACTIONS,
  CLEANUP_OBJECT_KINDS,
  CLEANUP_OUTCOMES,
  CLEANUP_SAFETY_LEVELS,
  CleanupPlanSchema,
  treeBytes,
  type CleanupItem,
  type CleanupOutcome,
  type CleanupPlan,
  type CleanupSafetyLevel
} from "./inventory.js";

/**
 * Guarded execution of a cleanup plan (M6-02 / A40).
 *
 * Semantics, in order:
 * 1. the plan itself is schema-validated again (a hand-edited plan fails
 *    loudly instead of deleting something unexpected);
 * 2. confirmation ids are checked BEFORE anything executes — an unknown id
 *    aborts with UnknownCleanupItemError and nothing runs;
 * 3. `retain` items are never executed; `require-confirm` items execute only
 *    when their exact item id appears in `confirmations` (the A40 gate:
 *    undelivered changes, unconsumed approvals and undelivered outbox rows
 *    are refused by default). Items refused for lack of confirmation are
 *    RECEIPT ROWS, not exceptions — the default run's receipt is the answer;
 * 4. every target is re-verified at execution time (optimistic state guard):
 *    a worktree that became dirty after planning is refused, a row that
 *    changed state deletes 0 rows and is refused, a missing directory is
 *    "already-absent" — nothing is deleted on stale information;
 * 5. filesystem removal uses whitelisted primitives (unlink/rmdir with a
 *    chmod retry for git's read-only pack files), and directory targets are
 *    containment-checked against the plan's scan roots before removal; as a
 *    LAST gate, a directory whose removal would take a registered worktree
 *    (re-listed from git at execution time) or a retain item of the plan
 *    with it is refused (`containment-guard`), never recurse-deleted;
 * 6. database row deletions run in ONE transaction with guarded WHERE
 *    clauses, so the DB-side receipt is atomic;
 * 7. everything that happened — executed, refused, failed — is returned as
 *    an itemized receipt. Nothing is ever deleted silently.
 */

export const CleanupRecordSchema = z.strictObject({
  itemId: z.string().min(1),
  kind: z.enum(CLEANUP_OBJECT_KINDS),
  target: z.string().min(1),
  action: z.enum(CLEANUP_ACTIONS),
  safety: z.enum(CLEANUP_SAFETY_LEVELS),
  /** Whether the operator's explicit confirmation admitted this item. */
  confirmed: z.boolean(),
  outcome: z.enum(CLEANUP_OUTCOMES),
  /** Machine-readable refusal/failure reason; null for successes. */
  reasonCode: z.string().nullable(),
  detail: z.string().min(1),
  bytesFreed: z.number().int().min(0)
});
export type CleanupRecord = z.output<typeof CleanupRecordSchema>;

export const CleanupReceiptSchema = z.strictObject({
  planId: z.string().min(1),
  executedAt: TimestampSchema,
  records: z.array(CleanupRecordSchema),
  totals: z.strictObject({
    executed: z.number().int().min(0),
    refused: z.number().int().min(0),
    failed: z.number().int().min(0),
    bytesFreed: z.number().int().min(0)
  })
});
export type CleanupReceipt = z.output<typeof CleanupReceiptSchema>;

const ExecuteCleanupInputSchema = z.strictObject({
  now: TimestampSchema,
  /** Item ids the operator explicitly confirmed. Default: none. */
  confirmations: z.array(z.string().min(1)).optional()
});

export interface ExecuteCleanupInput {
  readonly now: string;
  readonly confirmations?: readonly string[] | undefined;
}

/** Whitelisted-primitive recursive removal (git pack files are read-only on Windows). */
function removeTreeRobust(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // already gone
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stats = statSync(entryPath, { throwIfNoEntry: false });
    if (stats?.isDirectory() === true) {
      removeTreeRobust(entryPath);
    } else if (stats !== undefined) {
      try {
        unlinkSync(entryPath);
      } catch {
        try {
          chmodSync(entryPath, 0o666);
          unlinkSync(entryPath);
        } catch {
          // detected by the leftover check below
        }
      }
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // detected by the leftover check below
  }
}

interface RowDeletion {
  readonly itemId: string;
  readonly sql: string;
  readonly id: string;
  readonly confirmed: boolean;
  readonly successDetail: string;
}

/**
 * Execution-time containment inputs for directory removals (A40 defense in
 * depth): `registeredWorktreePaths` is refreshed from git right before the
 * plan executes; `registeredPathsVerified` is false when git could not be
 * asked (fail closed — removals are refused, not trusted).
 */
interface ContainmentInput {
  readonly registeredWorktreePaths: readonly string[];
  readonly registeredPathsVerified: boolean;
}

/** Kinds whose plan target is a filesystem path (containment-guard inputs). */
const FILESYSTEM_KINDS: readonly string[] = [
  "execution-worktree",
  "integration-worktree",
  "unregistered-worktree-directory",
  "validation-workspace",
  "evidence-directory",
  "temp-database"
];

/**
 * First path in `candidates` that lies inside `dir` (equal counts — a
 * deletion target that IS a protected path contradicts the plan too).
 * Comparisons reuse the worktree package's samePath/isInsidePath semantics
 * (resolved, separator/case tolerant), so stale separator styles in a
 * hand-built plan cannot sneak past the guard.
 */
function containedProtectedPath(dir: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    if (isInsidePath(candidate, dir)) return candidate;
  }
  return null;
}

/**
 * The containment refusal detail for a directory removal target, or null
 * when the target provably contains neither a registered worktree nor a
 * retain item of this plan. This is the last gate BEFORE removeTreeRobust:
 * even a mis-classified plan item can never recursively delete a directory
 * that holds a protected path.
 */
function containmentConflictFor(
  dir: string,
  plan: CleanupPlan,
  containment: ContainmentInput
): string | null {
  if (!containment.registeredPathsVerified) {
    return (
      `registered worktree containment could not be verified at execution time ` +
      `(git worktree list failed) — refusing to recurse-delete ${dir} (containment guard, A40)`
    );
  }
  const registeredHit = containedProtectedPath(dir, containment.registeredWorktreePaths);
  if (registeredHit !== null) {
    return (
      `directory ${dir} contains the registered worktree ${registeredHit} — ` +
      `never recursively removed (containment guard, A40)`
    );
  }
  const retainedPaths = plan.items
    .filter((item) => item.safety === "retain" && FILESYSTEM_KINDS.includes(item.kind))
    .map((item) => item.target);
  const retainedHit = containedProtectedPath(dir, retainedPaths);
  if (retainedHit !== null) {
    return (
      `directory ${dir} contains a retain item of this plan (${retainedHit}) — ` +
      `never recursively removed (containment guard, A40)`
    );
  }
  return null;
}

function recordFor(
  item: CleanupItem,
  confirmed: boolean,
  outcome: CleanupOutcome,
  reasonCode: string | null,
  detail: string,
  bytesFreed: number
): CleanupRecord {
  return CleanupRecordSchema.parse({
    itemId: item.id,
    kind: item.kind,
    target: item.target,
    action: item.action,
    safety: item.safety,
    confirmed,
    outcome,
    reasonCode,
    detail,
    bytesFreed
  });
}

/**
 * Containment re-check before ANY directory removal: the target must sit
 * inside the scan root the plan declared for its kind. A plan whose roots no
 * longer match its targets is refused instead of trusted.
 */
function containmentRootFor(item: CleanupItem, plan: CleanupPlan): string | null {
  switch (item.kind) {
    case "unregistered-worktree-directory":
      return plan.scanRoots.worktreesRoot;
    case "validation-workspace":
    case "temp-database":
      return plan.scanRoots.tempRoot;
    case "evidence-directory":
      return (
        plan.scanRoots.evidenceRoots.find((root) => isInsidePath(item.target, root)) ?? null
      );
    default:
      return null;
  }
}

async function executeFilesystemItem(
  git: GitRunner,
  plan: CleanupPlan,
  item: CleanupItem,
  confirmed: boolean,
  containment: ContainmentInput
): Promise<{ record: CleanupRecord; rowDeletion: RowDeletion | null }> {
  const confirmedNote = confirmed ? " (explicitly confirmed)" : "";

  if (item.action === "delete-outbox-row") {
    const pending = item.safety !== "auto";
    return {
      record: recordFor(
        item,
        confirmed,
        "deleted",
        null,
        pending
          ? `pending outbox row ${item.target} deleted${confirmedNote} (guard: published_at IS NULL)`
          : `published outbox row ${item.target} deleted (guard: published_at IS NOT NULL)`,
        0
      ),
      rowDeletion: {
        itemId: item.id,
        sql: pending
          ? "DELETE FROM outbox WHERE id = ? AND published_at IS NULL"
          : "DELETE FROM outbox WHERE id = ? AND published_at IS NOT NULL",
        id: item.target,
        confirmed,
        successDetail: `outbox row ${item.target} deleted in the cleanup transaction`
      }
    };
  }

  if (item.action === "delete-approval-row") {
    return {
      record: recordFor(
        item,
        confirmed,
        "deleted",
        null,
        `pending approval row ${item.target} deleted${confirmedNote}; the plan snapshot in the receipt preserves its action digest`,
        0
      ),
      rowDeletion: {
        itemId: item.id,
        sql: "DELETE FROM approvals WHERE id = ? AND status = 'PENDING'",
        id: item.target,
        confirmed,
        successDetail: `approval row ${item.target} deleted in the cleanup transaction`
      }
    };
  }

  if (item.action === "git-worktree-remove") {
    const repoPath = plan.scanRoots.repoPath;
    if (repoPath === null) {
      return {
        record: recordFor(
          item,
          confirmed,
          "refused",
          "missing-repo-path",
          "the plan does not carry a repoPath; worktree removal cannot be verified",
          0
        ),
        rowDeletion: null
      };
    }
    if (!existsSync(item.target)) {
      return {
        record: recordFor(item, confirmed, "already-absent", null, `worktree ${item.target} is already gone`, 0),
        rowDeletion: null
      };
    }
    const bytes = treeBytes(item.target);
    try {
      await discardWorktree(git, { repoPath, worktreePath: item.target, force: confirmed });
    } catch (error) {
      if (error instanceof DiscardBlockedByUncommittedChangesError) {
        return {
          record: recordFor(
            item,
            confirmed,
            "refused",
            "uncommitted-changes-appeared",
            "the worktree gained uncommitted changes after the plan was built — undelivered work is never cleaned on stale information (A40)",
            0
          ),
          rowDeletion: null
        };
      }
      if (error instanceof WorktreeDirectoryMissingError) {
        return {
          record: recordFor(item, confirmed, "already-absent", null, `worktree ${item.target} disappeared before execution`, 0),
          rowDeletion: null
        };
      }
      if (error instanceof WorktreeNotRegisteredError) {
        return {
          record: recordFor(
            item,
            confirmed,
            "refused",
            "target-changed-since-plan",
            "the worktree is no longer registered with git — re-plan",
            0
          ),
          rowDeletion: null
        };
      }
      return {
        record: recordFor(
          item,
          confirmed,
          "failed",
          "worktree-removal-failed",
          `git worktree remove failed: ${error instanceof Error ? error.message : String(error)}`,
          0
        ),
        rowDeletion: null
      };
    }
    return {
      record: recordFor(
        item,
        confirmed,
        "removed",
        null,
        `worktree ${item.target} removed${confirmedNote}; branch retained for traceability`,
        bytes
      ),
      rowDeletion: null
    };
  }

  if (item.action === "remove-directory") {
    const root = containmentRootFor(item, plan);
    if (root === null || !isInsidePath(item.target, root)) {
      return {
        record: recordFor(
          item,
          confirmed,
          "refused",
          "target-outside-scan-root",
          `target ${item.target} is not inside the plan's scan root; refusing a plan whose roots drifted`,
          0
        ),
        rowDeletion: null
      };
    }
    if (!existsSync(item.target)) {
      return {
        record: recordFor(item, confirmed, "already-absent", null, `directory ${item.target} is already gone`, 0),
        rowDeletion: null
      };
    }
    // Defense in depth (A40): the LAST gate before recursive deletion. Even
    // if the plan's classification was wrong (a mislabeled ancestor of a
    // registered worktree, a stale plan overtaken by a new registration), a
    // directory that would take a registered worktree or a retain item of
    // this plan with it is refused, never recurse-deleted.
    const containmentConflict = containmentConflictFor(item.target, plan, containment);
    if (containmentConflict !== null) {
      return {
        record: recordFor(item, confirmed, "refused", "containment-guard", containmentConflict, 0),
        rowDeletion: null
      };
    }
    const bytes = treeBytes(item.target);
    removeTreeRobust(item.target);
    if (existsSync(item.target)) {
      return {
        record: recordFor(
          item,
          confirmed,
          "failed",
          "removal-leftovers",
          `directory ${item.target} could not be fully removed (locked files?); nothing is claimed as deleted`,
          0
        ),
        rowDeletion: null
      };
    }
    return {
      record: recordFor(item, confirmed, "removed", null, `directory ${item.target} removed${confirmedNote}`, bytes),
      rowDeletion: null
    };
  }

  // "manual" actions exist only so the inventory can show WHY an object is
  // retained; executing one is a refusal by construction.
  return {
    record: recordFor(
      item,
      confirmed,
      "refused",
      "manual-handling",
      `this object is documented as manual handling (${item.reasons[0] ?? "policy"})`,
      0
    ),
    rowDeletion: null
  };
}

/** Execute a plan. The plan is the dry run; this is the guarded real thing. */
export async function executeCleanup(
  db: DatabaseSync,
  git: GitRunner,
  plan: CleanupPlan,
  input: ExecuteCleanupInput
): Promise<CleanupReceipt> {
  const value = ExecuteCleanupInputSchema.parse(input);
  const checkedPlan = CleanupPlanSchema.parse(plan);
  const confirmations = new Set(value.confirmations ?? []);

  // ---- preflight: unknown confirmations abort BEFORE anything executes -----
  const knownIds = new Set(checkedPlan.items.map((item) => item.id));
  for (const id of confirmations) {
    if (!knownIds.has(id)) {
      throw new UnknownCleanupItemError(id);
    }
  }

  const records: CleanupRecord[] = [];
  const rowDeletions: RowDeletion[] = [];

  // ---- containment guard input: registered worktrees as of NOW ------------
  // The plan's view of "what git knows" can be stale; directory removals are
  // gated against a fresh `git worktree list` instead. A plan without a
  // repoPath has no git registry to check against; a failing git call fails
  // closed (registeredPathsVerified = false → removals refused below).
  const repoPath = checkedPlan.scanRoots.repoPath;
  const hasDirectoryRemovals = checkedPlan.items.some(
    (item) => item.action === "remove-directory"
  );
  let containment: ContainmentInput = {
    registeredWorktreePaths: [],
    registeredPathsVerified: true
  };
  if (hasDirectoryRemovals && repoPath !== null) {
    try {
      const listing = await git.run(repoPath, ["worktree", "list", "--porcelain"]);
      containment = {
        registeredWorktreePaths: parseWorktreeListPorcelain(listing.stdout).map(
          (registration) => registration.path
        ),
        registeredPathsVerified: true
      };
    } catch {
      containment = { registeredWorktreePaths: [], registeredPathsVerified: false };
    }
  }

  for (const item of checkedPlan.items) {
    const confirmed = confirmations.has(item.id);

    if (item.safety === "retain") {
      records.push(
        recordFor(item, false, "refused", "retain-by-policy", `retained: ${item.reasons[0] ?? "policy"}`, 0)
      );
      continue;
    }
    if (item.safety === "require-confirm" && !confirmed) {
      records.push(
        recordFor(
          item,
          false,
          "refused",
          "requires-explicit-confirmation",
          `default refusal (A40): ${item.reasons[0] ?? "protected object"} — pass itemId "${item.id}" in confirmations to allow`,
          0
        )
      );
      continue;
    }
    const result = await executeFilesystemItem(git, checkedPlan, item, confirmed, containment);
    records.push(result.record);
    if (result.rowDeletion !== null) {
      rowDeletions.push(result.rowDeletion);
    }
  }

  // ---- database rows: one atomic transaction, guarded WHERE clauses ---------
  if (rowDeletions.length > 0) {
    withTransaction(db, () => {
      for (const deletion of rowDeletions) {
        const result = db.prepare(deletion.sql).run(deletion.id);
        const index = records.findIndex((record) => record.itemId === deletion.itemId);
        if (index < 0) continue;
        if (Number(result.changes) === 1) {
          const updated = { ...records[index], detail: deletion.successDetail } as CleanupRecord;
          records[index] = CleanupRecordSchema.parse(updated);
        } else {
          const source = checkedPlan.items.find((item) => item.id === deletion.itemId);
          if (source !== undefined) {
            records[index] = recordFor(
              source,
              deletion.confirmed,
              "refused",
              "target-changed-since-plan",
              `row ${deletion.id} no longer matches its planned state; re-plan`,
              0
            );
          }
        }
      }
    });
  }

  const totals = {
    executed: records.filter((record) =>
      ["removed", "deleted", "already-absent"].includes(record.outcome)
    ).length,
    refused: records.filter((record) => record.outcome === "refused").length,
    failed: records.filter((record) => record.outcome === "failed").length,
    bytesFreed: records.reduce((sum, record) => sum + record.bytesFreed, 0)
  };
  return CleanupReceiptSchema.parse({
    planId: checkedPlan.planId,
    executedAt: value.now,
    records,
    totals
  });
}

// Convenience re-exports so callers can talk about levels without importing inventory.
export type { CleanupItem, CleanupOutcome, CleanupPlan, CleanupSafetyLevel };
