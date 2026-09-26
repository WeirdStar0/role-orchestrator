/**
 * Review baseline (M2-05) — the read-only snapshot of the EXACT candidateSha
 * and the per-file content manifest that gives the A13 invariance assertion
 * its teeth (docs/GIT_AND_WORKSPACES.md 读者与测试: "Reviewer 绑定不可变
 * candidateSha … 不允许修改被审查源码").
 *
 * Shape: a DETACHED worktree (`git worktree add --detach <path> <sha>`)
 * created through the worktree package's GitRunner — the single spawn point
 * with argv-array discipline. No branch is created: a review branch would be
 * a writable ref nobody may advance; a detached HEAD pinned at candidateSha
 * is the honest shape of a frozen read-only baseline (the ask's "等效只读
 * 检出" option).
 *
 * The manifest binds the session to candidate CONTENT, not just a ref:
 * - at session open, the checked-out file set must equal `git ls-tree -r`
 *   HEAD's path set (the checkout IS the commit's tree), and every file's
 *   sha256 is recorded into the persisted record;
 * - at session end, the per-file hashes are recomputed and compared — any
 *   added/modified/deleted path or a moved HEAD is a
 *   `ReviewBaselineDriftError`, i.e. an INVALID review (A13).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CommitShaSchema } from "@role-orchestrator/integration";
import {
  GitRunner,
  WorktreePathConflictError,
  WorktreeVerificationError
} from "@role-orchestrator/worktree";
import { ReviewBaselineDriftError, ReviewBaselineUnsupportedError } from "./errors.js";

export const BaselineDriftKindSchema = z.enum(["added", "deleted", "modified"]);
export type BaselineDriftKind = z.output<typeof BaselineDriftKindSchema>;

export const BaselineDriftSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  kind: BaselineDriftKindSchema
});
export type BaselineDrift = z.output<typeof BaselineDriftSchema>;

export const BaselineFileEntrySchema = z.strictObject({
  /** Forward-slash path relative to the worktree root. */
  path: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
});
export type BaselineFileEntry = z.output<typeof BaselineFileEntrySchema>;

export const MAX_BASELINE_FILES = 1_000_000;

export const BaselineManifestSchema = z.strictObject({
  candidateSha: CommitShaSchema,
  fileCount: z.number().int().min(0).max(MAX_BASELINE_FILES),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(BaselineFileEntrySchema).max(MAX_BASELINE_FILES)
});
export type BaselineManifest = z.output<typeof BaselineManifestSchema>;

/** sha256 over one file's raw bytes. */
function sha256File(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replace(/\\/g, "/");
}

/**
 * Recursive walk with whitelisted primitives. `.git` at the ROOT is skipped
 * (a worktree's `.git` is a gitdir pointer file, never commit content).
 * Symlinks and other exotic directory entries are refused loudly — the
 * invariance assertion must never silently skip something it cannot hash.
 */
export function manifestFromDirectory(root: string): BaselineFileEntry[] {
  const files: BaselineFileEntry[] = [];
  const walk = (dir: string, depth: number): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (depth === 0 && entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ReviewBaselineUnsupportedError([toRelative(root, absolute)]);
      }
      if (entry.isDirectory()) {
        walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new ReviewBaselineUnsupportedError([toRelative(root, absolute)]);
      }
      files.push({ path: toRelative(root, absolute), sha256: sha256File(absolute) });
    }
  };
  walk(root, 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** Canonical manifest serialization: `path\u0000sha256\n` per file, sorted. */
export function canonicalManifestBytes(files: readonly BaselineFileEntry[]): string {
  return files.map((file) => `${file.path}\u0000${file.sha256}\n`).join("");
}

/** sha256 over the canonical serialization — the record's tamper anchor. */
export function manifestDigest(files: readonly BaselineFileEntry[]): string {
  return createHash("sha256").update(canonicalManifestBytes(files), "utf8").digest("hex");
}

/**
 * Tracked path set of the checked-out commit via `git ls-tree -r -z HEAD`.
 * Only regular blobs are accepted; gitlinks (submodules) and anything
 * unexpected fail closed — a tree this function cannot enumerate is a tree
 * the per-file assertion cannot vouch for.
 */
export async function trackedPathsFromHead(
  git: GitRunner,
  worktreePath: string
): Promise<string[]> {
  const result = await git.run(worktreePath, ["ls-tree", "-r", "-z", "HEAD"]);
  const paths: string[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const meta = tab < 0 ? null : record.slice(0, tab);
    if (meta === null) {
      throw new ReviewBaselineUnsupportedError([record.slice(0, 80)]);
    }
    const parts = meta.split(" ");
    if (parts.length !== 3 || parts[1] !== "blob") {
      throw new ReviewBaselineUnsupportedError([record.slice(tab + 1, tab + 81)]);
    }
    paths.push(record.slice(tab + 1));
  }
  return paths;
}

/**
 * Per-file diff of two manifests: deleted (in expected, missing now),
 * modified (same path, different hash), added (new path). Sorted by path.
 */
export function diffManifests(
  expected: readonly BaselineFileEntry[],
  current: readonly BaselineFileEntry[]
): BaselineDrift[] {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const currentByPath = new Map(current.map((entry) => [entry.path, entry.sha256]));
  const drifts: BaselineDrift[] = [];
  for (const [filePath, sha] of expectedByPath) {
    const nowSha = currentByPath.get(filePath);
    if (nowSha === undefined) {
      drifts.push({ path: filePath, kind: "deleted" });
    } else if (nowSha !== sha) {
      drifts.push({ path: filePath, kind: "modified" });
    }
  }
  for (const filePath of currentByPath.keys()) {
    if (!expectedByPath.has(filePath)) {
      drifts.push({ path: filePath, kind: "added" });
    }
  }
  drifts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return drifts;
}

/**
 * Build the baseline manifest of a freshly created review worktree and BIND
 * it to the candidate content: the checked-out file set must equal the
 * commit's tracked path set, or this session never opens.
 */
export async function buildBaselineManifest(
  git: GitRunner,
  worktreePath: string,
  candidateSha: string
): Promise<BaselineManifest> {
  const files = manifestFromDirectory(worktreePath);
  const tracked = await trackedPathsFromHead(git, worktreePath);
  const fsPaths = new Set(files.map((file) => file.path));
  const drifts: BaselineDrift[] = [];
  for (const trackedPath of tracked) {
    if (!fsPaths.has(trackedPath)) {
      drifts.push({ path: trackedPath, kind: "deleted" });
    }
  }
  const trackedSet = new Set(tracked);
  for (const filePath of fsPaths) {
    if (!trackedSet.has(filePath)) {
      drifts.push({ path: filePath, kind: "added" });
    }
  }
  drifts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (drifts.length > 0) {
    throw new ReviewBaselineDriftError({
      baselineWorktreePath: worktreePath,
      candidateSha,
      phase: "creation",
      headSha: candidateSha,
      drifts
    });
  }
  return {
    candidateSha,
    fileCount: files.length,
    digest: manifestDigest(files),
    files
  };
}

/**
 * The A13 invariance assertion: recompute the per-file manifest of the
 * baseline worktree and compare it against the pinned manifest; also demand
 * HEAD still points at the candidateSha. Any mismatch throws
 * `ReviewBaselineDriftError` (the caller persists INVALID before/after —
 * see `completeReview`, which invalidates the record first).
 */
export async function assertBaselineMatches(
  git: GitRunner,
  input: { readonly worktreePath: string; readonly manifest: BaselineManifest }
): Promise<{ readonly checkedFiles: number; readonly digest: string }> {
  const head = await git.run(input.worktreePath, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();
  const current = manifestFromDirectory(input.worktreePath);
  const drifts = diffManifests(input.manifest.files, current);
  const headMoved = headSha !== input.manifest.candidateSha;
  if (drifts.length > 0 || headMoved) {
    throw new ReviewBaselineDriftError({
      baselineWorktreePath: input.worktreePath,
      candidateSha: input.manifest.candidateSha,
      phase: "final",
      headSha,
      drifts
    });
  }
  return { checkedFiles: current.length, digest: manifestDigest(current) };
}

/**
 * Create the review baseline: a DETACHED worktree at the exact candidateSha
 * (`git worktree add --detach` — no branch, nothing for anyone to advance),
 * verified by re-reading HEAD. The only mutation against the user repository
 * is the worktree registration itself; the user working tree is never
 * touched. Failures leave whatever git already created on disk (A40
 * discipline: never auto-clean).
 */
export async function createReviewWorktree(
  git: GitRunner,
  input: {
    readonly repoPath: string;
    readonly worktreePath: string;
    readonly candidateSha: string;
  }
): Promise<{ readonly worktreePath: string; readonly headSha: string }> {
  if (existsSync(input.worktreePath)) {
    throw new WorktreePathConflictError(input.worktreePath);
  }
  await git.run(input.repoPath, [
    "worktree",
    "add",
    "--detach",
    input.worktreePath,
    input.candidateSha
  ]);
  const head = await git.run(input.worktreePath, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();
  if (headSha !== input.candidateSha) {
    throw new WorktreeVerificationError(
      input.worktreePath,
      `fresh review worktree HEAD ${headSha} does not match the pinned candidateSha ${input.candidateSha}`
    );
  }
  return { worktreePath: input.worktreePath, headSha };
}
