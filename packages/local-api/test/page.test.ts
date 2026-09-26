import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildStaticPageAssets, redactText } from "../src/index.js";

const assets = buildStaticPageAssets();

interface PageApi {
  escapeHtml(text: string): string;
  stripAnsiEscapes(text: string): string;
  esc(text: string): string;
  renderEvents(container: { innerHTML: string; hidden: boolean }, events: unknown): void;
  renderRunDetail(
    container: { innerHTML: string; hidden: boolean },
    detail: Record<string, unknown>
  ): void;
}

/** Evaluate the SERVED script (same string the server sends) in a DOM-less sandbox. */
function loadPageApi(): PageApi {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  // No `document` in the sandbox: the script must skip DOM wiring and still
  // expose its pure functions — exactly the contract the page relies on.
  vm.runInContext(assets.appJs, sandbox, { filename: "app.js" });
  const api = sandbox["__roleOrchestratorPage"] as PageApi | undefined;
  if (api === undefined) {
    throw new Error("served app.js did not expose __roleOrchestratorPage");
  }
  return api;
}

const ALLOWED_RAW_TAGS = /^<\/?(li|span|time|div|ul|h2|p)\b[^>]*>$/;

/** Every raw tag in the rendered HTML must be one of the template's own tags. */
function rawTags(html: string): string[] {
  return html.match(/<[^>]+>/g) ?? [];
}

describe("the served page assets", () => {
  it("carry the CSP meta, reference the external script, and avoid inline handlers", () => {
    expect(assets.indexHtml).toContain("Content-Security-Policy");
    expect(assets.indexHtml).toContain('src="/app.js"');
    // No inline event handlers and no inline script bodies.
    expect(assets.indexHtml).not.toMatch(/\son(click|load|error|mouseover)=/i);
    expect(assets.indexHtml.replace(/<script[^>]*><\/script>/g, "")).not.toContain("<script");
  });
});

describe("rendering sanitization of the served script (A36 渲染)", () => {
  const api = loadPageApi();

  it("exposes the same escape algorithm as the server side", () => {
    expect(api.escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(api.escapeHtml('<img src=x onerror=alert(2)>')).toBe(
      "&lt;img src&#61;x onerror&#61;alert(2)&gt;"
    );
  });

  it("strips ANSI escapes before escaping", () => {
    expect(api.stripAnsiEscapes("\u001b[31mRED\u001b[0m")).toBe("RED");
    expect(api.esc("\u001b[31m<script>\u001b[0m")).toBe("&lt;script&gt;");
  });

  it("renders hostile log samples with NO live script surface", () => {
    const container = { innerHTML: "", hidden: true };
    const events = [
      {
        seq: 1,
        type: "<script>alert('type-xss')</script>",
        occurredAt: "2026-09-22T00:00:00.000Z",
        payload: { summary: "<img src=x onerror=alert(1)>" }
      },
      {
        seq: 2,
        type: "diagnostic",
        occurredAt: "2026-09-22T00:00:01.000Z",
        payload: { summary: "leaked Bearer abcdef123456secret" }
      },
      {
        seq: 3,
        type: "error",
        occurredAt: "2026-09-22T00:00:02.000Z",
        payload: { error: "</li><script>alert(3)</script><li>" }
      }
    ];
    api.renderEvents(container, events);
    const html = container.innerHTML;

    // Structural: the only raw tags are the template's own.
    for (const tag of rawTags(html)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
    // Textual: no script/img element opening survives, anywhere.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    // The payloads are present as inert escaped text.
    expect(html).toContain("&lt;script&gt;alert(&#39;type-xss&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;img src&#61;x onerror&#61;alert(1)&gt;");
    expect(html).toContain("&lt;/li&gt;&lt;script&gt;");
    // The fake secret is inert text too — redaction happens at the API
    // boundary (redactText), the page renders whatever it receives safely.
    expect(html).toContain("Bearer abcdef123456secret");
  });

  it("renders run detail without attribute breakouts", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderRunDetail(container, {
      taskId: '"><img src=x onerror=alert(4)>',
      id: "run-1",
      status: "<script>alert(5)</script>",
      baseSha: "\u001b[31msha\u001b[0m",
      executions: [{ id: "exec-1", phase: "SUCCEEDED", attempt: 1, pid: 4242 }]
    });
    const html = container.innerHTML;
    for (const tag of rawTags(html)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&quot;&gt;&lt;img");
    expect(html).toContain("sha"); // ANSI stripped, content kept
  });

  it("keeps API-side redaction and page escaping composable end to end", () => {
    const storedSummary = "upstream said Authorization: Bearer livecred1234567890";
    const served = redactText(storedSummary).text; // API boundary
    const container = { innerHTML: "", hidden: true };
    api.renderEvents(container, [
      { seq: 1, type: "diagnostic", occurredAt: "t", payload: { summary: served } }
    ]);
    expect(container.innerHTML).toContain("Authorization: Bearer [REDACTED]");
    expect(container.innerHTML).not.toContain("livecred1234567890");
  });
});
