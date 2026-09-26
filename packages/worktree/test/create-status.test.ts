/**
 * M2-03 create/getStatus over real temp-dir fixture repositories:
 * - create pins the worktree HEAD to the fixed base SHA and adds exactly one
 *   branch, from argv-array git calls only;
 * - getStatus reports registration, branch, HEAD and cleanliness;
 * - option-shaped / non-SHA inputs are rejected before any git call runs;
 * - worktree roots inside the user repository are refused.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { describe, expect, test } from "vitest";
import {
  BaseShaNotFoundError,
  BranchAlreadyExistsError,
  GitRunner,
  UnsafeWorktreePathError,
  WorktreeNotRegisteredError,
  createWorktree,
  getWorktreeStatus,
  branchNameFor,
  worktreePathFor,
  samePath,
  snapshotRepositoryState
} from "../src/index.js";
import {
  RecordingRunner,
  createFixtureRepo,
  expectRejection,
  removeTreeRobust
} from "./helpers.js";

describe("worktree create/getStatus", () => {
  test("creates the pinned branch and worktree, getStatus reads it back", async () => {
    const fixture = await createFixtureRepo("create-basic");
    try {
      const baseSha = await fixture.headSha();
      const worktreesRoot = path.join(fixture.scratchDir, "wt-root");
      const recording = new RecordingRunner();

      const created = await createWorktree(recording, {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-alpha",
        nodeId: "node-impl",
        attempt: 1,
        baseSha
      });

      expect(created.worktreePath).toBe(worktreePathFor(worktreesRoot, "run-alpha", "node-impl", 1));
      expect(created.branch).toBe(branchNameFor("run-alpha", "node-impl", 1));
      expect(created.worktreeHeadSha).toBe(baseSha);
      expect(existsSync(created.worktreePath)).toBe(true);

      // Exactly one new branch, with the frozen exec/<run>/<node>/<attempt> shape.
      const branches = await fixture.branchNames();
      expect(branches.sort()).toEqual([
        "exec/run-alpha/node-impl/1",
        "main"
      ]);

      const status = await getWorktreeStatus(new GitRunner(), {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath
      });
      expect(status.branch).toBe("exec/run-alpha/node-impl/1");
      expect(status.headSha).toBe(baseSha);
      expect(status.isDirty).toBe(false);
      expect(status.dirtyEntries).toEqual([]);
      expect(status.isMainWorktree).toBe(false);
      expect(status.locked).toBe(false);

      // The single mutating call is the documented argv ARRAY, with cwd
      // pinned to the user repository.
      const addCalls = recording.calls.filter((call) => call.argv[0] === "worktree");
      expect(addCalls.length).toBe(1);
      expect([...addCalls[0]!.argv]).toEqual([
        "worktree",
        "add",
        "-b",
        "exec/run-alpha/node-impl/1",
        created.worktreePath,
        baseSha
      ]);
      expect(addCalls[0]!.cwd).toBe(fixture.repoPath);
      // Read-only bookkeeping only: no checkout/reset/clean anywhere.
      const mutatingWords = new Set(["checkout", "reset", "clean", "stash"]);
      for (const call of recording.calls) {
        expect(mutatingWords.has(call.argv[0] ?? "")).toBe(false);
      }
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("refuses to overwrite an existing branch and gives the next attempt a disjoint worktree", async () => {
    const fixture = await createFixtureRepo("create-conflict");
    try {
      const baseSha = await fixture.headSha();
      const worktreesRoot = path.join(fixture.scratchDir, "wt-root");
      const git = new GitRunner();
      const first = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-b",
        nodeId: "node-x",
        attempt: 1,
        baseSha
      });

      await expectRejection(
        createWorktree(git, {
          repoPath: fixture.repoPath,
          worktreesRoot,
          runId: "run-b",
          nodeId: "node-x",
          attempt: 1,
          baseSha
        }),
        BranchAlreadyExistsError
      );
      // The refused attempt left no directory behind.
      expect(existsSync(first.worktreePath)).toBe(true);

      const second = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-b",
        nodeId: "node-x",
        attempt: 2,
        baseSha
      });
      expect(samePath(second.worktreePath, first.worktreePath)).toBe(false);
      expect(second.branch).not.toBe(first.branch);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("rejects option-shaped ids and non-SHA baselines before running any git", async () => {
    const fixture = await createFixtureRepo("create-injection");
    try {
      const baseSha = await fixture.headSha();
      const branchesBefore = await fixture.branchNames();
      const git = new GitRunner();
      const base = {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt-root")
      };

      // A branch-part that looks like an option must be schema-rejected, not
      // passed through to git as a flag.
      await expect(createWorktree(git, { ...base, runId: "-b", nodeId: "node-y", attempt: 1, baseSha }))
        .rejects.toBeInstanceOf(ZodError);
      await expect(
        createWorktree(git, { ...base, runId: "run-c", nodeId: "node-y", attempt: 1.5, baseSha })
      ).rejects.toBeInstanceOf(ZodError);
      // baseSha is pinned to full lowercase 40-hex: no "HEAD", no short SHAs,
      // no shell-flavored payloads.
      await expect(
        createWorktree(git, { ...base, runId: "run-c", nodeId: "node-y", attempt: 1, baseSha: "HEAD" })
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        createWorktree(git, {
          ...base,
          runId: "run-c",
          nodeId: "node-y",
          attempt: 1,
          baseSha: `${baseSha}; rm -rf /`
        })
      ).rejects.toBeInstanceOf(ZodError);

      expect(await fixture.branchNames()).toEqual(branchesBefore);
      expect(existsSync(path.join(fixture.scratchDir, "wt-root"))).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("refuses an unknown base SHA and a worktree root inside the user repository", async () => {
    const fixture = await createFixtureRepo("create-guards");
    try {
      const git = new GitRunner();
      const base = {
        repoPath: fixture.repoPath,
        runId: "run-d",
        nodeId: "node-z",
        attempt: 1
      };
      await expectRejection(
        createWorktree(git, {
          ...base,
          worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
          baseSha: "0".repeat(40)
        }),
        BaseShaNotFoundError
      );

      await expectRejection(
        createWorktree(git, {
          ...base,
          worktreesRoot: path.join(fixture.repoPath, "inside"),
          baseSha: await fixture.headSha()
        }),
        UnsafeWorktreePathError
      );
      // Nothing was created inside the user repository.
      expect(readdirSync(fixture.repoPath).includes("inside")).toBe(false);

      const snapshot = await snapshotRepositoryState(git, fixture.repoPath);
      expect(snapshot.isDirty).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("getStatus refuses unregistered paths", async () => {
    const fixture = await createFixtureRepo("get-status-unregistered");
    try {
      const stranger = path.join(fixture.scratchDir, "stranger-dir");
      mkdirSync(stranger, { recursive: true });
      await expectRejection(
        getWorktreeStatus(new GitRunner(), {
          repoPath: fixture.repoPath,
          worktreePath: stranger
        }),
        WorktreeNotRegisteredError
      );
      expect(existsSync(stranger)).toBe(true);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });
});
