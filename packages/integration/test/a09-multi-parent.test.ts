/**
 * A09 — 多父依赖修改不同文件: 后继 inputSha 同时包含父输出.
 *
 * The integration must produce a successor baseline (candidateSha) that
 * contains BOTH parents' outputs, with the structured inputSha set recording
 * every accepted parent commit — and nothing about the parents' worktrees or
 * branches may be consumed or altered by the merge.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createWorktree } from "@role-orchestrator/worktree";
import {
  getIntegrationRecord,
  integrateParents,
  isAncestorOrEqual,
  listIntegrationRecords,
  ParentOutputMovedError
} from "../src/index.js";
import {
  createIntegrationFixture,
  createMigratedFileDb,
  iso,
  removeTreeRobust,
  type IntegrationFixture,
  type TestDb
} from "./helpers.js";

const fixtures: { readonly fixture: IntegrationFixture; readonly db: TestDb }[] = [];

async function scenario(label: string) {
  const fixture = await createIntegrationFixture(label);
  const testDb = createMigratedFileDb(label, fixture.repoPath, fixture.runId);
  fixtures.push({ fixture, db: testDb });
  return { fixture, db: testDb.db };
}

afterAll(() => {
  for (const entry of fixtures) {
    entry.db.close();
    removeTreeRobust(entry.fixture.scratchDir);
  }
});

describe("A09 · multi-parent integration (different files)", () => {
  it("merges both parents in topological order and the candidate contains every parent output", async () => {
    const { fixture, db } = await scenario("a09-merge");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "a.txt",
      content: "alpha-from-a\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "b.txt",
      content: "beta-from-b\n"
    });

    const outcome = await integrateParents(
      { db, git: fixture.git },
      {
        repoPath: fixture.repoPath,
        worktreesRoot: fixture.worktreesRoot,
        runId: fixture.runId,
        nodeId: "n-succ",
        baseSha: fixture.baseSha,
        parents: [
          { nodeId: parentA.nodeId, branch: parentA.branch, headSha: parentA.headSha },
          { nodeId: parentB.nodeId, branch: parentB.branch, headSha: parentB.headSha }
        ],
        now: iso(1_000)
      }
    );

    expect(outcome.kind).toBe("integrated");
    if (outcome.kind !== "integrated") throw new Error("unreachable");
    // The structured inputSha set carries BOTH accepted parent outputs, in
    // the caller's topological order.
    expect(outcome.inputShaSet.map((entry) => entry.nodeId)).toEqual(["n-a", "n-b"]);
    expect(outcome.inputShaSet.map((entry) => entry.headSha)).toEqual([
      parentA.headSha,
      parentB.headSha
    ]);

    // The candidate is a descendant of both parent outputs (A09 ancestry).
    expect(
      await isAncestorOrEqual(fixture.git, fixture.repoPath, parentA.headSha, outcome.candidateSha)
    ).toBe(true);
    expect(
      await isAncestorOrEqual(fixture.git, fixture.repoPath, parentB.headSha, outcome.candidateSha)
    ).toBe(true);

    // The candidate branch head IS the recorded candidate (stable, re-verifiable).
    expect(await fixture.branchHead(outcome.integrationBranch)).toBe(outcome.candidateSha);

    // The successor's own writer worktree, created FROM the candidate,
    // sees both parents' file modifications — 合流内容齐全.
    const successor = await createWorktree(fixture.git, {
      repoPath: fixture.repoPath,
      worktreesRoot: fixture.worktreesRoot,
      runId: fixture.runId,
      nodeId: "n-succ",
      attempt: 1,
      baseSha: outcome.candidateSha
    });
    expect(readFileSync(path.join(successor.worktreePath, "a.txt"), "utf8")).toBe("alpha-from-a\n");
    expect(readFileSync(path.join(successor.worktreePath, "b.txt"), "utf8")).toBe("beta-from-b\n");
    expect(readFileSync(path.join(successor.worktreePath, "seed.txt"), "utf8")).toBe("seed content v1\n");

    // Parents were consumed, not altered.
    expect(await fixture.branchHead(parentA.branch)).toBe(parentA.headSha);
    expect(await fixture.branchHead(parentB.branch)).toBe(parentB.headSha);
    expect(existsSync(path.join(parentA.worktreePath, "a.txt"))).toBe(true);
    expect(existsSync(path.join(parentB.worktreePath, "b.txt"))).toBe(true);
  });

  it("persists the record: COMPLETED state, structured inputSha set, manifest with candidateSha", async () => {
    const { fixture, db } = await scenario("a09-record");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "a.txt",
      content: "alpha-from-a\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "b.txt",
      content: "beta-from-b\n"
    });
    const outcome = await integrateParents(
      { db, git: fixture.git },
      {
        repoPath: fixture.repoPath,
        worktreesRoot: fixture.worktreesRoot,
        runId: fixture.runId,
        nodeId: "n-succ",
        baseSha: fixture.baseSha,
        parents: [
          { nodeId: parentA.nodeId, branch: parentA.branch, headSha: parentA.headSha },
          { nodeId: parentB.nodeId, branch: parentB.branch, headSha: parentB.headSha }
        ],
        now: iso(1_000)
      }
    );
    if (outcome.kind !== "integrated") throw new Error("expected integrated outcome");

    const record = getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" });
    expect(record).not.toBeNull();
    if (record === null) throw new Error("unreachable");
    expect(record.state).toBe("COMPLETED");
    expect(record.candidateSha).toBe(outcome.candidateSha);
    expect(record.inputShaSet.map((entry) => entry.nodeId)).toEqual(["n-a", "n-b"]);
    expect(record.manifest.schemaVersion).toBe(1);
    expect(record.manifest.candidateSha).toBe(outcome.candidateSha);
    expect(record.manifest.parents.map((entry) => entry.headSha)).toEqual([
      parentA.headSha,
      parentB.headSha
    ]);
    expect(record.manifest.integrationBranch).toBe(`task/${fixture.runId}`);
    expect(listIntegrationRecords(db, fixture.runId)).toHaveLength(1);
  });

  it("is idempotent: re-invoking with the same inputs returns already-integrated and commits nothing", async () => {
    const { fixture, db } = await scenario("a09-idempotent");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "a.txt",
      content: "alpha-from-a\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "b.txt",
      content: "beta-from-b\n"
    });
    const input = {
      repoPath: fixture.repoPath,
      worktreesRoot: fixture.worktreesRoot,
      runId: fixture.runId,
      nodeId: "n-succ",
      baseSha: fixture.baseSha,
      parents: [
        { nodeId: parentA.nodeId, branch: parentA.branch, headSha: parentA.headSha },
        { nodeId: parentB.nodeId, branch: parentB.branch, headSha: parentB.headSha }
      ],
      now: iso(1_000)
    };
    const first = await integrateParents({ db, git: fixture.git }, input);
    if (first.kind !== "integrated") throw new Error("expected integrated outcome");
    const commitsBefore = await fixture.branchCommits(`task/${fixture.runId}`);

    const second = await integrateParents({ db, git: fixture.git }, input);
    expect(second.kind).toBe("already-integrated");
    if (second.kind !== "already-integrated") throw new Error("unreachable");
    expect(second.candidateSha).toBe(first.candidateSha);
    expect(second.via).toBe("record");

    const commitsAfter = await fixture.branchCommits(`task/${fixture.runId}`);
    expect(commitsAfter).toEqual(commitsBefore); // no duplicate integration commits
  });

  it("stops with ParentOutputMovedError before touching anything when a parent tip moved", async () => {
    const { fixture, db } = await scenario("a09-moved");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "a.txt",
      content: "alpha-from-a\n"
    });
    // A second attempt advances the parent branch AFTER the output was accepted.
    await fixture.git.run(parentA.worktreePath, ["commit", "--allow-empty", "-m", "advance"], {
      env: {
        GIT_AUTHOR_NAME: "x",
        GIT_AUTHOR_EMAIL: "x@x",
        GIT_COMMITTER_NAME: "x",
        GIT_COMMITTER_EMAIL: "x@x"
      }
    });

    await expect(
      integrateParents(
        { db, git: fixture.git },
        {
          repoPath: fixture.repoPath,
          worktreesRoot: fixture.worktreesRoot,
          runId: fixture.runId,
          nodeId: "n-succ",
          baseSha: fixture.baseSha,
          parents: [
            { nodeId: parentA.nodeId, branch: parentA.branch, headSha: parentA.headSha }
          ],
          now: iso(1_000)
        }
      )
    ).rejects.toBeInstanceOf(ParentOutputMovedError);

    // The verification runs before the claim: no record exists yet.
    expect(getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" })).toBeNull();
  });
});
