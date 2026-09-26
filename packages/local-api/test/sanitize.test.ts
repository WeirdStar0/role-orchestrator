import { describe, expect, it } from "vitest";
import { escapeHtml, isHtmlEscaped, sanitizeDisplayText, stripAnsiEscapes } from "../src/index.js";

describe("escapeHtml (A36 渲染)", () => {
  it("defuses <script> payloads", () => {
    const escaped = escapeHtml("<script>alert(1)</script>");
    expect(escaped).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(escaped).not.toContain("<script");
  });

  it("defuses <img onerror> payloads", () => {
    const escaped = escapeHtml('<img src=x onerror=alert(2)>');
    expect(escaped).toBe("&lt;img src&#61;x onerror&#61;alert(2)&gt;");
    expect(escaped.startsWith("<img")).toBe(false);
  });

  it("escapes attribute-context breakouts (quotes, backtick, equals)", () => {
    expect(escapeHtml('" onmouseover="alert(3)')).toBe(
      "&quot; onmouseover&#61;&quot;alert(3)"
    );
    expect(escapeHtml("`")).toBe("&#96;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes the fake-secret sample after redaction would run", () => {
    // Layering: redaction runs first at the API boundary; whatever secret
    // text still slips through is here rendered inert as plain text.
    expect(escapeHtml("Bearer abcdef123456")).toBe("Bearer abcdef123456");
    expect(escapeHtml("<b>Bearer</b> abcdef123456")).toBe("&lt;b&gt;Bearer&lt;/b&gt; abcdef123456");
  });

  it("isHtmlEscaped flags anything escapeHtml would still change", () => {
    expect(isHtmlEscaped("plain text 123")).toBe(true);
    expect(isHtmlEscaped("<b>")).toBe(false);
    // "&amp;" contains a raw "&", so re-escaping WOULD change it — the
    // guard reports false, correctly indicating "escape exactly once".
    expect(isHtmlEscaped("&amp;")).toBe(false);
  });
});

describe("stripAnsiEscapes", () => {
  it("removes CSI sequences and single-byte escapes", () => {
    expect(stripAnsiEscapes("\u001b[31mRED\u001b[0m plain")).toBe("RED plain");
    expect(stripAnsiEscapes("a\u001b[2Jb")).toBe("ab");
    expect(stripAnsiEscapes("\u001b]0;title\u0007")).not.toContain("\u001b");
  });

  it("removes C1 CSI (0x9B) and leaves normal text untouched", () => {
    expect(stripAnsiEscapes("\u009b31mRED")).toBe("RED");
    expect(stripAnsiEscapes("café – naïve")).toBe("café – naïve");
  });
});

describe("sanitizeDisplayText", () => {
  it("strips escapes BEFORE escaping so no markup survives", () => {
    expect(sanitizeDisplayText("\u001b[31m<script>\u001b[0m")).toBe("&lt;script&gt;");
  });

  it("renders the full hostile log sample inert", () => {
    const sample =
      "\u001b[1;31mERROR\u001b[0m <img src=x onerror=alert(1)> <script>alert('x')</script> Bearer abcdef123456";
    const sanitized = sanitizeDisplayText(sample);
    expect(sanitized).not.toMatch(/<img/);
    expect(sanitized).not.toMatch(/<script/);
    expect(sanitized).toContain("&lt;img");
    expect(sanitized).toContain("&lt;script&gt;");
  });
});
