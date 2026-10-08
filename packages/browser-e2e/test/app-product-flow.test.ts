/**
 * M11-03 — the NEW /app product core flow, browser end to end over a REAL
 * Chromium: 登记项目 (a FRESH git fixture directory the world does not
 * pre-seed) → 四角色绑定 (through the wizard's embedded step, against the
 * loaded fake-cli profile) → 建任务 (fake-cli `--scenario success`) → 详情
 * Agent 时间线 (node card, terminal state, drill-down with the honest
 * degradation sentence) → 历史列表 (the row appears, row-click re-enters the
 * detail). This is the replacement coverage for the old workbench's
 * equivalent flow (flow-6 keeps running unchanged).
 *
 * Authentication: the shell injects `Authorization: Bearer …` on every
 * request to the serve port (ADR docs/adr/010-token-auto-session.md); a test
 * browser has no shell, so the context carries the SAME header for every
 * request via setExtraHTTPHeaders — the honest simulation of the injection,
 * not a bypass (the guard pipeline sees a normal authenticated request).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeBinPath } from "../src/index.js";
import { startHarness } from "./helpers.js";

const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn("[browser-e2e] non-Windows platform — launcher-driven cells are skipped");
}

const PROFILE_ID = "app-flow-claude";
const OBJECTIVE = "新 UI 核心流:从登记到详情时间线的第一个任务";

/** A FRESH git repository (the world's seeded project is a different dir on
 * purpose — the registration flow must register a never-seen directory).
 * git runs ONLY inside this system-temp fixture. */
function createFreshGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ro-appflow-repo-"));
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "appflow@example.invalid"]);
  git(["config", "user.name", "app-flow-fixture"]);
  writeFileSync(join(repoPath, "README.md"), "app product flow fixture\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return repoPath;
}

describe.skipIf(!LAUNCHER_APPLIES)("M11-03 flow: /app 登记 → 绑定 → 建任务 → 详情时间线 → 历史 (browser e2e)", () => {
  test("the full product chain drives through real clicks in the new UI", async () => {
    const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-appflow-wt-"));
    const configDir = mkdtempSync(join(tmpdir(), "ro-appflow-cfg-"));
    const repoPath = createFreshGitRepo();
    const harness = await startHarness("app-product-flow", {
      orchestration: {
        worktreesRoot,
        profiles: [
          {
            id: PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "appflow-claude",
            maxConcurrency: 2,
            timeoutSeconds: 600,
            extraArgs: [],
            invocationArgs: ["--scenario", "success"]
          }
        ]
      }
    });
    const { server, browser, evidence } = harness;
    const consoleErrors: string[] = [];
    try {
      // The ADR-010 injection, simulated at the context level: every request
      // this browser makes carries the session header.
      await browser.context.setExtraHTTPHeaders({ Authorization: `Bearer ${server.token}` });
      browser.page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
      browser.page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      browser.page.on("response", (response) => {
        const url = response.url();
        if (url.includes("/api/")) {
          evidence.log(`api ${response.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")} -> ${String(response.status())}`);
        }
      });
      const page = browser.page;
      const baseUrl = `http://127.0.0.1:${String(server.port)}/app`;

      // ---- ① the home wizard: register the fresh directory ---------------
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#wizard-register-dir", { timeout: 15_000 });
      await page.fill("#wizard-register-dir", repoPath);
      await page.click('button:has-text("校验并登记")');
      await page.waitForSelector("text=已登记", { timeout: 20_000 });
      evidence.log(`registered fresh project dir: ${repoPath}`);

      // The select auto-selected the new project (the fresh registration
      // returns the resolved repoRoot; match on the unique fixture prefix so
      // separator/case normalization cannot flake).
      const selected = await page.$eval("#new-task-project", (element) => (element as HTMLSelectElement).value);
      expect(selected.replace(/\\/g, "/")).toContain("ro-appflow-repo-");

      // ---- ② the embedded binding step: bind all four roles --------------
      // M11-06: the wizard's editor is the (CLI × model) pair — the single
      // fixture profile is (claude, model null), so every role selects CLI
      // claude with the CLI 默认 model and combo reuse lands on it.
      await page.waitForSelector("#role-cli-coordinator", { timeout: 15_000 });
      for (const roleId of ["coordinator", "architect", "developer", "reviewer"]) {
        await page.selectOption(`#role-cli-${roleId}`, "claude");
      }
      const selections = await page.$$eval(".role-combo-editor select", (elements) =>
        elements.map((element) => (element as HTMLSelectElement).value)
      );
      evidence.log(`binding selections before save: ${JSON.stringify(selections)}`);
      await page.click('button:has-text("保存绑定")');
      try {
        await page.waitForSelector("text=四个角色已绑定", { timeout: 20_000 });
      } catch (error) {
        const mainText = await page.textContent(".app-main");
        evidence.log(`BINDING DEBUG main text: ${mainText?.slice(0, 1200) ?? "(none)"}`);
        throw error;
      }
      evidence.log("four roles bound through the wizard's transactional PUT");

      // ---- ③ create the task ---------------------------------------------
      await page.fill("#new-task-objective", OBJECTIVE);
      await page.click('button:has-text("开始执行")');
      await page.waitForURL(/\/app\/runs\//, { timeout: 20_000 });
      evidence.log(`task created, navigated to ${page.url()}`);

      // ---- ④ the detail page: the Agent timeline -------------------------
      try {
        await page.waitForSelector("text=Agent 时间线", { timeout: 15_000 });
      } catch (error) {
        const mainText = await page.textContent(".app-main");
        evidence.log(`DETAIL DEBUG main text: ${mainText?.slice(0, 800) ?? "(none)"}`);
        evidence.log(`DETAIL DEBUG console: ${JSON.stringify(consoleErrors)}`);
        throw error;
      }
      await page.waitForSelector(".timeline-node", { timeout: 15_000 });
      // The node card speaks the human role name and the real objective.
      expect(await page.textContent(".timeline-node-head")).toContain("开发");
      expect((await page.locator(".timeline-node-objective").first().textContent()) ?? "").toContain(OBJECTIVE);
      evidence.log("timeline node card rendered (开发 role, objective shown)");

      // The single-node run has no integration record: the honest
      // degradation must be reachable through the drill-down.
      await page.click('button:has-text("查看详情/日志")');
      await page.waitForSelector("text=尝试次数", { timeout: 15_000 });
      await page.waitForSelector("text=该信息当前未持久化", { timeout: 15_000 });
      evidence.log("drill-down: attempt count + honest 在改文件/Diff degradation sentence");

      // Terminal state (fake-cli success drives the run to completion).
      await page.waitForFunction(
        () => {
          const badges = [...document.querySelectorAll(".timeline-node .status-badge")];
          return badges.some((badge) => (badge.textContent ?? "").includes("已完成"));
        },
        undefined,
        { timeout: 90_000 }
      );
      evidence.log("run reached terminal state: node badge 已完成");

      // M11-04: the 节点图 secondary view (nodes + declared dependencies)
      // toggles from the timeline and renders the single-node face honestly.
      await page.click('button:has-text("节点图")');
      await page.waitForSelector(".node-graph-row", { timeout: 15_000 });
      const graphRow = await page.textContent(".node-graph-row");
      expect(graphRow ?? "").toContain("节点 1");
      expect(graphRow ?? "").toContain("无前置依赖(起点节点)。");
      await page.click('button:has-text("时间线")');
      await page.waitForSelector(".timeline-wave", { timeout: 15_000 });
      evidence.log("节点图 secondary view toggled (节点+依赖 face) and back to the timeline");

      // ---- ⑤ history: the row appears and row-click re-enters ------------
      await page.goto(`${baseUrl}/history`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("text=" + OBJECTIVE, { timeout: 15_000 });
      evidence.log("history list shows the run row (人话状态列)");
      await page.click(`text=${OBJECTIVE}`);
      await page.waitForURL(/\/app\/runs\//, { timeout: 15_000 });
      await page.waitForSelector("text=Agent 时间线", { timeout: 15_000 });
      evidence.log("row-click re-entered the detail page");

      // ---- console cleanliness (authenticated: no 403 noise is expected) -
      // M11-04 (review handover ⑫): the filter is the SMOKE test's exact
      // pattern — only the browser's OWN network annotation of a refused
      // resource (and only an EXPECTED refusal) may pass; any other console
      // entry fails the test. M11-06: the pages additionally probe
      // GET /api/v1/profiles/full, whose DESIGNED 409 (PROFILE_SOURCE_ABSENT
      // — this harness wires no profiles file) Chromium annotates exactly
      // like the 403 arm (status-only annotation, no URL in the message —
      // the page itself handles the refusal and degrades honestly).
      const unexpected = consoleErrors.filter((message) => !/Failed to load resource.*(403|409)/.test(message));
      expect(unexpected).toEqual([]);
      for (const message of consoleErrors) {
        evidence.log(`console entry: ${message}`);
      }
    } finally {
      await harness.close("M11-03 /app product flow: register → bind → create → timeline → history");
      // Best-effort scratch removal (same discipline as flow-6).
      for (const dir of [repoPath, worktreesRoot, configDir]) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
