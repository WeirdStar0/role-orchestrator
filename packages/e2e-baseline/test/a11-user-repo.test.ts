/**
 * ACCEPTANCE A11 — 用户原仓库有 dirty 修改：原修改与分支保持不变。
 *
 * The baseline's fixture repo carries one uncommitted user file
 * (`notes/scratch.txt`) plus the committed seed. Asserted after the WHOLE
 * run: HEAD and branch unchanged (main still exactly the seed commit), the
 * status snapshot byte-fingerprint identical to the pre-run snapshot taken by
 * the FIRST worktree creation (and by every subsequent one), the dirty file
 * and seed files byte-identical, and every git worktree git knows about lives
 * OUTSIDE the user repo in the engine-managed worktrees root.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorktreeListPorcelain } from "@role-orchestrator/worktree";
import {
  DIRTY_FILE_CONTENT,
  DIRTY_FILE_REL,
  FIXTURE_SEED_FILES
} from "../src/index.js";
import { readWorldFile, runFullBaseline, type BaselineHarness } from "./helpers.js";

let harness: BaselineHarness | undefined;

beforeAll(async () => {
  harness = await runFullBaseline("a11");
});

afterAll(() => {
  harness?.cleanup();
});

function h(): BaselineHarness {
  if (harness === undefined) throw new Error("baseline harness not initialised");
  return harness;
}

describe("A11: 用户原仓库全程不变", () => {
  it("HEAD 与分支保持基线提交，main 上没有新增提交", async () => {
    const snapshot = await h().snapshotUserRepo();
    expect(snapshot.branch).toBe("main");
    expect(snapshot.headSha).toBe(h().world.baseSha);
    expect(await h().commitCount("main")).toBe(1);
  });

  it("状态指纹与每次建 worktree 前的快照逐字节一致", async () => {
    const final = await h().snapshotUserRepo();
    const first = h().result.firstUserRepoSnapshot;
    expect(first.headSha).toBe(h().world.baseSha);
    expect(first.branch).toBe("main");
    // Byte-level: the raw `status --porcelain=v1 -z --untracked-files=all`
    // output hashes identically before every worktree creation and after the
    // whole run.
    expect(final.rawStatusSha256).toBe(first.rawStatusSha256);
    expect(h().result.worktreeFingerprints.length).toBeGreaterThanOrEqual(7);
    expect(new Set(h().result.worktreeFingerprints)).toEqual(new Set([final.rawStatusSha256]));
    // And the dirty entry itself is exactly the user's file.
    expect(final.dirtyEntries.map((entry) => entry.path)).toEqual([DIRTY_FILE_REL]);
    expect(final.isDirty).toBe(true);
  });

  it("用户未提交修改与种子文件逐字节保留", () => {
    expect(readWorldFile(h().world, DIRTY_FILE_REL)).toBe(DIRTY_FILE_CONTENT);
    for (const [relativePath, content] of Object.entries(FIXTURE_SEED_FILES)) {
      expect(readWorldFile(h().world, relativePath)).toBe(content);
    }
  });

  it("所有 git worktree 都在托管根内，用户仓库目录里没有任何 worktree", async () => {
    const listing = await h().world.fixture.git.run(h().world.repoPath, [
      "worktree",
      "list",
      "--porcelain"
    ]);
    const registrations = parseWorktreeListPorcelain(listing.stdout);
    // 7 exec worktrees + 1 integration worktree + review baseline worktrees
    // (one per review session) — every one of them outside the user repo.
    expect(registrations.length).toBeGreaterThanOrEqual(9);
    // git reports Windows paths with forward slashes; compare normalized.
    const normalize = (value: string): string => value.replace(/\\/g, "/");
    const repoPrefix = normalize(h().world.repoPath);
    const rootPrefix = normalize(h().world.worktreesRoot);
    for (const registration of registrations) {
      expect(normalize(registration.path).startsWith(rootPrefix) || normalize(registration.path) === repoPrefix).toBe(true);
      expect(normalize(registration.path).startsWith(`${repoPrefix}/`) === false).toBe(true);
    }
    // The main worktree IS the user repo — exactly one registration there,
    // and the only one not under the worktrees root.
    expect(registrations.filter((registration) => normalize(registration.path) === repoPrefix)).toHaveLength(1);
    expect(
      registrations
        .filter((registration) => normalize(registration.path) !== repoPrefix)
        .every((registration) => normalize(registration.path).startsWith(rootPrefix))
    ).toBe(true);
  });
});
