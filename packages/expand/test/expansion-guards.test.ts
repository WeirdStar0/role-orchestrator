/**
 * Expansion trigger and repair-target guards (M4-03): the expander is
 * fail-closed about WHAT it expands — only a reviewer node, only a durable
 * fail verdict for the exact candidate (the M2-05 A12 query), only a repair
 * target the failed review actually reviewed. Also covers the readable-id
 * overflow fallback (hashed deterministic ids for near-bound repaired ids).
 */
import { describe, expect, it } from "vitest";
import { listRunNodes } from "@role-orchestrator/dag";
import {
  AmbiguousRepairTargetError,
  getRunReviewExpansionState,
  listRunExpansions,
  NoFailVerdictError,
  NotReviewNodeError,
  requestReviewExpansion,
  RepairTargetNotReviewedError
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

describe("expansion trigger guards", () => {
  it("refuses non-reviewer trigger nodes before any verdict lookup", async () => {
    const testDb = createExpandedDb("a20-guard-role");
    try {
      const { db } = testDb;
      const runId = "run-guard-role";
      await seedExpansionRun(db, { runId });
      const error = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "dev_a",
            candidateSha: fakeSha("guard-role"),
            now: T0
          }),
        NotReviewNodeError
      );
      expect(error.actualRole).toBe("developer");
      expect(listRunExpansions(db, runId)).toHaveLength(0);
    } finally {
      testDb.close();
    }
  });

  it("refuses without a durable fail verdict: none, invalidated, pass and blocked all refuse", async () => {
    const testDb = createExpandedDb("a20-guard-verdict");
    try {
      const { db } = testDb;
      const runId = "run-guard-verdict";
      await seedExpansionRun(db, { runId });

      // `none` — no review record at all for this node.
      const missing = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "review_0",
            candidateSha: fakeSha("never-reviewed"),
            now: T0
          }),
        NoFailVerdictError
      );
      expect(missing.lookupKind).toBe("none");
      expect(missing.verdict).toBeNull();

      // A PASS verdict for the exact candidate is not a rework trigger.
      const passSha = fakeSha("pass-candidate");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: passSha, verdict: "pass", now: T0 });
      const passed = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "review_0",
            candidateSha: passSha,
            now: T0
          }),
        NoFailVerdictError
      );
      expect(passed.lookupKind).toBe("valid");
      expect(passed.verdict).toBe("pass");

      // A fail recorded for a DIFFERENT candidate does not trigger for THIS
      // one — the A12 invalidated answer carries no verdict to act on.
      const failedSha = fakeSha("failed-candidate");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: failedSha, verdict: "fail", now: T0 });
      const stale = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "review_0",
            candidateSha: fakeSha("other-candidate"),
            now: T0
          }),
        NoFailVerdictError
      );
      expect(stale.lookupKind).toBe("invalidated");
      expect(stale.verdict).toBeNull();

      // A `blocked` verdict (the reviewer could not complete) is likewise no
      // automatic rework trigger — only `fail` is.
      const blockedSha = fakeSha("blocked-candidate");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha: blockedSha, verdict: "blocked", now: T0 });
      const blocked = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "review_0",
            candidateSha: blockedSha,
            now: T0
          }),
        NoFailVerdictError
      );
      expect(blocked.verdict).toBe("blocked");

      // The genuine fail still expands after all those refusals.
      const outcome = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha: failedSha,
        now: T0
      });
      expect(outcome.created).toBe(true);
    } finally {
      testDb.close();
    }
  });
});

describe("repair target guards", () => {
  it("an ambiguous reviewed scope requires an explicit repairedNodeId", async () => {
    const testDb = createExpandedDb("a20-guard-ambiguous");
    try {
      const { db } = testDb;
      const runId = "run-ambiguous";
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: "dev_a", role: "developer" }),
          rawNode({ id: "dev_b", role: "developer" }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a", "dev_b"] })
        ]
      });
      const candidateSha = fakeSha("ambiguous");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: T0 });

      const ambiguous = expectError(
        () =>
          requestReviewExpansion(db, { runId, reviewNodeId: "review_0", candidateSha, now: T0 }),
        AmbiguousRepairTargetError
      );
      expect([...ambiguous.directDependencies].sort()).toEqual(["dev_a", "dev_b"]);

      // Explicit designation of one reviewed node works; the fix depends on
      // exactly that node.
      const outcome = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        repairedNodeId: "dev_b",
        now: T0
      });
      expect(outcome.created).toBe(true);
      expect(outcome.repairedNodeId).toBe("dev_b");
      expect(outcome.fixNode.dependencies).toEqual(["dev_b"]);
      expect(outcome.fixNode.roleId).toBe("developer");
    } finally {
      testDb.close();
    }
  });

  it("refuses a repair target the failed review never reviewed", async () => {
    const testDb = createExpandedDb("a20-guard-scope");
    try {
      const { db } = testDb;
      const runId = "run-scope";
      await seedExpansionRun(db, { runId });
      const candidateSha = fakeSha("scope");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: T0 });
      const error = expectError(
        () =>
          requestReviewExpansion(db, {
            runId,
            reviewNodeId: "review_0",
            candidateSha,
            repairedNodeId: "unrelated_node",
            now: T0
          }),
        RepairTargetNotReviewedError
      );
      expect(error.repairedNodeId).toBe("unrelated_node");
      expect(error.directDependencies).toEqual(["dev_a"]);
      expect(listRunExpansions(db, runId)).toHaveLength(0);
    } finally {
      testDb.close();
    }
  });
});

describe("minted id derivation", () => {
  it("falls back to hashed deterministic ids when the readable form would overflow the id bound", async () => {
    const testDb = createExpandedDb("a20-guard-longname");
    try {
      const { db } = testDb;
      const runId = "run-longname";
      const longId = "a".repeat(60); // legal id, but 60 + "-review-2" > 64 chars
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: longId, role: "developer" }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: [longId] })
        ]
      });
      const candidateSha = fakeSha("longname");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: T0 });
      const outcome = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        now: T0
      });
      expect(outcome.created).toBe(true);
      // Both minted ids are valid, deterministic, and NOT the overflowing
      // readable forms.
      expect(outcome.fixNode.nodeId).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
      expect(outcome.reviewNode.nodeId).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
      expect(outcome.fixNode.nodeId.startsWith("fix-")).toBe(true);
      expect(outcome.reviewNode.nodeId.startsWith("review-")).toBe(true);
      // derivedId: "<prefix>-" + 40 hex chars.
      expect(outcome.fixNode.nodeId).toHaveLength(44);
      expect(outcome.reviewNode.nodeId).toHaveLength(47);
      // A replay derives the SAME hashed ids (determinism = idempotency).
      const replay = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        now: T0
      });
      expect(replay.created).toBe(false);
      expect(replay.fixNode.nodeId).toBe(outcome.fixNode.nodeId);
      expect(getRunReviewExpansionState(db, runId).expansions).toHaveLength(1);
      expect(listRunNodes(db, runId)).toHaveLength(4);
    } finally {
      testDb.close();
    }
  });
});
