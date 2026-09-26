/**
 * Review-round lineage (M4-03) — the round bookkeeping of docs/ORCHESTRATION.md
 * section 5 (返工不是有环图) and docs/ACCEPTANCE.md A20.
 *
 * A review node's GENERATION is its position in the rework chain:
 * - generation 1 — every reviewer node that already existed in the run's
 *   graph before any expansion (the "first review" the budget counts);
 * - generation n+1 — the re-review node minted by the expansion whose trigger
 *   was the generation-n review node's fail.
 *
 * `maxReviewRounds = 3` INCLUDES that first review, so a chain reaches at most
 * review generations 1, 2, 3: after a third-generation review fails, the
 * fourth-round expansion request is refused (see `requestReviewExpansion`) and
 * the run is held for user disposition. The bound is per rework chain —
 * independent review chains of one run each model their own 返工 loop, exactly
 * like ORCHESTRATION.md's diagram, and each is bounded at three generations.
 *
 * The generation is derived from the durable `review_expansions` rows (the
 * UNIQUE(run_id, review_node_id) index makes the derivation a lookup, never a
 * guess from node id spellings): a node id that names no minted re-review is
 * an original plan review node, generation 1.
 */
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { derivedId } from "@role-orchestrator/scheduler";

/**
 * ORCHESTRATION.md section 5: "maxReviewRounds=3 包含首次审查，即最多再生成
 * 两轮修复与复审". Pinned (not caller-adjustable) so the A20 pause semantics
 * cannot drift per call site; migration 013's CHECK enforces the same bound at
 * the storage layer.
 */
export const MAX_REVIEW_ROUNDS = 3;

export function reviewNodeGeneration(db: DatabaseSync, runId: string, reviewNodeId: string): number {
  IdSchema.parse(runId);
  IdSchema.parse(reviewNodeId);
  const row = db
    .prepare("SELECT new_generation FROM review_expansions WHERE run_id = ? AND review_node_id = ?")
    .get(runId, reviewNodeId) as { new_generation: number | unknown } | undefined;
  if (row === undefined) {
    return 1;
  }
  const generation = Number(row.new_generation);
  if (!Number.isInteger(generation) || generation < 2) {
    // Defense-in-depth against a corrupted lineage row; the CHECK constraint
    // (new_generation >= 2) should make this unreachable.
    throw new Error(
      `review expansion lineage for review node "${reviewNodeId}" of run "${runId}" ` +
        `carries an impossible generation ${String(row.new_generation)}`
    );
  }
  return generation;
}

export interface MintedNodeIds {
  readonly fixNodeId: string;
  readonly reviewNodeId: string;
}

/**
 * Deterministic ids for the minted pair. Readable form first
 * (`<repaired>-fix-<generation>` / `<repaired>-review-<generation>`, the A20
 * shape "<node>-fix-2/<node>-review-2"); when the composed id would overflow
 * the shared 64-char id vocabulary (a repaired node id near the bound), the
 * hashed `derivedId` form keeps the ids deterministic AND valid — determinism
 * is what makes the task_nodes UNIQUE(run_id, node_id) constraint a second,
 * storage-level idempotency net behind the expansion table's own.
 */
export function mintExpansionNodeIds(
  runId: string,
  repairedNodeId: string,
  generation: number
): MintedNodeIds {
  IdSchema.parse(runId);
  IdSchema.parse(repairedNodeId);
  if (!Number.isInteger(generation) || generation < 2) {
    throw new Error(`minted expansion generation must be an integer >= 2, got ${String(generation)}`);
  }
  const round = String(generation);
  const readableFix = `${repairedNodeId}-fix-${round}`;
  const readableReview = `${repairedNodeId}-review-${round}`;
  return {
    fixNodeId: IdSchema.safeParse(readableFix).success
      ? readableFix
      : derivedId("fix", runId, repairedNodeId, round),
    reviewNodeId: IdSchema.safeParse(readableReview).success
      ? readableReview
      : derivedId("review", runId, repairedNodeId, round)
  };
}

/** Deterministic expansion row id (one row per trigger triple). */
export function expansionIdFor(runId: string, reviewNodeId: string, candidateSha: string): string {
  return derivedId("xexp", runId, reviewNodeId, candidateSha);
}

/** Deterministic user-hold row id (one row per refused trigger triple). */
export function expansionHoldIdFor(
  runId: string,
  reviewNodeId: string,
  candidateSha: string
): string {
  return derivedId("xhold", runId, reviewNodeId, candidateSha);
}
