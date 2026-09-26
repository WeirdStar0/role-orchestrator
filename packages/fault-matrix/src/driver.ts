/**
 * The matrix driver (M4-05): walks the FAULT_MATRIX registry once, in the
 * fixed order, and collects the 通过/失败清单 into a validated report.
 *
 * The driver owns NO fault logic — a case is either "pass" (its recovery
 * assertions held), "fail" (an assertion threw; the error message is the
 * finding), or "skipped-platform" (the case needs a platform this host is
 * not; declared, never silently counted as a pass).
 */
import { MatrixCaseResultSchema, MatrixReportSchema, type MatrixCase, type MatrixCaseResult, type MatrixReport } from "./report.js";
import { FAULT_MATRIX } from "./matrix.js";

export interface RunFaultMatrixOptions {
  /** A subset to run (same order); defaults to the full registry. */
  readonly cases?: readonly MatrixCase[];
}

export async function runFaultMatrix(options: RunFaultMatrixOptions = {}): Promise<MatrixReport> {
  const cases = options.cases ?? FAULT_MATRIX;
  const startedAt = new Date().toISOString();
  const results: MatrixCaseResult[] = [];

  for (const matrixCase of cases) {
    const started = Date.now();
    if (!matrixCase.platforms.includes(process.platform)) {
      results.push(
        MatrixCaseResultSchema.parse({
          id: matrixCase.id,
          title: matrixCase.title,
          boundary: matrixCase.boundary,
          acceptance: [...matrixCase.acceptance],
          injection: matrixCase.injection,
          status: "skipped-platform",
          error: `case requires one of [${matrixCase.platforms.join(", ")}]; host is ${process.platform}`,
          durationMs: 0
        })
      );
      continue;
    }
    let result: MatrixCaseResult;
    try {
      await matrixCase.run();
      result = {
        id: matrixCase.id,
        title: matrixCase.title,
        boundary: matrixCase.boundary,
        acceptance: [...matrixCase.acceptance],
        injection: matrixCase.injection,
        status: "pass",
        error: null,
        durationMs: Date.now() - started
      };
    } catch (error) {
      result = {
        id: matrixCase.id,
        title: matrixCase.title,
        boundary: matrixCase.boundary,
        acceptance: [...matrixCase.acceptance],
        injection: matrixCase.injection,
        status: "fail",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        durationMs: Date.now() - started
      };
    }
    results.push(MatrixCaseResultSchema.parse(result));
  }

  const passed = results.filter((entry) => entry.status === "pass").length;
  const failed = results.filter((entry) => entry.status === "fail").length;
  const skippedPlatform = results.filter((entry) => entry.status === "skipped-platform").length;
  return MatrixReportSchema.parse({
    startedAt,
    finishedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    skippedPlatform,
    allPassed: failed === 0,
    cases: results
  });
}
