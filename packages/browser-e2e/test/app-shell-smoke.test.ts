/**
 * M11-01 — the /app desktop-renderer SMOKE (the ask: 加载成功 / 侧栏可见 /
 * 无控制台错误), over a REAL Chromium against a live local-api server.
 *
 * Scope discipline: this is a smoke, not a flow. The new UI authenticates
 * through the desktop shell's loopback Authorization injection (ADR
 * docs/adr/010-token-auto-session.md), which a plain test browser does NOT
 * have, so /api-driven content stays in its honest unauthenticated state
 * here: the server refuses with 403, the page code itself logs nothing, and
 * the only console entries are the browser's OWN network-level annotations
 * of those refused fetches (pinned below). What is pinned: the single-file
 * artifact loads and executes, the shell skeleton (sidebar + the frozen
 * four entries + the home hero) renders, the refused-probe guide card stays
 * honestly absent, and the console stays clean (no pageerror, no React/JS
 * error, no router warning).
 *
 * M11-02 review handover F/R — ABSENCE IS NOW A HARD FAILURE: the M11-01
 * early-return skip was the odd one out in this suite (every other file
 * hard-requires its built inputs, see helpers.ts fake-cli "not built"
 * throw), and the turbo `test dependsOn build` edge already guarantees the
 * artifact in the gate context — so a missing artifact here meant a
 * partial direct run silently lost its only /app coverage. Decision: the
 * smoke FAILS with the producing command named (the repo-root `pnpm build`
 * covers it), never skips.
 */
import { describe, expect, test } from "vitest";
import { startHarness } from "./helpers.js";

describe("M11-01 /app smoke (real Chromium)", () => {
  test("loads the single-file renderer, shows the frozen sidebar, keeps the console clean", async () => {
    const harness = await startHarness("app-shell-smoke");
    const { server, browser, evidence } = harness;
    try {
      const page = browser.page;
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => {
        consoleErrors.push(`pageerror: ${error.message}`);
      });

      // Absence is a HARD failure (handover F/R): the renderer build is a
      // precondition of this suite, like every other built input here.
      const probe = await page.request.get(`http://127.0.0.1:${String(server.port)}/app`, {
        maxRedirects: 0,
        failOnStatusCode: false
      });
      if (probe.status() === 302) {
        throw new Error(
          "/app artifact absent (the /app route answered 302 -> /): build the desktop renderer first — " +
            "`pnpm --filter @role-orchestrator/desktop-ui run build` (repo-root `pnpm build` covers it) — and re-run the smoke"
        );
      }
      expect(probe.status()).toBe(200);

      await page.goto(`http://127.0.0.1:${String(server.port)}/app`, { waitUntil: "load" });
      evidence.log("/app loaded");

      // 侧栏可见: the frozen four entries (220-260px band, fixed 240px).
      await page.waitForSelector(".app-sidebar", { timeout: 15_000 });
      expect(await page.locator(".app-sidebar").count()).toBe(1);
      const entries = await page.$$eval(".sidebar-link", (links) =>
        links.map((link) => link.textContent?.trim() ?? "")
      );
      expect(entries).toEqual(["新任务", "项目", "历史", "设置"]);
      evidence.log(`sidebar entries: ${entries.join(" / ")}`);

      // 首页首面: the frozen hero + the create form affordances.
      const hero = await page.textContent("h1");
      expect(hero).toContain("今天想完成什么?");
      await page.waitForSelector("#new-task-objective", { timeout: 15_000 });

      // M11-02: the first-run guide card is honestly ABSENT in this plain
      // browser (its status probe is refused like every /api call) — the
      // unauthenticated home stays free of wizard noise.
      await page.waitForTimeout(500); // let the status probe settle/refuse
      expect(await page.locator(".setup-guide-head").count()).toBe(0);

      // /app/* deep link serves the same single-file document (SPA refresh).
      await page.goto(`http://127.0.0.1:${String(server.port)}/app/settings`, { waitUntil: "load" });
      await page.waitForSelector(".app-sidebar", { timeout: 15_000 });
      evidence.log("/app/settings deep link loaded");

      // 无控制台错误 — with documented browser-native exceptions: Chromium
      // annotates a refused fetch as "Failed to load resource: ... 403".
      // In this plain-browser harness the guard's 403 on the home page's
      // project-list AND setup-status probes is the DESIGNED
      // unauthenticated state (the real authentication path is the shell's
      // header injection, outside a test browser's reach). The pin
      // therefore asserts: every console entry is exactly such a 403
      // resource annotation — no pageerror, no React/JS error, no router
      // warning — i.e. the APP itself logs nothing.
      const unexpected = consoleErrors.filter(
        (message) => !/Failed to load resource.*403/.test(message)
      );
      expect(unexpected).toEqual([]);
      for (const message of consoleErrors) {
        evidence.log(`expected-unauthenticated console entry: ${message}`);
      }
      await evidence.screenshot(page, "app-shell-smoke");
    } finally {
      await harness.close("M11-01 /app smoke: renderer loads, sidebar shows the frozen four entries, console clean");
    }
  });
});
