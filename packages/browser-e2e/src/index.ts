/**
 * @role-orchestrator/browser-e2e — public entry point (M5-05).
 *
 * The five-flow browser end-to-end baseline: a pure test/driver package (NO
 * product logic) that drives the five user flows — 顺序, 并行, 返工, 审批,
 * 恢复 — through a REAL Chromium (playwright-core) against a live
 * local-api server over a real fake-cli dogfood run, plus the browser-layer
 * A38/A39 regressions. Exposed pieces:
 *
 *  - `createWorld` / `createRunnableRun` — migrated store (full M5 chain),
 *    A11 fixture repo, fake-cli profiles, run + revision baseline;
 *  - `runPump` — the graph pump (scheduler -> engine -> worktree ->
 *    integration -> review) with the browser-capture hook;
 *  - `launchBrowser` + the page helpers — every UI assertion reads the DOM;
 *  - `Evidence` — real screenshots + driver log per flow under evidence/.
 */
export * from "./errors.js";
export * from "./evidence.js";
export * from "./world.js";
export * from "./scenario.js";
export * from "./pump.js";
export * from "./fixtures.js";
export * from "./browser.js";
