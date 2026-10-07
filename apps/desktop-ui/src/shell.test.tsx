/**
 * M11-01 shell render tests: the served /app skeleton — sidebar (四入口),
 * home hero + form, and the placeholder pages — rendered via
 * react-dom/server (pure string render, no DOM and no fetch: data loading
 * happens in effects, which SSR never runs).
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { App } from "./App";
import { NewTaskPage } from "./pages/NewTaskPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<App />}>
          <Route index element={<NewTaskPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<p>页面不存在。</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
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
