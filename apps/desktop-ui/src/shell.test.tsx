/**
 * M11-01 shell render tests (M11-02 extended): the served /app skeleton —
 * sidebar (四入口), home hero + form, the placeholder pages — and the
 * M11-02 first-run wizard, rendered via react-dom/server (pure string
 * render, no DOM and no fetch: data loading happens in effects, which SSR
 * never runs).
 *
 * M11-02 review handover A pin: the OLD-page links render href="/" EXACTLY
 * under a basename="/app" router — the production router config. A router
 * <Link> would resolve to /app (the new-UI root) under that basename
 * (renderToString-verified defect); the native <a> keeps the operator one
 * real click from the old workbench.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ProjectsEmptyGuide, ProjectsPage } from "./pages/ProjectsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { SetupGuideCard, type SetupGuideState } from "./components/SetupGuideCard";

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<App />}>
          <Route index element={<NewTaskPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="setup" element={<SetupPage />} />
          <Route path="*" element={<p>页面不存在。</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

/** Render one page under the PRODUCTION basename (/app), as main.tsx does.
 * (Locations are basename-qualified; React Router strips the basename.) */
function renderWithAppBasename(element: ReactNode): string {
  return renderToString(
    <MemoryRouter basename="/app" initialEntries={["/app/settings"]}>
      <Routes>
        <Route path="settings" element={element} />
      </Routes>
    </MemoryRouter>
  );
}

/** React SSR sprinkles <!-- --> separators around interpolated text; strip
 * them so assertions read against the visible text. */
function visibleText(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

describe("the /app shell (M11-01)", () => {
  it("renders the frozen sidebar: brand + exactly the four entries, none of them carrying internal ids", () => {
    const html = renderAt("/");
    expect(html).toContain("app-sidebar");
    expect(html).toContain("role-orchestrator");
    for (const label of ["新任务", "项目", "历史", "设置"]) {
      expect(html).toContain(`>${label}</`);
    }
    // The default view must not leak internal identifiers.
    expect(html).not.toContain("csrfToken");
    expect(html).not.toContain("profileId");
    expect(html).not.toMatch(/run-[a-z0-9]/);
    expect(html).not.toMatch(/proj-[a-f0-9]{8}/);
  });

  it("renders the home page: 今天想完成什么? hero + objective input + project select + 开始执行", () => {
    const html = renderAt("/");
    expect(html).toContain("今天想完成什么?");
    expect(html).toContain('id="new-task-objective"');
    expect(html).toContain('id="new-task-project"');
    expect(html).toContain("开始执行");
    // Server-side validation honesty note (the UI never pre-validates paths).
    expect(html).toContain("服务端校验");
  });

  it("renders the projects / history / settings skeletons and the not-found fallback", () => {
    const projects = renderAt("/projects");
    expect(projects).toContain("项目");
    expect(projects).toContain("M11-03");
    const history = renderAt("/history");
    expect(history).toContain("历史");
    const settings = renderAt("/settings");
    expect(settings).toContain("M11-05");
    expect(settings).toContain("旧工作台");
    expect(renderAt("/nowhere")).toContain("页面不存在");
  });
});

describe("review handover A: old-page links survive the /app basename", () => {
  it("settings and projects render the old-workbench link as a NATIVE anchor with href exactly /", () => {
    // The production router carries basename="/app"; under it a router
    // <Link to="/"> renders href="/app" (the defect this pin kills).
    const settings = renderWithAppBasename(<SettingsPage />);
    expect(settings).toContain('href="/"');
    expect(settings).toContain("旧工作台");
    expect(settings).not.toContain('href="/app"');
    // ProjectsPage's link lives in its empty state (data arrives via
    // effects, which SSR never runs) — the pin renders that exported guide
    // under the same basename router.
    const projectsGuide = renderWithAppBasename(<ProjectsEmptyGuide />);
    expect(projectsGuide).toContain('href="/"');
    expect(projectsGuide).toContain("旧工作台");
    expect(projectsGuide).not.toContain('href="/app"');
  });
});

describe("the M11-02 first-run wizard card (pure render, every phase)", () => {
  const renderCard = (state: SetupGuideState): string =>
    renderToString(
      <MemoryRouter initialEntries={["/"]}>
        <SetupGuideCard state={state} onGenerate={() => undefined} />
      </MemoryRouter>
    );

  it("ready (both CLIs): names both with ✓, states the recommended division, offers the generate button", () => {
    const html = renderCard({
      phase: "ready",
      claudeFound: true,
      codexFound: true,
      fileState: "absent"
    });
    expect(html).toContain("检测到 Claude Code ✓ 与 Codex ✓");
    expect(html).toContain("Claude Code 负责协调、架构与评审,Codex 负责开发");
    expect(html).toContain("生成推荐配置");
    // 人话 discipline: no internal identifiers in the copy.
    expect(html).not.toContain("claude-default");
    expect(html).not.toContain("sourcePath");
    expect(html).not.toContain("profileId");
  });

  it("ready (single CLI): honestly names the miss and lands all four roles on the found CLI", () => {
    const onlyClaude = renderCard({ phase: "ready", claudeFound: true, codexFound: false, fileState: "absent" });
    expect(onlyClaude).toContain("检测到 Claude Code ✓(未检测到 Codex)");
    expect(onlyClaude).toContain("四个角色(协调、架构、开发、评审)都将由 Claude Code 承担");
    const onlyCodex = renderCard({ phase: "ready", claudeFound: false, codexFound: true, fileState: "unparseable" });
    expect(onlyCodex).toContain("检测到 Codex ✓(未检测到 Claude Code)");
    expect(onlyCodex).toContain("四个角色(协调、架构、开发、评审)都将由 Codex 承担");
  });

  it("ready (no CLI): no generate button — the honest miss list plus the manual-config route", () => {
    const html = renderCard({ phase: "ready", claudeFound: false, codexFound: false, fileState: "absent" });
    expect(html).toContain("未检测到 Claude Code,也未检测到 Codex");
    expect(html).not.toContain("生成推荐配置");
    expect(html).toContain("旧工作台");
    expect(html).toContain('href="/"');
  });

  it("ready but unwired: generation is not offered; the honest no-wiring guidance is", () => {
    const html = renderCard({ phase: "ready", claudeFound: true, codexFound: true, fileState: "unwired" });
    expect(html).not.toContain("生成推荐配置");
    expect(html).toContain("没有接入 AI 配置文件");
  });

  it("working state disables the button; done/restart-pending state the restart truth", () => {
    const working = renderCard({ phase: "working", claudeFound: true, codexFound: true });
    expect(working).toContain('disabled=""');
    const done = visibleText(renderCard({ phase: "done", mode: "created", profileCount: 2 }));
    expect(done).toContain("重启桌面应用后生效");
    expect(done).toContain("2 个默认 AI 配置");
    const pending = renderCard({ phase: "restart-pending" });
    expect(pending).toContain("推荐配置已生成——重启桌面应用后生效");
    const allSet = renderCard({ phase: "all-set" });
    expect(allSet).toContain("AI 配置已就绪,无需初始设置");
  });

  it("error state renders the humanized refusal and the miss list, still id-free", () => {
    const html = visibleText(
      renderCard({
        phase: "error",
        message: "未能生成(422):本机没有找到 Claude Code 和 Codex。",
        misses: ["Claude Code", "Codex"]
      })
    );
    expect(html).toContain("未能生成(422)");
    expect(html).toContain("本次未检测到:Claude Code、Codex");
    expect(html).not.toContain('"claude"');
  });
});

describe("the M11-02 /app/setup wizard page", () => {
  it("renders the wizard chrome and the checking probe line (SSR runs no effects)", () => {
    const html = renderAt("/setup");
    expect(html).toContain("初始设置");
    expect(html).toContain("正在检测本机已安装的 AI 命令行");
    // Sidebar stays the frozen four — the wizard is NOT a fifth entry.
    expect(html.match(/sidebar-link/g)?.length).toBe(4);
  });
});
