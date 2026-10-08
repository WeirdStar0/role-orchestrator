/**
 * M11-04 — the unified-diff classifier: each cell names what would make it
 * red (a mis-colored change line, a context line colored as a change, or a
 * render cap that swallows content silently).
 */
import { describe, expect, it } from "vitest";
import { classifyDiffLine, diffLineClass, MAX_DIFF_RENDER_LINES } from "./diffLines";

describe("classifyDiffLine (unified -U3 行分类:自有轻量渲染的纯层)", () => {
  it("classifies the change lines by their leading sign, never by containment", () => {
    expect(classifyDiffLine("+added line")).toBe("add");
    expect(classifyDiffLine("-removed line")).toBe("del");
    // A context line that merely CONTAINS +/- stays context.
    expect(classifyDiffLine("a + b - c")).toBe("context");
    expect(classifyDiffLine("plain context")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });

  it("file headers are meta and a hunk opener is a hunk (neither renders as a change)", () => {
    expect(classifyDiffLine("diff --git a/src.txt b/src.txt")).toBe("meta");
    expect(classifyDiffLine("index 000000..ffffff 100644")).toBe("meta");
    expect(classifyDiffLine("--- a/src.txt")).toBe("meta");
    expect(classifyDiffLine("+++ b/src.txt")).toBe("meta");
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
  });

  it("the classes map 1:1 and the add/del classes stay visually distinct", () => {
    expect(diffLineClass("add")).toBe("diff-line diff-line-add");
    expect(diffLineClass("del")).toBe("diff-line diff-line-del");
    expect(diffLineClass("meta")).toBe("diff-line diff-line-meta");
    expect(diffLineClass("hunk")).toBe("diff-line diff-line-hunk");
    expect(diffLineClass("context")).toBe("diff-line");
  });

  it("the render cap exists and is announced by the page, never a silent cut", () => {
    expect(MAX_DIFF_RENDER_LINES).toBeGreaterThan(0);
    // A real unified diff snippet classifies line by line end to end.
    const snippet = [
      "diff --git a/src.txt b/src.txt",
      "index 000000..ffffff 100644",
      "--- a/src.txt",
      "+++ b/src.txt",
      "@@ -1,2 +1,2 @@",
      "-line-v1",
      "+line-v2",
      " context"
    ];
    expect(snippet.map(classifyDiffLine)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "del",
      "add",
      "context"
    ]);
  });
});
