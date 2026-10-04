/**
 * M9-02 flow 6 — the task workbench, browser end to end (the page's DEFAULT
 * tab now opens as the workbench):
 *
 *   输入令牌 (unchanged token flow) -> 填工作目录,只读读出『本项目
 *   Developer 角色』(M10-01:经 GET /api/v1/projects/role-bindings?
 *   projectDir=… 读取项目绑定;profile 下拉已移除——创建任务不选择、也不
 *   改写 profile) -> 填新建任务表单 (objective/工作目录) -> 创建任务
 *   (已接受, 状态 queued——页面文案从响应 body 推导,不含硬编码 HTTP 数字,
 *   精确 202 断言在服务端套件 runs-orchestration) -> 任务列表自动出现该
 *   任务 (GET /api/v1/runs, 倒序)
 *   -> 点行展开实时进度 (run detail 渲染 + WS /api/v1/events/live 事件)
 *   -> 终态徽标 READY_FOR_DELIVERY。
 *
 * The flow also pins the batch's security invariants at the browser layer:
 * a hostile objective reaches the list ONLY as inert escaped text (A36), and
 * the 高级 tab still serves every M5 observatory surface unchanged (the run
 * graph loads through the existing canvas path).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  fakeBinPath,
  openWorkbenchPage,
  readDeveloperBinding,
  fillCreateRunForm,
  submitCreateRun,
  waitForRunList,
  openRunDetail,
  readWorkbenchDetail,
  waitForWorkbenchEvents,
  loadGraph,
  readCanvas,
  pageBodyText,
  type LocalPageTarget
} from "../src/index.js";
import { startHarness } from "./helpers.js";

/**
 * The cells execute through the engine launcher (windows-native-only), same
 * gate as every other launcher-driven flow.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[browser-e2e] non-Windows platform — launcher-driven cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}

const WORKBENCH_PROFILE_ID = "profile-wb-claude";
const OBJECTIVE_MARKER = "工作台端到端:产出合成任务结果";

describe.skipIf(!LAUNCHER_APPLIES)("M9-02 flow 6: 任务工作台 (browser e2e)", () => {
  test("binding readout -> create (accepted/queued) -> list -> live detail -> terminal badge, observatory intact", async () => {
    // Server-owned orchestration scratch: the worktrees root and a config dir
    // with NO declared files (externalConfigFiles: [] is a legal
    // first-revision state, M9-01 §6). Both are ASCII OS-temp paths, removed
    // best-effort on every exit path below.
    const worktreesRoot = mkdtemp("ro-flow6-wt-");
    const configDir = mkdtemp("ro-flow6-cfg-");
    const harness = await startHarness("flow-6-workbench", {
      orchestration: {
        worktreesRoot,
        profiles: [
          {
            id: WORKBENCH_PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "wb-claude",
            maxConcurrency: 2,
            timeoutSeconds: 600,
            extraArgs: [],
            invocationArgs: ["--scenario", "success"]
          }
        ]
      }
    });
    const { world, server, browser, evidence } = harness;
    try {
      const target: LocalPageTarget = { port: server.port, token: server.token };
      const page = browser.page;

      // ---- the page opens ON the workbench; token flow unchanged ----------
      await openWorkbenchPage(page, target);
      evidence.log("workbench page open, token entered (default tab)");

      // ---- M10-01 pre-registration (the product's own sequence) -----------
      // The world seeds its project row with git's canonical repo-root form;
      // run creation registers the RESOLVED form. The first creation attempt
      // is therefore the honest M10-01 refusal (422 ROLE_BINDINGS_INCOMPLETE,
      // details carrying the projectId) — the migration's step ①. Node-side,
      // exactly what the migration doc prescribes; nothing here bypasses the
      // guarded surface.
      const probe = await fetch(`http://127.0.0.1:${String(server.port)}/api/v1/runs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.token}`,
          origin: `http://127.0.0.1:${String(server.port)}`,
          "x-csrf-token": server.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ objective: OBJECTIVE_MARKER, projectDir: world.repoPath })
      });
      expect(probe.status).toBe(422);
      const probeBody = (await probe.json()) as { error: { code: string }; projectId: string };
      expect(probeBody.error.code).toBe("ROLE_BINDINGS_INCOMPLETE");

      // Migration step ②: configure the four bindings through the guarded PUT
      // (token + Origin + CSRF). The world's seeded codex binding points at a
      // profile THIS harness does not load — the deliberate operator act is a
      // rebind to the loaded claude profile.
      const configure = await fetch(
        `http://127.0.0.1:${String(server.port)}/api/v1/projects/${probeBody.projectId}/role-bindings`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${server.token}`,
            origin: `http://127.0.0.1:${String(server.port)}`,
            "x-csrf-token": server.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            bindings: [
              { roleId: "coordinator", profileId: WORKBENCH_PROFILE_ID },
              { roleId: "architect", profileId: WORKBENCH_PROFILE_ID },
              { roleId: "developer", profileId: WORKBENCH_PROFILE_ID },
              { roleId: "reviewer", profileId: WORKBENCH_PROFILE_ID }
            ]
          })
        }
      );
      expect(configure.status).toBe(200);

      // ---- the Developer binding readout replaces the dropdown ------------
      // Read-only, from the project's role bindings — never a form selection.
      const bindingText = await readDeveloperBinding(page, world.repoPath, WORKBENCH_PROFILE_ID);
      evidence.log(`developer binding readout (bound): ${bindingText}`);
      expect(bindingText).toContain("本项目 Developer 角色");
      // The selection surface only: no executable path anywhere in the body.
      expect(await pageBodyText(page)).not.toContain("executable");

      // ---- create: 202 accepted, queued ------------------------------------
      await fillCreateRunForm(page, {
        objective: OBJECTIVE_MARKER,
        projectDir: world.repoPath
      });
      const createStatus = await submitCreateRun(page);
      evidence.log(`create status: ${createStatus}`);
      // M9-02 review handover #9: the page copy derives the state from the
      // response body and never hardcodes the HTTP number (the exact-202
      // assertion lives in runs-orchestration.test.ts).
      expect(createStatus).toContain("已接受(状态");
      expect(createStatus).toContain("queued");
      expect(createStatus).not.toContain("202");
      await evidence.screenshot(page, "create-accepted-queued");

      // ---- the run list picks the task up automatically (2s poll) ----------
      const rows = await waitForRunList(
        page,
        (list) => list.some((row) => row.objective === OBJECTIVE_MARKER),
        "the created task appears in the list",
        20_000
      );
      const row = rows.find((candidate) => candidate.objective === OBJECTIVE_MARKER);
      expect(row).toBeDefined();
      evidence.log(`list row: ${row?.runId} status=${row?.status}`);
      expect(["PLANNED", "RUNNING", "READY_FOR_DELIVERY"]).toContain(row?.status);
      await evidence.screenshot(page, "task-in-list");

      // ---- expand: run detail renders + live events stream over WS ---------
      await openRunDetail(page, row?.runId ?? "");
      const eventsSeen = await waitForWorkbenchEvents(page, 3, 45_000);
      const detail = await readWorkbenchDetail(page);
      evidence.log(`detail live events: ${String(eventsSeen)}; badge=${detail.badgeText}`);
      expect(eventsSeen).toBeGreaterThanOrEqual(3);
      evidence.log(`event types: ${detail.events.map((event) => event.type).join(", ")}`);
      expect(detail.detailText).toContain(row?.runId ?? "");
      // The execution inventory (the existing run-detail renderer): one
      // claimed attempt with a real engine-recorded process id once terminal.
      expect(detail.detailText).toContain("attempt 1");

      // ---- terminal: badge + execution inventory through the same detail ---
      await page.waitForFunction(badgeIncludesReady, undefined, { timeout: 60_000 });
      const finalDetail = await readWorkbenchDetail(page);
      evidence.log(`final badge: ${finalDetail.badgeText}; executions: ${finalDetail.detailText.slice(0, 160)}`);
      expect(finalDetail.badgeText).toContain("READY_FOR_DELIVERY");
      expect(finalDetail.detailText).toContain("SUCCEEDED");
      await evidence.screenshot(page, "terminal-ready-for-delivery");

      // ---- A36 at the browser layer: hostile objective is inert text -------
      const hostileObjective = '<img src=x onerror=alert(12)>工作台注入探针';
      await fillCreateRunForm(page, {
        objective: hostileObjective,
        projectDir: world.repoPath
      });
      await submitCreateRun(page);
      await waitForRunList(
        page,
        (list) => list.some((candidate) => candidate.objective === hostileObjective),
        "the hostile-objective task appears (as inert text)",
        20_000
      );
      const injection = await page.evaluate(() => ({
        liveImgElements: document.querySelectorAll("#run-list-panel img").length,
        rawTextPresent:
          (document.getElementById("run-list-panel")?.textContent ?? "").includes(
            "<img src=x onerror=alert(12)>工作台注入探针"
          )
      }));
      evidence.log(
        `A36 probe: liveImgElements=${String(injection.liveImgElements)} rawTextPresent=${String(injection.rawTextPresent)}`
      );
      expect(injection.liveImgElements).toBe(0);
      expect(injection.rawTextPresent).toBe(true);
      await evidence.screenshot(page, "hostile-objective-inert-text");

      // ---- 高级 tab: every observatory surface still there (regression) ----
      await page.click("#tab-advanced");
      await page.fill("#run-graph-input", row?.runId ?? "");
      await loadGraph(page);
      const canvas = await readCanvas(page);
      evidence.log(`advanced tab canvas: ${canvas.map((node) => `${node.nodeId}=${node.state}`).join(", ")}`);
      expect(canvas.map((node) => node.nodeId)).toEqual(["execute"]);
      expect(canvas[0]?.state).toBe("SUCCEEDED");
      await evidence.screenshot(page, "advanced-tab-observatory-intact");

      await harness.close("flow 6 workbench: OK");
    } catch (error) {
      await harness.close(`flow 6 workbench FAILED: ${String(error)}`);
      throw error;
    } finally {
      cleanupTemp(worktreesRoot);
      cleanupTemp(configDir);
    }
  }, 180_000);
});

function mkdtemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** In-page predicate: the expanded detail's badge reached READY_FOR_DELIVERY. */
function badgeIncludesReady(): boolean {
  const badge = document.querySelector("#workbench-detail .workbench-detail-head .run-status-badge");
  return (badge?.textContent ?? "").includes("READY_FOR_DELIVERY");
}

function cleanupTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort scratch cleanup; never masks a test result
  }
}
