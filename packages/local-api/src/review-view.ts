/**
 * M11-04 — the per-review-node VERDICT RECORD view (read-only). The A12
 * verdicts are durable in `review_records` (verdict pass|fail, findings as a
 * plain string list, candidateSha binding), but until this view they were
 * reachable only through the candidate-diff endpoint's embedded lookup —
 * which keys on the QUERIED node's own candidate, and a review node never
 * carries one (the candidate belongs to the integration node it reviewed).
 * The product UI's Reviewer drill-down needs the records under the REVIEW
 * node's own id, so this view walks `listReviewRecords` for one (run, node).
 *
 * Problem SEVERITY is deliberately ABSENT: the frozen contracts
 * `ReviewSchema.findings` is a plain string list — no severity/grading field
 * exists in the persistence, and none is invented here (the UI says so
 * honestly). Rework status is NOT duplicated here either: the executed
 * expansion rounds (fix/re-review node ids, generations, holds) are already
 * served by the M5-02 GET /runs/:id/expansions view.
 *
 * Projection discipline (same as every view): explicitly allowlisted fields
 * only — NO reviewId, NO workspace paths, NO baseline manifests. The shape is
 * zod-strict and re-validated at the serving boundary; a drift fails the
 * request (500) instead of emitting a drifted shape.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { listRunNodes } from "@role-orchestrator/dag";
import { listReviewRecords } from "@role-orchestrator/review";
import { getTaskRun } from "@role-orchestrator/store";
import { GraphEditRejectionError, LocalApiStateError } from "./errors.js";

/** One durable review record, allowlisted to the product face. */
export const ReviewRecordItemViewSchema = z.strictObject({
  /** The record's guarded state machine position (record.ts). */
  state: z.enum(["IN_PROGRESS", "COMPLETED", "INVALID"]),
  /** pass | fail — `blocked` never settles a session (the caller refuses it
   * before any record is opened), so the narrow enum is the honest shape; a
   * corrupt row fails the parse (500) instead of drifting through. */
  verdict: z.enum(["pass", "fail"]).nullable(),
  /** The fail verdict's findings, verbatim (plain strings — no severity). */
  findings: z.array(z.string()),
  /** Present on INVALID records (baseline drift / explicit invalidation). */
  invalidatedReason: z.string().nullable(),
  /** When the verdict landed (COMPLETED only). */
  completedAt: z.string().nullable(),
  /** The A12 binding: this verdict answers for EXACTLY this candidate. */
  candidateSha: z.string()
});

export const RunReviewRecordsViewSchema = z.strictObject({
  runId: z.string(),
  nodeId: z.string(),
  records: z.array(ReviewRecordItemViewSchema)
});

export type ReviewRecordItemView = z.output<typeof ReviewRecordItemViewSchema>;
export type RunReviewRecordsView = z.output<typeof RunReviewRecordsViewSchema>;

/**
 * The review records of one run node, oldest first (`listReviewRecords`'s
 * order), or `null` when the run id is unknown (served 404). A node outside
 * the run is a plain 404 (like the graph/diff views), not an empty list —
 * an empty list means "no review session ever opened for THIS node".
 */
export function getRunReviewRecordsView(
  db: DatabaseSync,
  runId: string,
  nodeId: string
): RunReviewRecordsView | null {
  const run = getTaskRun(db, runId);
  if (run === null) return null;
  const nodeKnown = listRunNodes(db, run.id).some((node) => node.nodeId === nodeId);
  if (!nodeKnown) {
    throw new GraphEditRejectionError(
      404,
      "NOT_FOUND",
      `node "${nodeId}" is not part of run "${run.id}"`
    );
  }
  const records = listReviewRecords(db, run.id)
    .filter((record) => record.nodeId === nodeId)
    .map((record): ReviewRecordItemView => {
      if (record.verdict === "blocked") {
        // `blocked` never settles a session (review-driver refuses it before
        // any record opens); a persisted 'blocked' verdict is corruption —
        // fail closed (500) instead of emitting it.
        throw new LocalApiStateError(
          `review record for node "${nodeId}" of run "${run.id}" carries the impossible verdict "blocked"`
        );
      }
      return {
        state: record.state,
        verdict: record.verdict,
        findings: [...(record.findings ?? [])],
        invalidatedReason: record.invalidatedReason,
        completedAt: record.state === "COMPLETED" ? record.updatedAt : null,
        candidateSha: record.candidateSha
      };
    });
  return { runId: run.id, nodeId, records };
}
