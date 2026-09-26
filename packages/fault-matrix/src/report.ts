/**
 * Matrix report types (M4-05). Every case result carries the acceptance ids
 * it evidences and the FIXED injection point + ordinal it used, so the
 * report is the reproducible pass/fail manifest of one full matrix drive.
 */
import { z } from "zod";

export const MATRIX_BOUNDARIES = ["db", "process", "git", "approval", "side-effect", "retry"] as const;
export type MatrixBoundary = (typeof MATRIX_BOUNDARIES)[number];

export const MATRIX_CASE_STATUSES = ["pass", "fail", "skipped-platform"] as const;
export type MatrixCaseStatus = (typeof MATRIX_CASE_STATUSES)[number];

const MatrixCaseDescriptorSchema = z.strictObject({
  id: z.string().regex(/^FM-[A-Z0-9]+-\d{2}$/),
  boundary: z.enum(MATRIX_BOUNDARIES),
  acceptance: z.array(z.string().regex(/^A\d{2}$/)).min(1),
  title: z.string().min(1),
  /** The fixed injection point + ordinal, human-readable, stable across reruns. */
  injection: z.string().min(1),
  /** Platforms the case can run on; others report skipped-platform honestly. */
  platforms: z.array(z.string()).min(1),
  run: z.custom<() => Promise<void>>((value) => typeof value === "function")
});

export type MatrixCase = z.output<typeof MatrixCaseDescriptorSchema>;

export const MatrixCaseResultSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  boundary: z.enum(MATRIX_BOUNDARIES),
  acceptance: z.array(z.string()),
  injection: z.string(),
  status: z.enum(MATRIX_CASE_STATUSES),
  error: z.string().nullable(),
  durationMs: z.number().int().min(0)
});

export type MatrixCaseResult = z.output<typeof MatrixCaseResultSchema>;

export const MatrixReportSchema = z.strictObject({
  startedAt: z.string(),
  finishedAt: z.string(),
  total: z.number().int().min(1),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skippedPlatform: z.number().int().min(0),
  allPassed: z.boolean(),
  cases: z.array(MatrixCaseResultSchema).min(1)
});

export type MatrixReport = z.output<typeof MatrixReportSchema>;

/** One-line rendering of the report — the 通过/失败清单. */
export function renderMatrixReport(report: MatrixReport): string {
  const lines: string[] = [];
  lines.push(
    `fault matrix: ${String(report.passed)} passed, ${String(report.failed)} failed, ` +
      `${String(report.skippedPlatform)} skipped (platform gate) of ${String(report.total)} cases` +
      ` — allPassed=${String(report.allPassed)}`
  );
  for (const result of report.cases) {
    const acceptance = result.acceptance.join("/");
    lines.push(
      `[${result.status.toUpperCase()}] ${result.id} (${acceptance}, ${result.boundary}) ` +
        `${result.title} | injection: ${result.injection}` +
        (result.error === null ? "" : ` | ERROR: ${result.error.split("\n")[0] ?? result.error}`)
    );
  }
  return lines.join("\n");
}
