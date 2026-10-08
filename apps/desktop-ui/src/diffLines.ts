/**
 * M11-04 — the unified-diff line classifier for the detail page's own
 * lightweight diff painter. The diff TEXT is DATA (diff-view.ts serves it
 * capped and escaped-by-transport); this layer only CLASSIFIES each line so
 * the page can color it with plain React text nodes — no HTML assembly, no
 * dangerouslySetInnerHTML, no syntax-highlight dependency (the ask's own
 * lightweight-render discipline: 逐行+增删着色, nothing heavier).
 */

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

/**
 * Total over strings: a unified -U3 line's kind by its prefix. `---`/`+++`
 * file headers and `diff --git`/`index` lines are META (not changes); `@@`
 * opens a hunk; a leading `+`/`-` is the change itself. A line that merely
 * CONTAINS `+`/`-` (context) is never a change — the prefix is the protocol.
 * An empty line is context.
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
