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
  /* M9-02 workbench surface */
  RUN_CREATE_FIELD_ALLOWLIST: readonly string[];
  buildRunCreatePayload(fields: Record<string, unknown>): Record<string, string>;
  projectDirHint(value: unknown): string;
  profileOptionsHtml(profiles: unknown): string;
  runStatusBadgeHtml(status: unknown): string;
  renderRunList(
    container: { innerHTML: string; hidden: boolean },
    runs: unknown,
    expandedRunId: string | null
  ): void;
  runDetailCardHtml(run: Record<string, unknown>): string;
  createRunFailureText(error: { status?: number; code?: string; message?: string }): string;
  /* M9-03 profiles config surface */
  PROFILES_WRITE_FIELD_ALLOWLIST: readonly string[];
  buildProfilesFullWritePayload(fields: Record<string, unknown>): Record<string, string>;
  profilesFullAbsenceHtml(): string;
  profilesFullViewHtml(view: Record<string, unknown>): string;
  profilesSaveFailureText(error: { status?: number; code?: string; message?: string }): string;
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

const ALLOWED_RAW_TAGS = /^<\/?(li|span|time|div|ul|h2|p|button)\b[^>]*>$/;

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

describe("M9-02 workbench surface (default tab)", () => {
  const api = loadPageApi();

  it("serves the workbench skeleton: tabs, create form, run list, detail slot — and the advanced tab keeps every observatory section", () => {
    const html = assets.indexHtml;
    // Tabs: workbench is the DEFAULT (no hidden attribute), advanced starts hidden.
    expect(html).toContain('id="tab-workbench"');
    expect(html).toContain('id="tab-advanced"');
    expect(html).toContain('<div id="tab-workbench-page">');
    expect(html).toContain('<div id="tab-advanced-page" hidden>');
    // The create form fields.
    expect(html).toContain('id="create-run-form"');
    expect(html).toContain('id="objective-input"');
    expect(html).toContain('id="profile-select"');
    expect(html).toContain('id="load-profiles-button"');
    expect(html).toContain('id="projectdir-input"');
    expect(html).toContain('id="projectdir-hint"');
    expect(html).toContain('id="create-status"');
    // The run list + detail slot.
    expect(html).toContain('id="run-list-panel"');
    expect(html).toContain('id="refresh-runs-button"');
    expect(html).toContain('id="auto-refresh-toggle"');
    expect(html).toContain('id="workbench-detail"');
    // The advanced tab retains EVERY existing observatory surface.
    for (const id of [
      "token-input",
      "execution-input",
      "load-button",
      "run-graph-input",
      "load-graph-button",
      "graph-canvas",
      "node-editor",
      "load-expansions-button",
      "expansion-panel",
      "load-approvals-button",
      "approval-panel",
      "load-diff-button",
      "diff-panel",
      "load-contexts-button",
      "context-panel"
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // Still no inline handlers anywhere (the CSP structural pin).
    expect(html).not.toMatch(/\son(click|load|error|mouseover)=/i);
  });

  it("renders run rows with escaped objective, badge and created time (no attribute breakout)", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderRunList(container, [
      {
        id: "run-1",
        objective: '"><img src=x onerror=alert(9)>',
        status: "RUNNING",
        createdAt: "2026-10-03T00:00:00.000Z"
      },
      { id: "run-2", objective: null, status: "TOTALLY-UNKNOWN", createdAt: "t2" }
    ], "run-1");
    const html = container.innerHTML;
    for (const tag of rawTags(html)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&quot;&gt;&lt;img");
    // Status badges: the durable status, an (unknown-safe) gloss, escaped into
    // the class attribute — a hostile status value cannot break out either.
    expect(html).toContain("run-status-RUNNING");
    expect(html).toContain("run-status-TOTALLY-UNKNOWN");
    expect(html).toContain("run-row-expanded");
    expect(html).toContain("(无 objective)");
  });

  it("marks failed executions explicitly (the run status vocabulary has no failed value)", () => {
    const card = api.runDetailCardHtml({
      id: "run-1",
      taskId: "task-run-1",
      status: "RUNNING",
      baseSha: "abc",
      createdAt: "t",
      executions: [{ id: "exec-1", phase: "FAILED", attempt: 1, pid: 7 }]
    });
    expect(card).toContain("存在失败执行");
    expect(card).toContain("exec-1");
    expect(card).toContain("run-status-RUNNING");
    const healthy = api.runDetailCardHtml({
      id: "run-2",
      taskId: "t",
      status: "READY_FOR_DELIVERY",
      baseSha: "abc",
      createdAt: "t",
      executions: [{ id: "exec-2", phase: "SUCCEEDED", attempt: 1, pid: 8 }]
    });
    expect(healthy).not.toContain("存在失败执行");
  });

  it("builds the create payload from an explicit allowlist and refuses model/Profile carriers (A02 UI layer)", () => {
    expect(api.RUN_CREATE_FIELD_ALLOWLIST).toEqual(["objective", "profileId", "projectDir"]);
    expect(
      api.buildRunCreatePayload({ objective: "目标", profileId: " profile-x ", projectDir: " C:/repo " })
    ).toEqual({ objective: "目标", profileId: "profile-x", projectDir: "C:/repo" });
    for (const bad of [
      { objective: "x", profileId: "p", projectDir: "C:/", model: "claude-opus-4" },
      { objective: "x", profileId: "p", projectDir: "C:/", profileRevision: 2 },
      { objective: "", profileId: "p", projectDir: "C:/" },
      { objective: "   ", profileId: "p", projectDir: "C:/" },
      { objective: "x".repeat(10001), profileId: "p", projectDir: "C:/" },
      { objective: "x", profileId: "", projectDir: "C:/" },
      { objective: "x", profileId: "p", projectDir: "  " }
    ]) {
      expect(() => api.buildRunCreatePayload(bad), JSON.stringify(Object.keys(bad))).toThrow();
    }
  });

  it("hints the absolute-path shape only (existence stays the backend's fail-closed job)", () => {
    expect(api.projectDirHint("")).toBe("");
    expect(api.projectDirHint("C:\\repo\\sub")).toBe("");
    expect(api.projectDirHint("C:/repo/sub")).toBe("");
    expect(api.projectDirHint("/srv/repo")).toBe("");
    expect(api.projectDirHint("\\\\server\\share")).toBe("");
    expect(api.projectDirHint("relative/dir")).toContain("PROJECT_DIR_NOT_ABSOLUTE");
  });

  it("surfaces the backend's typed creation refusals verbatim", () => {
    expect(api.createRunFailureText({ status: 400, code: "PROJECT_DIR_MISSING", message: "m" })).toContain(
      "工作目录不存在"
    );
    expect(api.createRunFailureText({ status: 400, code: "PROJECT_DIR_NOT_GIT_REPOSITORY", message: "m" })).toContain(
      "git 仓库"
    );
    expect(api.createRunFailureText({ status: 400, code: "UNKNOWN_PROFILE", message: "m" })).toContain("profile");
    expect(api.createRunFailureText({ status: 503, code: "ORCHESTRATION_NOT_CONFIGURED", message: "m" })).toContain(
      "--profiles"
    );
    expect(api.createRunFailureText({ status: 500, message: "boom" })).toContain("500");
  });

  it("renders profile options with escaped ids and no secret-bearing fields", () => {
    const html = api.profileOptionsHtml([
      {
        id: 'p"><script>',
        runtime: "claude",
        executionTarget: "windows-native",
        model: null,
        timeoutSeconds: 600
      }
    ]);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("默认模型");
    const withModel = api.profileOptionsHtml([
      { id: "p2", runtime: "codex", executionTarget: "windows-native", model: "gpt-5.x", timeoutSeconds: 30 }
    ]);
    expect(withModel).toContain("model ");
  });
});

describe("M9-03 profiles config tab (配置)", () => {
  const api = loadPageApi();

  it("serves the config tab skeleton: tab button, hidden page container, loader, status and panel slots", () => {
    const html = assets.indexHtml;
    // The tab bar now has THREE buttons; the config page starts hidden (the
    // workbench stays the default face).
    expect(html).toContain('id="tab-config"');
    expect(html).toContain('<div id="tab-config-page" hidden>');
    expect(html).toContain('id="profiles-config"');
    expect(html).toContain('id="load-profiles-full-button"');
    expect(html).toContain('id="profiles-full-status"');
    expect(html).toContain('id="profiles-full-panel"');
    // The served script carries the three-tab switch and the PUT helper; the
    // editor/summary are rendered by the pure builders (tested below).
    expect(assets.appJs).toContain("function showPageTab(");
    expect(assets.appJs).toContain("function putJson(");
    // Still no inline handlers anywhere (the CSP structural pin).
    expect(html).not.toMatch(/\son(click|load|error|mouseover)=/i);
  });

  it("renders the 409 absence guidance (壳未接线/未传 --profiles) with the per-user convention path", () => {
    const html = api.profilesFullAbsenceHtml();
    expect(html).toContain("壳未接线");
    expect(html).toContain("--profiles");
    expect(html).toContain("PROFILE_SOURCE_ABSENT");
    expect(html).toContain("503 ORCHESTRATION_NOT_CONFIGURED");
    expect(html).toContain("role-orchestrator\\profiles.json");
    expect(html).toContain("存在才由壳传给 serve");
    expect(html).toContain('role="alert"');
    // No live script/img surface in static guidance either.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
  });

  it("renders the config view with escaped source path, raw text and summary (no textarea breakout)", () => {
    const hostilePath = 'C:/x"><img src=x onerror=alert(1)>';
    const hostileRaw = '</textarea><script>alert(2)</script><img src=y onerror=alert(3)>';
    const html = api.profilesFullViewHtml({
      sourcePath: hostilePath,
      rawText: hostileRaw,
      parseError: null,
      profiles: [
        { id: 'p"><script>', runtime: "claude", model: null, maxConcurrency: 2, timeoutSeconds: 600 },
        { id: "codex-main", runtime: "codex", model: "gpt-5.x", maxConcurrency: 1, timeoutSeconds: 30 }
      ]
    });
    // Zero live script/img surface; the raw text cannot break out of the
    // textarea (esc turned every < into &lt; BEFORE the closing tag).
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("</textarea><script>");
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img");
    // The editor + save affordance + summary table (CLI 映射 / 预算).
    expect(html).toContain('id="profiles-full-editor"');
    expect(html).toContain('id="save-profiles-full-button"');
    expect(html).toContain("runtime(CLI 映射)");
    expect(html).toContain("maxConcurrency");
    expect(html).toContain("timeoutSeconds");
    expect(html).toContain("(CLI 默认模型)");
    // The honest no-hot-reload note is part of the view.
    expect(html).toContain("不热重载");
    // M9-04 review handover #62: the model-only semantics stated precisely —
    // new tasks run on the first-frozen revision; same-id edits (model
    // included) mint no new revision; the drift gate compares exactly seven
    // named fields (model is not one of them).
    expect(html).toContain("新建任务按首次创建时冻结的 revision 执行");
    expect(html).toContain("不创建新 revision 也不影响已建任务");
    expect(html).toContain("漂移门(409)仅比对 runtime/executable/executionTarget/configDir/credentialGroup/maxConcurrency/timeoutSeconds 七个字段");
  });

  it("renders the parse-error state as an explicit alert with the parser reason", () => {
    const html = api.profilesFullViewHtml({
      sourcePath: "C:/x/profiles.json",
      rawText: "{ broken",
      parseError: "Unexpected token",
      profiles: null
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("未通过既有解析器校验");
    expect(html).toContain("Unexpected token");
    // No summary table when there is no parse result; the editor still shows
    // the raw bytes so the maintainer can repair exactly what is on disk.
    expect(html).not.toContain("profiles-summary");
    expect(html).toContain("{ broken");
  });

  it("builds the write payload from a single-field allowlist and refuses empty content", () => {
    expect(api.PROFILES_WRITE_FIELD_ALLOWLIST).toEqual(["content"]);
    expect(api.buildProfilesFullWritePayload({ content: "{ok}" })).toEqual({ content: "{ok}" });
    expect(() => api.buildProfilesFullWritePayload({ content: "{ok}", model: "sneaky" })).toThrow(/refused field/);
    expect(() => api.buildProfilesFullWritePayload({ content: "   " })).toThrow(/空/);
    expect(() => api.buildProfilesFullWritePayload({})).toThrow(/空/);
  });

  it("maps the typed write-back refusals to explicit texts (422 keeps the editor's promise)", () => {
    const invalid = api.profilesSaveFailureText({ status: 422, code: "PROFILES_CONTENT_INVALID", message: "bad" });
    expect(invalid).toContain("422");
    expect(invalid).toContain("原文件未改动");
    expect(invalid).toContain("bad");
    const absent = api.profilesSaveFailureText({ status: 409, code: "PROFILE_SOURCE_ABSENT", message: "no source" });
    expect(absent).toContain("409");
    expect(absent).toContain("壳未接线/未传 --profiles");
    expect(absent).toContain("未改动任何文件");
    const guard = api.profilesSaveFailureText({ status: 403, code: "CSRF_REQUIRED", message: "csrf" });
    expect(guard).toContain("403");
    const fallback = api.profilesSaveFailureText({ status: 500, code: "INTERNAL", message: "boom" });
    expect(fallback).toContain("500");
    expect(fallback).toContain("boom");
  });
});
