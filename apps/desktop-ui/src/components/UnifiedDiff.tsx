/**
 * M11-04 — the unified-diff painter: the page's OWN lightweight renderer
 * (逐行+增删着色). The diff text is DATA: every line renders as a plain
 * React text node (transport-escaped by React, no HTML assembly, no
 * dangerouslySetInnerHTML, no syntax-highlight dependency). Both cut points
 * are announced — the server's character cap via `truncated`, the painter's
 * own line cap in the body. Classification runs through the hunk-aware
 * walk (M11-05): a `--- ` line inside a hunk is a real deletion and colors
 * as one, while the `--- a/<path>` file headers stay meta.
 */
import type { ReactNode } from "react";
import { classifyDiffLines, diffLineClass, MAX_DIFF_RENDER_LINES } from "../diffLines";

export function UnifiedDiff(props: { readonly unified: string; readonly truncated: boolean }): ReactNode {
  const lines = props.unified.split("\n");
  const rendered = lines.slice(0, MAX_DIFF_RENDER_LINES);
  const kinds = classifyDiffLines(rendered);
  return (
    <div className="diff-unified">
      {rendered.map((line, index) => (
        <div key={String(index)} className={diffLineClass(kinds[index] ?? "context")}>
          {line}
        </div>
      ))}
      {lines.length > rendered.length ? (
        <p className="form-status">
          内容较长,仅渲染前 {String(MAX_DIFF_RENDER_LINES)} 行(完整内容可在诊断台查看)。
        </p>
      ) : null}
      {props.truncated ? <p className="form-status">Diff 文本过长,服务端已截断(完整内容可在诊断台查看)。</p> : null}
    </div>
  );
}
