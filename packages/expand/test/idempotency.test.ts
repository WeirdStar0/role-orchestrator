/**
 * Expansion idempotency (M4-03): the same fail — the same (run, failed review
 * node, failed candidateSha) triple — NEVER mints a second pair. Replays
 * return the SAME expansion row; a second fail of the SAME review node on a
 * DIFFERENT candidate cannot fork the chain into a same-named generation and
 * is a typed conflict; independent review chains expand independently.
 */
import { describe, expect, it } from "vitest";
import { DuplicateNodeIdError, listRunNodes } from "@role-orchestrator/dag";
import {
  getRunExpansionById,
  listRunExpansions,
  requestReviewExpansion
} from "../src/index.js";
import {
  createExpandedDb,
  expectError,
  fakeSha,
  rawNode,
  recordVerdict,
  seedExpansionRun,
  T0
} from "./helpers.js";

describe("expansion idempotency and conflict semantics", () => {
  it("a replayed fail returns the SAME pair and mints nothing", async () => {
    const testDb = createExpandedDb("a20-idem-replay");
    try {
      const { db } = testDb;
      const runId = "run-idem";
      await seedExpansionRun(db, { runId });
      const candidateSha = fakeSha("idem-candidate");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: T0 });

      const first = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        now: T0
      });
      expect(first.created).toBe(true);
      expect(first.fixNode.nodeId).toBe("dev_a-fix-2");

      // Same fail again — even with a later timestamp: idempotency is keyed
      // on the trigger triple, not on the request's clock.
      const replay = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        now: T0
      });
      expect(replay.created).toBe(false);
      expect(replay.expansionId).toBe(first.expansionId);
      expect(replay.fixNode).toEqual(first.fixNode);
      expect(replay.reviewNode).toEqual(first.reviewNode);
      expect(replay.readinessTransitions).toEqual([]);

      // No duplicates anywhere: one expansion row, four nodes.
      expect(listRunExpansions(db, runId)).toHaveLength(1);
      expect(listRunNodes(db, runId).map((row) => row.nodeId).sort()).toEqual([
        "dev_a",
        "dev_a-fix-2",
        "dev_a-review-2",
        "review_0"
      ]);
      expect(getRunExpansionById(db, first.expansionId)?.generation).toBe(2);
    } finally {
      testDb.close();
    }
  });

  it("a second fail of the SAME review node cannot fork the generation — typed conflict, nothing written", async () => {
    const testDb = createExpandedDb("a20-idem-conflict");
    try {
      const { db } = testDb;
      const runId = "run-conflict";
      await seedExpansionRun(db, { runId });
      const firstFail = fakeSha("conflict-first");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: firstFail, verdict: "fail", now: T0 });
      requestReviewExpansion(db, { runId, reviewNodeId: "review_0", candidateSha: firstFail, now: T0 });

      // The same review node later records a fail for a DIFFERENT candidate
      // (a re-run reviewed new content and failed again). The round-2 pair
      // already exists — a second one would fork the chain under the same
      // generation, and dag's composed-graph re-validation refuses the
      // duplicate node ids BEFORE any write (typed, nothing forked).
      const secondFail = fakeSha("conflict-second");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: secondFail, verdict: "fail", now: T0 });
      const error = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "review_0",
            candidateSha: secondFail,
            now: T0
          }),
        DuplicateNodeIdError
      );
      expect(error.nodeId).toBe("dev_a-fix-2");

      expect(listRunExpansions(db, runId)).toHaveLength(1);
      expect(listRunExpansions(db, runId)[0]?.triggerCandidateSha).toBe(firstFail);
      expect(listRunNodes(db, runId).map((row) => row.nodeId).sort()).toEqual([
        "dev_a",
        "dev_a-fix-2",
        "dev_a-review-2",
        "review_0"
      ]);
    } finally {
      testDb.close();
    }
  });

  it("independent review chains expand independently", async () => {
    const testDb = createExpandedDb("a20-idem-chains");
    try {
      const { db } = testDb;
      const runId = "run-chains";
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: "dev_a", role: "developer" }),
          rawNode({ id: "dev_b", role: "developer" }),
          rawNode({ id: "review_a0", role: "reviewer", dependencies: ["dev_a"] }),
          rawNode({ id: "review_b0", role: "reviewer", dependencies: ["dev_b"] })
        ]
      });
      const failA = fakeSha("chain-a");
      const failB = fakeSha("chain-b");
      recordVerdict(db, { runId, nodeId: "review_a0", candidateSha: failA, verdict: "fail", now: T0 });
      recordVerdict(db, { runId, nodeId: "review_b0", candidateSha: failB, verdict: "fail", now: T0 });

      const expansionA = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_a0",
        candidateSha: failA,
        now: T0
      });
      const expansionB = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_b0",
        candidateSha: failB,
        now: T0
      });
      expect(expansionA.fixNode.nodeId).toBe("dev_a-fix-2");
      expect(expansionB.fixNode.nodeId).toBe("dev_b-fix-2");
      // Two chains, two expansions, both at generation 2 — the budget counts
      // generations per chain (ORCHESTRATION.md section 5's per-loop diagram),
      // not a shared counter across unrelated reviews.
      expect(expansionA.generation).toBe(2);
      expect(expansionB.generation).toBe(2);
      expect(listRunExpansions(db, runId)).toHaveLength(2);
      expect(listRunNodes(db, runId)).toHaveLength(8);
    } finally {
      testDb.close();
    }
  });
});
