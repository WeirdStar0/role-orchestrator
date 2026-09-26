/**
 * A10 — 多父依赖修改同一行: 暂停冲突，不丢弃任何分支.
 *
 * The conflicting merge must pause the integration as a queryable
 * PAUSED_CONFLICT record with the complete conflict file list, keep BOTH
 * parent branches and worktrees byte-identical, and leave the conflict scene
 * (markers + MERGE_HEAD) in the integration worktree — evidence that no side
 * was chosen. The dag bridge must keep the successor out of SUCCEEDED.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isLegalNodeTransition } from "@role-orchestrator/dag";
import {
  applyIntegrationOutcomeToNode,
  assertNodeNotIntegrationPaused,
  getIntegrationRecord,
  IntegrationConflictError,
  IntegrationPausedError,
  integrateParents,
  listIntegrationRecords,
  reconcileIntegration
} from "../src/index.js";
import {
  createIntegrationFixture,
  createMigratedFileDb,
  expectRejection,
  insertTaskNode,
  iso,
  removeTreeRobust,
  type IntegrationFixture,
  type TestDb
} from "./helpers.js";

const fixtures: { readonly fixture: IntegrationFixture; readonly db: TestDb }[] = [];

async function scenario(label: string) {
  const fixture = await createIntegrationFixture(label, {
    seedFiles: { "shared.txt": "line1\nline2\n" }
  });
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

describe("A10 · same-line conflict pauses the integration, nothing is discarded", () => {
  it("pauses with the typed error + PAUSED_CONFLICT record and the complete conflict list", async () => {
    const { fixture, db } = await scenario("a10-pause");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "shared.txt",
      content: "line1-A\nline2\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "shared.txt",
      content: "line1-B\nline2\n"
    });

    const error = await expectRejection(
      integrateParents(
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
      ),
      IntegrationConflictError
    );

    expect(error.conflictFiles).toEqual(["shared.txt"]);
    expect(error.conflictParentNodeId).toBe("n-b");

    // The pause is durable and queryable (恢复路径留待后续，暂停态可查询).
    const record = getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" });
    expect(record?.state).toBe("PAUSED_CONFLICT");
    expect(record?.conflictFiles).toEqual(["shared.txt"]);
    expect(record?.conflictParentNodeId).toBe("n-b");
    expect(listIntegrationRecords(db, fixture.runId)).toHaveLength(1);
  });

  it("keeps both parent branches and worktrees byte-identical and the conflict scene unresolved", async () => {
    const { fixture, db } = await scenario("a10-retain");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "shared.txt",
      content: "line1-A\nline2\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "shared.txt",
      content: "line1-B\nline2\n"
    });
    await expectRejection(
      integrateParents(
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
      ),
      IntegrationConflictError
    );

    // Branches: both still exist at their accepted tips (绝不丢分支).
    expect(await fixture.branchHead(parentA.branch)).toBe(parentA.headSha);
    expect(await fixture.branchHead(parentB.branch)).toBe(parentB.headSha);

    // Worktrees: both still on disk with their OWN content (现场保留).
    expect(
      readFileSync(path.join(parentA.worktreePath, "shared.txt"), "utf8")
    ).toBe("line1-A\nline2\n");
    expect(
      readFileSync(path.join(parentB.worktreePath, "shared.txt"), "utf8")
    ).toBe("line1-B\nline2\n");

    // The integration worktree holds the scene: BOTH sides visible as
    // conflict markers (no ours/theirs was picked) and MERGE_HEAD present.
    const merged = readFileSync(
      path.join(fixture.worktreesRoot, "_integration", fixture.runId, "shared.txt"),
      "utf8"
    );
    expect(merged).toContain("<<<<<<<");
    expect(merged).toContain("line1-A");
    expect(merged).toContain("=======");
    expect(merged).toContain("line1-B");
    expect(merged).toContain(">>>>>>>");

    // Nothing was committed for the conflicting parent: the branch history
    // ends at the FIRST parent's merge, never at a resolution.
    const taskCommits = await fixture.branchCommits(`task/${fixture.runId}`);
    expect(taskCommits).not.toContain(parentB.headSha);
    expect(await fixture.branchHead(`task/${fixture.runId}`)).not.toBe(parentB.headSha);
  });

  it("reconcile reports conflict-paused and re-invoking integrate refuses while paused", async () => {
    const { fixture, db } = await scenario("a10-query");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "shared.txt",
      content: "line1-A\nline2\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "shared.txt",
      content: "line1-B\nline2\n"
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
    await expectRejection(
      integrateParents({ db, git: fixture.git }, input),
      IntegrationConflictError
    );

    const result = await reconcileIntegration(
      { db, git: fixture.git },
      { runId: fixture.runId, nodeId: "n-succ", now: iso(2_000) }
    );
    expect(result.verdict.kind).toBe("conflict-paused");
    if (result.verdict.kind === "conflict-paused") {
      expect(result.verdict.conflictFiles).toEqual(["shared.txt"]);
      expect(result.verdict.conflictParentNodeId).toBe("n-b");
    }
    expect(result.record.state).toBe("PAUSED_CONFLICT");

    // A re-invocation keeps refusing (and keeps the record paused) — the
    // conflict is a human decision, never an automatic retry.
    await expectRejection(integrateParents({ db, git: fixture.git }, input), IntegrationConflictError);
    expect(getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" })?.state).toBe(
      "PAUSED_CONFLICT"
    );
  });

  it("keeps the successor node out of SUCCEEDED: bridge blocks PENDING/READY and the FSM has no BLOCKED->SUCCEEDED edge", async () => {
    const { fixture, db } = await scenario("a10-bridge");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "shared.txt",
      content: "line1-A\nline2\n"
    });
    const parentB = await fixture.createParentBranch({
      nodeId: "n-b",
      fileName: "shared.txt",
      content: "line1-B\nline2\n"
    });
    await expectRejection(
      integrateParents(
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
      ),
      IntegrationConflictError
    );

    // The SUCCEEDED gate refuses while paused.
    expect(() =>
      assertNodeNotIntegrationPaused(db, { runId: fixture.runId, nodeId: "n-succ" })
    ).toThrow(IntegrationPausedError);

    // The bridge moves the PENDING successor to BLOCKED — never SUCCEEDED.
    insertTaskNode(db, { runId: fixture.runId, nodeId: "n-succ", state: "PENDING" });
    const applied = applyIntegrationOutcomeToNode(db, {
      runId: fixture.runId,
      nodeId: "n-succ",
      now: iso(3_000)
    });
    expect(applied.action).toBe("blocked-successor");
    expect(applied.node.state).toBe("BLOCKED");
    expect(applied.node.state).not.toBe("SUCCEEDED");

    // The state machine itself agrees: BLOCKED has no edge to SUCCEEDED.
    expect(isLegalNodeTransition("BLOCKED", "SUCCEEDED")).toBe(false);
  });

  it("never promotes a node on a completed integration (the bridge only restricts)", async () => {
    const { fixture, db } = await scenario("a10-bridge-complete");
    const parentA = await fixture.createParentBranch({
      nodeId: "n-a",
      fileName: "a.txt",
      content: "alpha\n"
    });
    const outcome = await integrateParents(
      { db, git: fixture.git },
      {
        repoPath: fixture.repoPath,
        worktreesRoot: fixture.worktreesRoot,
        runId: fixture.runId,
        nodeId: "n-succ",
        baseSha: fixture.baseSha,
        parents: [{ nodeId: parentA.nodeId, branch: parentA.branch, headSha: parentA.headSha }],
        now: iso(1_000)
      }
    );
    expect(outcome.kind).toBe("integrated");

    insertTaskNode(db, { runId: fixture.runId, nodeId: "n-succ", state: "PENDING" });
    const applied = applyIntegrationOutcomeToNode(db, {
      runId: fixture.runId,
      nodeId: "n-succ",
      now: iso(2_000)
    });
    expect(applied.action).toBe("left-unchanged");
    expect(applied.node.state).toBe("PENDING"); // success stays the execution lifecycle's job
    expect(() =>
      assertNodeNotIntegrationPaused(db, { runId: fixture.runId, nodeId: "n-succ" })
    ).not.toThrow();
  });
});
