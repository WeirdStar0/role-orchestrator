/**
 * M5-03 — the candidate diff view (集成分支 vs 基线) with the A12 verdict
 * binding presented in the UI.
 *
 * Data source is GIT, reusing the M2-04/M2-05 semantics:
 * - the candidate and its baseline come from the run's `integration_records`
 *   row (the single-writer `task/<run-id>` assembly; `baseSha` is the run's
 *   pinned base, `candidateSha` the merged tip — null until the merges
 *   produced it, M2-04);
 * - the file changes are read with `git diff` (name-status, numstat and a
 *   unified -U3 diff) through the worktree package's `GitRunner` — the
 *   single spawn point with argv-ARRAY discipline (no shell string anywhere);
 *   both SHAs are strict 40-hex (`CommitShaSchema`) before they may become
 *   argv elements, so nothing user-shaped can dress up as a git option;
 * - the git operations are strictly read-only (`diff` subcommands only).
 *
 * A12 presentation: the verdict binding state comes from review's
 * `getReviewVerdict` — the ONLY verdict query. `valid` answers for the exact
 * candidateSha; `invalidated` means the candidate changed and any recorded
 * old verdict NEVER applies (the UI shows 已失效, never an old pass); `none`
 * means no review record exists for the run+node at all.
 *
 * Rendering safety: the unified diff is DATA. It is served as JSON text and
 * the page renders it ONLY through the same esc() pipeline as every other
 * dynamic value (A36 渲染消毒延续) — a diff containing `<script>` or fake
 * markup stays inert text. Output size is capped: a oversized diff is
 * truncated and marked `truncated`, never silently streamed whole.
 */
import type { DatabaseSync } from "node:sqlite";
import { listRunNodes } from "@role-orchestrator/dag";
import { CommitShaSchema, getIntegrationRecord } from "@role-orchestrator/integration";
import { getReviewVerdict, type ReviewVerdictLookup } from "@role-orchestrator/review";
import { getProject, getTaskRun } from "@role-orchestrator/store";
import { GitCommandError, GitRunner } from "@role-orchestrator/worktree";
import { GraphEditRejectionError, LocalApiStateError } from "./errors.js";

/** Cap for the unified diff text (UTF-8-safe slice by characters, then marked). */
export const MAX_DIFF_OUTPUT_CHARS = 262_144;
/** Cap for the per-file list. */
export const MAX_DIFF_FILES = 400;

/** One changed file: path + status + numstat counts (null = binary). */
export interface DiffFileEntryView {
  readonly path: string;
  readonly status: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface CandidateDiffView {
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly files: readonly DiffFileEntryView[];
  /** True when the file list was cut at MAX_DIFF_FILES. */
  readonly fileListTruncated: boolean;
  /** The unified -U3 diff text (capped at MAX_DIFF_OUTPUT_CHARS when truncated). */
  readonly unified: string;
  readonly unifiedTruncated: boolean;
  readonly unifiedChars: number;
}

export interface RunDiffIntegrationView {
  readonly integrationId: string;
  readonly state: string;
  readonly integrationBranch: string;
  readonly baseSha: string;
  /** The ordered accepted parent outputs (the structured inputSha set). */
  readonly parents: readonly {
    readonly nodeId: string;
    readonly headSha: string;
  }[];
  readonly conflictFiles: readonly string[] | null;
}

export interface RunDiffView {
  readonly runId: string;
  readonly nodeId: string;
  readonly runBaseSha: string | null;
  /** The node's current candidate SHA; null while no integration produced one. */
  readonly candidateSha: string | null;
  readonly integration: RunDiffIntegrationView | null;
  readonly diff: CandidateDiffView | null;
  /**
   * The A12 verdict binding for (run, node, candidateSha) — the three-state
   * lookup from the review package, passed through verbatim. Null when there
   * is no candidate to bind a verdict to.
   */
  readonly review: ReviewVerdictLookup | null;
}

// ---------------------------------------------------------------------------
// Pure git-output parsers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse `git diff --name-status` output (LF-separated, TAB-separated fields). */
export function parseNameStatus(raw: string): readonly { readonly status: string; readonly path: string }[] {
  const entries: { status: string; path: string }[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    const path = fields.slice(1).join("\t");
    if (status === "" || path === "") continue;
    entries.push({ status, path });
  }
  return entries;
}

/** Parse `git diff --numstat` output; "-\t-" marks a binary file. */
export function parseNumStat(
  raw: string
): ReadonlyMap<string, { readonly additions: number | null; readonly deletions: number | null; readonly binary: boolean }> {
  const byPath = new Map<
    string,
    { additions: number | null; deletions: number | null; binary: boolean }
  >();
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const path = fields.slice(2).join("\t");
    const additions = fields[0] === "-" ? null : Number(fields[0]);
    const deletions = fields[1] === "-" ? null : Number(fields[1]);
    if (path === "" || additions === null || deletions === null || Number.isNaN(additions) || Number.isNaN(deletions)) {
      if (path !== "") byPath.set(path, { additions: null, deletions: null, binary: true });
      continue;
    }
    byPath.set(path, { additions, deletions, binary: false });
  }
  return byPath;
}

/** Character-capped slice; the cut is announced, never silent. */
export function truncateText(text: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function diffArgv(base: string, candidate: string, extra: readonly string[]): readonly string[] {
  // Strict 40-hex was verified at the boundary; re-assert here so the argv
  // array can never carry anything option-shaped even on a refactor.
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    ...extra,
    CommitShaSchema.parse(base),
    CommitShaSchema.parse(candidate),
    "--"
  ];
}

/**
 * The candidate diff view for one run node, or `null` when the run id is
 * unknown (served 404). A node that exists but has no integration record (or
 * one without a candidate yet) yields `candidateSha: null` — an honest
 * "no candidate" state, not an error.
 */
export async function getRunDiffView(
  db: DatabaseSync,
  git: GitRunner,
  runId: string,
  nodeId: string
): Promise<RunDiffView | null> {
  const run = getTaskRun(db, runId);
  if (run === null) return null;
  const project = getProject(db, run.projectId);
  if (project === null) {
    throw new LocalApiStateError(`run "${run.id}" references missing project "${run.projectId}"`);
  }
  // A node outside the run is a plain 404 (like the graph view), not an
  // honest "no candidate yet" state.
  const nodeKnown = listRunNodes(db, run.id).some((node) => node.nodeId === nodeId);
  if (!nodeKnown) {
    throw new GraphEditRejectionError(
      404,
      "NOT_FOUND",
      `node "${nodeId}" is not part of run "${run.id}"`
    );
  }
  const record = getIntegrationRecord(db, { runId: run.id, nodeId });
  const candidateSha = record?.candidateSha ?? null;

  let diff: CandidateDiffView | null = null;
  let review: ReviewVerdictLookup | null = null;
  if (candidateSha !== null) {
    diff = await readGitDiff(git, project.repoRoot, record?.baseSha ?? run.baseSha, candidateSha);
    // A12: the ONLY verdict query — a verdict answers for its own exact
    // candidateSha and nothing else.
    review = getReviewVerdict(db, { runId: run.id, nodeId, candidateSha });
  }

  return {
    runId: run.id,
    nodeId,
    runBaseSha: run.baseSha,
    candidateSha,
    integration:
      record === null
        ? null
        : {
            integrationId: record.integrationId,
            state: record.state,
            integrationBranch: record.integrationBranch,
            baseSha: record.baseSha,
            parents: record.inputShaSet.map((parent) => ({
              nodeId: parent.nodeId,
              headSha: parent.headSha
            })),
            conflictFiles: record.conflictFiles === null ? null : [...record.conflictFiles]
          },
    diff,
    review
  };
}

async function readGitDiff(
  git: GitRunner,
  repoRoot: string,
  baseSha: string,
  candidateSha: string
): Promise<CandidateDiffView> {
  let nameStatus: string;
  let numStat: string;
  let unified: string;
  try {
    [nameStatus, numStat, unified] = await Promise.all([
      git
        .run(repoRoot, diffArgv(baseSha, candidateSha, ["--name-status"]))
        .then((result) => result.stdout),
      git
        .run(repoRoot, diffArgv(baseSha, candidateSha, ["--numstat"]))
        .then((result) => result.stdout),
      git
        .run(repoRoot, diffArgv(baseSha, candidateSha, ["-U3"]))
        .then((result) => result.stdout)
    ]);
  } catch (error) {
    if (error instanceof GitCommandError) {
      // Git reality disagrees with the durable record (e.g. a gc'd commit):
      // an explicit refusal, never an empty "no changes" answer.
      throw new GraphEditRejectionError(
        409,
        "DIFF_SOURCE_UNAVAILABLE",
        `git diff of candidate ${candidateSha} against base ${baseSha} is unavailable: ${error.stderrTail || "git failed"}`,
        { cause: error }
      );
    }
    throw error;
  }

  const nameStatusEntries = parseNameStatus(nameStatus);
  const numStatByPath = parseNumStat(numStat);
  const files: DiffFileEntryView[] = nameStatusEntries.slice(0, MAX_DIFF_FILES).map((entry) => {
    const counts = numStatByPath.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      additions: counts?.additions ?? null,
      deletions: counts?.deletions ?? null,
      binary: counts?.binary ?? false
    };
  });
  const capped = truncateText(unified, MAX_DIFF_OUTPUT_CHARS);
  return {
    baseSha,
    candidateSha,
    files,
    fileListTruncated: nameStatusEntries.length > MAX_DIFF_FILES,
    unified: capped.text,
    unifiedTruncated: capped.truncated,
    unifiedChars: capped.text.length
  };
}
