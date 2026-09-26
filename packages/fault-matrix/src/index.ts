/**
 * @role-orchestrator/fault-matrix — public entry point (M4-05).
 *
 * The recovery fault-injection matrix: a PURE test/matrix-driver package
 * (no product logic) that injects deterministic failures at every critical
 * boundary of the end-to-end chain
 *
 *   dag 建图 -> 调度 -> engine 执行 fake-cli -> worktree -> integration -> review
 *
 * and asserts the recovery semantics of ACCEPTANCE A22/A23/A24/A25/A26/A27
 * (plus A10/A17/A18/A19/A21 regressions):
 *
 *  - `FAULT_MATRIX` — the fixed, ordered case registry (injection point +
 *    ordinal are part of the contract);
 *  - `runFaultMatrix` — drives the whole matrix once and returns the
 *    validated pass/fail report (`MatrixReportSchema`);
 *  - `renderMatrixReport` — the human-readable 通过/失败清单;
 *  - `crashOnSqlFragment` / `dbCrashingAt` — the deterministic DB crash
 *    proxy (the M2-04 pattern generalized with an injection ordinal);
 *  - `cases/*` — one self-contained run function per case (also the focus
 *    of the per-boundary vitest suites).
 */
export * from "./errors.js";
export * from "./crash-db.js";
export * from "./report.js";
export * from "./matrix.js";
export * from "./driver.js";
export * from "./pipeline.js";
export {
  T0,
  iso,
  fakeBinPath,
  createMatrixWorld,
  createMatrixRun,
  createGhostRun,
  makeLaunchDir,
  DIRTY_FILE_CONTENT,
  DIRTY_FILE_REL,
  SEED_FILES
} from "./world.js";
