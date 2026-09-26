/**
 * Fail-closed git gate: a missing, broken or too-old git refuses EVERY
 * lifecycle operation before anything is read, created or removed —
 * including discard (a broken git must never turn into an accidental
 * cleanup). Also pins the GitCommandError evidence fields.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  GitCommandError,
  GitRunner,
  GitUnavailableError,
  NotGitRepositoryError,
  createWorktree,
  discardWorktree,
  getWorktreeStatus
} from "../src/index.js";
import {
  FixedVersionRunner,
  createFixtureRepo,
  expectRejection,
  removeTreeRobust
} from "./helpers.js";

describe("fail-closed git availability gate", () => {
  test("missing git binary: createWorktree refuses before creating anything", async () => {
    const fixture = await createFixtureRepo("gate-missing");
    try {
      const worktreesRoot = path.join(fixture.scratchDir, "wt-root");
      const brokenGit = new GitRunner({ gitPath: path.join(fixture.scratchDir, "kein-git", "git.exe") });
      const error = await expectRejection(
        createWorktree(brokenGit, {
          repoPath: fixture.repoPath,
          worktreesRoot,
          runId: "run-gate",
          nodeId: "node-gate",
          attempt: 1,
          baseSha: await fixture.headSha()
        }),
        GitUnavailableError
      );
      expect(error.gitPath).toContain("kein-git");
      // Nothing happened: not even the engine-managed root exists yet.
      expect(existsSync(worktreesRoot)).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("unparseable and pre-2.x version output are both refused", async () => {
    const fixture = await createFixtureRepo("gate-version");
    try {
      const input = {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
        runId: "run-gate",
        nodeId: "node-version",
        attempt: 1,
        baseSha: await fixture.headSha()
      } as const;

      const garbage = await expectRejection(
        createWorktree(new FixedVersionRunner("git gibberish 9.9 nonsense"), input),
        GitUnavailableError
      );
      expect(garbage.detail).toContain("not a parseable git version");

      await expectRejection(
        createWorktree(new FixedVersionRunner("git version 1.9.4"), input),
        GitUnavailableError
      );
      expect(existsSync(path.join(fixture.scratchDir, "wt-root"))).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("discard and getStatus are fail-closed too — a broken git never becomes cleanup", async () => {
    const fixture = await createFixtureRepo("gate-discard");
    try {
      const realGit = new GitRunner();
      const created = await createWorktree(realGit, {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
        runId: "run-gate",
        nodeId: "node-discard",
        attempt: 1,
        baseSha: await fixture.headSha()
      });

      const oldGit = new FixedVersionRunner("git version 1.8.0");
      await expectRejection(
        discardWorktree(oldGit, { repoPath: fixture.repoPath, worktreePath: created.worktreePath }),
        GitUnavailableError
      );
      await expectRejection(
        getWorktreeStatus(oldGit, { repoPath: fixture.repoPath, worktreePath: created.worktreePath }),
        GitUnavailableError
      );
      // The worktree is STILL there, registered and intact.
      expect(existsSync(created.worktreePath)).toBe(true);
      const status = await getWorktreeStatus(realGit, {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath
      });
      expect(status.headSha).toBe(created.worktreeHeadSha);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("GitCommandError carries argv/cwd/exitCode/stderr evidence; non-repo paths are refused", async () => {
    const fixture = await createFixtureRepo("gate-command-error");
    try {
      const git = new GitRunner();
      const error = await expectRejection(
        git.run(fixture.repoPath, ["rev-parse", "--verify", "definitely-not-a-ref"]),
        GitCommandError
      );
      expect(error.exitCode).toBe(128);
      expect(error.argv).toEqual(["rev-parse", "--verify", "definitely-not-a-ref"]);
      expect(error.cwd).toBe(fixture.repoPath);
      expect(error.stderrTail.length).toBeGreaterThan(0);

      // A plain directory without .git is not a usable repository root.
      const plainDir = path.join(fixture.scratchDir, "plain");
      mkdirSync(plainDir, { recursive: true });
      await expectRejection(
        createWorktree(git, {
          repoPath: plainDir,
          worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
          runId: "run-gate",
          nodeId: "node-plain",
          attempt: 1,
          baseSha: "0".repeat(40)
        }),
        NotGitRepositoryError
      );
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });
});
