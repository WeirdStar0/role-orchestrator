/**
 * @role-orchestrator/dogfood — public entry point (M6-04).
 *
 * The CONTROLLED DOGFOOD + usage-evidence package: a pure test/driver
 * package (no product logic) that runs ONE small feature on an isolated git
 * fixture repository (the A11 user repo, system temp) through the FULL
 * orchestration chain — graph -> schedule -> execute -> integrate -> review
 * -> injected review-fail -> controlled expansion -> approval checkpoint
 * (A17 digest tamper refusal -> approve -> bounded continuation) -> injected
 * launch-window interrupt -> the REAL reconcileStartup (A22
 * RECOVERY_REQUIRED, nothing auto re-runs) -> operator resolution -> retry
 * success — and records every injection point, recovery action and
 * acceptance observation on a driver timeline plus a timestamped evidence
 * log under `evidence/`.
 *
 * World/driver reuse the e2e-baseline (M2-06) primitives: fixture repo,
 * fake-cli dist bin paths, sequence clock and the writer-commit stand-in.
 * Every CLI the chain spawns is the BUILT fake-cli dist bin (dogfood); a
 * real claude/codex is never invoked and no credential material is read.
 */
export * from "./errors.js";
export * from "./evidence.js";
export * from "./world.js";
export * from "./scenario.js";
export * from "./driver.js";
