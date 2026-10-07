/**
 * M11-01 shell render tests (M11-02 extended, M11-03 the wizard): the served
 * /app skeleton — sidebar (四入口), home hero + form, the real projects page
 * with its registration flow — and the M11-02 first-run wizard, rendered via
 * react-dom/server (pure string render, no DOM and no fetch: data loading
 * happens in effects, which SSR never runs).
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
import { ProjectsPage } from "./pages/ProjectsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { SetupGuideCard, type SetupGuideState } from "./components/SetupGuideCard";
import { ApprovalCard } from "./components/ApprovalCard";
import { RoleBindingCards, resolveRoleBindings } from "./components/RoleBindingSection";
import type { ApprovalItemView } from "./api";

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
          <Route path="runs/:runId" element={<RunDetailPage />} />
          <Route path="*" element={<p>页面不存在。</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

/** Render one page under the PRODUCTION basename (/app), as main.tsx does.
 * (Locations are basename-qualified; React Router strips the basename.) */
function renderWithAppBasename(element: ReactNode, initial = "/app/settings"): string {
  return renderToString(
    <MemoryRouter basename="/app" initialEntries={[initial]}>
      <Routes>
        <Route path="*" element={element} />
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

  it("renders the projects / history / settings pages and the not-found fallback", () => {
    const projects = renderAt("/projects");
    expect(projects).toContain("项目");
    // M11-03: the real registration flow replaces the placeholder pointer.
    expect(projects).toContain("登记项目");
    expect(projects).toContain('id="register-project-dir"');
    expect(projects).toContain("校验并登记");
    expect(projects).toContain("git 仓库");
    const history = renderAt("/history");
    expect(history).toContain("历史");
    const settings = renderAt("/settings");
    expect(settings).toContain("M11-05");
    expect(settings).toContain("旧工作台");
    expect(renderAt("/nowhere")).toContain("页面不存在");
  });
});

describe("the M11-03 new-task wizard chrome (SSR: effects never run)", () => {
  it("renders the four steps: 项目下拉+登记入口 → 角色绑定 → 目标 → 开始执行", () => {
    const html = renderAt("/");
    // ① project select + the inline register entry
    expect(html).toContain('id="new-task-project"');
    expect(html).toContain('id="wizard-register-dir"');
    expect(html).toContain("校验并登记");
    // ② the binding step label (its data face arrives via effects)
    expect(html).toContain("角色绑定");
    expect(html).toContain("一次保存,全部生效或全部不生效");
    // ④ the submit affordance
    expect(html).toContain("开始执行");
    // The advanced multi-node face is a COLLAPSED opt-in.
    expect(html).toContain("高级:多节点工作流");
    expect(html).toContain("默认单节点执行");
    expect(html).toContain("至多一个");
    // 人话 discipline: no internal identifiers anywhere in the static chrome.
    expect(html).not.toContain("profileId");
    expect(html).not.toMatch(/proj-[a-f0-9]{8}/);
  });
});

describe("the M11-03 role binding face (pure render)", () => {
  const resolved = resolveRoleBindings(
    {
      bindings: [
        { roleId: "coordinator", profileId: "claude-a", profileRevision: 1 },
        { roleId: "architect", profileId: "claude-a", profileRevision: 1 },
        { roleId: "developer", profileId: "codex-b", profileRevision: 1 },
        { roleId: "reviewer", profileId: null, profileRevision: null }
      ]
    },
    [
      { id: "claude-a", runtime: "claude", model: null },
      { id: "codex-b", runtime: "codex", model: "gpt-5.1" }
    ]
  );

  it("role cards show product names; unbound/not-loaded stay honest and id-free", () => {
    const html = visibleText(renderToString(<RoleBindingCards resolved={resolved} />));
    expect(html).toContain("协调");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("未绑定");
    // The ids exist ONLY as handles, never in the card copy.
    expect(html).not.toContain("claude-a");
    expect(html).not.toContain("codex-b");
  });

  it("a bound-but-not-loaded profile is an honest 未载入 state, never healthy", () => {
    const stale = resolveRoleBindings(
      { bindings: [{ roleId: "developer", profileId: "gone-profile", profileRevision: 1 }] },
      [{ id: "claude-a", runtime: "claude", model: null }]
    );
    const html = visibleText(renderToString(<RoleBindingCards resolved={stale} />));
    expect(html).toContain("未载入");
    expect(html).toContain("开发");
  });

  it("the ok/missing card classes track completeness exactly (the success face keys on them)", () => {
    const complete = resolveRoleBindings(
      {
        bindings: [
          { roleId: "coordinator", profileId: "claude-a", profileRevision: 1 },
          { roleId: "architect", profileId: "claude-a", profileRevision: 1 },
          { roleId: "developer", profileId: "codex-b", profileRevision: 1 },
          { roleId: "reviewer", profileId: "claude-a", profileRevision: 1 }
        ]
      },
      [
        { id: "claude-a", runtime: "claude", model: null },
        { id: "codex-b", runtime: "codex", model: null }
      ]
    );
    const done = renderToString(<RoleBindingCards resolved={complete} />);
    expect(done.match(/role-card-ok/g)?.length).toBe(4);
    expect(done).not.toContain("role-card-missing");
    // The incomplete face from the cell above: exactly one missing card.
    const partial = renderToString(<RoleBindingCards resolved={resolved} />);
    expect(partial.match(/role-card-missing/g)?.length).toBe(1);
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
    // M11-03: the projects page's old-workbench anchor lives in its static
    // footer (data arrives via effects, which SSR never runs) — the pin
    // renders the whole page under the same basename router.
    const projects = renderWithAppBasename(<ProjectsPage />, "/app/projects");
    expect(projects).toContain('href="/"');
    expect(projects).toContain("旧工作台");
    expect(projects).not.toContain('href="/app"');
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

describe("the M11-03 history + run-detail pages (SSR chrome)", () => {
  it("history rows are row-clickable into the detail (点行进详情): the SSR chrome carries the human copy", () => {
    const html = renderAt("/history");
    expect(html).toContain("最近的任务,按创建时间倒序");
    expect(html).toContain("点一行进任务详情");
    // SSR runs no effects: rows AND the empty state arrive client-side; the
    // loading line is the honest static face.
    expect(html).toContain("正在读取…");
  });

  it("run detail renders its loading chrome with ZERO internal ids in the default view", () => {
    const html = renderAt("/runs/run-abc123");
    expect(html).toContain("返回历史");
    expect(html).toContain("正在读取任务…");
    // The 开发者详情 block exists as a COLLAPSED details element — the ids
    // render only when the operator opens it (and only after data arrives).
    expect(html).not.toContain("run-abc123");
    expect(html).not.toContain("开发者详情(内部标识)未折叠");
  });
});

describe("the M11-03 approval card (A17 product face, pure render)", () => {
  const base: ApprovalItemView = {
    approvalId: "apr-1",
    status: "PENDING",
    riskGrade: "high",
    riskReasons: ["unscoped-write"],
    expiresAt: "2026-10-08T12:00:00.000Z",
    argv: ["claude", "--scene", "write-file"],
    permissionIncrements: ["fs.write:/tmp/out.txt"],
    requestedNodeId: "node-a",
    invalidations: [],
    actionable: true
  };
  const renderCard = (approval: ApprovalItemView): string =>
    visibleText(renderToString(<ApprovalCard approval={approval} busy={false} errorText={null} onDecide={() => undefined} />));

  it("a live PENDING approval shows the full digest essentials and the per-approval decision pair", () => {
    const html = renderCard(base);
    expect(html).toContain("等待你的审批");
    expect(html).toContain("高风险");
    expect(html).toContain("unscoped-write");
    expect(html).toContain("将执行:claude --scene write-file");
    expect(html).toContain("新增权限:fs.write:/tmp/out.txt");
    expect(html).toContain("批准");
    expect(html).toContain("拒绝");
    expect(html).toContain("拒绝原因(拒绝时必填)");
    // A17: no global-grant vocabulary anywhere.
    expect(html).not.toContain("全部批准");
    expect(html).not.toContain("信任此站点");
  });

  it("a non-actionable approval renders its invalidations honestly and offers NO buttons", () => {
    const consumed = renderCard({ ...base, status: "CONSUMED", actionable: false, invalidations: ["STATUS_CONSUMED"] });
    expect(consumed).toContain("已被任务继续流程消费");
    expect(consumed).not.toContain("批准");
    const candidateChanged = renderCard({
      ...base,
      actionable: false,
      invalidations: ["CANDIDATE_CHANGED"]
    });
    expect(candidateChanged).toContain("绑定的候选产物已变化");
    expect(candidateChanged).not.toContain("拒绝");
    // The id never renders in the card copy.
    expect(candidateChanged).not.toContain("apr-1");
  });

  it("risk grades humanize with a verbatim fallback", async () => {
    const { riskGradeLabel } = await import("./components/ApprovalCard");
    expect(riskGradeLabel("low")).toBe("低风险");
    expect(riskGradeLabel("medium")).toBe("中风险");
    expect(riskGradeLabel("high")).toBe("高风险");
    expect(riskGradeLabel("future-grade")).toBe("future-grade");
  });
});
