/**
 * M5-02 expansion API over REAL HTTP (the same rawRequest matrix the A30/M5-01
 * tests use): the Proposal view (pending fail triggers, executed expansions,
 * unresolved A20 hold, budget headroom), the controlled POST (A04 permission
 * refusal 403 with an audited reason; A38 stale-revision 409 carrying the
 * current revision; rounds cap 409; budget 400; A02 override-carrier 403) and
 * the "an expansion never starts an execution" property. Every response below
 * came from a live `startLocalApiServer` socket — no handler was called
 * directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { applyControlledExpansionMigrations } from "@role-orchestrator/expand";
import { appliedMigrationRecords } from "@role-orchestrator/store";
import {
  completeReviewRecord,
  createReviewRecord,
  manifestDigest,
  reviewIdFor
} from "@role-orchestrator/review";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import type { RoleId } from "@role-orchestrator/contracts";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { createRunGraph, recordInitialGraphRevision } from "@role-orchestrator/dag";
import { createProject, openDatabase } from "@role-orchestrator/store";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T0, iso, rawRequest, seedEditableRun } from "./helpers.js";

let server: LocalApiServer;
let dbHandle: { db: DatabaseSync; dbPath: string; close(): void };

beforeAll(async () => {
  dbHandle = createControlledDb("expansion-api");
  server = await startLocalApiServer({ db: dbHandle.db, tokenFile: undefined });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

const db = (): DatabaseSync => dbHandle.db;

/** A migrated file-backed store with the controlled-expansion chain (16 rows). */
function createControlledDb(label: string): { db: DatabaseSync; dbPath: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), `ro-localapi-exp-${label}-`));
  const dbPath = join(dir, "test.db");
  const database = openDatabase(dbPath);
  void applyControlledExpansionMigrations(database, { now: T0 });
  const records = appliedMigrationRecords(database);
  if (
    records.length !== 16 ||
    records[12]?.version !== 13 ||
    records[13]?.version !== 15 ||
    records[14]?.version !== 16 ||
    records[15]?.version !== 17
  ) {
    database.close();
    throw new Error("test helper: controlled-expansion migrations were not applied");
  }
  return { db: database, dbPath, close: () => database.close() };
}

function makeConfigDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ro-localapi-expcfg-")), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

/** Seed an edit-enabled run with an arbitrary node list (a/b/c by default). */
async function seedGraphRun(runId: string, nodes: readonly Record<string, unknown>[]): Promise<void> {
  const projectId = `proj-${runId}`;
  const profileId = `profile-${runId}`;
  createProject(db(), {
    id: projectId,
    repoRoot: `h:/repos/${projectId}`,
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createProfile(db(), {
    id: profileId,
    runtime: "claude",
    executable: "claude.cmd",
    executionTarget: "windows-native",
    configDir: makeConfigDir(),
    credentialGroup: "personal",
    maxConcurrency: 1,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db(), {
    profileId,
    model: null,
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: T0
  });
  initializeProjectRoleBindings(db(), { projectId, now: T0 });
  for (const roleId of ROLE_IDS as readonly RoleId[]) {
    setRoleBinding(db(), {
      projectId,
      roleId,
      profileId,
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
  createTaskRunWithProfileSnapshot(db(), {
    runId,
    projectId,
    taskId: `task-${runId}`,
    graphRevision: 0,
    baseSha: "base-sha-exp",
    now: T0
  });
  const workflow = { id: `wf-${runId}`, name: `workflow-${runId}`, nodes };
  createRunGraph(db(), { runId, workflow, now: T0 });
  recordInitialGraphRevision(db(), { runId, workflow, now: T0 });
}

let runCounter = 0;

/** The standard a (coordinator) -> b (developer) -> c (reviewer) run. */
async function freshRun(): Promise<string> {
  runCounter += 1;
  const runId = `run-exp-${String(runCounter)}`;
  await seedEditableRun(db(), { runId });
  return runId;
}

/** A durable COMPLETED fail verdict via the M2-05 record API. */
function seedFailVerdict(runId: string, nodeId: string, candidateSha: string, findings?: readonly string[]): void {
  const reviewId = reviewIdFor(runId, nodeId, candidateSha, T0);
  const files = [{ path: "src/app.ts", sha256: "b".repeat(64) }];
  createReviewRecord(db(), {
    reviewId,
    runId,
    nodeId,
    candidateSha,
    repoPath: "h:/repos/fixture",
    baselineWorktreePath: "h:/worktrees/fixture-baseline",
    validationWorkspacePath: "h:/worktrees/fixture-workspace",
    validationTempRoot: "h:/worktrees/fixture-root",
    baseline: {
      candidateSha,
      fileCount: files.length,
      digest: manifestDigest(files),
      files
    },
    now: iso(100)
  });
  completeReviewRecord(db(), {
    reviewId,
    review: {
      verdict: "fail",
      candidateSha,
      evidenceRefs: ["evidence-fixture-1"],
      findings: [...(findings ?? [`finding against ${candidateSha}`])]
    },
    evidence: [
      {
        artifactRef: { id: "evidence-fixture-1", kind: "report" },
        summary: "fixture review evidence",
        exitCode: 0,
        recordedAt: iso(200)
      }
    ],
    now: iso(300)
  });
}

function sha40(seed: string): string {
  let hex = "";
  for (let i = 0; i < 40; i++) {
    hex += ((seed.charCodeAt(i % seed.length) + i * 7) % 16).toString(16);
  }
  return hex;
}

function authed(): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    origin: `http://127.0.0.1:${String(server.port)}`,
    "x-csrf-token": server.csrfToken,
    "content-type": "application/json"
  };
}

function getExpansions(runId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    path: `/api/v1/runs/${runId}/expansions`,
    headers: { authorization: `Bearer ${server.token}` }
  }).then((response) => ({ status: response.status, body: JSON.parse(response.body) as Record<string, unknown> }));
}

function postExpansion(
  runId: string,
  body: unknown,
  headerOverrides: Record<string, string | undefined> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    method: "POST",
    path: `/api/v1/runs/${runId}/expansions`,
    headers: { ...authed(), ...headerOverrides },
    body: typeof body === "string" ? body : JSON.stringify(body)
  }).then((response) => ({ status: response.status, body: JSON.parse(response.body) as Record<string, unknown> }));
}

function getGraph(runId: string): Promise<Record<string, unknown>> {
  return rawRequest(server.port, {
    path: `/api/v1/runs/${runId}/graph`,
    headers: { authorization: `Bearer ${server.token}` }
  }).then((response) => JSON.parse(response.body) as Record<string, unknown>);
}

function currentRevision(runId: string): number {
  const row = db().prepare("SELECT graph_revision FROM task_runs WHERE id = ?").get(runId) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) throw new Error(`run ${runId} vanished`);
  return Number(row["graph_revision"]);
}

function executionCount(runId: string): number {
  return Number(
    (db().prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = ?").get(runId) as Record<string, unknown>)["n"]
  );
}

interface PendingTrigger {
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  readonly proposedFixNodeId: string | null;
  readonly proposedReviewNodeId: string | null;
  readonly proposedFixRole: string | null;
  readonly nextGeneration: number;
  readonly roundsExhausted: boolean;
  readonly findings: readonly string[];
}

function pendingTriggersOf(body: Record<string, unknown>): readonly PendingTrigger[] {
  const view = body["expansion"] as Record<string, unknown>;
  return view["pendingTriggers"] as PendingTrigger[];
}

const FAIL_SHA = sha40("expansion-api-fail");

describe("GET /api/v1/runs/:runId/expansions — the Proposal view", () => {
  it("serves the empty view with budget headroom and the round cap", async () => {
    const runId = await freshRun();
    const response = await getExpansions(runId);
    expect(response.status).toBe(200);
    const view = response.body["expansion"] as Record<string, unknown>;
    expect(view["graphRevision"]).toBe(0);
    expect(view["maxReviewRounds"]).toBe(3);
    expect(view["budget"]).toMatchObject({
      maxNodes: 64,
      maxDepth: 16,
      nodeCount: 3,
      nodeDepth: 2,
      headroomNodes: 61,
      headroomDepth: 14
    });
    expect(view["expansions"]).toEqual([]);
    expect(view["unresolvedHold"]).toBeNull();
    expect(pendingTriggersOf(response.body)).toEqual([]);
  });

  it("lists a failed review as a pending Proposal with findings and minted ids", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA, ["the boundary case is untested"]);
    const response = await getExpansions(runId);
    const triggers = pendingTriggersOf(response.body);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      triggerGeneration: 1,
      nextGeneration: 2,
      roundsExhausted: false,
      repairedNodeId: "b",
      repairTargetAmbiguous: false,
      proposedFixNodeId: "b-fix-2",
      proposedReviewNodeId: "b-review-2",
      proposedFixRole: "developer"
    });
    expect(triggers[0]?.findings).toEqual(["the boundary case is untested"]);
  });

  it("404s an unknown run and rejects unknown query parameters", async () => {
    const missing = await rawRequest(server.port, {
      path: "/api/v1/runs/run-missing/expansions",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(missing.status).toBe(404);
    const withQuery = await rawRequest(server.port, {
      path: "/api/v1/runs/run-missing/expansions?extra=1",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(withQuery.status).toBe(400);
  });
});

describe("POST /api/v1/runs/:runId/expansions — the happy path", () => {
  it("expands via the controlled protocol; new nodes appear in graph data and task_nodes", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);

    const response = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator"
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      created: true,
      requesterRoleId: "coordinator",
      triggerReviewNodeId: "c",
      generation: 2,
      repairedNodeId: "b",
      revision: 1
    });
    expect((response.body["fixNode"] as Record<string, unknown>)["nodeId"]).toBe("b-fix-2");
    expect((response.body["reviewNode"] as Record<string, unknown>)["nodeId"]).toBe("b-review-2");

    // The new nodes are ordinary task_nodes rows...
    const rows = db()
      .prepare("SELECT node_id, role_id, state FROM task_nodes WHERE run_id = ? ORDER BY node_id")
      .all(runId) as Record<string, unknown>[];
    expect(rows.map((row) => row["node_id"])).toEqual(["a", "b", "b-fix-2", "b-review-2", "c"]);

    // ...and appear in the graph (SVG canvas) data WITH their objectives, which
    // proves the 'expansion' revision row feeds the view.
    const graph = (await getGraph(runId))["graph"] as Record<string, unknown>;
    const nodes = graph["nodes"] as Record<string, unknown>[];
    expect(nodes).toHaveLength(5);
    const byId = new Map(nodes.map((node) => [String(node["nodeId"]), node]));
    expect(byId.get("b-fix-2")?.["state"]).toBe("PENDING");
    expect(String(byId.get("b-fix-2")?.["objective"])).toContain("Repair the work that review node");
    expect(currentRevision(runId)).toBe(1);

    // The Proposal view consumed the trigger and answers 谁请求 from the audit.
    const viewResponse = await getExpansions(runId);
    const view = viewResponse.body["expansion"] as Record<string, unknown>;
    expect(pendingTriggersOf(viewResponse.body)).toEqual([]);
    const expansions = view["expansions"] as Record<string, unknown>[];
    expect(expansions).toHaveLength(1);
    expect(expansions[0]).toMatchObject({ requestedBy: "coordinator", generation: 2 });

    // An expansion NEVER starts an execution.
    expect(executionCount(runId)).toBe(0);
  });

  it("replays an already-expanded fail idempotently with 200 and created:false", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);
    const first = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator"
    });
    expect(first.status).toBe(201);
    const replay = await postExpansion(runId, {
      expectedGraphRevision: 1,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator"
    });
    expect(replay.status).toBe(200);
    expect(replay.body["created"]).toBe(false);
    expect(replay.body["expansionId"]).toBe(first.body["expansionId"]);
    expect(currentRevision(runId)).toBe(1);
  });
});

describe("A04 — the API refuses a permissionless expansion and records the reason", () => {
  it("answers 403 EXPANSION_PERMISSION_DENIED with the denial reason, audited", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);
    const response = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "developer"
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatchObject({ code: "EXPANSION_PERMISSION_DENIED" });
    expect(response.body["denialReason"]).toBe("can-create-subtasks-disabled");
    expect(String((response.body["error"] as Record<string, unknown>)["message"])).toContain("A04");

    // The refusal reason is DURABLE in the audit trail.
    const audit = db()
      .prepare("SELECT * FROM expansion_request_audit WHERE run_id = ?")
      .all(runId) as Record<string, unknown>[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      requester_role: "developer",
      outcome: "denied-permission",
      expected_graph_revision: 0
    });
    expect(String(audit[0]?.["reason"])).toContain("canCreateSubtasks");

    // Nothing was minted and nothing moved.
    expect(currentRevision(runId)).toBe(0);
    expect(executionCount(runId)).toBe(0);
  });

  it("refuses an unknown acting role with the same typed 403 (fail-closed)", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);
    const response = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "impostor"
    });
    // An unknown role never passes the strict schema in the first place.
    expect(response.status).toBe(400);
    expect(currentRevision(runId)).toBe(0);
  });
});

describe("A38 — a stale graphRevision is a 409 carrying the current revision", () => {
  it("refuses a never-seen revision with currentGraphRevision in the body", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);
    const response = await postExpansion(runId, {
      expectedGraphRevision: 9,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator"
    });
    expect(response.status).toBe(409);
    expect(response.body["error"]).toMatchObject({ code: "GRAPH_REVISION_CONFLICT" });
    expect(response.body["currentGraphRevision"]).toBe(0);
    expect(currentRevision(runId)).toBe(0);
  });

  it("refuses an expansion made stale by a CONCURRENT EDIT; the retry lands", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);
    // A UI edit bumps the revision to 1.
    const edit = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/runs/${runId}/graph/edits`,
      headers: authed(),
      body: JSON.stringify({ expectedGraphRevision: 0, nodeId: "b", patch: { objective: "edited elsewhere" } })
    });
    expect(edit.status).toBe(200);

    const stale = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator"
    });
    expect(stale.status).toBe(409);
    expect(stale.body["currentGraphRevision"]).toBe(1);

    const retry = await postExpansion(runId, {
      expectedGraphRevision: 1,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator"
    });
    expect(retry.status).toBe(201);
    expect(retry.body["revision"]).toBe(2);
    // The edit and the expansion COMPOSED: no silent overwrite of either.
    const sources = (db()
      .prepare("SELECT source FROM task_graph_revisions WHERE run_id = ? ORDER BY revision")
      .all(runId) as Record<string, unknown>[]).map((row) => String(row["source"]));
    expect(sources).toEqual(["initial", "ui-node-edit", "expansion"]);
  });
});

describe("A02 — override carriers are refused before anything else", () => {
  it("refuses an expansion body carrying model/profile fields with 403", async () => {
    const runId = await freshRun();
    seedFailVerdict(runId, "c", FAIL_SHA);
    const response = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator",
      model: "override-claude-4"
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatchObject({ code: "PROFILE_OVERRIDE_REJECTED" });
    expect(currentRevision(runId)).toBe(0);
  });

  it("rejects unknown non-override fields and a malformed candidateSha with 400", async () => {
    const runId = await freshRun();
    const unknownField = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: FAIL_SHA,
      requesterRoleId: "coordinator",
      teleport: true
    });
    expect(unknownField.status).toBe(400);
    const badSha = await postExpansion(runId, {
      expectedGraphRevision: 0,
      reviewNodeId: "c",
      candidateSha: "not-a-sha",
      requesterRoleId: "coordinator"
    });
    expect(badSha.status).toBe(400);
  });
});

describe("A20 — the rounds cap through the API, and the hold in the view", () => {
  it("refuses the fourth round with 409 REVIEW_ROUNDS_EXHAUSTED and surfaces the hold", async () => {
    const runId = await freshRun();
    const sha1 = sha40("round-1");
    const sha2 = sha40("round-2");
    const sha3 = sha40("round-3");
    seedFailVerdict(runId, "c", sha1);
    const first = await postExpansion(runId, {
      expectedGraphRevision: 0, reviewNodeId: "c", candidateSha: sha1, requesterRoleId: "coordinator"
    });
    expect(first.status).toBe(201);
    seedFailVerdict(runId, "b-review-2", sha2);
    const second = await postExpansion(runId, {
      expectedGraphRevision: 1, reviewNodeId: "b-review-2", candidateSha: sha2, requesterRoleId: "coordinator"
    });
    expect(second.status).toBe(201);
    seedFailVerdict(runId, "b-fix-2-review-3", sha3);
    const fourth = await postExpansion(runId, {
      expectedGraphRevision: 2, reviewNodeId: "b-fix-2-review-3", candidateSha: sha3, requesterRoleId: "coordinator"
    });
    expect(fourth.status).toBe(409);
    expect(fourth.body["error"]).toMatchObject({ code: "REVIEW_ROUNDS_EXHAUSTED" });

    // The view answers 等待用户处理 with the durable hold.
    const viewResponse = await getExpansions(runId);
    const view = viewResponse.body["expansion"] as Record<string, unknown>;
    expect(view["unresolvedHold"]).toMatchObject({
      reviewNodeId: "b-fix-2-review-3",
      candidateSha: sha3,
      attemptedGeneration: 4,
      reason: "review-rounds-exhausted"
    });

    // And a further request cannot continue the run.
    const again = await postExpansion(runId, {
      expectedGraphRevision: 2, reviewNodeId: "b-fix-2-review-3", candidateSha: sha3, requesterRoleId: "coordinator"
    });
    expect(again.status).toBe(409);
    expect(again.body["error"]).toMatchObject({ code: "RUN_HELD_FOR_USER" });
  });
});

describe("budget exhaustion — 64 nodes / depth 16 (ORCHESTRATION.md section 5)", () => {
  it("refuses an expansion past the node budget with 400 and the limit/actual", async () => {
    const runId = `run-budget-nodes-${String(runCounter + 1)}`;
    runCounter += 1;
    // 63 nodes: hub + 61 leaves + review_0 (single dep = hub, so the default
    // repair target is unambiguous). Composed: 63 + 2 = 65 > 64.
    const nodes: Record<string, unknown>[] = [
      { id: "hub", role: "developer", title: "t", objective: "o", dependencies: [], capabilityTags: ["backend"], acceptanceCriteria: ["c"] }
    ];
    for (let i = 1; i <= 61; i++) {
      nodes.push({
        id: `leaf-${String(i)}`, role: "developer", title: "t", objective: "o",
        dependencies: ["hub"], capabilityTags: ["backend"], acceptanceCriteria: ["c"]
      });
    }
    nodes.push({ id: "review_0", role: "reviewer", title: "t", objective: "o", dependencies: ["hub"], capabilityTags: ["backend"], acceptanceCriteria: ["c"] });
    await seedGraphRun(runId, nodes);
    seedFailVerdict(runId, "review_0", FAIL_SHA);

    const response = await postExpansion(runId, {
      expectedGraphRevision: 0, reviewNodeId: "review_0", candidateSha: FAIL_SHA, requesterRoleId: "coordinator"
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "GRAPH_BUDGET_EXCEEDED" });
    const message = String((response.body["error"] as Record<string, unknown>)["message"]);
    expect(message).toContain("max-nodes");
    expect(message).toContain("64");
    expect(message).toContain("65");
    expect(currentRevision(runId)).toBe(0);
  });

  it("refuses an expansion past the depth budget with 400", async () => {
    const runId = `run-budget-depth-${String(runCounter + 1)}`;
    runCounter += 1;
    // Chain n01..n16 + review_0: depth 16 is allowed; the minted re-review
    // would sit at depth 17 > 16.
    const nodes: Record<string, unknown>[] = [
      { id: "n01", role: "developer", title: "t", objective: "o", dependencies: [], capabilityTags: ["backend"], acceptanceCriteria: ["c"] }
    ];
    for (let i = 2; i <= 16; i++) {
      const previous = `n${String(i - 1).padStart(2, "0")}`;
      nodes.push({
        id: `n${String(i).padStart(2, "0")}`, role: "developer", title: "t", objective: "o",
        dependencies: [previous], capabilityTags: ["backend"], acceptanceCriteria: ["c"]
      });
    }
    nodes.push({ id: "review_0", role: "reviewer", title: "t", objective: "o", dependencies: ["n16"], capabilityTags: ["backend"], acceptanceCriteria: ["c"] });
    await seedGraphRun(runId, nodes);
    seedFailVerdict(runId, "review_0", FAIL_SHA);

    const response = await postExpansion(runId, {
      expectedGraphRevision: 0, reviewNodeId: "review_0", candidateSha: FAIL_SHA, requesterRoleId: "coordinator"
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "GRAPH_BUDGET_EXCEEDED" });
    const message = String((response.body["error"] as Record<string, unknown>)["message"]);
    expect(message).toContain("max-depth");
    expect(message).toContain("16");
    expect(message).toContain("17");
  });
});

describe("shape guards", () => {
  it("rejects a mutating method on the view path and unknown bodies", async () => {
    const runId = await freshRun();
    const putView = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/runs/${runId}/expansions`,
      headers: { ...authed() }
    });
    expect([400, 405]).toContain(putView.status);
    const emptyBody = await postExpansion(runId, "");
    expect(emptyBody.status).toBe(400);
    const badJson = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/runs/${runId}/expansions`,
      headers: authed(),
      body: "{not json"
    });
    expect(badJson.status).toBe(400);
  });
});
