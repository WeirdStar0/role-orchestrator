/**
 * M11-04 — the unified-diff line classifier for the detail page's own
 * lightweight diff painter. The diff TEXT is DATA (diff-view.ts serves it
 * capped and escaped-by-transport); this layer only CLASSIFIES each line so
 * the page can color it with plain React text nodes — no HTML assembly, no
 * dangerouslySetInnerHTML, no syntax-highlight dependency (the ask's own
 * lightweight-render discipline: 逐行+增删着色, nothing heavier).
 *
 * M11-05 (review handover, 『--- 』行着色归 del): a `--- ` line is
 * AMBIGUOUS per line — before the first `@@` it is the git file header
 * (`--- a/<path>` / `--- /dev/null`, meta), but INSIDE a hunk a `--- `
 * line is a deleted line whose content began `-- ` (the `-` prefix glued
 * to the content), and coloring it meta would hide a real deletion. The
 * per-line function keeps the stateless meta default (documented
 * ambiguity); the painter walks lines with classifyDiffLines, which tracks
 * hunk state and classifies `--- `/`+++ ` inside a hunk as del/add —
 * symmetrically, since an added line starting `++ ` has the same shape.
 */

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

/**
 * Total over strings: a unified -U3 line's kind by its prefix. `---`/`+++`
 * file headers and `diff --git`/`index` lines are META (not changes); `@@`
 * opens a hunk; a leading `+`/`-` is the change itself. A line that merely
 * CONTAINS `+`/`-` (context) is never a change — the prefix is the protocol.
 * An empty line is context. (The `--- `/`+++ ` header-vs-change ambiguity is
 * resolved by classifyDiffLines below, which knows whether a hunk is open.)
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/**
 * The hunk-aware walk the painter uses: identical to classifyDiffLine for
 * every unambiguous line, but once a hunk has opened, `--- `/`+++ `
 * prefixes can no longer be file headers — they are deletions/additions of
 * lines whose own content began `-- `/`++ ` (M11-05: a real change renders
 * as a change, the header stays meta). A `@@` opens a hunk; a `diff --git`
 * line is the per-file boundary and CLOSES it, so a multi-file diff's
 * second/third file headers classify meta again instead of leaking into
 * the in-hunk change arm.
 */
export function classifyDiffLines(lines: readonly string[]): readonly DiffLineKind[] {
  const kinds: DiffLineKind[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      kinds.push("meta");
    } else if (line.startsWith("@@")) {
      inHunk = true;
      kinds.push("hunk");
    } else if (inHunk && line.startsWith("--- ")) {
      kinds.push("del");
    } else if (inHunk && line.startsWith("+++ ")) {
      kinds.push("add");
    } else {
      kinds.push(classifyDiffLine(line));
    }
  }
  return kinds;
}

/**
 * The painter's own render cap (the SERVER already caps the text at
 * 262,144 chars — diff-view.ts MAX_DIFF_OUTPUT_CHARS; this cap bounds the
 * DOM the page builds, and the cut is announced, never silent).
 */
export const MAX_DIFF_RENDER_LINES = 2_000;

export function diffLineClass(kind: DiffLineKind): string {
  switch (kind) {
    case "add":
      return "diff-line diff-line-add";
    case "del":
      return "diff-line diff-line-del";
    case "meta":
      return "diff-line diff-line-meta";
    case "hunk":
      return "diff-line diff-line-hunk";
    default:
      return "diff-line";
  }
}
