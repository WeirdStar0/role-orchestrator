/**
 * M11-04 — the unified-diff classifier: each cell names what would make it
 * red (a mis-colored change line, a context line colored as a change, or a
 * render cap that swallows content silently). M11-05 (review handover,
 * 『--- 』行着色归 del) adds the hunk-aware walk: an in-hunk `--- `/`+++ `
 * line is a REAL change (deleted/added content beginning `-- `/`++ `) and
 * must color as one — the stateless per-line default reads it meta, which
 * would hide a deletion; the file headers stay meta in both layers.
 */
import { describe, expect, it } from "vitest";
import { classifyDiffLine, classifyDiffLines, diffLineClass, MAX_DIFF_RENDER_LINES } from "./diffLines";

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

/** M11-05 — the hunk-aware walk (the painter's classifier). DISCRIMINANCE:
 * the same `--- ` text classifies meta as a file header and del inside a
 * hunk — a regression that flattens the walk back to the per-line default
 * (or colors the header red) goes red on the first cell. */
describe("classifyDiffLines (hunk-aware: in-hunk --- / +++ 归增删,文件头保持 meta)", () => {
  it("colors an in-hunk --- line as a deletion and +++ as an addition, headers stay meta", () => {
    const snippet = [
      "diff --git a/notes.md b/notes.md",
      "index 000000..ffffff 100644",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,3 @@",
      " context line",
      "--- dropped -- bullet",
      "+++ added ++ bullet",
      " context line"
    ];
    expect(classifyDiffLines(snippet)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
      "context"
    ]);
    // The per-line default for the SAME texts is meta — the walk, not the
    // string, is what makes the in-hunk change visible.
    expect(classifyDiffLine("--- dropped -- bullet")).toBe("meta");
    expect(classifyDiffLine("+++ added ++ bullet")).toBe("meta");
  });

  it("before any hunk the --- / +++ lines stay meta (the file-header face)", () => {
    expect(classifyDiffLines(["--- a/src.txt", "+++ b/src.txt"])).toEqual(["meta", "meta"]);
    // An empty diff walks to an empty kind list.
    expect(classifyDiffLines([])).toEqual([]);
  });

  it("a multi-file diff resets at each diff --git boundary (second file's headers stay meta)", () => {
    const twoFiles = [
      "diff --git a/one.txt b/one.txt",
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1,1 +1,1 @@",
      "-old one",
      "--- dropped -- bullet",
      "+new one",
      "diff --git a/two.txt b/two.txt",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1,1 +1,1 @@",
      "+added two"
    ];
    expect(classifyDiffLines(twoFiles)).toEqual([
      "meta",
      "meta",
      "meta",
      "hunk",
      "del",
      "del",
      "add",
      "meta",
      "meta",
      "meta",
      "hunk",
      "add"
    ]);
  });

  it("the end-to-end snippet classifies identically through the walk", () => {
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
    expect(classifyDiffLines(snippet)).toEqual(snippet.map(classifyDiffLine));
  });
});
