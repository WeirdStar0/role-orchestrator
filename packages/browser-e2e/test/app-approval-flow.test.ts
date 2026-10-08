/**
 * M11-04 — the approval-pause product chain, browser end to end over a REAL
 * Chromium (the batch's e2e ask): the wizard registers a fresh repo → binds
 * four roles (developer = the PROPOSING fake-cli profile, M9-01 cell-⑤
 * semantics) → creates a single-node task → the fake-cli `action-proposal`
 * scenario ends having ONLY proposed an unscoped write → the checkpoint
 * parks the node WAITING_APPROVAL and the run outcome goes `blocked` →
 * the /app detail page keeps polling through the pause (task-1 fix:
 * runIsTerminal no longer counts `blocked` as terminal) → ApprovalCard
 * 批准 (the EXISTING guarded per-actionDigest decision) → the digest-bound
 * continuation really runs (attempt 2) → the proposal profile re-proposes
 * and parks a NEW PENDING approval → the page shows ALL of it WITHOUT any
 * reload; a second approval grows the attempts to 3.
 *
 * OLD-IMPLEMENTATION DISCRIMINANCE (why this cell is not vacuous): the M11-03
 * runIsTerminal treated `blocked` as TERMINAL — the 3s poll STOPPED at the
 * pause, the header's 每 3 秒自动刷新 indicator disappeared, and after a
 * decision NOTHING new ever rendered without a manual reload (no new
 * approval card, attempts stuck at 1). Under that implementation the
 * indicator assertion, the second-card appearance and the attempt growth
 * all time out — this cell goes red. The re-proposing profile is what makes
 * the pause OBSERVABLE as a live state (A19: the unapproved side effect
 * never happens, so the run stays honestly paused between approvals).
 *
 * Authentication: the ADR-010 injection, simulated at the context level
 * (the same honest simulation app-product-flow uses).
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

const PROPOSER_PROFILE_ID = "app-approval-proposer";
const WORKER_PROFILE_ID = "app-approval-worker";
const OBJECTIVE = "审批暂停产品链:提案→批准→续行→再提案";

function createFreshGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ro-approval-repo-"));
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "approval@example.invalid"]);
  git(["config", "user.name", "approval-flow-fixture"]);
  writeFileSync(join(repoPath, "README.md"), "approval flow fixture\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return repoPath;
}

describe.skipIf(!LAUNCHER_APPLIES)("M11-04 flow: 审批暂停 → 决策 → 续行 → 再提案 (browser e2e)", () => {
  test("the page stays live through the pause and renders every decision's wake WITHOUT reload", async () => {
    const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-approval-wt-"));
    const configDir = mkdtempSync(join(tmpdir(), "ro-approval-cfg-"));
    const proposedWritePath = join(mkdtempSync(join(tmpdir(), "ro-approval-target-")), "proposed.txt");
    const repoPath = createFreshGitRepo();
    const harness = await startHarness("app-approval-flow", {
      orchestration: {
        worktreesRoot,
        profiles: [
          {
            id: PROPOSER_PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "approval-proposer",
            maxConcurrency: 1,
            timeoutSeconds: 600,
            extraArgs: [],
            // The A19 heart: this profile PROPOSES an unscoped write on
            // EVERY execution (including continuations) and never performs
            // it — the run stays honestly paused between approvals.
            invocationArgs: ["--scenario", "action-proposal", "--propose-write", proposedWritePath]
          },
          {
            id: WORKER_PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            // M11-06: a DISTINCT model value so the (CLI × model) editor can
            // select this fixture as its own combo ((claude, approval-worker)
            // → here; (claude, 默认) → the proposer). The fake CLI ignores the
            // model flag (args.ts IGNORED_WITH_VALUE) — behavior unchanged.
            model: "approval-worker",
            credentialGroup: "approval-worker",
            maxConcurrency: 1,
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
      await browser.context.setExtraHTTPHeaders({ Authorization: `Bearer ${server.token}` });
      browser.page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
      browser.page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      const page = browser.page;
      const baseUrl = `http://127.0.0.1:${String(server.port)}/app`;

      // ---- ① register + bind + create (the wizard chain, real clicks) ----
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#wizard-register-dir", { timeout: 15_000 });
      await page.fill("#wizard-register-dir", repoPath);
      await page.click('button:has-text("校验并登记")');
      await page.waitForSelector("text=已登记", { timeout: 20_000 });
      await page.waitForSelector("#role-cli-coordinator", { timeout: 15_000 });
      // M11-06: the wizard's editor is the (CLI × model) pair. The worker
      // profile carries a DISTINCT model value so the two same-CLI fixtures
      // stay two selectable combos ((claude, 默认) → proposer, (claude,
      // approval-worker) → worker); combo reuse resolves by (runtime, model).
      for (const roleId of ["coordinator", "architect", "reviewer"]) {
        await page.selectOption(`#role-cli-${roleId}`, "claude");
        await page.selectOption(`#role-model-${roleId}`, "approval-worker");
      }
      // The DEVELOPER role carries the proposing profile: the single-node
      // run dispatches through it (the M9-01 approval cell's binding).
      await page.selectOption("#role-cli-developer", "claude");
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=四个角色已绑定", { timeout: 20_000 });
      evidence.log("four roles bound; developer = the proposing profile");
      await page.fill("#new-task-objective", OBJECTIVE);
      await page.click('button:has-text("开始执行")');
      await page.waitForURL(/\/app\/runs\//, { timeout: 20_000 });
      evidence.log(`task created, on ${page.url()}`);

      // ---- ② the pause: WAITING_APPROVAL + blocked, page STILL live -------
      await page.waitForSelector(".timeline-node-waiting", { timeout: 60_000 });
      await page.waitForSelector("text=等待审批", { timeout: 15_000 });
      // TASK-1 FIX DISCRIMINANCE: under the old runIsTerminal the poll died
      // here (blocked was "terminal") and this indicator disappeared. The
      // fix keeps the poll alive through the pause.
      await page.waitForSelector("text=每 3 秒自动刷新", { timeout: 15_000 });
      evidence.log("node parked WAITING_APPROVAL, run blocked — and the poll indicator is STILL live");

      // ---- ③ the approval card: full digest essentials + the guide --------
      await page.waitForSelector(".approval-card-live", { timeout: 30_000 });
      const cardText = await page.textContent(".approval-card-live");
      expect(cardText ?? "").toContain("高风险");
      expect(cardText ?? "").toContain("将执行:fake-agent write --path");
      expect(cardText ?? "").toContain(proposedWritePath);
      expect(cardText ?? "").toContain("新增权限:repo.write");
      expect(cardText ?? "").toContain("过期时间:");
      // The M11-04 guidance on the paused node scrolls to the approvals card.
      await page.waitForSelector('button:has-text("等待你的决定")', { timeout: 15_000 });
      // A19: the proposed side effect has NOT happened.
      expect(existsSync(proposedWritePath)).toBe(false);
      evidence.log("approval card live (argv/风险/权限/过期全要素) + 等待你的决定 guide; nothing was written");

      // Expand the drill-down NOW so the attempt growth is watchable live.
      await page.click('button:has-text("查看详情/日志")');
      await page.waitForSelector("text=尝试次数", { timeout: 15_000 });

      // ---- ④ approve #1: the continuation runs, a NEW PENDING card lands --
      await page.click('.approval-card-live button:has-text("批准")');
      await page.waitForSelector("text=已批准", { timeout: 15_000 });
      // The decision refetch + the surviving poll bring BOTH the consumed
      // first card and the re-proposal's second PENDING card — without any
      // reload. (Old implementation: poll dead → this never appears.)
      await page.waitForFunction(
        () => document.querySelectorAll(".approval-card").length >= 2,
        undefined,
        { timeout: 45_000 }
      );
      await page.waitForSelector("text=已被任务继续流程消费", { timeout: 15_000 });
      evidence.log("approval #1 consumed by the continuation; the re-proposal parked a NEW PENDING card (no reload)");
      // The continuation is a REAL second attempt on the node.
      await page.waitForFunction(
        () => document.body.textContent !== null && document.body.textContent.includes("尝试次数:2 次"),
        undefined,
        { timeout: 45_000 }
      );
      evidence.log("timeline recovered through the pause: attempt 2 visible in the drill-down (no reload)");

      // ---- ⑤ approve #2: the chain repeats; attempts reach 3 --------------
      await page.click('.approval-card-live button:has-text("批准")');
      await page.waitForFunction(
        () => document.querySelectorAll(".approval-card").length >= 3,
        undefined,
        { timeout: 45_000 }
      );
      await page.waitForFunction(
        () => document.body.textContent !== null && document.body.textContent.includes("尝试次数:3 次"),
        undefined,
        { timeout: 45_000 }
      );
      const consumedCount = await page.locator("text=已被任务继续流程消费").count();
      expect(consumedCount).toBeGreaterThanOrEqual(2);
      evidence.log("approval #2 consumed; attempt 3 parked the third PENDING card — all rendered live");
      // A19 still: nothing was ever written.
      expect(existsSync(proposedWritePath)).toBe(false);

      // ---- console cleanliness (the smoke-aligned filter; M11-04 ⑫) -------
      // M11-06: the pages additionally probe GET /api/v1/profiles/full,
      // whose DESIGNED 409 (PROFILE_SOURCE_ABSENT — this harness wires no
      // profiles file) Chromium annotates like the 403 arm (status-only
      // annotation; the page handles the refusal and degrades honestly).
      const unexpected = consoleErrors.filter((message) => !/Failed to load resource.*(403|409)/.test(message));
      expect(unexpected).toEqual([]);
      for (const message of consoleErrors) {
        evidence.log(`console entry: ${message}`);
      }
    } finally {
      await harness.close("M11-04 approval flow: pause → decision → continuation → re-proposal, page live throughout");
      for (const dir of [repoPath, worktreesRoot, configDir]) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 240_000);
});
