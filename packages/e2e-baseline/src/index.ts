/**
 * @role-orchestrator/e2e-baseline — public entry point (M2-06).
 *
 * The parallel-development END-TO-END BASELINE: a pure test/benchmark package
 * (no product logic) that drives one synthetic workflow
 *
 *   plan -> (frontend || backend) -> integrate -> review -> followup ->
 *   integrate-followup
 *
 * through the REAL chain — dag validation/graph -> scheduler dispatch claims
 * (real three-level quota + unverified-credential lock) -> engine executions
 * (fake-cli dist bins as real subprocesses) -> worktree isolation ->
 * integration (inputSha set + candidateSha) -> review verdict — and exposes
 * the fixture/world/scenario/driver pieces the tests assert on:
 *
 *  - `createFixtureRepo` — the A11 user repo (seed commit + uncommitted dirty
 *    file) built by git inside the system temp directory;
 *  - `createBaselineWorld` / `createBaselineRun` — migrated store (001..006),
 *    project, fake-cli profiles, the four role bindings, frozen snapshots;
 *  - `baselineWorkflowRaw` / `BASELINE_NODE_SPECS` — the one source of truth
 *    for the example workflow;
 *  - `runBaseline` — the pump; fails with `BaselineDriverError` carrying a
 *    store-fact site summary (diagnosable failures).
 */
export * from "./errors.js";
export * from "./clock.js";
export * from "./fixture-repo.js";
export * from "./scenario.js";
export * from "./world.js";
export * from "./writer-commit.js";
export * from "./driver.js";
