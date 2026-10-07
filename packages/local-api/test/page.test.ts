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
  developerBindingHtml(view: Record<string, unknown>): string;
  runStatusBadgeHtml(status: unknown): string;
  RUN_OUTCOME_GLOSS: Record<string, string>;
  runOutcomeBadgeHtml(outcome: unknown): string;
  runRowHtml(run: Record<string, unknown>, expandedRunId: string | null): string;
  renderRunList(
    container: { innerHTML: string; hidden: boolean },
    runs: unknown,
    expandedRunId: string | null
  ): void;
  runDetailCardHtml(run: Record<string, unknown>): string;
  countExecutionPhases(run: Record<string, unknown>): { failed: number; active: number; stopped: number };
  runFailureNoteHtml(run: Record<string, unknown>): string;
  createRunFailureText(error: { status?: number; code?: string; message?: string }): string;
  /* M9-03 profiles config surface */
  PROFILES_WRITE_FIELD_ALLOWLIST: readonly string[];
  buildProfilesFullWritePayload(fields: Record<string, unknown>): Record<string, string>;
  profilesFullAbsenceHtml(): string;
  profilesFullViewHtml(view: Record<string, unknown>): string;
  profilesSaveFailureText(error: { status?: number; code?: string; message?: string }): string;
  /* M10-03 role-bindings surface */
  ROLE_BINDING_ROLES: readonly string[];
  bindingsComplete(bindings: unknown): boolean;
  createFormGate(view: Record<string, unknown>): { disabled: boolean; reason: string };
  CREATE_GATE_HINT_TEXT: string;
  buildRoleBindingsWritePayload(fields: Record<string, unknown>): Record<string, unknown>;
  roleBindingsAbsenceHtml(): string;
  roleBindingsPanelHtml(view: Record<string, unknown>): string;
  bindingsSaveFailureText(error: { status?: number; code?: string; message?: string }): string;
  /* M11-01 shell auto-session surface */
  AUTO_SESSION_SENTINEL: string;
  autoSessionAdoption(ok: boolean, body: unknown): { csrfToken: string | null } | null;
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

  it("derive the create-accept copy from the response body — the HTTP number is never hardcoded (M9-02 review handover #9)", () => {
    // The old copy hardcoded "已接受(202 …)": had the route reverted to 201
    // while keeping the queued body, the page would have kept SAYING 202 —
    // discrimination now lives in the server suite's exact-code assertions
    // and the page states only what the body says.
    expect(assets.appJs).not.toContain("已接受(202");
    expect(assets.appJs).toContain('"已接受(状态 " + body.status + "');
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
    // The create form fields. M10-01: the profile dropdown is GONE — the
    // executing profile comes from the project role bindings, shown read-only.
    expect(html).toContain('id="create-run-form"');
    expect(html).toContain('id="objective-input"');
    expect(html).not.toContain('id="profile-select"');
    expect(html).not.toContain('id="load-profiles-button"');
    expect(html).toContain('id="developer-binding-view"');
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
      { id: "run-2", objective: null, status: "TOTALLY-UNKNOWN", createdAt: "t2" },
      // M9-02 review handover #8: the STATUS field itself is hostile (quotes +
      // angle brackets) — it lands in BOTH the class attribute and the text.
      { id: "run-3", objective: "hostile status probe", status: '"><img src=x onerror=alert(11)>', createdAt: "t3" }
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
    // The hostile status: the double quote is escaped INSIDE the attribute
    // (the attribute never terminates early) and the angle brackets never
    // become markup — the whitelist loop above covers every emitted tag.
    expect(html).toContain('<span class="run-status-badge run-status-&quot;&gt;&lt;img');
    // Direct renderer probe: the badge opens with a safe attribute and closes
    // as one span; both emission points carry the escaped text only.
    const badge = api.runStatusBadgeHtml('"><img src=x onerror=alert(11)>');
    expect(badge.startsWith('<span class="run-status-badge run-status-&quot;&gt;&lt;img')).toBe(true);
    expect(badge.endsWith("</span>")).toBe(true);
    for (const tag of rawTags(badge)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
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
    // M9-02 review handover #2 (a11y): the failure note inside the 2s-poll
    // re-rendered card is VISUAL ONLY — no role="alert" (that would
    // re-announce on every tick). The one-time announcement belongs to the
    // skeleton's polite live region, driven by the state-switch detection.
    expect(card).not.toContain('role="alert"');
    const healthy = api.runDetailCardHtml({
      id: "run-2",
      taskId: "t",
      status: "READY_FOR_DELIVERY",
      baseSha: "abc",
      createdAt: "t",
      executions: [{ id: "exec-2", phase: "SUCCEEDED", attempt: 1, pid: 8 }]
    });
    expect(healthy).not.toContain("存在失败执行");
    expect(healthy).not.toContain("run-failure-note");
  });

  it("classifies execution phases against the store vocabulary (FINALIZING active; INTERRUPTED/CANCELLED annotated)", () => {
    // M9-02 review handover #55: the active set is ACTIVE_ATTEMPT_PHASES
    // (store/src/entities/executions.ts) — FINALIZING included.
    expect(
      api.countExecutionPhases({
        executions: [
          { id: "e1", phase: "PREPARING" },
          { id: "e2", phase: "STARTING" },
          { id: "e3", phase: "RUNNING" },
          { id: "e4", phase: "FINALIZING" }
        ]
      })
    ).toEqual({ failed: 0, active: 4, stopped: 0 });
    expect(
      api.countExecutionPhases({
        executions: [
          { id: "e5", phase: "INTERRUPTED" },
          { id: "e6", phase: "CANCELLED" },
          { id: "e7", phase: "SUCCEEDED" },
          { id: "e8", phase: "FAILED" }
        ]
      })
    ).toEqual({ failed: 1, active: 0, stopped: 2 });

    // A FINALIZING attempt counts as in-progress, not silent.
    const finalizing = api.runDetailCardHtml({
      id: "run-f",
      taskId: "t",
      status: "RUNNING",
      baseSha: "abc",
      createdAt: "t",
      executions: [{ id: "exec-f", phase: "FINALIZING", attempt: 1, pid: 9 }]
    });
    expect(finalizing).toContain("执行进行中");

    // Non-success terminal states get their own explicit annotation instead
    // of silence (they are neither failures nor in progress).
    const stopped = api.runDetailCardHtml({
      id: "run-s",
      taskId: "t",
      status: "RUNNING",
      baseSha: "abc",
      createdAt: "t",
      executions: [
        { id: "exec-s1", phase: "INTERRUPTED", attempt: 1, pid: 10 },
        { id: "exec-s2", phase: "CANCELLED", attempt: 1, pid: 11 }
      ]
    });
    expect(stopped).toContain("非成功终态执行(INTERRUPTED/CANCELLED 共 2 个)");
    expect(stopped).not.toContain("存在失败执行");
  });

  it("renders the M10-04 outcome badge: nothing when NULL, 失败/阻塞 labels when set, hostile values escaped", () => {
    // NULL / absent outcome renders NOTHING — the row shape stays byte-
    // identical to the pre-outcome page whenever there is nothing to say.
    expect(api.runOutcomeBadgeHtml(null)).toBe("");
    expect(api.runOutcomeBadgeHtml(undefined)).toBe("");
    expect(api.runOutcomeBadgeHtml("")).toBe("");
    expect(api.RUN_OUTCOME_GLOSS).toEqual({ failed: "失败", blocked: "阻塞", cancelled: "已取消", success: "成功" });

    // The two badges the ask names: a failed run and a blocked run.
    const failed = api.runOutcomeBadgeHtml("failed");
    expect(failed).toContain("run-outcome-badge run-outcome-failed");
    expect(failed).toContain("失败");
    const blocked = api.runOutcomeBadgeHtml("blocked");
    expect(blocked).toContain("run-outcome-badge run-outcome-blocked");
    expect(blocked).toContain("阻塞");

    // A hostile outcome value cannot break out of the attribute (A36).
    const hostile = api.runOutcomeBadgeHtml('"><img src=x onerror=alert(11)>');
    expect(hostile.startsWith('<span class="run-outcome-badge run-outcome-&quot;&gt;&lt;img')).toBe(true);
    expect(hostile.endsWith("</span>")).toBe(true);
    for (const tag of rawTags(hostile)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
  });

  it("shows the outcome badge next to the frozen status in the list row and the detail head (never a fake 执行中 alone)", () => {
    // The failed run: RUNNING stays, the outcome badge says 失败 beside it.
    const failedRow = api.runRowHtml(
      { id: "run-f", objective: "目标", status: "RUNNING", outcome: "failed", createdAt: "t" },
      null
    );
    expect(failedRow).toContain("run-status-RUNNING");
    expect(failedRow).toContain("run-outcome-failed");
    expect(failedRow).toContain("失败");

    // A pre-outcome API shape (no outcome field) renders exactly as before.
    const legacyRow = api.runRowHtml(
      { id: "run-l", objective: "目标", status: "RUNNING", createdAt: "t" },
      null
    );
    expect(legacyRow).toContain("run-status-RUNNING");
    expect(legacyRow).not.toContain("run-outcome-badge");

    // The detail head carries the badge too.
    const card = api.runDetailCardHtml({
      id: "run-b",
      taskId: "t",
      status: "RUNNING",
      outcome: "blocked",
      baseSha: "abc",
      createdAt: "t",
      executions: [{ id: "exec-b", phase: "RUNNING", attempt: 1, pid: 7 }]
    });
    expect(card).toContain("run-outcome-blocked");
    expect(card).toContain("阻塞");
    expect(card).toContain("run-status-RUNNING");
  });

  it("builds the create payload from an explicit allowlist and refuses model/Profile carriers (A02 UI layer, M10-01: profileId included)", () => {
    expect(api.RUN_CREATE_FIELD_ALLOWLIST).toEqual(["objective", "projectDir"]);
    expect(
      api.buildRunCreatePayload({ objective: "目标", projectDir: " C:/repo " })
    ).toEqual({ objective: "目标", projectDir: "C:/repo" });
    for (const bad of [
      { objective: "x", projectDir: "C:/", model: "claude-opus-4" },
      { objective: "x", projectDir: "C:/", profileRevision: 2 },
      // M10-01: profileId is now OUTSIDE the allowlist — a task must not
      // select a profile (selection lives in the project role bindings).
      { objective: "x", projectDir: "C:/", profileId: "profile-x" },
      { objective: "", projectDir: "C:/" },
      { objective: "   ", projectDir: "C:/" },
      { objective: "x".repeat(10001), projectDir: "C:/" },
      { objective: "x", projectDir: "  " }
    ]) {
      expect(() => api.buildRunCreatePayload(bad), JSON.stringify(Object.keys(bad))).toThrow();
    }
    // The refusal names the M10-01 migration path for profileId carriers.
    expect(() => api.buildRunCreatePayload({ objective: "x", projectDir: "C:/", profileId: "p" }))
      .toThrow(/role-bindings/);
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
    expect(api.createRunFailureText({ status: 422, code: "ROLE_BINDINGS_INCOMPLETE", message: "m" })).toContain(
      "role-bindings"
    );
    expect(api.createRunFailureText({ status: 503, code: "ORCHESTRATION_NOT_CONFIGURED", message: "m" })).toContain(
      "--profiles"
    );
    expect(api.createRunFailureText({ status: 500, message: "boom" })).toContain("500");
  });

  it("renders the project Developer binding read-only: bound, incomplete and absent states, every dynamic value escaped (M10-01)", () => {
    // Bound: 本项目 Developer 角色: <id> — profileId and revision escaped.
    const bound = api.developerBindingHtml({
      projectId: "proj-x",
      bindings: [
        { roleId: "coordinator", profileId: "p-c", profileRevision: 1 },
        { roleId: "developer", profileId: 'p"><script>', profileRevision: 3 }
      ]
    });
    expect(bound).toContain("本项目 Developer 角色");
    expect(bound).not.toMatch(/<script/i);
    expect(bound).toContain("&quot;&gt;&lt;script&gt;");
    expect(bound).toContain("revision 3");

    // Project known but the developer role unbound -> guidance naming the
    // PUT endpoint (with the escaped projectId).
    const incomplete = api.developerBindingHtml({
      projectId: 'proj"><script>',
      bindings: [{ roleId: "developer", profileId: null, profileRevision: null }]
    });
    expect(incomplete).toContain("尚未绑定");
    expect(incomplete).toContain("role-bindings");
    expect(incomplete).not.toMatch(/<script/i);
    expect(incomplete).toContain("&quot;&gt;&lt;script&gt;");

    // Project unknown (first creation registers it) -> honest absent state.
    const absent = api.developerBindingHtml({});
    expect(absent).toContain("还没有项目记录");
    expect(absent).not.toMatch(/<script/i);
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

describe("M10-03 四角色绑定 UI (配置 tab) + create-form gate", () => {
  const api = loadPageApi();

  const COMPLETE_BINDINGS = [
    { roleId: "coordinator", profileId: "p-c", profileRevision: 1 },
    { roleId: "architect", profileId: "p-a", profileRevision: 1 },
    { roleId: "developer", profileId: "p-d", profileRevision: 2 },
    { roleId: "reviewer", profileId: "p-r", profileRevision: 1 }
  ];

  const PROFILES = [
    { id: "p-d", runtime: "claude", executionTarget: "windows-native", model: null, timeoutSeconds: 600 },
    { id: 'evil"><script>', runtime: "codex", executionTarget: "windows-native", model: "m", timeoutSeconds: 600 }
  ];

  it("carries the section skeleton: heading, directory lookup, loader, status and panel slots", () => {
    const html = assets.indexHtml;
    expect(html).toContain('id="role-bindings-config"');
    expect(html).toContain('id="bindings-projectdir-input"');
    expect(html).toContain('id="load-bindings-button"');
    expect(html).toContain('id="bindings-status"');
    expect(html).toContain('id="bindings-panel"');
    // The create form carries the gate hint slot (hidden by default).
    expect(html).toContain('id="create-gate-hint"');
    expect(html).toMatch(/id="create-gate-hint"[^>]*hidden/);
    // The served script exposes the new pure builders.
    expect(assets.appJs).toContain("buildRoleBindingsWritePayload");
    expect(assets.appJs).toContain("createFormGate");
  });

  it("classifies binding completeness exactly over the four built-in roles", () => {
    expect(api.ROLE_BINDING_ROLES).toEqual(["coordinator", "architect", "developer", "reviewer"]);
    expect(api.bindingsComplete(COMPLETE_BINDINGS)).toBe(true);
    // developer unbound -> incomplete; unknown extra roles never satisfy.
    expect(api.bindingsComplete([{ roleId: "developer", profileId: "p" }])).toBe(false);
    expect(
      api.bindingsComplete(COMPLETE_BINDINGS.map((b) => (b.roleId === "reviewer" ? { roleId: "reviewer", profileId: null } : b)))
    ).toBe(false);
    expect(
      api.bindingsComplete(COMPLETE_BINDINGS.map((b) => (b.roleId === "architect" ? { roleId: "architect", profileId: "" } : b)))
    ).toBe(false);
    expect(api.bindingsComplete([])).toBe(false);
  });

  it("gates the create form: unknown project stays enabled (registration), incomplete disables, complete enables", () => {
    expect(api.createFormGate({})).toEqual({ disabled: false, reason: "register" });
    expect(api.createFormGate({ projectId: "proj-x", bindings: [] })).toEqual({
      disabled: true,
      reason: "incomplete"
    });
    expect(api.createFormGate({ projectId: "proj-x", bindings: COMPLETE_BINDINGS })).toEqual({
      disabled: false,
      reason: "ready"
    });
    // The gate hint is static guidance (no dynamic interpolation surface).
    expect(api.CREATE_GATE_HINT_TEXT).toContain("配置");
    expect(api.CREATE_GATE_HINT_TEXT).toContain("422");
  });

  it("renders the binding editor: four selects over the loaded profiles, current bindings preselected, every dynamic value escaped", () => {
    const html = api.roleBindingsPanelHtml({
      projectId: 'proj"><script>',
      executionTarget: "windows-native",
      profiles: PROFILES,
      bindings: [
        { roleId: "developer", profileId: "p-d", profileRevision: 2 },
        { roleId: "coordinator", profileId: null, profileRevision: null }
      ]
    });
    // projectId escaped everywhere it appears (hidden input + heading).
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    // All four selects, in role order, each with the placeholder + every profile.
    for (const role of api.ROLE_BINDING_ROLES) {
      expect(html).toContain('id="binding-select-' + role + '"');
      expect(html).toContain('data-role="' + role + '"');
    }
    expect(html).toContain('<option value="">(选择 profile)</option>');
    expect(html).toContain('value="p-d"');
    // The hostile profile id is a VALUE only after escaping — never markup.
    expect(html).toContain('value="evil&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("evil&quot;&gt;&lt;script&gt; — codex");
    // Current bindings: developer preselected, coordinator reads 未绑定.
    expect(html).toMatch(new RegExp('value="p-d" selected="selected"'));
    expect(html).toContain("当前: 未绑定");
    expect(html).toContain("当前: p-d(revision 2)");
    // One save button + status span.
    expect(html).toContain('id="save-bindings-button"');
    expect(html).toContain('id="bindings-save-status"');
    const absent = api.roleBindingsPanelHtml({ projectId: "proj-x", profiles: [], bindings: [] });
    expect(absent).toContain("当前: 未绑定");
  });

  it("builds the save payload from the four-role allowlist and refuses every other shape", () => {
    const four = [
      { roleId: "coordinator", profileId: "p-c" },
      { roleId: "architect", profileId: "p-a" },
      { roleId: "developer", profileId: "p-d" },
      { roleId: "reviewer", profileId: "p-r" }
    ];
    expect(api.buildRoleBindingsWritePayload({ bindings: four })).toEqual({ bindings: four });
    // Extra field at the top level: refused (A02 UI layer).
    expect(() =>
      api.buildRoleBindingsWritePayload({
        bindings: four.map((b) => ({ roleId: b.roleId, profileId: "p" })),
        model: "sneaky"
      })
    ).toThrow(/refused field/);
    // Three rows: refused; unknown role: refused; duplicate role: refused;
    // blank profileId: refused; bindings key missing: refused.
    const three = four.slice(0, 3);
    expect(() => api.buildRoleBindingsWritePayload({ bindings: three })).toThrow(/必须恰好配置四个角色/);
    expect(() =>
      api.buildRoleBindingsWritePayload({ bindings: [...three, { roleId: "tester", profileId: "p" }] })
    ).toThrow(/未知角色/);
    expect(() =>
      api.buildRoleBindingsWritePayload({ bindings: [...three, { roleId: "developer", profileId: "p" }] })
    ).toThrow(/多次/);
    expect(() =>
      api.buildRoleBindingsWritePayload({ bindings: [...three, { roleId: "reviewer", profileId: "  " }] })
    ).toThrow(/尚未选择 profile/);
    expect(() => api.buildRoleBindingsWritePayload({} as Record<string, unknown>)).toThrow(/bindings/);
  });

  it("renders the honest absence guidance (the registration mechanism, not a dead end)", () => {
    const html = api.roleBindingsAbsenceHtml();
    expect(html).toContain("还没有项目记录");
    expect(html).toContain("422 ROLE_BINDINGS_INCOMPLETE");
    expect(html).toContain("404 PROJECT_NOT_FOUND");
    expect(html).toContain('role="alert"');
  });

  it("maps the typed save refusals to explicit texts (the transactional promise stays visible)", () => {
    const unknownProject = api.bindingsSaveFailureText({ status: 404, code: "PROJECT_NOT_FOUND", message: "m" });
    expect(unknownProject).toContain("404");
    expect(unknownProject).toContain("登记");
    const unknownProfile = api.bindingsSaveFailureText({ status: 422, code: "UNKNOWN_PROFILE", message: "m" });
    expect(unknownProfile).toContain("422");
    expect(unknownProfile).toContain("不在本进程载入列表");
    const mismatch = api.bindingsSaveFailureText({ status: 422, code: "EXECUTION_TARGET_MISMATCH", message: "m" });
    expect(mismatch).toContain("A29");
    const guard = api.bindingsSaveFailureText({ status: 403, code: "CSRF_REQUIRED", message: "csrf" });
    expect(guard).toContain("403");
    const badShape = api.bindingsSaveFailureText({ status: 400, code: "INPUT_REJECTED", message: "m" });
    expect(badShape).toContain("{bindings:[{roleId,profileId} x4]}");
    const fallback = api.bindingsSaveFailureText({ status: 500, message: "boom" });
    expect(fallback).toContain("500");
    expect(fallback).toContain("boom");
  });
});

describe("M11-01 shell auto-session probe (the ONE sanctioned page change)", () => {
  const api = loadPageApi();

  it("keeps the manual skeleton byte-compat: #connect and the token input stay present and visible by default", () => {
    const html = assets.indexHtml;
    expect(html).toContain('id="connect"');
    expect(html).toContain('id="token-input"');
    // The manual flow is the default: the connect section does NOT start hidden.
    expect(html).not.toMatch(/id="connect"[^>]*hidden/);
    // The hide pin lives in the CSS (display:flex would override the UA
    // [hidden] style otherwise).
    expect(assets.appCss).toContain("#connect[hidden] { display: none; }");
    // CSP structural pin unchanged.
    expect(html).not.toMatch(/\son(click|load|error|mouseover)=/i);
  });

  it("probes /api/v1/session WITHOUT a local token — the bare fetch carries no Authorization header", () => {
    // The probe is a bare fetch (no headers argument): authentication comes
    // exclusively from the shell's network-layer injection (M11-01 ADR).
    // Every other /api/v1/session caller goes through fetchJson(…, token).
    expect(assets.appJs.match(/fetch\("\/api\/v1\/session"\)/g)).toHaveLength(1);
    expect(assets.appJs).toContain('fetchJson("/api/v1/session", token)');
    // The hide path: sentinel seed + hidden connect, exactly once.
    expect(assets.appJs).toContain('tokenInput.value = AUTO_SESSION_SENTINEL;');
    expect(assets.appJs).toContain("connect.hidden = true;");
    // The sentinel is a non-secret marker, never shaped like a credential.
    expect(api.AUTO_SESSION_SENTINEL).toBe("shell-auto-session");
    expect(api.AUTO_SESSION_SENTINEL).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("adopts the session ONLY on a 2xx probe: non-ok/failed probes keep the manual flow (null = zero DOM change)", () => {
    // Refused probe (plain browser: 403 TOKEN_REQUIRED) and any falsy ok.
    expect(api.autoSessionAdoption(false, { csrfToken: "c" })).toBeNull();
    expect(api.autoSessionAdoption(false, null)).toBeNull();
    // Authenticated probe without a usable body: adopt, no cached csrf
    // (the loaders' ensureCsrfToken still works — one extra roundtrip).
    expect(api.autoSessionAdoption(true, null)).toEqual({ csrfToken: null });
    expect(api.autoSessionAdoption(true, undefined)).toEqual({ csrfToken: null });
    expect(api.autoSessionAdoption(true, {})).toEqual({ csrfToken: null });
    // A malformed csrf shape is never cached.
    expect(api.autoSessionAdoption(true, { csrfToken: "" })).toEqual({ csrfToken: null });
    expect(api.autoSessionAdoption(true, { csrfToken: "   " })).toEqual({ csrfToken: null });
    expect(api.autoSessionAdoption(true, { csrfToken: 42 })).toEqual({ csrfToken: null });
    // The real shape (server.ts: {schemaVersion, csrfToken}).
    expect(api.autoSessionAdoption(true, { schemaVersion: 1, csrfToken: "csrf-1" })).toEqual({
      csrfToken: "csrf-1"
    });
  });
});
