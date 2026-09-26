/**
 * M5-03 context surface over REAL HTTP: the bundle fragment inventory (layer,
 * source, trust, truncation marker) and the per-fragment traceFragment
 * provenance, served from bundles assembled and persisted through the REAL
 * @role-orchestrator/context machinery (M3-01/M3-03 data face -> M5-03 view).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import {
  assembleContextBundle,
  persistContextBundle,
  traceFragment
} from "@role-orchestrator/context";
import { CommitShaSchema, createIntegrationRecord } from "@role-orchestrator/integration";
import { T0, createM5TestDb, fakeSha40, rawRequest, seedEditableRun } from "./helpers.js";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createM5TestDb>;

beforeAll(async () => {
  dbHandle = createM5TestDb("context-view");
  server = await startLocalApiServer({ db: dbHandle.db, tokenFile: undefined });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

const db: () => DatabaseSync = () => dbHandle.db;

let runCounter = 0;

/** Assemble + persist one bundle for node `a` of a fresh run. */
async function seedBundle(input: {
  budgetBytes?: number | null;
  withMemory?: boolean;
}): Promise<{ runId: string; bundleId: string }> {
  runCounter += 1;
  const runId = `run-ctx-${String(runCounter)}`;
  await seedEditableRun(db(), { runId });
  const bundle = assembleContextBundle(db(), {
    projectId: `proj-${runId}`,
    runId,
    nodeId: "a",
    node: {
      id: "a",
      role: "coordinator",
      title: "title-a",
      objective: "objective-a",
      dependencies: [],
      capabilityTags: ["planning"],
      acceptanceCriteria: ["criteria-a"]
    },
    roleResponsibility: "coordinator 负责澄清任务与按权限创建子任务。",
    projectRules: [
      { ruleId: "rule-security", revision: 3, content: "安全规则：审批 UI 不得诱导全局放权。" },
      { ruleId: "rule-scope", revision: 1, content: "范围规则：一个 Execution 对应一个可追溯工作项。" }
    ],
    dependencies: [],
    ...(input.withMemory === true
      ? {
          memoryEntries: [
            {
              memoryId: "mem-decisions",
              version: 4,
              content: "项目事实：2026-09 决定集成分支命名保持 task/<run-id>。",
              sourceSha: null,
              stale: false,
              staleReason: null
            }
          ]
        }
      : {}),
    budgetBytes: input.budgetBytes ?? null
  });
  const persisted = persistContextBundle(db(), bundle, T0);
  return { runId, bundleId: persisted.id };
}

/** A bundle whose dependency layer is real (integration record + parent SHA). */
async function seedBundleWithDependency(): Promise<{ runId: string; bundleId: string }> {
  runCounter += 1;
  const runId = `run-ctxdep-${String(runCounter)}`;
  await seedEditableRun(db(), { runId });
  const depSha = CommitShaSchema.parse(fakeSha40(`${runId}-dep-output`));
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
      parents: [{ nodeId: "a", branch: `exec/${runId}/a/1`, headSha: depSha }],
      candidateSha: null,
      createdAt: T0
    },
    now: T0
  });
  const bundle = assembleContextBundle(db(), {
    projectId: `proj-${runId}`,
    runId,
    nodeId: "b",
    node: {
      id: "b",
      role: "developer",
      title: "title-b",
      objective: "objective-b",
      dependencies: ["a"],
      capabilityTags: ["backend"],
      acceptanceCriteria: ["criteria-b"]
    },
    roleResponsibility: "developer 在授权工作树内实现与测试。",
    projectRules: [],
    dependencies: [
      {
        sourceNodeId: "a",
        commitSha: depSha,
        content: "依赖产物：a 的输出（verified-evidence，绑定 SHA）。"
      }
    ],
    budgetBytes: null
  });
  const persisted = persistContextBundle(db(), bundle, T0);
  return { runId, bundleId: persisted.id };
}

function getContexts(runId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return rawRequest(server.port, {
    path: `/api/v1/runs/${runId}/contexts`,
    headers: { authorization: `Bearer ${server.token}` }
  }).then((response) => ({
    status: response.status,
    body: JSON.parse(response.body) as Record<string, unknown>
  }));
}

describe("GET /api/v1/runs/:runId/contexts — the fragment inventory with trust + truncation", () => {
  it("lists fragments with layer, trust, source provenance and the traceFragment record", async () => {
    const { runId, bundleId } = await seedBundleWithDependency();
    const response = await getContexts(runId);
    expect(response.status).toBe(200);
    const view = response.body["context"] as Record<string, unknown>;
    expect(view["runId"]).toBe(runId);
    const bundles = view["bundles"] as Record<string, unknown>[];
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0] as Record<string, unknown>;
    expect(bundle["bundleId"]).toBe(bundleId);
    expect(bundle["nodeId"]).toBe("b");
    expect(bundle["roleId"]).toBe("developer");
    expect(bundle["budgetMethod"]).toBe("estimated-bytes");

    const fragments = bundle["fragments"] as Record<string, unknown>[];
    expect(fragments).toHaveLength(3); // role + task + dependency (no rules)
    const byLayer = new Map(fragments.map((f) => [String(f["layer"]), f]));

    const role = byLayer.get("role") as Record<string, unknown>;
    expect(role["trust"]).toBe("policy");
    expect(role["layerPriority"]).toBe(1);
    expect(role["included"]).toBe(true);
    const roleSource = role["source"] as Record<string, unknown>;
    expect(roleSource["kind"]).toBe("role_binding");

    const task = byLayer.get("task") as Record<string, unknown>;
    expect(task["trust"]).toBe("policy");
    expect((task["source"] as Record<string, unknown>)["kind"]).toBe("task_node");

    const dependency = byLayer.get("dependency") as Record<string, unknown>;
    expect(dependency["trust"]).toBe("verified-evidence");
    const depSource = dependency["source"] as Record<string, unknown>;
    expect(depSource["kind"]).toBe("dependency_output");
    expect(depSource["commitSha"]).toBeTruthy();

    // The trace section is the context package's OWN traceFragment output.
    const trace = dependency["trace"] as Record<string, unknown>;
    const expected = traceFragment(db(), { bundleId, sequence: Number(dependency["sequence"]) });
    expect(trace).toMatchObject({
      bundleId,
      projectId: `proj-${runId}`,
      runId,
      nodeId: "b",
      sequence: expected.sequence,
      layer: "dependency",
      contentHash: expected.contentHash,
      included: true,
      omittedReason: null
    });
  });

  it("marks truncation with omittedReason (never silent) and keeps rules uncut", async () => {
    // Budget smaller than the content: memory + task get dropped, rules never.
    const { runId } = await seedBundle({ budgetBytes: 260, withMemory: true });
    const response = await getContexts(runId);
    expect(response.status).toBe(200);
    const bundle = ((response.body["context"] as Record<string, unknown>)["bundles"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(bundle).toBeTruthy();
    const fragments = bundle["fragments"] as Record<string, unknown>[];
    const kept = fragments.filter((f) => f["included"] === true);
    const omitted = fragments.filter((f) => f["included"] === false);
    // 安全与项目规则 are never dropped; the lowest-priority layers are.
    expect(kept.filter((f) => f["layer"] === "project_rule")).toHaveLength(2);
    expect(omitted.map((f) => f["layer"])).toContain("memory");
    expect(omitted.length).toBeGreaterThanOrEqual(1);
    for (const fragment of omitted) {
      expect(fragment["omittedReason"]).toBe("budget-bytes-exceeded");
      const trace = fragment["trace"] as Record<string, unknown>;
      expect(trace["omittedReason"]).toBe("budget-bytes-exceeded");
    }
    expect(bundle["budgetExceeded"]).toBe(false);
    expect(bundle["omittedReasons"]).toEqual(["budget-bytes-exceeded"]);
  });

  it("serves memory fragments as untrusted-content (A16: memory is DATA)", async () => {
    const { runId } = await seedBundle({ withMemory: true });
    const response = await getContexts(runId);
    const bundle = ((response.body["context"] as Record<string, unknown>)["bundles"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(bundle).toBeTruthy();
    const fragments = bundle["fragments"] as Record<string, unknown>[];
    const memory = fragments.find((f) => f["layer"] === "memory") as Record<string, unknown>;
    expect(memory).toBeTruthy();
    expect(memory["trust"]).toBe("untrusted-content");
    expect((memory["source"] as Record<string, unknown>)["kind"]).toBe("memory_entry");
  });

  it("returns an empty inventory for a run without bundles and 404s unknown runs", async () => {
    runCounter += 1;
    const runId = `run-ctxempty-${String(runCounter)}`;
    await seedEditableRun(db(), { runId });
    const empty = await getContexts(runId);
    expect(empty.status).toBe(200);
    expect(((empty.body["context"] as Record<string, unknown>)["bundles"] as unknown[])).toHaveLength(0);

    const missing = await getContexts("run-missing");
    expect(missing.status).toBe(404);
    const withQuery = await rawRequest(server.port, {
      path: `/api/v1/runs/run-missing/contexts?extra=1`,
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(withQuery.status).toBe(400);
  });
});
