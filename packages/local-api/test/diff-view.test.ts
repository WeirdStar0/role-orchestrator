/**
 * M5-03 candidate-diff surface over REAL HTTP (A12): the diff is read from a
 * REAL git fixture repository under the system temp directory (the only
 * place git commands run), the verdict binding comes from review's
 * `getReviewVerdict` three-state lookup, and a changed candidate shows
 * 已失效 — never an old pass. The M5-02 semantics of M2-04/M2-05 (the
 * single-writer integration record's baseSha/candidateSha) are the data
 * source; git itself is only ever invoked read-only (`git diff`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { createIntegrationRecord, completeIntegrationRecord } from "@role-orchestrator/integration";
import { completeReviewRecord, createReviewRecord, manifestDigest, reviewIdFor } from "@role-orchestrator/review";
import {
  T0,
  createGitFixture,
  createM5TestDb,
  fakeSha40,
  rawRequest,
  seedEditableRun,
  type GitFixture
} from "./helpers.js";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createM5TestDb>;
let fixture: GitFixture;

// Explicit hook timeouts (full-load hardening, the M8-06 ws-backpressure
// precedent): createGitFixture spawns ~10 git processes, and under a fully
// loaded turbo run the default 10s hookTimeout flaked this suite's beforeAll
// even though every test passes (M10-05 full-gate round 1). The other two
// git-fixture suites (runs-multi-node, runs-orchestration) already carry
// explicit 60s/120s hook budgets.
beforeAll(async () => {
  dbHandle = createM5TestDb("diff-view");
  fixture = await createGitFixture("diff-view");
  server = await startLocalApiServer({ db: dbHandle.db, tokenFile: undefined });
}, 60_000);

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
  fixture?.close();
}, 60_000);

const db: () => DatabaseSync = () => dbHandle.db;

let runCounter = 0;
let sharedProject: { projectId: string; profileId: string } | null = null;

/**
 * A fresh run whose project repoRoot IS the git fixture (projects.repo_root
 * is UNIQUE, so runs after the first REUSE the first run's project), plus an
 * integration record for node `b` completed at the given candidate SHA.
 */
async function freshRunWithCandidate(
  candidateSha: string | null
): Promise<{ runId: string }> {
  runCounter += 1;
  const runId = `run-diff-${String(runCounter)}`;
  const seed = await seedEditableRun(db(), {
    runId,
    repoRoot: fixture.repoPath,
    ...(sharedProject === null ? {} : { existingProject: sharedProject })
  });
  sharedProject = { projectId: seed.projectId, profileId: seed.profileId };
  createIntegrationRecord(db(), {
    id: `integ-${runId}-b`,
    manifest: {
      schemaVersion: 1,
      integrationId: `integ-${runId}`,
      runId,
      nodeId: "b",
      repoPath: fixture.repoPath,
      integrationBranch: `task/${runId}`,
      integrationWorktreePath: `${fixture.repoPath}/../_integration/${runId}`.replace(/\\/g, "/"),
      baseSha: fixture.baseSha,
      parents: [{ nodeId: "a", branch: `exec/${runId}/a/1`, headSha: fixture.baseSha }],
      candidateSha,
      createdAt: T0
    },
    now: T0
  });
  if (candidateSha !== null) {
    completeIntegrationRecord(db(), { runId, nodeId: "b", candidateSha, now: T0 });
  }
  return { runId };
}

/** Record a COMPLETED review verdict for (run, node b, candidateSha). */
function seedReview(runId: string, candidateSha: string, verdict: "pass" | "fail" | "blocked"): string {
  const reviewId = reviewIdFor(runId, "b", candidateSha, T0);
  createReviewRecord(db(), {
    reviewId,
    runId,
    nodeId: "b",
    candidateSha,
    repoPath: fixture.repoPath,
    baselineWorktreePath: `${fixture.repoPath}/baseline`,
    validationWorkspacePath: `${fixture.repoPath}/validation`,
    validationTempRoot: `${fixture.repoPath}/validation-temp`,
    // Empty file list; the digest must be the canonical digest of THAT list.
    baseline: { candidateSha, fileCount: 0, digest: manifestDigest([]), files: [] },
    now: T0
  });
  completeReviewRecord(db(), {
    reviewId,
    review: {
      verdict,
      candidateSha,
      evidenceRefs: ["art-review-log"],
      findings: verdict === "pass" ? [] : ["findings: 边界未覆盖"]
    },
    evidence: [
      {
        artifactRef: { id: "art-review-log", kind: "report" },
        summary: "fixture review evidence",
        exitCode: verdict === "pass" ? 0 : 1,
        recordedAt: T0
      }
    ],
    now: T0
  });
  return reviewId;
}

function getDiff(runId: string, nodeId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    path: `/api/v1/runs/${runId}/diff?nodeId=${encodeURIComponent(nodeId)}`,
    headers: { authorization: `Bearer ${server.token}` }
  }).then((response) => ({
    status: response.status,
    body: JSON.parse(response.body) as Record<string, unknown>
  }));
}

describe("GET /api/v1/runs/:runId/diff — git-sourced candidate diff (M2-04/M2-05 semantics)", () => {
  it("serves the file list and the unified diff of the integrated candidate vs the baseline", async () => {
    const { runId } = await freshRunWithCandidate(fixture.candidateSha);
    const response = await getDiff(runId, "b");
    expect(response.status).toBe(200);
    const view = response.body["diff"] as Record<string, unknown>;
    expect(view["runId"]).toBe(runId);
    expect(view["nodeId"]).toBe("b");
    expect(view["candidateSha"]).toBe(fixture.candidateSha);
    // The RUN's pinned base (the seed's deterministic 40-hex stand-in); the
    // DIFF base is the integration record's baseSha, asserted below.
    expect(view["runBaseSha"]).toBe(fakeSha40(`${runId}-base`));
    const integration = view["integration"] as Record<string, unknown>;
    expect(integration["state"]).toBe("COMPLETED");
    expect(integration["integrationBranch"]).toBe(`task/${runId}`);
    expect(integration["baseSha"]).toBe(fixture.baseSha);
    const diff = view["diff"] as Record<string, unknown>;
    expect(diff["baseSha"]).toBe(fixture.baseSha);
    expect(diff["candidateSha"]).toBe(fixture.candidateSha);
    const files = diff["files"] as Record<string, unknown>[];
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: "docs/note.md", status: "A" });
    expect(files[1]).toMatchObject({ path: "src.txt", status: "M", additions: 1, deletions: 1 });
    const unified = String(diff["unified"]);
    expect(unified).toContain("diff --git");
    expect(unified).toContain("-line-v1");
    expect(unified).toContain("+line-v2");
    expect(unified).toContain("+<script>alert('diff-xss')</script>");
    expect(diff["unifiedTruncated"]).toBe(false);
    // No review record exists yet — the three-state lookup says "none".
    expect((view["review"] as Record<string, unknown>)["kind"]).toBe("none");
  });

  it("binds a valid verdict to the exact candidateSha (A12 `valid`)", async () => {
    const { runId } = await freshRunWithCandidate(fixture.candidateSha);
    const reviewId = seedReview(runId, fixture.candidateSha, "pass");
    const response = await getDiff(runId, "b");
    const review = ((response.body["diff"] as Record<string, unknown>)["review"]) as Record<string, unknown>;
    expect(review["kind"]).toBe("valid");
    expect(review["reviewId"]).toBe(reviewId);
    expect(review["verdict"]).toBe("pass");
    expect(review["candidateSha"]).toBe(fixture.candidateSha);
    expect(review["evidenceRefs"]).toEqual(["art-review-log"]);
  });

  it("answers `invalidated` when the candidate changed — the old pass never applies (A12)", async () => {
    // A review was recorded for candidate 1, but the node's integration now
    // stands at candidate 2: records exist for this run+node, none for THIS
    // candidateSha.
    const { runId } = await freshRunWithCandidate(fixture.candidateSha2);
    seedReview(runId, fixture.candidateSha, "pass");
    const response = await getDiff(runId, "b");
    const view = response.body["diff"] as Record<string, unknown>;
    expect(view["candidateSha"]).toBe(fixture.candidateSha2);
    const review = view["review"] as Record<string, unknown>;
    expect(review["kind"]).toBe("invalidated");
    expect(review["recordedCandidateShas"]).toEqual([fixture.candidateSha]);
  });

  it("serves an honest no-candidate state for a node without an integration record", async () => {
    const { runId } = await freshRunWithCandidate(null);
    const response = await getDiff(runId, "c");
    expect(response.status).toBe(200);
    const view = response.body["diff"] as Record<string, unknown>;
    expect(view["candidateSha"]).toBeNull();
    expect(view["diff"]).toBeNull();
    expect(view["review"]).toBeNull();
    expect(view["integration"]).toBeNull();
  });

  it("reports DIFF_SOURCE_UNAVAILABLE (409) when git reality has no such candidate", async () => {
    const { runId } = await freshRunWithCandidate(fixture.missingSha);
    const response = await getDiff(runId, "b");
    expect(response.status).toBe(409);
    expect((response.body["error"] as Record<string, unknown>)["code"]).toBe("DIFF_SOURCE_UNAVAILABLE");
  });

  it("truncates an oversized unified diff and marks it (never streams whole)", async () => {
    // Build a commit whose diff exceeds the 262,144-char cap.
    runCounter += 1;
    const runId = `run-diff-big-${String(runCounter)}`;
    await seedEditableRun(db(), {
      runId,
      repoRoot: fixture.repoPath,
      ...(sharedProject === null ? {} : { existingProject: sharedProject })
    });
    const { GitRunner } = await import("@role-orchestrator/worktree");
    const git = new GitRunner();
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(`删除旧行 ${i} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    writeFileSync(join(fixture.repoPath, "big.txt"), `${lines.join("\n")}\n`, "utf8");
    await git.run(fixture.repoPath, ["add", "."]);
    await git.run(fixture.repoPath, ["commit", "-m", "big-change"]);
    const bigSha = (await git.run(fixture.repoPath, ["rev-parse", "HEAD"])).stdout.trim();

    createIntegrationRecord(db(), {
      id: `integ-${runId}-b`,
      manifest: {
        schemaVersion: 1,
        integrationId: `integ-${runId}`,
        runId,
        nodeId: "b",
        repoPath: fixture.repoPath,
        integrationBranch: `task/${runId}`,
        integrationWorktreePath: `${fixture.repoPath}/../_integration/${runId}`.replace(/\\/g, "/"),
        baseSha: fixture.baseSha,
        parents: [{ nodeId: "a", branch: `exec/${runId}/a/1`, headSha: fixture.baseSha }],
        candidateSha: bigSha,
        createdAt: T0
      },
      now: T0
    });
    completeIntegrationRecord(db(), { runId, nodeId: "b", candidateSha: bigSha, now: T0 });

    const response = await getDiff(runId, "b");
    expect(response.status).toBe(200);
    const diff = ((response.body["diff"] as Record<string, unknown>)["diff"]) as Record<string, unknown>;
    expect(diff["unifiedTruncated"]).toBe(true);
    expect(diff["unifiedChars"]).toBe(262_144);
    expect(String(diff["unified"]).length).toBe(262_144);
  });

  it("404s an unknown run or a node outside the run, 400s a missing/extra nodeId", async () => {
    const { runId } = await freshRunWithCandidate(null);
    expect((await getDiff("run-missing", "b")).status).toBe(404);
    const outside = await getDiff(runId, "zzz");
    expect(outside.status).toBe(404);
    expect((outside.body["error"] as Record<string, unknown>)["code"]).toBe("NOT_FOUND");
    const noParam = await rawRequest(server.port, {
      path: `/api/v1/runs/${runId}/diff`,
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(noParam.status).toBe(400);
    const extraParam = await rawRequest(server.port, {
      path: `/api/v1/runs/${runId}/diff?nodeId=b&extra=1`,
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(extraParam.status).toBe(400);
  });

  it("refuses mutating methods (read-only view)", async () => {
    const { runId } = await freshRunWithCandidate(null);
    const response = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/runs/${runId}/diff?nodeId=b`,
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${String(server.port)}`,
        "x-csrf-token": server.csrfToken,
        "content-type": "application/json"
      }
    });
    expect(response.status).toBe(405);
  });
});
