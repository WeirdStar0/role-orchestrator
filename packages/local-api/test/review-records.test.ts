/**
 * M11-04 — GET /api/v1/runs/:runId/review-records?nodeId=<id> over REAL
 * HTTP: the A12 verdict records of one review node, projected to the
 * allowlisted product face. Hermetic: the rows are seeded through the review
 * package's own guarded primitives (the same surface the driver settles
 * sessions with) into a real M5-migration store; git never runs here.
 *
 * Covered here:
 * - 200 with the records oldest-first: verdict pass/fail, findings verbatim,
 *   candidateSha binding, completedAt; NO internal id / path / manifest in
 *   the body (the projection discipline);
 * - an empty list is the honest "no review session ever opened for THIS
 *   node" (the run exists, the node exists);
 * - 404 unknown run; 404 node-not-in-run (the SAME 404 semantics the graph
 *   and diff views use — not an empty list);
 * - 400 query rejection (missing / extra parameters — zod strict);
 * - 405 non-GET with the Allow header (read-only route);
 * - guard pipeline: no token → 403 before anything else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
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

// Explicit hook budgets (the runs-orchestration T0_TIMEOUT_MS precedent):
// createGitFixture spawns a real git chain and the full turbo load can
// outrun vitest's default 10s hookTimeout.
beforeAll(async () => {
  dbHandle = createM5TestDb("review-records");
  fixture = await createGitFixture("review-records");
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

async function freshRun(): Promise<{ runId: string }> {
  runCounter += 1;
  const runId = `run-revrec-${String(runCounter)}`;
  const seed = await seedEditableRun(db(), {
    runId,
    repoRoot: fixture.repoPath,
    ...(sharedProject === null ? {} : { existingProject: sharedProject })
  });
  sharedProject = { projectId: seed.projectId, profileId: seed.profileId };
  return { runId };
}

/** Record one COMPLETED verdict for (run, nodeId, candidateSha) through the
 * review package's own guarded transitions — the same primitives the driver
 * settles real sessions with. */
function seedReview(
  runId: string,
  nodeId: string,
  candidateSha: string,
  verdict: "pass" | "fail",
  findings: readonly string[]
): string {
  const reviewId = reviewIdFor(runId, nodeId, candidateSha, T0);
  createReviewRecord(db(), {
    reviewId,
    runId,
    nodeId,
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
    review: { verdict, candidateSha, evidenceRefs: ["art-review-log"], findings: [...findings] },
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

function getReviewRecords(
  runId: string,
  query: string,
  headers: Record<string, string> = { authorization: `Bearer ${server.token}` }
): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    path: `/api/v1/runs/${runId}/review-records${query}`,
    headers
  }).then((response) => ({
    status: response.status,
    body: (response.body === "" ? {} : JSON.parse(response.body)) as Record<string, unknown>
  }));
}

describe("GET /api/v1/runs/:runId/review-records (M11-04 Reviewer 产品化数据面)", () => {
  it("serves the verdict records of a review node oldest-first, allowlisted fields only", async () => {
    const { runId } = await freshRun();
    const firstCandidate = fakeSha40(`${runId}-cand-1`);
    const secondCandidate = fakeSha40(`${runId}-cand-2`);
    // Two rounds on node "b" (the seeded graph's review-shaped node): a fail
    // with findings, then a pass on the next candidate.
    seedReview(runId, "b", firstCandidate, "fail", ["findings: 边界未覆盖", "findings: 错误提示缺失"]);
    seedReview(runId, "b", secondCandidate, "pass", []);
    const response = await getReviewRecords(runId, `?nodeId=${encodeURIComponent("b")}`);
    expect(response.status).toBe(200);
    const view = response.body["reviewRecords"] as Record<string, unknown>;
    expect(view["runId"]).toBe(runId);
    expect(view["nodeId"]).toBe("b");
    const records = view["records"] as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    // Oldest first — the rounds read in execution order.
    expect(records[0]).toMatchObject({
      state: "COMPLETED",
      verdict: "fail",
      findings: ["findings: 边界未覆盖", "findings: 错误提示缺失"],
      invalidatedReason: null,
      candidateSha: firstCandidate
    });
    expect(typeof records[0]?.["completedAt"]).toBe("string");
    expect(records[1]).toMatchObject({
      state: "COMPLETED",
      verdict: "pass",
      findings: [],
      candidateSha: secondCandidate
    });
    // Projection discipline: no internal id, no host path, no manifest fields.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("reviewId");
    expect(serialized).not.toContain("repoPath");
    expect(serialized).not.toContain("baseline");
    expect(serialized).not.toContain("validation");
    expect(serialized).not.toContain("evidenceRefs");
  });

  it("an empty list is the honest no-session state; other nodes of the same run read independently", async () => {
    const { runId } = await freshRun();
    seedReview(runId, "b", fakeSha40(`${runId}-cand`), "pass", []);
    const empty = await getReviewRecords(runId, `?nodeId=${encodeURIComponent("a")}`);
    expect(empty.status).toBe(200);
    expect(((empty.body["reviewRecords"] as Record<string, unknown>)["records"] as unknown[])).toEqual([]);
  });

  it("a node outside the run is a 404, not an empty list; an unknown run is a 404", async () => {
    const { runId } = await freshRun();
    const foreign = await getReviewRecords(runId, `?nodeId=${encodeURIComponent("nowhere")}`);
    expect(foreign.status).toBe(404);
    expect((foreign.body["error"] as Record<string, unknown>)["code"]).toBe("NOT_FOUND");
    const unknownRun = await getReviewRecords("run-revrec-never-created", `?nodeId=${encodeURIComponent("a")}`);
    expect(unknownRun.status).toBe(404);
  });

  it("the query is zod strict: missing and extra parameters are 400 rejections", async () => {
    const { runId } = await freshRun();
    const missing = await getReviewRecords(runId, "");
    expect(missing.status).toBe(400);
    const extra = await getReviewRecords(runId, `?nodeId=a&verbose=1`);
    expect(extra.status).toBe(400);
  });

  it("the route is read-only: POST answers 405 with the Allow header", async () => {
    const { runId } = await freshRun();
    const response = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/runs/${runId}/review-records?nodeId=a`,
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${String(server.port)}`,
        "x-csrf-token": server.csrfToken,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe("GET, HEAD");
  });

  it("the guard pipeline runs first: a tokenless request is 403", async () => {
    const { runId } = await freshRun();
    const response = await getReviewRecords(runId, `?nodeId=a`, {});
    expect(response.status).toBe(403);
  });
});
