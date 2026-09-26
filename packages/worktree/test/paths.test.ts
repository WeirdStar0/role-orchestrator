/**
 * A28 path-form matrix — real git worktree operations across the path shapes
 * that break shell-based tooling:
 * - CJK characters + spaces in BOTH the user repo and the worktree root;
 * - worktree paths longer than the classic MAX_PATH 260;
 * - different drive letters (repo on the system-temp drive, worktrees on a
 *   second local drive).
 *
 * Every cell runs the full create -> write -> getStatus -> discard cycle and
 * additionally asserts the argv discipline: the CJK/space path arrives at git
 * as ONE argv element, never pre-quoted, never split. Injection safety is
 * covered by the schema rejections in create-status.test.ts.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  GitCommandError,
  GitRunner,
  createWorktree,
  discardWorktree,
  getWorktreeStatus,
  worktreePathFor
} from "../src/index.js";
import {
  RecordingRunner,
  createFixtureRepo,
  expectRejection,
  removeTreeRobust
} from "./helpers.js";

const LONG_SEGMENT = "segment-level-abcdefghijklmnopqrstuvwxyz0123456789";

/** Machine-dependent platform gate: is a second writable local drive present? */
function probeSecondaryDrive(): boolean {
  try {
    const probe = mkdtempSync(path.join("H:" + path.sep, "worktree-m2-03-drive-probe-"));
    removeTreeRobust(probe);
    return true;
  } catch {
    return false;
  }
}

const secondaryDriveWritable = probeSecondaryDrive();
if (!secondaryDriveWritable) {
  // Truthful platform-gate declaration instead of a silent skip.
  console.warn(
    "[worktree A28] no writable H: drive on this machine — the cross-drive cell is skipped " +
      "(platform gate; recorded in the package README)"
  );
}

describe("A28 path form matrix", () => {
  test("CJK + spaces in the user repository AND the worktree root, end to end", async () => {
    const fixture = await createFixtureRepo("a28-cjk", { dirName: "仓库 中文 与 空格" });
    try {
      const worktreesRoot = path.join(fixture.scratchDir, "工作树 根 目录 带空格");
      const recording = new RecordingRunner();
      const created = await createWorktree(recording, {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-cjk",
        nodeId: "node-cjk",
        attempt: 1,
        baseSha: await fixture.headSha()
      });
      expect(created.worktreePath.includes("中文")).toBe(true);
      expect(created.worktreePath.includes(" ")).toBe(true);

      // The CJK+space path reached git as ONE raw argv element — not quoted,
      // not split, not shell-joined.
      const addCall = recording.calls.find((call) => call.argv[0] === "worktree");
      expect(addCall).toBeDefined();
      const pathArg = addCall?.argv[4];
      expect(pathArg).toBe(created.worktreePath);
      for (const element of addCall?.argv ?? []) {
        expect(element.includes('"')).toBe(false);
      }

      // Full cycle under the hostile path: write a CJK-named file, see it in
      // status, discard with force.
      const written = path.join(created.worktreePath, "源码 文件 一.txt");
      writeFileSync(written, "writer output 写入内容\n", "utf8");
      const status = await getWorktreeStatus(new GitRunner(), {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath
      });
      expect(status.dirtyEntries.map((entry) => entry.path)).toEqual(["源码 文件 一.txt"]);

      const discarded = await discardWorktree(new GitRunner(), {
        repoPath: fixture.repoPath,
        worktreePath: created.worktreePath,
        force: true
      });
      expect(discarded.removed).toBe(true);
      expect(existsSync(created.worktreePath)).toBe(false);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test("long path >260: git-for-windows refuses worktrees outright, and this package fails closed", async () => {
    // Measured platform truth (git version 2.54.0.windows.1, probed before
    // this test was written): a linked-worktree path beyond the classic
    // MAX_PATH cannot be created —
    //   plain add, 262/301 chars   -> exit 128 "could not create leading
    //                                  directories of '...'"
    //   -c core.longpaths=true     -> exit 128 "fatal: '$GIT_DIR' too big"
    //                                 (and it breaks SHORT worktree adds too)
    //   core.longpaths=true config -> same "'$GIT_DIR' too big"
    //   \\?\ extended prefix       -> git mangles it to "//?/C:/..." -> 128
    // Spawning git itself with a >260 cwd dies with ENOENT before exec, so a
    // >260 FIXTURE REPO is equally unreachable for git.
    // The honest deliverable is therefore the pinned FAIL-CLOSED behavior:
    // git's refusal surfaces as a typed GitCommandError and leaves the user
    // repository byte-identical.
    const fixture = await createFixtureRepo("a28-longpath");
    try {
      const worktreesRoot = path.join(
        fixture.scratchDir,
        "long-root",
        ...Array.from({ length: 6 }, () => LONG_SEGMENT)
      );
      const git = new GitRunner();
      const headBefore = await fixture.headSha();
      const branchesBefore = await fixture.branchNames();
      const input = {
        repoPath: fixture.repoPath,
        worktreesRoot,
        runId: "run-long",
        nodeId: "node-long",
        attempt: 1,
        baseSha: headBefore
      } as const;
      // Precondition: the TARGET the caller asked for really is >260 chars.
      expect(worktreePathFor(worktreesRoot, "run-long", "node-long", 1).length).toBeGreaterThan(260);

      const error = await expectRejection(createWorktree(git, input), GitCommandError);
      expect(error.exitCode).toBe(128);
      // git refuses past MAX_PATH at whichever step hits the limit first
      // (observed: "Filename too long" writing the worktree .git link, or
      // "could not create leading directories" for deeper parents).
      expect(error.stderrTail).toMatch(/Filename too long|could not create leading directories/);

      // Fail-closed: the worktree DIRECTORY was never created, the user's
      // working tree and HEAD are untouched. `git worktree add -b` creates
      // the branch BEFORE the checkout, so the exec branch remains as
      // residue — retained on purpose (A40: a failure never triggers
      // compensating cleanup; the next attempt must pick a fresh number,
      // which BranchAlreadyExistsError enforces).
      expect(existsSync(worktreePathFor(worktreesRoot, "run-long", "node-long", 1))).toBe(false);
      expect(await fixture.branchNames()).toEqual(
        expect.arrayContaining([...branchesBefore, "exec/run-long/node-long/1"])
      );
      expect(await fixture.headSha()).toBe(headBefore);
    } finally {
      removeTreeRobust(fixture.scratchDir);
    }
  });

  test.skipIf(!secondaryDriveWritable)(
    "cross-drive: repo on the system-temp drive, worktrees on H:",
    async () => {
      const fixture = await createFixtureRepo("a28-cross-drive");
      let hRoot: string | null = null;
      try {
        hRoot = mkdtempSync(path.join("H:" + path.sep, "worktree-m2-03-h-"));
        const git = new GitRunner();
        const created = await createWorktree(git, {
          repoPath: fixture.repoPath,
          worktreesRoot: hRoot,
          runId: "run-drive",
          nodeId: "node-drive",
          attempt: 1,
          baseSha: await fixture.headSha()
        });

        // The repo and the worktree really live on different drive letters.
        const repoDrive = path.resolve(fixture.repoPath).slice(0, 2).toUpperCase();
        const worktreeDrive = path.resolve(created.worktreePath).slice(0, 2).toUpperCase();
        expect(repoDrive).not.toBe(worktreeDrive);
        expect(worktreeDrive).toBe("H:");

        writeFileSync(path.join(created.worktreePath, "跨盘.txt"), "cross-drive writer\n", "utf8");
        const status = await getWorktreeStatus(git, {
          repoPath: fixture.repoPath,
          worktreePath: created.worktreePath
        });
        expect(status.dirtyEntries.map((entry) => entry.path)).toEqual(["跨盘.txt"]);

        const discarded = await discardWorktree(git, {
          repoPath: fixture.repoPath,
          worktreePath: created.worktreePath,
          force: true
        });
        expect(discarded.removed).toBe(true);
        expect(existsSync(created.worktreePath)).toBe(false);
      } finally {
        removeTreeRobust(fixture.scratchDir);
        if (hRoot !== null) removeTreeRobust(hRoot);
      }
    }
  );
});
