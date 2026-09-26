/**
 * A13 (M2-05): the reviewer runs tests in a one-shot validation workspace —
 * temp artifacts are writable THERE, the reviewed source must not change.
 * Any drift of the reviewed baseline (file added/modified/deleted, HEAD
 * moved) makes the review INVALID with a typed error.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsidePath } from "@role-orchestrator/worktree";
import {
  assertBaselineInvariance,
  completeReview,
  getReviewRecord,
  getReviewVerdict,
  invalidateReviewSession,
  openReviewSession,
  ReviewBaselineDriftError,
  ReviewCandidateMissingError,
  ReviewSessionStateError,
  ReviewWorkspaceError,
  runValidationCommand
} from "../src/index.js";
import {
  createMigratedFileDb,
  createReviewFixture,
  expectRejection,
  iso,
  removeTreeRobust
} from "./helpers.js";

describe("A13: validation workspace and baseline invariance", () => {
  it("opens a detached baseline at the exact candidateSha with a faithful one-shot workspace copy", async () => {
    const fx = await createReviewFixture("a13-open");
    const testDb = createMigratedFileDb("a13-open", fx.repoPath, fx.runId);
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

      // HEAD of the baseline is exactly the pinned candidate…
      const head = await fx.git.run(session.baselineWorktreePath, ["rev-parse", "HEAD"]);
      expect(head.stdout.trim()).toBe(candidateSha);
      // …and DETACHED: nothing for a later writer to advance
      const symbolicRef = await fx.git.tryRun(session.baselineWorktreePath, ["symbolic-ref", "-q", "HEAD"]);
      expect(symbolicRef.exitCode).not.toBe(0);

      // the workspace copy is outside the baseline and byte-faithful
      expect(isInsidePath(session.validationWorkspacePath, session.baselineWorktreePath)).toBe(false);
      expect(isInsidePath(session.validationTempRoot, os.tmpdir())).toBe(true);
      expect(fx.readFile(path.join(session.validationWorkspacePath, "src", "lib.ts"))).toBe(
        "export const v = 1;\n"
      );
      expect(session.baseline.fileCount).toBe(2); // src/app.ts + src/lib.ts
      expect(session.baseline.files.map((file) => file.path)).toEqual(["src/app.ts", "src/lib.ts"]);

      const record = getReviewRecord(testDb.db, session.reviewId);
      expect(record?.state).toBe("IN_PROGRESS");
      expect(record?.baselineFileCount).toBe(2);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("keeps the baseline invariant while test artifacts pile up in the workspace", async () => {
    const fx = await createReviewFixture("a13-clean");
    const testDb = createMigratedFileDb("a13-clean", fx.repoPath, fx.runId);
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

      // a test writes its own artifacts into the WORKSPACE…
      mkdirSync(path.join(session.validationWorkspacePath, "coverage"), { recursive: true });
      writeFileSync(
        path.join(session.validationWorkspacePath, "coverage", "lcov.info"),
        "synthetic coverage report\n",
        "utf8"
      );
      // …and a validation command does the same, from inside the copy
      const run = await runValidationCommand(session, {
        argv: [
          process.execPath,
          "-e",
          "const fs = require('node:fs');" +
            "fs.mkdirSync('dist', { recursive: true });" +
            "fs.writeFileSync('dist/bundle.js', 'synthetic build output');"
        ],
        timeoutMs: 60_000
      });
      expect(run.exitCode).toBe(0);
      expect(existsSync(path.join(session.validationWorkspacePath, "dist", "bundle.js"))).toBe(true);

      // …while the reviewed source stays untouched and provably so
      const report = await assertBaselineInvariance(deps, session);
      expect(report.checkedFiles).toBe(session.baseline.fileCount);
      expect(report.digest).toBe(session.baseline.digest);
      expect(existsSync(path.join(session.baselineWorktreePath, "coverage"))).toBe(false);
      expect(existsSync(path.join(session.baselineWorktreePath, "dist"))).toBe(false);

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
      // the one-shot workspace is disposed with the session
      expect(completed.validationWorkspaceRemoved).toBe(true);
      expect(existsSync(session.validationTempRoot)).toBe(false);
      // …and the baseline worktree is KEPT as review evidence (A40)
      expect(existsSync(session.baselineWorktreePath)).toBe(true);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("invalidates the review when a file is ADDED to the reviewed baseline", async () => {
    const fx = await createReviewFixture("a13-added");
    const testDb = createMigratedFileDb("a13-added", fx.repoPath, fx.runId);
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

      // a runaway test "escapes" into the reviewed source tree
      writeFileSync(path.join(session.baselineWorktreePath, "escape.txt"), "tampered\n", "utf8");

      const error = await expectRejection(
        completeReview(deps, session, {
          review: { verdict: "pass", candidateSha, evidenceRefs: [run.artifactRef.id], findings: [] },
          now: iso(2)
        }),
        ReviewBaselineDriftError
      );
      expect(error.phase).toBe("final");
      expect(error.drifts).toEqual([{ path: "escape.txt", kind: "added" }]);
      // the drift persisted INVALID before the error surfaced…
      expect(getReviewRecord(testDb.db, session.reviewId)?.state).toBe("INVALID");
      // …so no verdict answers, not even for the original candidateSha
      const lookup = getReviewVerdict(testDb.db, {
        runId: fx.runId,
        nodeId: "review-node",
        candidateSha
      });
      expect(lookup.kind).toBe("invalidated");
      // the one-shot workspace is disposed with the dead session
      expect(existsSync(session.validationTempRoot)).toBe(false);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("invalidates the review when a reviewed file is MODIFIED", async () => {
    const fx = await createReviewFixture("a13-modified");
    const testDb = createMigratedFileDb("a13-modified", fx.repoPath, fx.runId);
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
      writeFileSync(
        path.join(session.baselineWorktreePath, "src", "lib.ts"),
        "export const v = 999;\n",
        "utf8"
      );
      const error = await expectRejection(
        completeReview(deps, session, {
          review: { verdict: "pass", candidateSha, evidenceRefs: [run.artifactRef.id], findings: [] },
          now: iso(2)
        }),
        ReviewBaselineDriftError
      );
      expect(error.drifts).toEqual([{ path: "src/lib.ts", kind: "modified" }]);
      expect(getReviewRecord(testDb.db, session.reviewId)?.state).toBe("INVALID");
      expect(existsSync(session.validationTempRoot)).toBe(false);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("invalidates the review when a reviewed file is DELETED", async () => {
    const fx = await createReviewFixture("a13-deleted");
    const testDb = createMigratedFileDb("a13-deleted", fx.repoPath, fx.runId);
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
      unlinkSync(path.join(session.baselineWorktreePath, "src", "lib.ts"));
      const error = await expectRejection(
        completeReview(deps, session, {
          review: { verdict: "pass", candidateSha, evidenceRefs: [run.artifactRef.id], findings: [] },
          now: iso(2)
        }),
        ReviewBaselineDriftError
      );
      expect(error.drifts).toEqual([{ path: "src/lib.ts", kind: "deleted" }]);
      expect(getReviewRecord(testDb.db, session.reviewId)?.state).toBe("INVALID");
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("refuses to open a session on a candidateSha that does not resolve", async () => {
    const fx = await createReviewFixture("a13-missing-sha");
    const testDb = createMigratedFileDb("a13-missing-sha", fx.repoPath, fx.runId);
    try {
      const deps = { db: testDb.db, git: fx.git };
      const ghost = "1".repeat(40);
      await expectRejection(
        openReviewSession(deps, {
          repoPath: fx.repoPath,
          worktreesRoot: fx.worktreesRoot,
          runId: fx.runId,
          nodeId: "review-node",
          candidateSha: ghost,
          now: iso(1)
        }),
        ReviewCandidateMissingError
      );
      // nothing was created: no record, no baseline directory
      expect(existsSync(path.join(fx.worktreesRoot, "_review", fx.runId, "review-node"))).toBe(false);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("refuses a validation command that cannot be spawned and records no evidence for it", async () => {
    const fx = await createReviewFixture("a13-spawn-fail");
    const testDb = createMigratedFileDb("a13-spawn-fail", fx.repoPath, fx.runId);
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
      const error = await expectRejection(
        runValidationCommand(session, {
          argv: ["definitely-not-a-real-binary-xyz", "--version"],
          timeoutMs: 60_000
        }),
        ReviewWorkspaceError
      );
      expect(error.detail).toContain("definitely-not-a-real-binary-xyz");
      expect(session.artifacts).toHaveLength(0);
      await invalidateReviewSession(deps, session, { reason: "harness failure", now: iso(2) });
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });

  it("refuses to invalidate a session twice (guarded transition)", async () => {
    const fx = await createReviewFixture("a13-twice-invalid");
    const testDb = createMigratedFileDb("a13-twice-invalid", fx.repoPath, fx.runId);
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
      const first = invalidateReviewSession(deps, session, { reason: "cancelled", now: iso(2) });
      expect(first.record.state).toBe("INVALID");
      expect(first.validationWorkspaceRemoved).toBe(true);
      const second = () =>
        invalidateReviewSession(deps, session, { reason: "again", now: iso(3) });
      expect(second).toThrow(ReviewSessionStateError);
      expect(second).toThrow(/INVALID, expected IN_PROGRESS/);
    } finally {
      testDb.close();
      removeTreeRobust(fx.scratchDir);
    }
  });
});
