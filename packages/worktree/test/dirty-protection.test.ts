/**
 * A11 — the user repository has dirty modifications while a worktree is
 * created. The lifecycle must leave them byte-identical and mtime-identical,
 * must not move HEAD, must add exactly one branch and nothing else, and the
 * new worktree must contain the pinned base SHA WITHOUT the user's uncommitted
 * changes (docs/GIT_AND_WORKSPACES.md: 本次任务基于选定 commit，不包含未提交修改;
 * 用户已有未提交修改不被 stash/reset/clean).
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  GitRunner,
  createWorktree,
  getWorktreeStatus,
  snapshotRepositoryState
} from "../src/index.js";
import { createFixtureRepo, removeTreeRobust, walkWorkingTree } from "./helpers.js";

describe("A11 dirty user repository protection", () => {
  test("create leaves dirty content, mtimes, HEAD and branch set untouched", async () => {
    const fixture = await createFixtureRepo("a11-dirty");
    try {
      const git = new GitRunner();
      const headBefore = await fixture.headSha();
      const branchesBefore = await fixture.branchNames();

      // Dirty state: modified tracked file + untracked CJK/space file + a
      // STAGED new file (index dirty too).
      const trackedPath = path.join(fixture.repoPath, "seed.txt");
      writeFileSync(trackedPath, "seed content v1\nuser local edit 用户的本地修改\n", "utf8");
      const untrackedPath = path.join(fixture.repoPath, "未跟踪 笔记.txt");
      writeFileSync(untrackedPath, "untracked idea 未经跟踪的想法\n", "utf8");
      const stagedPath = path.join(fixture.repoPath, "staged 本地 文件.txt");
      writeFileSync(stagedPath, "staged locally\n", "utf8");
      await git.run(fixture.repoPath, ["add", "staged 本地 文件.txt"]);

      const beforeFiles = walkWorkingTree(fixture.repoPath);
      const beforeMtimes = {
        tracked: statSync(trackedPath).mtimeMs,
        untracked: statSync(untrackedPath).mtimeMs,
        staged: statSync(stagedPath).mtimeMs
      };
      const snapshotBefore = await snapshotRepositoryState(git, fixture.repoPath);
      expect(snapshotBefore.isDirty).toBe(true);

      const baseSha = headBefore;
      const created = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt 根"),
        runId: "run-dirty",
        nodeId: "node-w",
        attempt: 1,
        baseSha
      });
      // The returned snapshot is the pre-mutation evidence (A11 artifact).
      expect(created.userRepoSnapshot.rawStatusSha256).toBe(snapshotBefore.rawStatusSha256);

      // 1. Content AND mtime semantics of every dirty file are unchanged.
      const afterMtimes = {
        tracked: statSync(trackedPath).mtimeMs,
        untracked: statSync(untrackedPath).mtimeMs,
        staged: statSync(stagedPath).mtimeMs
      };
      expect(afterMtimes).toEqual(beforeMtimes);
      expect(readFileSync(trackedPath, "utf8")).toBe("seed content v1\nuser local edit 用户的本地修改\n");
      expect(readFileSync(untrackedPath, "utf8")).toBe("untracked idea 未经跟踪的想法\n");
      expect(readFileSync(stagedPath, "utf8")).toBe("staged locally\n");

      // 2. Working-tree walk: identical file set, contents and mtimes.
      const afterFiles = walkWorkingTree(fixture.repoPath);
      expect(afterFiles.size).toBe(beforeFiles.size);
      for (const [relativePath, evidence] of beforeFiles) {
        const after = afterFiles.get(relativePath);
        expect(after, `missing file after create: ${relativePath}`).toBeDefined();
        expect(after?.contentSha256).toBe(evidence.contentSha256);
        expect(after?.mtimeMs).toBe(evidence.mtimeMs);
      }

      // 3. HEAD did not move; dirty-state fingerprint is byte-identical.
      const snapshotAfter = await snapshotRepositoryState(git, fixture.repoPath);
      expect(snapshotAfter.headSha).toBe(headBefore);
      expect(snapshotAfter.branch).toBe("main");
      expect(snapshotAfter.rawStatusSha256).toBe(snapshotBefore.rawStatusSha256);
      expect(snapshotAfter.dirtyEntries).toEqual(snapshotBefore.dirtyEntries);

      // 4. Branch set grew by exactly the one exec branch.
      const branchesAfter = await fixture.branchNames();
      expect(branchesAfter.sort()).toEqual([...branchesBefore, "exec/run-dirty/node-w/1"].sort());

      // 5. The worktree is at the pinned base WITHOUT the user's changes.
      const wtSeed = path.join(created.worktreePath, "seed.txt");
      expect(readFileSync(wtSeed, "utf8")).toBe("seed content v1\n");
      expect(existsSync(path.join(created.worktreePath, "未跟踪 笔记.txt"))).toBe(false);
      expect(existsSync(path.join(created.worktreePath, "staged 本地 文件.txt"))).toBe(false);
      const wtStatus = await getWorktreeStatus(git, {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath
      });
      expect(wtStatus.headSha).toBe(baseSha);
      expect(wtStatus.isDirty).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });
});
