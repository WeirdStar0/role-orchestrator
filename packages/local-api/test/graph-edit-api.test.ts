/**
 * M5-01 graph-edit API over REAL HTTP (the same rawRequest matrix the A30
 * tests use): the run-graph view, the graphRevision optimistic lock (A38,
 * 409), the running-node refusal (A38 前半), the A08-before-persist gate,
 * the A02 API-layer override rejection, and the "an edit never starts an
 * execution" property. Every response below came from a live
 * `startLocalApiServer` socket — no handler was called directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { transitionNodeState } from "@role-orchestrator/dag";
import {
  T0,
  createGraphEditTestDb,
  rawRequest,
  seedEditableRun,
  type EditableRunSeed
} from "./helpers.js";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createGraphEditTestDb>;

beforeAll(async () => {
  dbHandle = createGraphEditTestDb("edit-api");
  server = await startLocalApiServer({ db: dbHandle.db, tokenFile: undefined });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

const db: () => DatabaseSync = () => dbHandle.db;

let runCounter = 0;

/** A fresh edit-enabled run per test: each starts at revision 0 (baseline). */
async function freshRun(): Promise<EditableRunSeed> {
  runCounter += 1;
  return seedEditableRun(db(), { runId: `run-edit-${String(runCounter)}` });
}

function authed(port: number): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    origin: `http://127.0.0.1:${String(port)}`,
    "x-csrf-token": server.csrfToken,
    "content-type": "application/json"
  };
}

function getGraph(runId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    path: `/api/v1/runs/${runId}/graph`,
    headers: { authorization: `Bearer ${server.token}` }
  }).then((response) => ({ status: response.status, body: JSON.parse(response.body) as Record<string, unknown> }));
}

function postEdit(
  runId: string,
  body: unknown,
  headerOverrides: Record<string, string | undefined> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    method: "POST",
    path: `/api/v1/runs/${runId}/graph/edits`,
    headers: { ...authed(server.port), ...headerOverrides },
    body: typeof body === "string" ? body : JSON.stringify(body)
  }).then((response) => ({ status: response.status, body: JSON.parse(response.body) as Record<string, unknown> }));
}

function revisionRows(runId: string): { revision: number; source: string }[] {
  return (db().prepare(
    "SELECT revision, source FROM task_graph_revisions WHERE run_id = ? ORDER BY revision ASC"
  ).all(runId) as Record<string, unknown>[]).map((row) => ({
    revision: Number(row["revision"]),
    source: String(row["source"])
  }));
}

function currentRevision(runId: string): number {
  const row = db().prepare("SELECT graph_revision FROM task_runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error(`run ${runId} vanished`);
  return Number(row["graph_revision"]);
}

function nodeDeps(runId: string, nodeId: string): string[] {
  const row = db().prepare("SELECT dependencies FROM task_nodes WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error(`node ${nodeId} vanished`);
  return JSON.parse(String(row["dependencies"])) as string[];
}

function executionCount(runId: string): number {
  return Number(
    (db().prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = ?").get(runId) as Record<string, unknown>)["n"]
  );
}

describe("GET /api/v1/runs/:runId/graph (the canvas view)", () => {
  it("serves the graph with nodes, editable flags and the current revision", async () => {
    const seed = await freshRun();
    const response = await getGraph(seed.runId);
    expect(response.status).toBe(200);
    const graph = response.body["graph"] as Record<string, unknown>;
    expect(graph["graphRevision"]).toBe(0);
    expect(graph["editableNodeStates"]).toEqual(["PENDING", "READY", "BLOCKED"]);
    const nodes = graph["nodes"] as Record<string, unknown>[];
    expect(nodes).toHaveLength(3);
    const byId = new Map(nodes.map((node) => [String(node["nodeId"]), node]));
    expect(byId.get("a")).toMatchObject({ state: "READY", editable: true, role: "coordinator" });
    expect(byId.get("b")).toMatchObject({ state: "PENDING", editable: true, dependencies: ["a"] });
    expect(byId.get("c")).toMatchObject({ state: "PENDING", editable: true, dependencies: ["b"] });
    // Objectives come from the recorded baseline definitions.
    expect(byId.get("b")?.["objective"]).toBe("objective-b");
  });

  it("404s an unknown run and rejects unknown query parameters", async () => {
    const missing = await rawRequest(server.port, {
      path: "/api/v1/runs/run-missing/graph",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(missing.status).toBe(404);
    const withQuery = await rawRequest(server.port, {
      path: `/api/v1/runs/run-missing/graph?extra=1`,
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(withQuery.status).toBe(400);
  });
});

describe("POST /api/v1/runs/:runId/graph/edits — happy path", () => {
  it("persists a dependency+objective edit as a NEW revision (history not rewritten)", async () => {
    const seed = await freshRun();
    const before = revisionRows(seed.runId);
    expect(before).toEqual([{ revision: 0, source: "initial" }]);

    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "c",
      patch: { dependencies: ["a"], objective: "审查 a 的产出" }
    });
    expect(response.status).toBe(200);
    expect(response.body["revision"]).toBe(1);

    // The live pointer moved, the node row moved, and history APPENDED.
    expect(currentRevision(seed.runId)).toBe(1);
    expect(nodeDeps(seed.runId, "c")).toEqual(["a"]);
    const rows = revisionRows(seed.runId);
    expect(rows).toEqual([
      { revision: 0, source: "initial" },
      { revision: 1, source: "ui-node-edit" }
    ]);
    // The baseline row is untouched — the original workflow is still there.
    const baselineRow = db().prepare(
      "SELECT workflow FROM task_graph_revisions WHERE run_id = ? AND revision = 0"
    ).get(seed.runId) as Record<string, unknown>;
    const baseline = JSON.parse(String(baselineRow["workflow"])) as { nodes: { id: string; dependencies: string[] }[] };
    expect(baseline.nodes.find((node) => node.id === "c")?.dependencies).toEqual(["b"]);

    // The view reflects the edit.
    const graph = await getGraph(seed.runId);
    const nodes = (graph.body["graph"] as Record<string, unknown>)["nodes"] as Record<string, unknown>[];
    const c = nodes.find((node) => node["nodeId"] === "c");
    expect(c).toMatchObject({ dependencies: ["a"], objective: "审查 a 的产出" });
  });

  it("edits a role within the four built-ins (resolved against the frozen snapshots)", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { role: "architect" }
    });
    expect(response.status).toBe(200);
    const node = response.body["node"] as Record<string, unknown>;
    expect(node["role"]).toBe("architect");
    const graph = await getGraph(seed.runId);
    const nodes = (graph.body["graph"] as Record<string, unknown>)["nodes"] as Record<string, unknown>[];
    expect(nodes.find((node2) => node2["nodeId"] === "b")?.["role"]).toBe("architect");
  });

  it("NEVER creates an execution or touches scheduling — an edit only persists", async () => {
    const seed = await freshRun();
    expect(executionCount(seed.runId)).toBe(0);
    const first = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { objective: "objective-b-2" }
    });
    expect(first.status).toBe(200);
    const second = await postEdit(seed.runId, {
      expectedGraphRevision: 1,
      nodeId: "c",
      patch: { objective: "objective-c-2" }
    });
    expect(second.status).toBe(200);
    expect(executionCount(seed.runId)).toBe(0);
    expect(currentRevision(seed.runId)).toBe(2);
  });
});

describe("A38 optimistic lock — stale graphRevision gets 409, history stays append-only", () => {
  it("refuses a revision the caller could not have seen and reports the current one", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 5,
      nodeId: "c",
      patch: { objective: "stale" }
    });
    expect(response.status).toBe(409);
    expect(response.body["error"]).toMatchObject({ code: "GRAPH_REVISION_CONFLICT" });
    const message = String((response.body["error"] as Record<string, unknown>)["message"]);
    expect(message).toContain("current revision of run");
    expect(currentRevision(seed.runId)).toBe(0);
    expect(revisionRows(seed.runId)).toHaveLength(1);
  });

  it("refuses a revision made stale by ANOTHER edit; the retry against current lands", async () => {
    const seed = await freshRun();
    const first = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { objective: "v2" }
    });
    expect(first.status).toBe(200);
    const stale = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "c",
      patch: { objective: "based on v1" }
    });
    expect(stale.status).toBe(409);
    expect(stale.body["error"]).toMatchObject({ code: "GRAPH_REVISION_CONFLICT" });
    const retry = await postEdit(seed.runId, {
      expectedGraphRevision: 1,
      nodeId: "c",
      patch: { objective: "based on v2" }
    });
    expect(retry.status).toBe(200);
    expect(retry.body["revision"]).toBe(2);
    expect(revisionRows(seed.runId)).toHaveLength(3);
  });
});

describe("A38 前半 — running and finished nodes refuse structural edits (typed 409)", () => {
  it("refuses an edit to a RUNNING node and leaves the graph untouched", async () => {
    const seed = await freshRun();
    transitionNodeState(db(), { runId: seed.runId, nodeId: "a", to: "RUNNING", now: T0 });
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "a",
      patch: { objective: "sneaky in-flight change" }
    });
    expect(response.status).toBe(409);
    expect(response.body["error"]).toMatchObject({ code: "NODE_NOT_EDITABLE" });
    const message = String((response.body["error"] as Record<string, unknown>)["message"]);
    expect(message).toContain("RUNNING");
    expect(currentRevision(seed.runId)).toBe(0);
    // The view marks the node as not editable for the canvas.
    const graph = await getGraph(seed.runId);
    const nodes = (graph.body["graph"] as Record<string, unknown>)["nodes"] as Record<string, unknown>[];
    expect(nodes.find((node) => node["nodeId"] === "a")).toMatchObject({ editable: false });
  });

  it("refuses an edit to a SUCCEEDED node", async () => {
    const seed = await freshRun();
    transitionNodeState(db(), { runId: seed.runId, nodeId: "a", to: "RUNNING", now: T0 });
    transitionNodeState(db(), { runId: seed.runId, nodeId: "a", to: "SUCCEEDED", now: T0 });
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "a",
      patch: { dependencies: [] }
    });
    expect(response.status).toBe(409);
    expect(response.body["error"]).toMatchObject({ code: "NODE_NOT_EDITABLE" });
  });
});

describe("A08 — the post-edit graph is rejected BEFORE any write", () => {
  it("refuses a dependency edit that would close a cycle", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { dependencies: ["c"] } // a -> b -> c -> b
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "DEPENDENCY_CYCLE" });
    expect(currentRevision(seed.runId)).toBe(0);
    expect(nodeDeps(seed.runId, "b")).toEqual(["a"]);
    expect(revisionRows(seed.runId)).toHaveLength(1);
  });

  it("refuses a self dependency", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { dependencies: ["b"] }
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "SELF_DEPENDENCY" });
    expect(revisionRows(seed.runId)).toHaveLength(1);
  });

  it("refuses a missing dependency", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "c",
      patch: { dependencies: ["ghost"] }
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "UNKNOWN_DEPENDENCY" });
    expect(revisionRows(seed.runId)).toHaveLength(1);
  });

  it("refuses a role outside the four built-ins at the API schema", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { role: "scrum-master" }
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "INPUT_REJECTED" });
    expect(revisionRows(seed.runId)).toHaveLength(1);
  });
});

describe("A02 — the API layer rejects model/Profile carriers (403) and other unknown fields (400)", () => {
  it("refuses a top-level model field with PROFILE_OVERRIDE_REJECTED", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      model: "claude-opus-4-6"
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatchObject({ code: "PROFILE_OVERRIDE_REJECTED" });
    expect(revisionRows(seed.runId)).toHaveLength(1);
  });

  it("refuses profileId inside the patch", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { profileId: "profile-graph", objective: "x" }
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatchObject({ code: "PROFILE_OVERRIDE_REJECTED" });
  });

  it("refuses an override carrier nested in a non-schema object before schema parsing", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { objective: "x" },
      metadata: { fallbackProfileId: "profile-graph" }
    });
    expect(response.status).toBe(403);
    expect(response.body["error"]).toMatchObject({ code: "PROFILE_OVERRIDE_REJECTED" });
  });

  it("refuses other unknown fields with a plain 400", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: { objective: "x", capabilityTags: ["hax"] }
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "INPUT_REJECTED" });
  });

  it("refuses an empty patch (no field would change)", async () => {
    const seed = await freshRun();
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "b",
      patch: {}
    });
    expect(response.status).toBe(400);
    expect(response.body["error"]).toMatchObject({ code: "INPUT_REJECTED" });
  });
});

describe("the guard pipeline and the session view wrap the edit endpoint", () => {
  it("demands the bearer token, the loopback Origin and the CSRF token", async () => {
    const seed = await freshRun();
    const noToken = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/runs/${seed.runId}/graph/edits`,
      headers: { origin: `http://127.0.0.1:${String(server.port)}`, "x-csrf-token": server.csrfToken },
      body: JSON.stringify({ expectedGraphRevision: 0, nodeId: "a", patch: { objective: "x" } })
    });
    expect(noToken.status).toBe(403);
    expect(noToken.body).toContain("TOKEN_REQUIRED");

    const crossOrigin = await postEdit(seed.runId, { expectedGraphRevision: 0, nodeId: "a", patch: { objective: "x" } }, {
      origin: "https://evil.example"
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body["error"]).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });

    const noCsrf = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/runs/${seed.runId}/graph/edits`,
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${String(server.port)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ expectedGraphRevision: 0, nodeId: "a", patch: { objective: "x" } })
    });
    expect(noCsrf.status).toBe(403);
    expect(JSON.parse(noCsrf.body)["error"]).toMatchObject({ code: "CSRF_REQUIRED" });
  });

  it("serves the session-bound CSRF token to the authenticated page only", async () => {
    const authedSession = await rawRequest(server.port, {
      path: "/api/v1/session",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(authedSession.status).toBe(200);
    const body = JSON.parse(authedSession.body) as Record<string, unknown>;
    expect(body["csrfToken"]).toBe(server.csrfToken);

    const anonymous = await rawRequest(server.port, { path: "/api/v1/session" });
    expect(anonymous.status).toBe(403);
  });
});

describe("runs without a recorded baseline refuse edits (composition-root contract)", () => {
  it("answers 409 GRAPH_BASELINE_MISSING while the view still renders", async () => {
    const seed = await seedEditableRun(db(), { runId: `run-nobaseline-${String(runCounter + 1)}`, recordBaseline: false });
    runCounter += 1;
    const response = await postEdit(seed.runId, {
      expectedGraphRevision: 0,
      nodeId: "a",
      patch: { objective: "x" }
    });
    expect(response.status).toBe(409);
    expect(response.body["error"]).toMatchObject({ code: "GRAPH_BASELINE_MISSING" });

    const graph = await getGraph(seed.runId);
    expect(graph.status).toBe(200);
    const nodes = (graph.body["graph"] as Record<string, unknown>)["nodes"] as Record<string, unknown>[];
    expect(nodes.find((node) => node["nodeId"] === "a")).toMatchObject({ objective: "", editable: true });
  });
});
