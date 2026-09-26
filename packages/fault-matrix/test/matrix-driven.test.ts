/**
 * The matrix-driven run (M4-05): ONE drive over the whole FAULT_MATRIX
 * registry, in the fixed order, asserting the report shows zero failures.
 * The rendered pass/fail manifest is the matrix's own evidence output.
 */
import { strict as assert } from "node:assert";
import { test } from "vitest";
import { FAULT_MATRIX, renderMatrixReport, runFaultMatrix } from "../src/index.js";


/** The fixed injection order IS the contract — pinned here id by id. */
const EXPECTED_CASE_ORDER: readonly string[] = [
  "FM-DB-01",
  "FM-DB-02",
  "FM-DB-03",
  "FM-DB-04",
  "FM-DB-05",
  "FM-PROC-01",
  "FM-PROC-02",
  "FM-PROC-03",
  "FM-PROC-04",
  "FM-GIT-01",
  "FM-A22-01",
  "FM-APR-01",
  "FM-APR-02",
  "FM-RETRY-01",
  "FM-CHAIN-01"
];

test("the registry order (fixed injection order) is stable and complete", () => {
  assert.deepEqual(
    FAULT_MATRIX.map((matrixCase) => matrixCase.id),
    EXPECTED_CASE_ORDER
  );
  for (const matrixCase of FAULT_MATRIX) {
    assert.ok(matrixCase.acceptance.length >= 1, `${matrixCase.id} must cite acceptance rows`);
    assert.ok(matrixCase.injection.length >= 1, `${matrixCase.id} must declare its injection point`);
  }
});

test(
  "the full fault matrix passes in one deterministic drive",
  { timeout: 900_000 },
  async () => {
    const report = await runFaultMatrix();
    // Every case must have actually run or been declared platform-gated —
    // on an unsupported platform the matrix honestly reports the skips.
    assert.equal(
      report.passed + report.failed + report.skippedPlatform,
      report.total,
      "the report must account for every registered case"
    );
    console.log(`\n${renderMatrixReport(report)}\n`);
    assert.equal(
      report.failed,
      0,
      `fault matrix failures:\n${renderMatrixReport(report)}`
    );
  }
);
