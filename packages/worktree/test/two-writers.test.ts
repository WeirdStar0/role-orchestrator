/**
 * Two-writer isolation (M2-03 完成标准: 两 writer 不共用目录): two concurrent
 * executions get two worktrees with disjoint directories and branches, and
 * interleaved writes to both stay isolated — each worktree's status sees only
 * its own files, and a commit in one never leaks into the other.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  GitRunner,
  createWorktree,
  getWorktreeStatus,
  samePath
} from "../src/index.js";
import { createFixtureRepo, removeTreeRobust } from "./helpers.js";

describe("two-writer isolation", () => {
  test("two executions get disjoint worktrees; parallel writes do not interfere", async () => {
    const fixture = await createFixtureRepo("two-writers");
    try {
      const git = new GitRunner();
      const baseSha = await fixture.headSha();
      const worktreesRoot = path.join(fixture.scratchDir, "writers 根 目录");

      const writerA = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-par",
        nodeId: "node-writer-a",
        attempt: 1,
        baseSha
      });
      const writerB = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-par",
        nodeId: "node-writer-b",
        attempt: 1,
        baseSha
      });

      // Paths and branches are pairwise disjoint.
      expect(samePath(writerA.worktreePath, writerB.worktreePath)).toBe(false);
      expect(existsSync(writerA.worktreePath)).toBe(true);
      expect(existsSync(writerB.worktreePath)).toBe(true);
      expect(writerA.branch).toBe("exec/run-par/node-writer-a/1");
      expect(writerB.branch).toBe("exec/run-par/node-writer-b/1");
      expect(writerA.branch).not.toBe(writerB.branch);

      // Interleaved parallel writes: both writers hammer their worktrees at
      // the same time, different files, CJK + space names included.
      const writeA = (i: number): Promise<void> =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              writeFileSync(
                path.join(writerA.worktreePath, `模块 a-${i}.txt`),
                `writer A line ${i}\n`,
                "utf8"
              );
              resolve();
            } catch (error) {
              reject(error as Error);
            }
          }, i % 4);
        });
      const writeB = (i: number): Promise<void> =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              writeFileSync(
                path.join(writerB.worktreePath, `模块 b-${i}.txt`),
                `writer B line ${i}\n`,
                "utf8"
              );
              resolve();
            } catch (error) {
              reject(error as Error);
            }
          }, (i + 2) % 4);
        });
      await Promise.all([
        ...Array.from({ length: 16 }, (_, i) => writeA(i)),
        ...Array.from({ length: 16 }, (_, i) => writeB(i))
      ]);

      // Each worktree's status sees exactly its own 16 files.
      const statusA = await getWorktreeStatus(git, {
        repoPath: fixture.repoPath,
        worktreePath: writerA.worktreePath
      });
      const statusB = await getWorktreeStatus(git, {
        repoPath: fixture.repoPath,
        worktreePath: writerB.worktreePath
      });
      expect(statusA.isDirty).toBe(true);
      expect(statusA.dirtyEntries.map((entry) => entry.path).sort()).toEqual(
        Array.from({ length: 16 }, (_, i) => `模块 a-${i}.txt`).sort()
      );
      expect(statusB.isDirty).toBe(true);
      expect(statusB.dirtyEntries.map((entry) => entry.path).sort()).toEqual(
        Array.from({ length: 16 }, (_, i) => `模块 b-${i}.txt`).sort()
      );

      // No cross-contamination on disk, either direction.
      expect(existsSync(path.join(writerA.worktreePath, "模块 b-0.txt"))).toBe(false);
      expect(existsSync(path.join(writerB.worktreePath, "模块 a-0.txt"))).toBe(false);

      // A commit in writer A advances only A; writer B stays at the base.
      await git.run(writerA.worktreePath, ["add", "-A"]);
      await git.run(writerA.worktreePath, ["commit", "-m", "writer a output"]);
      const headA = (await git.run(writerA.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      const headB = (await git.run(writerB.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      expect(headA).not.toBe(baseSha);
      expect(headB).toBe(baseSha);
      const statusAAfterCommit = await getWorktreeStatus(git, {
        repoPath: fixture.repoPath,
        worktreePath: writerA.worktreePath
      });
      expect(statusAAfterCommit.isDirty).toBe(false);

      // Writer B's files are intact and readable after A's commit.
      expect(readFileSync(path.join(writerB.worktreePath, "模块 b-7.txt"), "utf8")).toBe(
        "writer B line 7\n"
      );
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });
});
