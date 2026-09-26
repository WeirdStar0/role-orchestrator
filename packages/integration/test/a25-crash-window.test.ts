/**
 * A25 — Git commit 后 DB 更新前崩溃: 根据 manifest/SHA 核对，不重复提交.
 *
 * The crash is simulated EXACTLY at the dangerous boundary: a DatabaseSync
 * proxy whose `prepare` throws for the first statement matching the target
 * write. Everything before that statement is already committed (each record
 * write is its own autocommit transaction), so the process state after the
 * throw IS the real crash state.
 *
 * Windows covered here:
 *  1. "commit done, completion write missing"  (manifest already carries the
 *     预期 candidateSha) -> reconcile backfills the DB; git log unchanged.
 *  2. "commit done, manifest write missing"    (candidateSha not recorded) ->
 *     reconcile reports safe-to-retry; the retry re-merges as git no-ops and
 *     reproduces the SAME candidateSha; git log gains nothing new.
 *  3. "conflict scene present, pause write missing" -> merge-in-progress,
 *     manual handling; branches intact (never an unrecorded A10 auto-fix).
 *  4. determinism: two independent identical fixture repos integrate to the
 *     identical candidateSha — the reason the retry can never double-commit.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  getIntegrationRecord,
  IntegrationMergeStateLeftError,
  integrateParents,
  reconcileIntegration
} from "../src/index.js";
import {
  createIntegrationFixture,
  createMigratedFileDb,
  dbCrashingOn,
  expectRejection,
  insertTaskNode,
  iso,
  removeTreeRobust,
  type IntegrationFixture,
  type TestDb
} from "./helpers.js";

const fixtures: { readonly fixture: IntegrationFixture; readonly dbs: TestDb[] }[] = [];

async function scenario(label: string, count = 1) {
  const fixture = await createIntegrationFixture(label);
  const dbs: TestDb[] = [];
  for (let i = 0; i < count; i += 1) {
    dbs.push(createMigratedFileDb(`${label}-db${String(i)}`, fixture.repoPath, fixture.runId));
  }
  fixtures.push({ fixture, dbs });
  return { fixture, dbs };
}

afterAll(() => {
  for (const entry of fixtures) {
    for (const db of entry.dbs) db.close();
    removeTreeRobust(entry.fixture.scratchDir);
  }
});

interface TwoParents {
  readonly a: { readonly nodeId: string; readonly branch: string; readonly headSha: string };
  readonly b: { readonly nodeId: string; readonly branch: string; readonly headSha: string };
}

async function twoDifferentFileParents(fixture: IntegrationFixture): Promise<TwoParents> {
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
  return { a: parentA, b: parentB };
}

describe("A25 · crash between git commit and DB update converges without duplicate commits", () => {
  it("window 1: crash before the completion write -> reconcile backfills the DB, git log unchanged", async () => {
    const { fixture, dbs } = await scenario("a25-window1");
    const db = dbs[0]!.db;
    const parents = await twoDifferentFileParents(fixture);
    const input = {
      repoPath: fixture.repoPath,
      worktreesRoot: fixture.worktreesRoot,
      runId: fixture.runId,
      nodeId: "n-succ",
      baseSha: fixture.baseSha,
      parents: [
        { nodeId: parents.a.nodeId, branch: parents.a.branch, headSha: parents.a.headSha },
        { nodeId: parents.b.nodeId, branch: parents.b.branch, headSha: parents.b.headSha }
      ],
      now: iso(1_000)
    };

    // The completion UPDATE is exactly where the process dies.
    const crashingDb = dbCrashingOn(db, (sql) =>
      sql.includes("UPDATE integration_records SET state = 'COMPLETED'")
    );
    await expectRejection(
      integrateParents({ db: crashingDb, git: fixture.git }, input),
      Error
    ).then((error) => expect(error.message).toContain("SIMULATED CRASH"));

    // The commit LANDED (git half done) but the DB never heard of it.
    const branchHead = await fixture.branchHead(`task/${fixture.runId}`);
    expect(branchHead).not.toBeNull();
    const crashed = getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" });
    expect(crashed?.state).toBe("IN_PROGRESS");
    expect(crashed?.candidateSha).toBeNull();
    expect(crashed?.manifest.candidateSha).toBe(branchHead); // the 预期 SHA was recorded first
    const commitsAfterCrash = await fixture.branchCommits(`task/${fixture.runId}`);

    // Reconcile: verify manifest SHA against real git state, 补记 DB.
    const result = await reconcileIntegration(
      { db, git: fixture.git },
      { runId: fixture.runId, nodeId: "n-succ", now: iso(2_000) }
    );
    expect(result.verdict.kind).toBe("committed");
    expect(result.verdict.kind === "committed" && result.verdict.candidateSha).toBe(branchHead);
    expect(result.record.state).toBe("COMPLETED");
    expect(result.record.candidateSha).toBe(branchHead);

    // No duplicate commit: the reconcile never touched git.
    expect(await fixture.branchCommits(`task/${fixture.runId}`)).toEqual(commitsAfterCrash);

    // Reconcile again -> already-recorded (idempotent). Re-integrate ->
    // already-integrated. Still no new commit.
    const second = await reconcileIntegration(
      { db, git: fixture.git },
      { runId: fixture.runId, nodeId: "n-succ", now: iso(3_000) }
    );
    expect(second.verdict.kind).toBe("already-recorded");
    const third = await integrateParents({ db, git: fixture.git }, input);
    expect(third.kind).toBe("already-integrated");
    expect(await fixture.branchCommits(`task/${fixture.runId}`)).toEqual(commitsAfterCrash);
  });

  it("window 2: crash before the manifest write -> safe-to-retry, retry reproduces the same candidateSha", async () => {
    const { fixture, dbs } = await scenario("a25-window2");
    const db = dbs[0]!.db;
    const parents = await twoDifferentFileParents(fixture);
    const input = {
      repoPath: fixture.repoPath,
      worktreesRoot: fixture.worktreesRoot,
      runId: fixture.runId,
      nodeId: "n-succ",
      baseSha: fixture.baseSha,
      parents: [
        { nodeId: parents.a.nodeId, branch: parents.a.branch, headSha: parents.a.headSha },
        { nodeId: parents.b.nodeId, branch: parents.b.branch, headSha: parents.b.headSha }
      ],
      now: iso(1_000)
    };

    // Dies where the manifest (with candidateSha) would be recorded — after
    // the last merge commit landed.
    const crashingDb = dbCrashingOn(db, (sql) =>
      sql.includes("UPDATE integration_records SET manifest")
    );
    await expectRejection(
      integrateParents({ db: crashingDb, git: fixture.git }, input),
      Error
    ).then((error) => expect(error.message).toContain("SIMULATED CRASH"));

    const crashed = getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" });
    expect(crashed?.state).toBe("IN_PROGRESS");
    expect(crashed?.manifest.candidateSha).toBeNull();
    const branchHead = await fixture.branchHead(`task/${fixture.runId}`);
    expect(branchHead).not.toBeNull();
    const commitsAfterCrash = await fixture.branchCommits(`task/${fixture.runId}`);

    const result = await reconcileIntegration(
      { db, git: fixture.git },
      { runId: fixture.runId, nodeId: "n-succ", now: iso(2_000) }
    );
    expect(result.verdict).toMatchObject({ kind: "safe-to-retry", safeToRetry: true });

    // The retry merges already-ancestor parents (git no-ops) and lands on the
    // SAME candidateSha — never a duplicate commit.
    const retried = await integrateParents({ db, git: fixture.git }, input);
    expect(retried.kind).toBe("integrated");
    if (retried.kind !== "integrated") throw new Error("unreachable");
    expect(retried.candidateSha).toBe(branchHead);
    expect(await fixture.branchCommits(`task/${fixture.runId}`)).toEqual(commitsAfterCrash);
  });

  it("window 3: crash before the pause write leaves an unrecorded conflict scene -> merge-in-progress, manual handling", async () => {
    const { fixture, dbs } = await scenario("a25-window3");
    const db = dbs[0]!.db;
    // Same-line conflict parents.
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

    const crashingDb = dbCrashingOn(db, (sql) =>
      sql.includes("SET state = 'PAUSED_CONFLICT'")
    );
    await expectRejection(
      integrateParents({ db: crashingDb, git: fixture.git }, input),
      Error
    ).then((error) => expect(error.message).toContain("SIMULATED CRASH"));

    // The scene exists but the PAUSED_CONFLICT never got recorded: the record
    // is IN_PROGRESS while the worktree holds unmerged entries + MERGE_HEAD.
    expect(getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" })?.state).toBe(
      "IN_PROGRESS"
    );

    const result = await reconcileIntegration(
      { db, git: fixture.git },
      { runId: fixture.runId, nodeId: "n-succ", now: iso(2_000) }
    );
    expect(result.verdict).toMatchObject({
      kind: "merge-in-progress",
      safeToRetry: false,
      conflictFiles: ["shared.txt"]
    });

    // Re-integrating refuses instead of auto-resolving the possible conflict.
    await expectRejection(
      integrateParents({ db, git: fixture.git }, input),
      IntegrationMergeStateLeftError
    );

    // Nothing lost: both branches still at their accepted tips.
    expect(await fixture.branchHead(parentA.branch)).toBe(parentA.headSha);
    expect(await fixture.branchHead(parentB.branch)).toBe(parentB.headSha);
  });

  it("determinism: two independent identical fixture repos integrate to the identical candidateSha", async () => {
    const { fixture: fx1, dbs: dbs1 } = await scenario("a25-det-one");
    const { fixture: fx2, dbs: dbs2 } = await scenario("a25-det-two");
    const parents1 = await twoDifferentFileParents(fx1);
    const parents2 = await twoDifferentFileParents(fx2);

    // The identical fixture commits hash identically across repos — the
    // precondition that makes integration commits deterministic.
    expect(parents1.a.headSha).toBe(parents2.a.headSha);
    expect(parents1.b.headSha).toBe(parents2.b.headSha);

    const build = (fixture: IntegrationFixture, db: TestDb, parents: TwoParents) =>
      integrateParents(
        { db: db.db, git: fixture.git },
        {
          repoPath: fixture.repoPath,
          worktreesRoot: fixture.worktreesRoot,
          runId: fixture.runId,
          nodeId: "n-succ",
          baseSha: fixture.baseSha,
          parents: [
            { nodeId: parents.a.nodeId, branch: parents.a.branch, headSha: parents.a.headSha },
            { nodeId: parents.b.nodeId, branch: parents.b.branch, headSha: parents.b.headSha }
          ],
          now: iso(1_000)
        }
      );

    const outcome1 = await build(fx1, dbs1[0]!, parents1);
    const outcome2 = await build(fx2, dbs2[0]!, parents2);
    expect(outcome1.kind).toBe("integrated");
    expect(outcome2.kind).toBe("integrated");
    if (outcome1.kind !== "integrated" || outcome2.kind !== "integrated") throw new Error("unreachable");
    expect(outcome1.candidateSha).toBe(outcome2.candidateSha);
  });

  it("a completed integration keeps the successor dispatchable: node stays outside BLOCKED (bridge no-op)", async () => {
    const { fixture, dbs } = await scenario("a25-bridge-open");
    const db = dbs[0]!.db;
    const parents = await twoDifferentFileParents(fixture);
    const outcome = await integrateParents(
      { db, git: fixture.git },
      {
        repoPath: fixture.repoPath,
        worktreesRoot: fixture.worktreesRoot,
        runId: fixture.runId,
        nodeId: "n-succ",
        baseSha: fixture.baseSha,
        parents: [
          { nodeId: parents.a.nodeId, branch: parents.a.branch, headSha: parents.a.headSha },
          { nodeId: parents.b.nodeId, branch: parents.b.branch, headSha: parents.b.headSha }
        ],
        now: iso(1_000)
      }
    );
    expect(outcome.kind).toBe("integrated");

    // The scheduler/queue consumes node states, not git: a COMPLETED record
    // never blocks the READY transition dag computes from SUCCEEDED parents.
    insertTaskNode(db, { runId: fixture.runId, nodeId: "n-succ", state: "READY" });
    const record = getIntegrationRecord(db, { runId: fixture.runId, nodeId: "n-succ" });
    expect(record?.state).toBe("COMPLETED");
    expect(record?.conflictFiles).toBeNull();
  });
});
