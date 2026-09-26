/**
 * M5-03 approval surface over REAL HTTP (A17): the view exposes EVERY
 * actionDigest constituent before a decision; approve/reject go through the
 * approval package's guarded transitions; a candidate-changed or expired
 * approval renders/is served as 已失效 and cannot be approved; decisions
 * never execute anything. Every response below came from a live
 * `startLocalApiServer` socket.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import {
  actionDigest,
  createApproval,
  type ActionDescriptor
} from "@role-orchestrator/approval";
import { openApprovalCheckpoint } from "@role-orchestrator/checkpoint";
import { createIntegrationRecord } from "@role-orchestrator/integration";
import { transitionNodeState } from "@role-orchestrator/dag";
import {
  T0,
  createM5TestDb,
  fakeSha40,
  rawRequest,
  seedEditableRun,
  seedTerminalExecution
} from "./helpers.js";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createM5TestDb>;

beforeAll(async () => {
  dbHandle = createM5TestDb("approval-view");
  server = await startLocalApiServer({ db: dbHandle.db, tokenFile: undefined });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

const db: () => DatabaseSync = () => dbHandle.db;

let runCounter = 0;

/** A fresh run (a -> b -> c, frozen snapshots, revision baseline) per test. */
async function freshRun(): Promise<{ runId: string; nodeIds: readonly string[] }> {
  runCounter += 1;
  const seed = await seedEditableRun(db(), { runId: `run-appr-${String(runCounter)}` });
  return { runId: seed.runId, nodeIds: seed.nodeIds };
}

let approvalCounter = 0;

interface ApprovalFixtureInput {
  readonly targetSha?: string | null;
  readonly baseSha?: string;
  readonly argv?: readonly string[];
  readonly ttlSeconds?: number;
}

function makeDescriptor(runId: string, input: ApprovalFixtureInput = {}): ActionDescriptor {
  return {
    runtime: "claude",
    argv: input.argv ?? ["claude", "--print", "integrate task output"],
    cwd: "h:/worktrees/run-appr-1/b/1",
    repo: {
      root: "h:/repos/proj-x",
      baseSha: input.baseSha ?? fakeSha40(`${runId}-base`),
      targetSha: input.targetSha === undefined ? fakeSha40(`${runId}-target`) : input.targetSha
    },
    profileRevision: "1",
    requiredPermissions: ["repo.read", "repo.write"],
    grantedPermissions: ["repo.read"],
    dimensions: ["write"],
    writeScope: "managed-worktree",
    requiredCapabilities: []
  };
}

async function seedApproval(
  runId: string,
  nodeId: string,
  input: ApprovalFixtureInput = {}
): Promise<{ approvalId: string; digest: string; descriptor: ActionDescriptor }> {
  approvalCounter += 1;
  const descriptor = makeDescriptor(runId, input);
  const result = createApproval(db(), {
    idempotencyKey: `idem-${runId}-${nodeId}-${String(approvalCounter)}`,
    action: descriptor,
    requestedBy: { runId, nodeId, attempt: 1 },
    ttlSeconds: input.ttlSeconds ?? 2_592_000,
    now: T0
  });
  return { approvalId: result.approval.id, digest: result.approval.actionDigest, descriptor };
}

function getApprovals(runId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return raw(`/api/v1/runs/${runId}/approvals`, {});
}

function raw(
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `Bearer ${server.token}` };
  if (options.method === "POST") {
    headers["origin"] = `http://127.0.0.1:${String(server.port)}`;
    headers["x-csrf-token"] = server.csrfToken;
    headers["content-type"] = "application/json";
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers[name] = value;
  }
  return rawRequest(server.port, {
    path,
    ...(options.method !== undefined ? { method: options.method } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    headers
  }).then((response) => ({
    status: response.status,
    body: JSON.parse(response.body) as Record<string, unknown>
  }));
}

function postDecision(
  approvalId: string,
  body: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  return raw(`/api/v1/approvals/${approvalId}/decision`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function firstApproval(body: Record<string, unknown>): Record<string, unknown> {
  const view = body["approval"] as Record<string, unknown>;
  const approvals = view["approvals"] as Record<string, unknown>[];
  expect(approvals.length).toBeGreaterThanOrEqual(1);
  return approvals[0] as Record<string, unknown>;
}

describe("GET /api/v1/runs/:runId/approvals — every digest constituent is visible (A17)", () => {
  it("serves the complete action essentials, the derived increments, the risk grade and the expiry", async () => {
    const { runId } = await freshRun();
    const targetSha = fakeSha40(`${runId}-t`);
    const baseSha = fakeSha40(`${runId}-b`);
    const { digest, descriptor } = await seedApproval(runId, "b", { targetSha, baseSha });

    const response = await getApprovals(runId);
    expect(response.status).toBe(200);
    const item = firstApproval(response.body);

    // The binding anchor itself.
    expect(item["actionDigest"]).toBe(digest);
    expect(item["actionDigest"]).toBe(actionDigest(descriptor));
    // The FULL action essentials (the ask's 构成要素全部可见).
    const action = item["action"] as Record<string, unknown>;
    expect(action["argv"]).toEqual(["claude", "--print", "integrate task output"]);
    expect(action["runtime"]).toBe("claude");
    expect(action["cwd"]).toBe("h:/worktrees/run-appr-1/b/1");
    expect(action["profileRevision"]).toBe("1");
    expect(action["requiredPermissions"]).toEqual(["repo.read", "repo.write"]);
    expect(action["grantedPermissions"]).toEqual(["repo.read"]);
    expect(action["dimensions"]).toEqual(["write"]);
    expect(action["writeScope"]).toBe("managed-worktree");
    expect(action["requiredCapabilities"]).toEqual([]);
    const repo = action["repo"] as Record<string, unknown>;
    expect(repo["root"]).toBe("h:/repos/proj-x");
    expect(repo["baseSha"]).toBe(baseSha);
    expect(repo["targetSha"]).toBe(targetSha);
    // The DERIVED 权限增量 (required minus granted).
    expect(item["permissionIncrements"]).toEqual(["repo.write"]);
    // Grading + expiry, visible before any decision.
    expect(item["riskGrade"]).toBe("high");
    expect(item["requiresApproval"]).toBe(true);
    expect(item["expiresAt"]).toBe("2026-10-22T00:00:00.000Z");
    expect(item["status"]).toBe("PENDING");
    expect(item["invalidations"]).toEqual([]);
    expect(item["actionable"]).toBe(true);
    const reasons = item["riskReasons"] as Record<string, unknown>[];
    expect(reasons.some((reason) => reason["code"] === "permission-elevation")).toBe(true);
  });

  it("links a checkpointed approval to its waiting checkpoint", async () => {
    const { runId, nodeIds } = await freshRun();
    const nodeId = nodeIds[1] ?? "b";
    seedTerminalExecution(db(), { executionId: `exec-${runId}`, runId, nodeId });
    // The checkpoint opens only from a RUNNING node (A19: RUNNING -> WAITING_APPROVAL).
    transitionNodeState(db(), { runId, nodeId, to: "READY", whereStateIn: ["PENDING"], now: T0 });
    transitionNodeState(db(), { runId, nodeId, to: "RUNNING", whereStateIn: ["READY"], now: T0 });
    const open = await openApprovalCheckpoint(db(), {
      executionId: `exec-${runId}`,
      proposal: {
        schemaVersion: 1,
        proposalId: `prop-${runId}`,
        action: {
          argv: ["claude", "--print", "continue the integration"],
          dimensions: ["write"],
          writeScope: "managed-worktree",
          requiredPermissions: ["repo.read", "repo.write"],
          requiredCapabilities: [],
          targetSha: fakeSha40(`${runId}-ckpt-target`),
          requiresInteractiveApproval: false
        },
        source: { eventType: "result_reported", sourceType: null, eventSeq: null, requestId: null }
      },
      cwd: "h:/worktrees/cwd",
      grantedPermissions: ["repo.read"],
      ttlSeconds: 2_592_000,
      now: T0
    });

    const response = await getApprovals(runId);
    expect(response.status).toBe(200);
    const item = firstApproval(response.body);
    expect(item["approvalId"]).toBe(open.approval.id);
    const checkpoint = item["checkpoint"] as Record<string, unknown>;
    expect(checkpoint["checkpointId"]).toBe(open.checkpoint.id);
    expect(checkpoint["nodeId"]).toBe(nodeId);
    expect(checkpoint["status"]).toBe("WAITING");
    expect(checkpoint["proposalId"]).toBe(`prop-${runId}`);
    expect(item["requestedBy"]).toMatchObject({ runId, nodeId, attempt: 1 });
  });

  it("404s an unknown run and rejects unknown query parameters", async () => {
    expect((await getApprovals("run-missing")).status).toBe(404);
    expect((await raw("/api/v1/runs/run-missing/approvals?extra=1", {})).status).toBe(400);
  });
});

describe("POST /api/v1/approvals/:approvalId/decision — approve and reject", () => {
  it("approves a live PENDING approval and the view reflects the decided state", async () => {
    const { runId } = await freshRun();
    const { approvalId } = await seedApproval(runId, "b");
    const response = await postDecision(approvalId, { decision: "approve", decidedBy: "user-a" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ approvalId, status: "APPROVED", decision: "approve", decidedBy: "user-a" });

    const item = firstApproval((await getApprovals(runId)).body);
    expect(item["status"]).toBe("APPROVED");
    expect(item["approvedBy"]).toBe("user-a");
    expect(item["invalidations"]).toEqual(["STATUS_APPROVED"]);
    expect(item["actionable"]).toBe(false);
  });

  it("rejects with a mandatory reason, recorded on the row", async () => {
    const { runId } = await freshRun();
    const { approvalId } = await seedApproval(runId, "b");
    const withoutReason = await postDecision(approvalId, { decision: "reject", decidedBy: "user-a" });
    expect(withoutReason.status).toBe(400);

    const response = await postDecision(approvalId, { decision: "reject", decidedBy: "user-a", reason: "目标 SHA 已过期" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "REJECTED", decision: "reject" });

    const item = firstApproval((await getApprovals(runId)).body);
    expect(item["status"]).toBe("REJECTED");
    expect(item["rejectionReason"]).toBe("目标 SHA 已过期");
    expect(item["actionable"]).toBe(false);
  });

  it("refuses a second decision (single-shot; the state gate answers 409)", async () => {
    const { runId } = await freshRun();
    const { approvalId } = await seedApproval(runId, "b");
    expect((await postDecision(approvalId, { decision: "approve", decidedBy: "user-a" })).status).toBe(200);
    const again = await postDecision(approvalId, { decision: "approve", decidedBy: "user-a" });
    expect(again.status).toBe(409);
    expect((again.body["error"] as Record<string, unknown>)["code"]).toBe("APPROVAL_INVALIDATED");
    expect((await postDecision(approvalId, { decision: "reject", decidedBy: "user-a", reason: "x" })).status).toBe(409);
  });

  it("refuses unknown approvals with 404 and override carriers with 403 (A02)", async () => {
    const missing = await postDecision("approval-missing", { decision: "approve", decidedBy: "user-a" });
    expect(missing.status).toBe(404);

    const override = await postDecision("approval-missing", {
      decision: "approve",
      decidedBy: "user-a",
      model: "override-x"
    });
    expect(override.status).toBe(403);
    expect((override.body["error"] as Record<string, unknown>)["code"]).toBe("PROFILE_OVERRIDE_REJECTED");
  });

  it("keeps the guard pipeline in front of the endpoint (no CSRF -> 403)", async () => {
    const { runId } = await freshRun();
    const { approvalId } = await seedApproval(runId, "b");
    const response = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/approvals/${approvalId}/decision`,
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${String(server.port)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ decision: "approve", decidedBy: "user-a" })
    });
    expect(response.status).toBe(403);
  });

  it("a decision never executes anything: no execution row appears", async () => {
    const { runId } = await freshRun();
    const { approvalId } = await seedApproval(runId, "b");
    await postDecision(approvalId, { decision: "approve", decidedBy: "user-a" });
    const count = Number(
      (db().prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = ?").get(runId) as Record<string, unknown>)["n"]
    );
    expect(count).toBe(0);
    // The approval is APPROVED, not CONSUMED — consumption stays with the
    // checkpoint continuation (A17/A18 digest gate, unchanged).
    const status = String(
      (db().prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as Record<string, unknown>)["status"]
    );
    expect(status).toBe("APPROVED");
  });
});

describe("A17 invalidation — 候选 SHA 已变化的审批显示「已失效」且不可批准", () => {
  it("marks a candidate-changed approval 已失效 and refuses approval with 409 + currentCandidateSha", async () => {
    const { runId } = await freshRun();
    const targetSha = fakeSha40(`${runId}-old-target`);
    const { approvalId } = await seedApproval(runId, "b", { targetSha });

    // The node's integration moved on to a DIFFERENT candidate.
    createIntegrationRecord(db(), {
      id: `integ-${runId}-b`,
      manifest: {
        schemaVersion: 1,
        integrationId: `integ-${runId}`,
        runId,
        nodeId: "b",
        repoPath: "h:/repos/proj-x",
        integrationBranch: `task/${runId}`,
        integrationWorktreePath: "h:/worktrees/_integration/x",
        baseSha: fakeSha40(`${runId}-base`),
        parents: [{ nodeId: "a", branch: `exec/${runId}/a/1`, headSha: fakeSha40(`${runId}-p`) }],
        candidateSha: null,
        createdAt: T0
      },
      now: T0
    });
    const newCandidate = fakeSha40(`${runId}-new-candidate`);
    db().prepare(
      "UPDATE integration_records SET candidate_sha = ?, state = 'COMPLETED' WHERE run_id = ? AND node_id = 'b'"
    ).run(newCandidate, runId);

    // The VIEW shows the invalidation, not a live approval.
    const view = firstApproval((await getApprovals(runId)).body);
    expect(view["currentCandidateSha"]).toBe(newCandidate);
    expect(view["invalidations"]).toContain("CANDIDATE_CHANGED");
    expect(view["actionable"]).toBe(false);

    // The ENDPOINT refuses the approval BEFORE the CAS (A17 UI/API 呈现).
    const refused = await postDecision(approvalId, { decision: "approve", decidedBy: "user-a" });
    expect(refused.status).toBe(409);
    expect((refused.body["error"] as Record<string, unknown>)["code"]).toBe("APPROVAL_INVALIDATED");
    expect(refused.body["currentCandidateSha"]).toBe(newCandidate);

    // The row itself was never flipped.
    const status = String(
      (db().prepare("SELECT status FROM approvals WHERE id = ?").get(approvalId) as Record<string, unknown>)["status"]
    );
    expect(status).toBe("PENDING");

    // Rejecting a stale candidate is the safe direction and stays possible.
    const rejected = await postDecision(approvalId, { decision: "reject", decidedBy: "user-a", reason: "候选已变化" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: "REJECTED" });
  });

  it("refuses approving an expired approval with 409 APPROVAL_EXPIRED and the view shows 已失效", async () => {
    const { runId } = await freshRun();
    // ttl 1s from the fixed T0 — long past against the real clock.
    const { approvalId } = await seedApproval(runId, "b", { ttlSeconds: 1 });

    const view = firstApproval((await getApprovals(runId)).body);
    expect(view["invalidations"]).toContain("EXPIRED");
    expect(view["actionable"]).toBe(false);

    const refused = await postDecision(approvalId, { decision: "approve", decidedBy: "user-a" });
    expect(refused.status).toBe(409);
    expect((refused.body["error"] as Record<string, unknown>)["code"]).toBe("APPROVAL_EXPIRED");
  });
});
