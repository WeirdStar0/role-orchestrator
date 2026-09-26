/**
 * A12 (M2-05): a review verdict is bound to ONE exact candidateSha.
 *  - same candidateSha, repeated query -> the recorded verdict (cache hit);
 *  - candidateSha changed -> the old pass NEVER answers for the new
 *    candidate: the query result is `invalidated`;
 *  - the verdict payload rides contracts' ReviewSchema semantics, and
 *    review.evidenceRefs may only cite artifacts the session recorded.
 */
import { describe, expect, it } from "vitest";
import { ReviewSchema } from "@role-orchestrator/contracts";
import { verifyMigrations } from "@role-orchestrator/store";
import {
  completeReview,
  getReviewRecord,
  getReviewVerdict,
  invalidateReviewSession,
  openReviewSession,
  recordValidationArtifact,
  requireReviewRecord,
  REVIEW_MIGRATIONS,
  runValidationCommand,
  toContractsReview
} from "../src/index.js";
import {
  ReviewEvidenceError,
  ReviewSessionStateError,
  UnknownReviewRecordError
} from "../src/index.js";
import {
  createMigratedFileDb,
  createReviewFixture,
  expectRejection,
  iso,
  removeTreeRobust
} from "./helpers.js";

describe("A12: verdict binding to a fixed candidateSha", () => {
  it("applies migrations 001..006 and verifies their checksums", async () => {
    const fx = await createReviewFixture("a12-migrations");
    const testDb = createMigratedFileDb("a12-migrations", fx.repoPath, fx.runId);
    try {
      const verified = verifyMigrations(testDb.db, { migrations: REVIEW_MIGRATIONS });
      expect(verified.ok).toBe(true);
      expect(verified.checked).toBe(6);
      expect(verified.versions).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("returns the recorded pass for the SAME candidateSha on repeated queries", async () => {
    const fx = await createReviewFixture("a12-hit");
    const testDb = createMigratedFileDb("a12-hit", fx.repoPath, fx.runId);
    try {
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const deps = { db: testDb.db, git: fx.git };
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(1)
      });
      const run = await runValidationCommand(session, {
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 60_000
      });
      expect(run.exitCode).toBe(0);
      expect(run.timedOut).toBe(false);

      const completed = await completeReview(deps, session, {
        review: {
          verdict: "pass",
          candidateSha,
          evidenceRefs: [run.artifactRef.id],
          findings: []
        },
        now: iso(2)
      });
      expect(completed.record.state).toBe("COMPLETED");
      expect(completed.record.verdict).toBe("pass");
      expect(completed.validationWorkspaceRemoved).toBe(true);

      const first = getReviewVerdict(testDb.db, {
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha
      });
      const second = getReviewVerdict(testDb.db, {
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha
      });
      expect(second).toEqual(first);
      expect(first.kind).toBe("valid");
      if (first.kind !== "valid") throw new Error("unreachable");
      expect(first.verdict).toBe("pass");
      expect(first.candidateSha).toBe(candidateSha);
      expect(first.evidenceRefs).toEqual([run.artifactRef.id]);
      expect(first.findings).toEqual([]);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("never returns an old pass for a NEW candidateSha (invalidated)", async () => {
    const fx = await createReviewFixture("a12-stale");
    const testDb = createMigratedFileDb("a12-stale", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidate1 = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha: candidate1,
        now: iso(1)
      });
      const run = await runValidationCommand(session, {
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 60_000
      });
      await completeReview(deps, session, {
        review: { verdict: "pass", candidateSha: candidate1, evidenceRefs: [run.artifactRef.id], findings: [] },
        now: iso(2)
      });

      // the candidate changes (repair round produces a new integration)
      const candidate2 = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 2;\n"
      });

      const stale = getReviewVerdict(testDb.db, {
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha: candidate2
      });
      expect(stale.kind).toBe("invalidated");
      if (stale.kind !== "invalidated") throw new Error("unreachable");
      expect(stale.queriedCandidateSha).toBe(candidate2);
      expect(stale.recordedCandidateShas).toEqual([candidate1]);
      // the discriminated union carries no verdict at all for a new candidate
      expect("verdict" in stale).toBe(false);

      // the pass remains valid for its OWN exact candidate only
      const own = getReviewVerdict(testDb.db, {
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha: candidate1
      });
      expect(own.kind).toBe("valid");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("answers 'none' where no review record exists", async () => {
    const fx = await createReviewFixture("a12-none");
    const testDb = createMigratedFileDb("a12-none", fx.repoPath, fx.runId);
    try {
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      expect(
        getReviewVerdict(testDb.db, { runId: fx.runId, nodeId: "never-reviewed", candidateSha }).kind
      ).toBe("none");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("rejects a verdict bound to a foreign candidateSha and keeps the session open", async () => {
    const fx = await createReviewFixture("a12-foreign-sha");
    const testDb = createMigratedFileDb("a12-foreign-sha", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidate1 = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const candidate2 = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 2;\n"
      });
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha: candidate1,
        now: iso(1)
      });
      // a contract-valid payload (contracts ReviewSchema demands >=1 evidenceRef)
      const run = await runValidationCommand(session, {
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 60_000
      });
      expect(run.exitCode).toBe(0);
      const error = await expectRejection(
        completeReview(deps, session, {
          review: {
            verdict: "pass",
            candidateSha: candidate2,
            evidenceRefs: [run.artifactRef.id],
            findings: []
          },
          now: iso(2)
        }),
        ReviewEvidenceError
      );
      expect(error.detail).toContain(candidate2);
      // the rejection must not have touched the record
      expect(getReviewRecord(testDb.db, session.reviewId)?.state).toBe("IN_PROGRESS");
      // and a correct payload completes normally
      const completed = await completeReview(deps, session, {
        review: { verdict: "pass", candidateSha: candidate1, evidenceRefs: [run.artifactRef.id], findings: [] },
        now: iso(3)
      });
      expect(completed.record.state).toBe("COMPLETED");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("rejects evidenceRefs that cite artifacts the session never recorded, and empty refs via contracts", async () => {
    const fx = await createReviewFixture("a12-ghost-ref");
    const testDb = createMigratedFileDb("a12-ghost-ref", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(1)
      });
      const error = await expectRejection(
        completeReview(deps, session, {
          review: { verdict: "pass", candidateSha, evidenceRefs: ["ghost-artifact"], findings: [] },
          now: iso(2)
        }),
        ReviewEvidenceError
      );
      expect(error.detail).toContain("ghost-artifact");
      // an empty evidenceRefs array is already refused by the REUSED contracts
      // ReviewSchema (min(1)) — the review payload has no second definition
      await expect(
        completeReview(deps, session, {
          review: { verdict: "pass", candidateSha, evidenceRefs: [], findings: [] },
          now: iso(2)
        })
      ).rejects.toThrowError(/evidenceRefs/);
      expect(getReviewRecord(testDb.db, session.reviewId)?.state).toBe("IN_PROGRESS");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("refuses a pass without machine-verified test evidence, and a pass over failing evidence", async () => {
    const fx = await createReviewFixture("a12-weak-pass");
    const testDb = createMigratedFileDb("a12-weak-pass", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(1)
      });
      // a report artifact alone is not machine-verified test evidence
      const report = recordValidationArtifact(session, {
        kind: "report",
        summary: "manual smoke note",
        exitCode: null
      });
      await expectRejection(
        completeReview(deps, session, {
          review: { verdict: "pass", candidateSha, evidenceRefs: [report.artifactRef.id], findings: [] },
          now: iso(3)
        }),
        ReviewEvidenceError
      );

      // recorded evidence that FAILED cannot back a pass
      const failedRun = await runValidationCommand(session, {
        argv: [process.execPath, "-e", "process.exit(3)"],
        timeoutMs: 60_000
      });
      expect(failedRun.exitCode).toBe(3);
      await expectRejection(
        completeReview(deps, session, {
          review: {
            verdict: "pass",
            candidateSha,
            evidenceRefs: [failedRun.artifactRef.id],
            findings: []
          },
          now: iso(4)
        }),
        ReviewEvidenceError
      );

      // …but an honest fail with findings completes, and queries answer it
      const completed = await completeReview(deps, session, {
        review: {
          verdict: "fail",
          candidateSha,
          evidenceRefs: [failedRun.artifactRef.id, report.artifactRef.id],
          findings: ["lib.ts fails its own contract test"]
        },
        now: iso(5)
      });
      expect(completed.record.verdict).toBe("fail");
      const lookup = getReviewVerdict(testDb.db, {
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha
      });
      expect(lookup.kind).toBe("valid");
      if (lookup.kind === "valid") expect(lookup.verdict).toBe("fail");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("requires at least one finding on a fail verdict", async () => {
    const fx = await createReviewFixture("a12-fail-findings");
    const testDb = createMigratedFileDb("a12-fail-findings", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(1)
      });
      const failedRun = await runValidationCommand(session, {
        argv: [process.execPath, "-e", "process.exit(3)"],
        timeoutMs: 60_000
      });
      const error = await expectRejection(
        completeReview(deps, session, {
          review: {
            verdict: "fail",
            candidateSha,
            evidenceRefs: [failedRun.artifactRef.id],
            findings: []
          },
          now: iso(2)
        }),
        ReviewEvidenceError
      );
      expect(error.detail).toContain("finding");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("refuses completing the same session twice (guarded transition)", async () => {
    const fx = await createReviewFixture("a12-twice");
    const testDb = createMigratedFileDb("a12-twice", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const session = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(1)
      });
      const run = await runValidationCommand(session, {
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 60_000
      });
      const verdict = {
        verdict: "pass" as const,
        candidateSha,
        evidenceRefs: [run.artifactRef.id],
        findings: []
      };
      await completeReview(deps, session, { review: verdict, now: iso(2) });
      const error = await expectRejection(
        completeReview(deps, session, { review: verdict, now: iso(3) }),
        ReviewSessionStateError
      );
      expect(error.actualState).toBe("COMPLETED");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("maps a COMPLETED record onto contracts' Review shape and null otherwise", async () => {
    const fx = await createReviewFixture("a12-mapping");
    const testDb = createMigratedFileDb("a12-mapping", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const candidateSha = await fx.createCandidate({
        fileName: "src/lib.ts",
        content: "export const v = 1;\n"
      });
      const open = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(1)
      });
      const openRecord = getReviewRecord(testDb.db, open.reviewId);
      if (openRecord === null) throw new Error("record missing");
      expect(toContractsReview(openRecord)).toBeNull();

      invalidateReviewSession(deps, open, { reason: "harness cancelled", now: iso(2) });
      const reopened = await openReviewSession(deps, {
        repoPath: fx.repoPath,
        worktreesRoot: fx.worktreesRoot,
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha,
        now: iso(3)
      });
      const run = await runValidationCommand(reopened, {
        argv: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 60_000
      });
      await completeReview(deps, reopened, {
        review: { verdict: "pass", candidateSha, evidenceRefs: [run.artifactRef.id], findings: [] },
        now: iso(4)
      });
      const record = getReviewRecord(testDb.db, reopened.reviewId);
      if (record === null) throw new Error("record missing");
      const review = toContractsReview(record);
      expect(review).not.toBeNull();
      // the mapped payload round-trips through contracts' ReviewSchema
      expect(() => ReviewSchema.parse(review)).not.toThrow();
      expect(review).toEqual({
        verdict: "pass",
        candidateSha,
        evidenceRefs: [run.artifactRef.id],
        findings: []
      });
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("fails loudly when asked for an unknown review record", async () => {
    const fx = await createReviewFixture("a12-unknown-record");
    const testDb = createMigratedFileDb("a12-unknown-record", fx.repoPath, fx.runId);
    try {
      expect(getReviewRecord(testDb.db, "review-does-not-exist")).toBeNull();
      const require = () => requireReviewRecord(testDb.db, "review-does-not-exist");
      expect(require).toThrow(UnknownReviewRecordError);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });
});
