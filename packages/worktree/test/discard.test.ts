/**
 * A40 — no automatic cleanup. Default discard refuses worktrees with
 * uncommitted changes; only an explicit force flag removes them. Unregistered
 * paths and the repository root are never touched. And on EVERY failure path
 * (spawn failure, injected mid-flow error after the worktree exists) the
 * worktree is RETAINED for manual handling — nothing in this package cleans
 * up as a side effect of failing.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DiscardBlockedByUncommittedChangesError,
  GitCommandError,
  GitRunner,
  UnsafeWorktreePathError,
  WorktreeDirectoryMissingError,
  WorktreeNotRegisteredError,
  WorktreeVerificationError,
  createWorktree,
  discardWorktree,
  getWorktreeStatus,
  worktreePathFor
} from "../src/index.js";
import {
  InjectedFailureRunner,
  SpawnFailureRunner,
  createFixtureRepo,
  expectRejection,
  removeTreeRobust
} from "./helpers.js";

describe("A40 discard and failure retention", () => {
  test("clean worktree: default discard removes it and keeps the branch", async () => {
    const fixture = await createFixtureRepo("discard-clean");
    try {
      const git = new GitRunner();
      const created = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
        runId: "run-del",
        nodeId: "node-clean",
        attempt: 1,
        baseSha: await fixture.headSha()
      });

      const result = await discardWorktree(git, {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath
      });
      expect(result.removed).toBe(true);
      expect(result.forced).toBe(false);
      expect(result.hadUncommittedChanges).toBe(false);
      expect(result.retainedBranch).toBe("exec/run-del/node-clean/1");

      expect(existsSync(created.worktreePath)).toBe(false);
      await expectRejection(
        getWorktreeStatus(git, { repoPath: fixture.repoPath, worktreePath: created.worktreePath }),
        WorktreeNotRegisteredError
      );
      // Traceability: the exec branch survives the worktree.
      expect(await fixture.branchNames()).toContain("exec/run-del/node-clean/1");
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("dirty worktree: default discard REFUSES; only explicit force removes", async () => {
    const fixture = await createFixtureRepo("discard-dirty");
    try {
      const git = new GitRunner();
      const created = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
        runId: "run-dirty",
        nodeId: "node-undelivered",
        attempt: 1,
        baseSha: await fixture.headSha()
      });
      writeFileSync(path.join(created.worktreePath, "未交付 改动.txt"), "undelivered work\n", "utf8");

      // Default: refuse, and leave the worktree exactly as it was.
      const blocked = await expectRejection(
        discardWorktree(git, {
          repoPath: fixture.repoPath,
          worktreePath: created.worktreePath
        }),
        DiscardBlockedByUncommittedChangesError
      );
      expect(blocked.dirtyPaths).toEqual(["未交付 改动.txt"]);
      expect(existsSync(created.worktreePath)).toBe(true);
      const stillThere = await getWorktreeStatus(git, {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath
      });
      expect(stillThere.isDirty).toBe(true);

      // Explicit force is the only way through the gate.
      const forced = await discardWorktree(git, {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath,
        force: true
      });
      expect(forced.removed).toBe(true);
      expect(forced.forced).toBe(true);
      expect(forced.hadUncommittedChanges).toBe(true);
      expect(existsSync(created.worktreePath)).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("never touches unregistered directories or the repository root", async () => {
    const fixture = await createFixtureRepo("discard-refusals");
    try {
      const git = new GitRunner();
      const stranger = path.join(fixture.scratchDir, "stranger 目录");
      mkdirSync(stranger, { recursive: true });
      writeFileSync(path.join(stranger, "precious.txt"), "not a worktree\n", "utf8");

      await expectRejection(
        discardWorktree(git, { repoPath: fixture.repoPath, worktreePath: stranger }),
        WorktreeNotRegisteredError
      );
      expect(existsSync(path.join(stranger, "precious.txt"))).toBe(true);

      await expectRejection(
        discardWorktree(git, { repoPath: fixture.repoPath, worktreePath: fixture.repoPath }),
        UnsafeWorktreePathError
      );
      expect(existsSync(path.join(fixture.repoPath, "seed.txt"))).toBe(true);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("registered worktree whose directory vanished is retained for manual handling", async () => {
    const fixture = await createFixtureRepo("discard-missing");
    try {
      const git = new GitRunner();
      const created = await createWorktree(git, {
        repoPath: fixture.repoPath,
        worktreesRoot: path.join(fixture.scratchDir, "wt-root"),
        runId: "run-gone",
        nodeId: "node-vanished",
        attempt: 1,
        baseSha: await fixture.headSha()
      });
      // External loss (simulated): the directory disappears without git knowing.
      removeTreeRobust(created.worktreePath);
      expect(existsSync(created.worktreePath)).toBe(false);

      await expectRejection(
        discardWorktree(git, {
          repoPath: fixture.repoPath,
          worktreePath: created.worktreePath,
          force: true
        }),
        WorktreeDirectoryMissingError
      );
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("mid-flow failure AFTER the worktree exists retains it (no compensating delete)", async () => {
    const fixture = await createFixtureRepo("retain-verification");
    try {
      const realGit = new GitRunner();
      const worktreesRoot = path.join(fixture.scratchDir, "wt-root");
      const baseSha = await fixture.headSha();
      const input = {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-fault",
        nodeId: "node-midway",
        attempt: 1,
        baseSha
      } as const;

      // The verification call (`rev-parse HEAD` inside the new worktree)
      // blows up after `git worktree add` already succeeded.
      const expectedWorktreePath = worktreePathFor(worktreesRoot, "run-fault", "node-midway", 1);
      const faulty = new InjectedFailureRunner(
        (cwd, argv) =>
          path.resolve(cwd) === path.resolve(expectedWorktreePath) &&
          argv[0] === "rev-parse" &&
          argv[1] === "HEAD"
      );
      const verificationError = await expectRejection(
        createWorktree(faulty, input),
        WorktreeVerificationError
      );
      expect(verificationError.cause).toBeInstanceOf(Error);

      // A40 core: the created worktree is still on disk and still registered.
      const retained = await getWorktreeStatus(realGit, {
        repoPath: fixture.repoPath,
        worktreePath: expectedWorktreePath
      });
      expect(retained.headSha).toBe(baseSha);
      expect(retained.isDirty).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("spawn failure retains nothing and reports a typed evidence-carrying error", async () => {
    const fixture = await createFixtureRepo("retain-spawn-failure");
    try {
      const branchesBefore = await fixture.branchNames();
      const headBefore = await fixture.headSha();
      const worktreesRoot = path.join(fixture.scratchDir, "wt-root");

      const spawnError = await expectRejection(
        createWorktree(new SpawnFailureRunner(), {
          repoPath: fixture.repoPath,
          worktreesRoot,
          runId: "run-spawn",
          nodeId: "node-spawn",
          attempt: 1,
          baseSha: headBefore
        }),
        GitCommandError
      );
      expect(spawnError.exitCode).toBeNull();
      expect(spawnError.argv[0]).toBe("rev-parse");

      expect(existsSync(worktreesRoot)).toBe(false);
      expect(await fixture.branchNames()).toEqual(branchesBefore);
      expect(await fixture.headSha()).toBe(headBefore);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });
});
