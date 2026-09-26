/**
 * A20 bounded rounds (M4-03): maxReviewRounds = 3 INCLUDING the first review.
 * Three consecutive review generations fail -> the fourth-round expansion
 * request is refused with the typed ReviewRoundsExhaustedError, the run is
 * durably held for user disposition, and nothing auto-continues (no fourth
 * generation exists, nothing gets enqueued). The hold is only ever lifted by
 * an explicit user disposition — and even then the budget stays exhausted.
 *
 * M4-04 closes the scheduling enforcement point this suite previously
 * documented as a boundary: a HELD run's READY nodes no longer enqueue —
 * `enqueueReadyNodes` refuses with the typed RunHeldError while the hold is
 * unresolved, and ordinary scheduling (the original entry node) resumes only
 * after the user's explicit resolution.
 */
import { describe, expect, it } from "vitest";
import { RunHeldError, enqueueReadyNodes } from "@role-orchestrator/scheduler";
import { listRunNodes } from "@role-orchestrator/dag";
import {
  ExpandBudgetExceededError,
  getRunReviewExpansionState,
  getRunUserHold,
  requestReviewExpansion,
  resolveRunHold,
  ReviewRoundsExhaustedError,
  RunHeldForUserError,
  UnknownExpansionHoldError
} from "../src/index.js";
import {
  createExpandedDb,
  expectError,
  fakeSha,
  iso,
  rawNode,
  recordVerdict,
  seedExpansionRun,
  T0
} from "./helpers.js";

describe("A20: three total review rounds, the fourth request is refused and held for the user", () => {
  it("refuses the fourth round, holds the run, and never auto-continues", async () => {
    const testDb = createExpandedDb("a20-rounds");
    try {
      const { db } = testDb;
      const runId = "run-rounds";
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: "dev_a", role: "developer" }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })
        ]
      });
      let stamp = T0;
      const next = (): string => {
        stamp = iso(Date.parse(stamp) - Date.parse(T0) + 30_000);
        return stamp;
      };

      // Round 1 (gen 1, the original plan review) fails -> expansion 1.
      const fail1 = fakeSha("candidate-1");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: fail1, verdict: "fail", now: next() });
      const expansion1 = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha: fail1,
        now: next()
      });
      expect(expansion1.created).toBe(true);
      expect(expansion1.generation).toBe(2);
      expect(expansion1.reviewNode.nodeId).toBe("dev_a-review-2");

      // Round 2 (gen 2) fails -> expansion 2.
      const fail2 = fakeSha("candidate-2");
      recordVerdict(db, {
        runId,
        nodeId: "dev_a-review-2",
        candidateSha: fail2,
        verdict: "fail",
        now: next()
      });
      const expansion2 = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "dev_a-review-2",
        candidateSha: fail2,
        now: next()
      });
      expect(expansion2.created).toBe(true);
      expect(expansion2.generation).toBe(3);
      expect(expansion2.repairedNodeId).toBe("dev_a-fix-2");
      expect(expansion2.reviewNode.nodeId).toBe("dev_a-fix-2-review-3");
      expect(expansion2.fixNode.nodeId).toBe("dev_a-fix-2-fix-3");

      // Round 3 (gen 3) fails -> the FOURTH-round request is refused.
      const fail3 = fakeSha("candidate-3");
      recordVerdict(db, {
        runId,
        nodeId: "dev_a-fix-2-review-3",
        candidateSha: fail3,
        verdict: "fail",
        now: next()
      });
      const refused = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "dev_a-fix-2-review-3",
            candidateSha: fail3,
            now: next()
          }),
        ReviewRoundsExhaustedError
      );
      expect(refused.runId).toBe(runId);
      expect(refused.reviewNodeId).toBe("dev_a-fix-2-review-3");
      expect(refused.candidateSha).toBe(fail3);
      expect(refused.failedGeneration).toBe(3);
      // The typed budget base is the same object family (A20 类型化 BudgetExceeded).
      expect(refused).toBeInstanceOf(ExpandBudgetExceededError);

      // The run waits for the user — durably, with the refused round recorded.
      const hold = getRunUserHold(db, runId);
      expect(hold).not.toBeNull();
      expect(hold?.reason).toBe("review-rounds-exhausted");
      expect(hold?.reviewNodeId).toBe("dev_a-fix-2-review-3");
      expect(hold?.candidateSha).toBe(fail3);
      expect(hold?.attemptedGeneration).toBe(4);
      expect(hold?.resolvedAt).toBeNull();

      // No fourth generation exists: exactly the six nodes of gens 1..3.
      const nodes = listRunNodes(db, runId).map((row) => row.nodeId);
      expect(nodes.sort()).toEqual([
        "dev_a",
        "dev_a-fix-2",
        "dev_a-fix-2-fix-3",
        "dev_a-fix-2-review-3",
        "dev_a-review-2",
        "review_0"
      ]);

      // Nothing auto-continues while the hold is unresolved: the ONLY READY
      // node is the run's original entry node (ordinary scheduling,
      // unrelated to the refused round) — and M4-04's scheduling enforcement
      // point refuses to enqueue ANYTHING for a held run.
      const heldEnqueue = expectError(
        () => enqueueReadyNodes(db, { runId, now: next() }),
        RunHeldError
      );
      expect(heldEnqueue.runId).toBe(runId);
      expect(heldEnqueue.holds).toEqual([
        { source: "expansion", reason: "review-rounds-exhausted", holdId: hold?.id, createdAt: heldEnqueue.holds[0]?.createdAt }
      ]);

      // A repeated fourth-round request is refused AGAIN (the hold answers
      // before any budget/insert work happens).
      const held = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "dev_a-fix-2-review-3",
            candidateSha: fail3,
            now: next()
          }),
        RunHeldForUserError
      );
      expect(held.holdId).toBe(hold?.id);
      expect(held.attemptedGeneration).toBe(4);

      // Idempotent replay of an ALREADY-expanded fail still answers with the
      // same pair — a read-only answer, even while the run is held.
      const replay = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha: fail1,
        now: next()
      });
      expect(replay.created).toBe(false);
      expect(replay.expansionId).toBe(expansion1.expansionId);

      // The read-side state view agrees.
      const state = getRunReviewExpansionState(db, runId);
      expect(state.maxReviewRounds).toBe(3);
      expect(state.expansions.map((row) => row.generation)).toEqual([2, 3]);
      expect(state.unresolvedHold?.id).toBe(hold?.id);

      // The user's explicit disposition resolves the hold — the ONLY exit.
      const resolved = resolveRunHold(db, {
        runId,
        note: "user accepted the round-3 candidate; stop rework here",
        now: next()
      });
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolutionNote).toBe("user accepted the round-3 candidate; stop rework here");
      expect(getRunUserHold(db, runId)).toBeNull();

      // With the hold resolved, ordinary scheduling resumes — and still only
      // for the original entry node: no fourth-generation node exists.
      const enqueue = enqueueReadyNodes(db, { runId, now: next() });
      expect(enqueue.enqueued.map((entry) => entry.nodeId)).toEqual(["dev_a"]);

      // Even after resolution the budget stays exhausted: the same fourth
      // round refuses again (typed, still) and is absorbed into the SAME
      // already-resolved hold row — resolution never minted a fourth round.
      const refusedAgain = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "dev_a-fix-2-review-3",
            candidateSha: fail3,
            now: next()
          }),
        ReviewRoundsExhaustedError
      );
      expect(refusedAgain.failedGeneration).toBe(3);
      expect(getRunUserHold(db, runId)).toBeNull();
      expect(listRunNodes(db, runId)).toHaveLength(6);
    } finally {
      testDb.close();
    }
  });

  it("the storage layer pins the same bound: a fourth-generation row cannot exist", async () => {
    const testDb = createExpandedDb("a20-rounds-check");
    try {
      const { db } = testDb;
      const runId = "run-check";
      await seedExpansionRun(db, { runId });
      // Bypass the typed layer entirely: the CHECK constraint on
      // new_generation (<= 3, = trigger_generation + 1) is the storage-side
      // defense-in-depth behind the typed refusal.
      let violated = false;
      try {
        db.prepare(
          "INSERT INTO review_expansions(id, run_id, trigger_review_node_id, trigger_candidate_sha, " +
            "trigger_generation, new_generation, repaired_node_id, fix_node_id, fix_role, " +
            "review_node_id, definition_revision, verdict, findings, minted_definitions, " +
            "created_at, updated_at) VALUES ('xexp-4th', ?, 'review_0', ?, 3, 4, 'dev_a', " +
            "'dev_a-fix-4', 'developer', 'dev_a-review-4', '1', 'fail', '[]', '{}', ?, ?)"
        ).run(runId, fakeSha("fourth"), T0, T0);
      } catch (error) {
        violated = error instanceof Error && /CHECK constraint failed/i.test(error.message);
      }
      expect(violated).toBe(true);
    } finally {
      testDb.close();
    }
  });

  it("resolving a run without a hold is a typed error", async () => {
    const testDb = createExpandedDb("a20-rounds-nohold");
    try {
      const { db } = testDb;
      await seedExpansionRun(db, { runId: "run-nohold" });
      const error = expectError(
        () => resolveRunHold(db, { runId: "run-nohold", note: "nothing to resolve", now: T0 }),
        UnknownExpansionHoldError
      );
      expect(error.runId).toBe("run-nohold");
    } finally {
      testDb.close();
    }
  });
});
