/**
 * M4-04 scheduling enforcement point over expansion holds (the "minor 9"
 * boundary of M4-03): while a run is HELD behind an unresolved
 * expansion_user_holds row (A20 fourth-round refusal), the scheduler
 * enqueues NOTHING for it and BLOCKS its already-WAITING entries at
 * dispatch. Both checks read the durable hold table — the enforcement lives
 * in the scheduler (enqueueReadyNodes / pollQueue), verified here against
 * the FULL migration chain including the budget schema (001..013 + 014).
 */
import { describe, expect, it } from "vitest";
import { RunHeldError, enqueueReadyNodes, listQueueEntries, pollQueue } from "@role-orchestrator/scheduler";
import { getRunUserHold, requestReviewExpansion } from "../src/index.js";
import {
  createExpandedBudgetDb,
  fakeSha,
  iso,
  rawNode,
  recordVerdict,
  seedExpansionRun,
  T0
} from "./helpers.js";

const POLL_INPUT = {
  leaseMs: 3_600_000,
  retryWindowMs: 60_000,
  starvationMs: 3_600_000,
  limit: 8,
  concurrency: { globalMax: 4, projectMax: 3, unverifiedCredentialGroupMax: 1 }
};

describe("M4-04: a held run enqueues and dispatches nothing", () => {
  it("blocks enqueue and dispatch for a run held behind an expansion hold", async () => {
    const testDb = createExpandedBudgetDb("held-run");
    try {
      const { db } = testDb;
      const runId = "run-held";
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: "dev_a", role: "developer" }),
          rawNode({ id: "dev_b", role: "developer" }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })
        ]
      });
      let stamp = T0;
      const next = (): string => {
        stamp = iso(Date.parse(stamp) - Date.parse(T0) + 30_000);
        return stamp;
      };

      // BEFORE the hold: the run's entry nodes queue normally.
      const enqueued = enqueueReadyNodes(db, { runId, now: next() });
      expect(enqueued.enqueued.map((entry) => entry.nodeId).sort()).toEqual(["dev_a", "dev_b"]);

      // The review chain walks to the fourth-round refusal: gen 1 fails ->
      // expansion 1 (fix-2/review-2); gen 2 fails -> expansion 2
      // (fix-3/review-3); gen 3 fails -> REFUSED, run held (A20).
      const fail1 = fakeSha("candidate-held-1");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: fail1, verdict: "fail", now: next() });
      const expansion1 = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha: fail1,
        now: next()
      });
      expect(expansion1.created).toBe(true);

      db.prepare("UPDATE task_nodes SET state = 'SUCCEEDED' WHERE run_id = ? AND node_id = ?").run(runId, expansion1.fixNode.nodeId);
      const fail2 = fakeSha("candidate-held-2");
      recordVerdict(db, { runId, nodeId: expansion1.reviewNode.nodeId, candidateSha: fail2, verdict: "fail", now: next() });
      const expansion2 = requestReviewExpansion(db, {
        runId,
        reviewNodeId: expansion1.reviewNode.nodeId,
        candidateSha: fail2,
        now: next()
      });
      expect(expansion2.created).toBe(true);

      db.prepare("UPDATE task_nodes SET state = 'SUCCEEDED' WHERE run_id = ? AND node_id = ?").run(runId, expansion2.fixNode.nodeId);
      const fail3 = fakeSha("candidate-held-3");
      recordVerdict(db, { runId, nodeId: expansion2.reviewNode.nodeId, candidateSha: fail3, verdict: "fail", now: next() });
      expect(() =>
        requestReviewExpansion(db, {
          runId,
          reviewNodeId: expansion2.reviewNode.nodeId,
          candidateSha: fail3,
          now: next()
        })
      ).toThrow(); // ReviewRoundsExhaustedError: the fourth round is refused
      const hold = getRunUserHold(db, runId);
      expect(hold?.reason).toBe("review-rounds-exhausted");
      expect(hold?.resolvedAt).toBeNull();

      // THE ENFORCEMENT POINT (enqueue): the held run's READY nodes do NOT
      // enqueue — and dev_b is an independent entry node that previously
      // kept scheduling ("ordinary scheduling" under M4-03).
      expect(() => enqueueReadyNodes(db, { runId, now: next() })).toThrow(RunHeldError);

      // THE ENFORCEMENT POINT (dispatch): the entries queued BEFORE the hold
      // are blocked with a recorded reason — never silently dropped, never
      // dispatched.
      const poll = pollQueue(db, { ...POLL_INPUT, now: next() });
      expect(poll.dispatched).toHaveLength(0);
      expect(poll.blocked).toHaveLength(2);
      for (const outcome of poll.blocked) {
        expect(outcome.kind).toBe("run-held");
        expect(outcome.reason).toContain("expansion:review-rounds-exhausted");
      }
      const blockedStates = listQueueEntries(db, { state: "GATE_BLOCKED" }).map((entry) => entry.nodeId);
      expect(blockedStates.sort()).toEqual(["dev_a", "dev_b"]);
    } finally {
      testDb.close();
    }
  });
});
