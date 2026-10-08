/**
 * M11-04 — the multi-node 返工循环 presentation, browser end to end over a
 * REAL Chromium (the batch acceptance face's UI half): a workflow run
 * (developer → integration → review) created through the guarded API, then
 * the /app detail page presents — LIVE, through the 3s poll:
 *
 *   - the multi-node timeline (topological waves; 轮内并行 face);
 *   - the 节点图 secondary view (nodes + declared dependencies, 节点 N
 *     labels, no raw ids);
 *   - the review node's fail grounding the CONTROLLED rework expansion: the
 *     返工轮次 section renders the REAL rounds from the durable
 *     review_expansions rows (评审未通过,发现 N 个问题 → 修复 → 复审), the
 *     minted fix/re-review nodes carry 第 N 轮返工 tags, and the A20 hold
 *     (the third-round cap) states the pause for the operator;
 *   - the Reviewer drill-down: the A12 verdict records (未通过 + the
 *     findings list naming the missing path) + the honest no-severity
 *     sentence + the node's own rework status;
 *   - the integration node's drill-down: the candidate file-list arm (the
 *     fake-cli chain commits nothing, so the honest empty-unified arm shows).
 *
 * Creation is API-driven on purpose: the wizard's creation chain is browser-
 * proven by app-product-flow; THIS cell proves the PRESENTATION of a graph
 * no fake-cli wizard session can reach (a failing review with rounds). The
 * reviewer profile is content-grounded: `--scenario review --review-exists`
 * resolves the path in its worktree — a path that never exists means a fail
 * verdict with exactly one finding, three rounds, then the user hold.
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

const WORKER_PROFILE_ID = "app-rework-worker";
const REVIEWER_PROFILE_ID = "app-rework-reviewer";
const OBJECTIVE = "返工循环产品呈现:评审不通过→修复→复审→轮次上限";
const MISSING_PATH = "definitely-missing-output.txt";

function createFreshGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ro-rework-repo-"));
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "rework@example.invalid"]);
  git(["config", "user.name", "rework-flow-fixture"]);
  writeFileSync(join(repoPath, "README.md"), "rework flow fixture\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return repoPath;
}

/** Authenticated JSON request against the harness server (node:http — the
 * same guard pipeline the page's fetches pass: token + Origin + CSRF). */
function api(
  port: number,
  token: string,
  csrf: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    void import("node:http").then(({ request }) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            authorization: `Bearer ${token}`,
            origin: `http://127.0.0.1:${String(port)}`,
            "x-csrf-token": csrf,
            "content-type": "application/json"
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) });
          });
        }
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe.skipIf(!LAUNCHER_APPLIES)("M11-04 flow: 多节点 返工轮次+评审发现 (browser e2e)", () => {
  test("the failing review's rounds, findings and the hold render live in the product UI", async () => {
    const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-rework-wt-"));
    const configDir = mkdtempSync(join(tmpdir(), "ro-rework-cfg-"));
    const repoPath = createFreshGitRepo();
    const harness = await startHarness("app-rework-flow", {
      orchestration: {
        worktreesRoot,
        profiles: [
          {
            id: WORKER_PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "rework-worker",
            maxConcurrency: 2,
            timeoutSeconds: 600,
            extraArgs: [],
            invocationArgs: ["--scenario", "success"]
          },
          {
            id: REVIEWER_PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "rework-reviewer",
            maxConcurrency: 1,
            timeoutSeconds: 600,
            extraArgs: [],
            // Content-grounded verdict: pass iff the path exists in the
            // reviewer's worktree — it never does, so every round fails with
            // exactly one finding naming the missing path.
            invocationArgs: ["--scenario", "review", "--review-exists", MISSING_PATH]
          }
        ]
      }
    });
    const { server, browser, evidence } = harness;
    const consoleErrors: string[] = [];
    try {
      await browser.context.setExtraHTTPHeaders({ Authorization: `Bearer ${server.token}` });
      browser.page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
      browser.page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      const page = browser.page;

      // ---- create the workflow run through the guarded API ----------------
      const registered = await api(server.port, server.token, server.csrfToken, "POST", "/api/v1/projects", {
        projectDir: repoPath
      });
      expect(registered.status).toBe(200);
      const bindingsLookup = await api(
        server.port,
        server.token,
        server.csrfToken,
        "GET",
        `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(repoPath)}`
      );
      expect(bindingsLookup.status).toBe(200);
      const projectId = bindingsLookup.json["projectId"] as string;
      const seeded = await api(server.port, server.token, server.csrfToken, "PUT", `/api/v1/projects/${projectId}/role-bindings`, {
        bindings: [
          { roleId: "coordinator", profileId: WORKER_PROFILE_ID },
          { roleId: "architect", profileId: WORKER_PROFILE_ID },
          { roleId: "developer", profileId: WORKER_PROFILE_ID },
          { roleId: "reviewer", profileId: REVIEWER_PROFILE_ID }
        ]
      });
      expect(seeded.status).toBe(200);
      const created = await api(server.port, server.token, server.csrfToken, "POST", "/api/v1/runs", {
        objective: OBJECTIVE,
        projectDir: repoPath,
        workflow: {
          nodes: [
            { id: "dev-a", role: "developer", kind: "agent", objective: "实现一个功能占位", dependencies: [] },
            { id: "dev-b", role: "developer", kind: "agent", objective: "实现另一个功能占位", dependencies: [] },
            {
              id: "merge",
              role: "developer",
              kind: "integration",
              objective: "集成各分支成果",
              dependencies: ["dev-a", "dev-b"]
            },
            { id: "check", role: "reviewer", kind: "review", objective: "评审集成候选", dependencies: ["merge"] }
          ]
        }
      });
      expect(created.status).toBe(202);
      const runId = created.json["runId"] as string;
      evidence.log(`workflow run created: ${runId} (dev-a + dev-b → merge → check)`);

      // ---- the detail page renders the multi-node timeline live -----------
      await page.goto(`http://127.0.0.1:${String(server.port)}/app/runs/${runId}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("text=Agent 时间线", { timeout: 15_000 });
      await page.waitForSelector(".timeline-wave", { timeout: 30_000 });
      // 轮内并行 face, REAL two-card row (任务 3 supplement): wave 1 carries
      // BOTH developer roots on ONE row — the wave label names the parallel
      // count and the row holds exactly 2 node cards.
      await page.waitForSelector("text=2 个角色并行", { timeout: 60_000 });
      const firstWaveCards = await page
        .locator(".timeline-wave")
        .first()
        .locator(".timeline-node")
        .count();
      expect(firstWaveCards).toBe(2);
      evidence.log("轮内并行 rendered: wave 1 = 2 developer cards on ONE row (第 1 波(2 个角色并行))");
      // Downstream declared generations render as their own waves.
      await page.waitForFunction(
        () => document.querySelectorAll(".timeline-wave").length >= 3,
        undefined,
        { timeout: 60_000 }
      );
      evidence.log("multi-node timeline: 3+ declared waves rendered");

      // ---- the rework rounds appear from REAL expansion rows --------------
      await page.waitForSelector(".rework-rounds", { timeout: 120_000 });
      await page.waitForSelector("text=第 2 轮", { timeout: 60_000 });
      evidence.log("返工轮次 section rendered (round 2 minted by the fail verdict)");
      // The re-review fails too; round 3 mints, and its fail hits the A20
      // cap — the hold states the pause for the operator.
      await page.waitForSelector("text=返工轮次已达上限", { timeout: 180_000 });
      evidence.log("A20 hold reached: 返工轮次已达上限 rendered (the run is paused for the operator)");

      // The minted fix/re-review nodes carry their round tags (real node ids
      // from the expansion view, never id-spelling guesses).
      const tagCount = await page.locator(".rework-tag").count();
      expect(tagCount).toBeGreaterThanOrEqual(4); // fix-2, review-2, fix-3, review-3

      // ---- the 节点图 secondary view: nodes + declared dependencies -------
      await page.click('button:has-text("节点图")');
      await page.waitForSelector(".node-graph-row", { timeout: 15_000 });
      const graphText = (await page.textContent(".node-graph")) ?? "";
      // Structural edges (the ordinals are the SERVED graph order — after an
      // expansion the minted nodes join it, so positions are not the creation
      // order; the dependency LABELS are what the view promises).
      expect(graphText).toContain("无前置依赖(起点节点)。");
      // The parallel JOIN face: the integration node's line names BOTH
      // developer roots on one dependency line.
      expect(graphText).toMatch(/依赖:节点 \d+\(开发\)、节点 \d+\(开发\)。/);
      // Every DEPENDENCY line speaks role labels, never raw node ids (the
      // minted ids merge-fix-2 etc. appear only inside the server-authored
      // objective PROSE — durable content — never in the structure rows).
      expect(graphText).toContain("(评审)");
      const depLines = graphText.match(/依赖:[^。]*。/g) ?? [];
      // Self-consistent accounting: one dependency line per non-root row —
      // (all 4 planned + 4 minted nodes) rows, exactly 2 roots.
      const rowCount = await page.locator(".node-graph-row").count();
      const rootCount = await page.locator(".node-graph-row", { hasText: "无前置依赖" }).count();
      expect(rowCount).toBeGreaterThanOrEqual(8);
      expect(rootCount).toBe(2);
      expect(depLines.length).toBe(rowCount - rootCount);
      for (const line of depLines) {
        expect(line).toMatch(/^依赖:节点 \d+\((开发|评审)\)(、节点 \d+\((开发|评审)\))*。$/);
      }
      await page.click('button:has-text("时间线")');
      evidence.log("节点图 view: nodes + declared dependencies with 节点 N labels, structure rows id-free");

      // ---- the Reviewer drill-down: verdict records + honest degradation --
      // Expand the ORIGINAL review node (matched by its UNIQUE objective —
      // the re-review nodes share the 评审 role label).
      const reviewerCard = page.locator(".timeline-node", { hasText: "评审集成候选" }).first();
      await reviewerCard.locator('button:has-text("查看详情/日志")').click();
      await page.waitForSelector("text=评审记录", { timeout: 15_000 });
      await page.waitForSelector("text=结论:未通过(发现 1 个问题)", { timeout: 30_000 });
      // The findings LIST names the missing path (asserted on the list
      // itself, not the node objective which also mentions it).
      const findingsText = (await page.textContent(".review-findings")) ?? "";
      expect(findingsText).toContain(MISSING_PATH);
      const drillText = (await page.textContent(".node-drill")) ?? "";
      // The honest degradation: NO severity is persisted, none is invented.
      expect(drillText).toContain("当前评审记录不保存问题分级(严重级)");
      // The node's own rework status, from the real expansion rows.
      expect(drillText).toContain("轮返工已触发");
      evidence.log("Reviewer drill-down: fail verdict + findings list + no-severity honesty + rework status");

      // ---- the integration node's drill-down: the candidate diff arm ------
      const mergeCard = page.locator(".timeline-node", { hasText: "集成各分支成果" }).first();
      const mergeExpand = mergeCard.locator('button:has-text("查看详情/日志")');
      await mergeExpand.click();
      // The drill renders the in-flight arm until the diff fetch settles —
      // wait for a SETTLED arm (candidate file-list, or the honest
      // no-text-changes note) before asserting.
      await page.waitForFunction(
        () => {
          const drills = [...document.querySelectorAll(".node-drill")];
          return drills.some(
            (drill) => drill.textContent !== null && (drill.textContent.includes("个文件:") || drill.textContent.includes("该候选没有可显示的文本改动"))
          );
        },
        undefined,
        { timeout: 15_000 }
      );
      const mergeText = (await mergeCard.locator(".node-drill").first().textContent()) ?? "";
      // The fake-cli chain commits nothing: the candidate exists but the
      // unified text is empty — the honest arm, not a fake diff.
      expect(mergeText).toContain("该候选没有可显示的文本改动");
      evidence.log("integration drill-down: candidate arm reached, empty-unified honest state");

      // ---- console cleanliness (smoke-aligned filter) ----------------------
      const unexpected = consoleErrors.filter((message) => !/Failed to load resource.*403/.test(message));
      expect(unexpected).toEqual([]);
      for (const message of consoleErrors) {
        evidence.log(`console entry: ${message}`);
      }
    } finally {
      await harness.close("M11-04 rework flow: multi-node timeline + rounds + reviewer findings + diff arm");
      for (const dir of [repoPath, worktreesRoot, configDir]) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 420_000);
});
