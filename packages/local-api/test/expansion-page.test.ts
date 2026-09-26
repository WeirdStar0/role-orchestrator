/**
 * M5-02 page tests: the SERVED app.js (the exact string the server sends) is
 * evaluated in a DOM-less sandbox and the pure rendering functions are
 * asserted snapshot-style — the Proposal card (findings, minted ids, role
 * selector without any model/Profile field, A02 UI layer), the budget line,
 * the A20 hold banner, hostile-text escaping, and the explicit 403/409
 * refusal texts (a revision conflict names the current revision and states
 * the request was discarded — never a silent overwrite).
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildStaticPageAssets } from "../src/index.js";

const assets = buildStaticPageAssets();

interface PageApi {
  esc(text: unknown): string;
  buildExpansionRequestPayload(
    reviewNodeId: string,
    candidateSha: string,
    expectedGraphRevision: number,
    fields: Record<string, unknown>
  ): Record<string, unknown>;
  expansionRequestFailureText(error: Record<string, unknown>): string;
  renderExpansionPanel(
    container: { innerHTML: string; hidden: boolean },
    view: Record<string, unknown>
  ): void;
  renderRunGraph(container: { innerHTML: string; hidden: boolean }, graph: unknown): void;
  ROLE_OPTIONS: readonly string[];
  EXPANSION_FIELD_ALLOWLIST: readonly string[];
}

function loadPageApi(): PageApi {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(assets.appJs, sandbox, { filename: "app.js" });
  const api = sandbox["__roleOrchestratorPage"] as PageApi | undefined;
  if (api === undefined) {
    throw new Error("served app.js did not expose __roleOrchestratorPage");
  }
  return api;
}

const EXPANSION_VIEW: Record<string, unknown> = {
  runId: "run-1",
  graphRevision: 4,
  runStatus: "RUNNING",
  maxReviewRounds: 3,
  budget: { maxNodes: 64, maxDepth: 16, nodeCount: 5, nodeDepth: 3, headroomNodes: 59, headroomDepth: 13 },
  unresolvedHold: null,
  expansions: [],
  pendingTriggers: [
    {
      reviewNodeId: "c",
      candidateSha: "a".repeat(40),
      triggerGeneration: 1,
      nextGeneration: 2,
      roundsExhausted: false,
      repairedNodeId: "b",
      repairTargetAmbiguous: false,
      directDependencies: ["b"],
      proposedFixNodeId: "b-fix-2",
      proposedReviewNodeId: "b-review-2",
      proposedFixRole: "developer",
      findings: ["边界用例未覆盖", "<script>alert('finding')</script>"]
    }
  ]
};

describe("the expansion section of the served page shell", () => {
  it("carries the expansion sections and keeps the no-inline-handler contract", () => {
    expect(assets.indexHtml).toContain('id="expansions"');
    expect(assets.indexHtml).toContain('id="expansion-panel"');
    expect(assets.indexHtml).toContain('id="load-expansions-button"');
    expect(assets.indexHtml).toContain("A04");
    expect(assets.indexHtml).toContain("A38");
    expect(assets.indexHtml).toContain("64 节点");
    expect(assets.indexHtml).not.toMatch(/\son(click|load|error|mouseover|submit)=/i);
  });
});

describe("renderExpansionPanel — the Proposal display", () => {
  const api = loadPageApi();

  it("renders budget headroom, the proposal card with findings and a four-role selector", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderExpansionPanel(container, EXPANSION_VIEW);
    const html = container.innerHTML;
    expect(container.hidden).toBe(false);

    // 预算余量 (budget headroom) is visible.
    expect(html).toContain("预算余量");
    expect(html).toContain("节点 5/64");
    expect(html).toContain("深度 3/16");
    expect(html).toContain("每链审查上限 3 轮");

    // The Proposal card: trigger, minted ids, requester selector (谁请求).
    expect(html).toContain("扩图 Proposal：审查节点 c");
    expect(html).toContain(`candidate ${"a".repeat(40)}`);
    expect(html).toContain("修复节点 b-fix-2");
    expect(html).toContain("（角色 developer）");
    expect(html).toContain("复审节点 b-review-2");
    expect(html).toContain("为什么 fail（审查 findings）");
    expect(html).toContain("<li>边界用例未覆盖</li>");
    expect(html).toContain('data-review-node-id="c"');
    expect(html).toContain(`data-candidate-sha="${"a".repeat(40)}"`);
    expect(html).toContain('data-expected-graph-revision="4"');
    expect(html).toContain('name="requesterRoleId"');
    expect(html.match(/<option /g)).toHaveLength(4);
    expect(html).toContain('value="coordinator"');
    expect(html).toContain("提交扩图请求");

    // The A02 pin: NO field named model/profile exists anywhere in the form.
    expect(html).not.toMatch(/name="(model|modelId|profile|profileId|profiles|fallbackProfileIds?)"/);
  });

  it("escapes hostile findings with NO live script surface (A36 语义延续)", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderExpansionPanel(container, EXPANSION_VIEW);
    const html = container.innerHTML;
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(&#39;finding&#39;)&lt;/script&gt;");
  });

  it("renders an explicit 等待用户处理 banner for the unresolved A20 hold", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderExpansionPanel(container, {
      ...EXPANSION_VIEW,
      pendingTriggers: [],
      unresolvedHold: {
        holdId: "hold-1",
        reviewNodeId: "b-fix-2-review-3",
        candidateSha: "b".repeat(40),
        attemptedGeneration: 4,
        reason: "review-rounds-exhausted",
        createdAt: "2026-09-22T00:00:00.000Z"
      }
    });
    const html = container.innerHTML;
    expect(html).toContain("hold-banner");
    expect(html).toContain("三轮审查上限（A20）");
    expect(html).toContain("等待用户显式处理");
    expect(html).toContain("不会自动继续");
    expect(html).toContain("第 4 轮扩图请求被拒绝");
  });

  it("renders executed expansions with their requester and minted nodes", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderExpansionPanel(container, {
      ...EXPANSION_VIEW,
      pendingTriggers: [],
      expansions: [
        {
          expansionId: "xexp-1",
          triggerReviewNodeId: "c",
          triggerCandidateSha: "c".repeat(40),
          triggerGeneration: 1,
          generation: 2,
          repairedNodeId: "b",
          fixNode: { nodeId: "b-fix-2", role: "developer", dependencies: ["b"], state: "READY" },
          reviewNode: { nodeId: "b-review-2", role: "reviewer", dependencies: ["b-fix-2"], state: "PENDING" },
          findings: [],
          requestedBy: "coordinator",
          createdAt: "2026-09-22T00:00:00.000Z"
        }
      ]
    });
    const html = container.innerHTML;
    expect(html).toContain("已执行扩图 xexp-1");
    expect(html).toContain("请求人：coordinator");
    expect(html).toContain("新增节点：b-fix-2（developer，READY） → b-review-2（reviewer，PENDING）");
  });

  it("renders an empty-state hint when there is nothing to show", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderExpansionPanel(container, {
      ...EXPANSION_VIEW,
      pendingTriggers: []
    });
    expect(container.innerHTML).toContain("没有待处理的扩图 Proposal");
  });
});

describe("buildExpansionRequestPayload — the UI layer refuses override carriers (A02)", () => {
  const api = loadPageApi();

  it("builds the strict body from the allowlist fields", () => {
    const payload = api.buildExpansionRequestPayload("c", "d".repeat(40), 4, {
      requesterRoleId: "coordinator"
    });
    expect(payload).toEqual({
      expectedGraphRevision: 4,
      reviewNodeId: "c",
      candidateSha: "d".repeat(40),
      requesterRoleId: "coordinator"
    });
    const withRepair = api.buildExpansionRequestPayload("c", "d".repeat(40), 4, {
      requesterRoleId: "coordinator",
      repairedNodeId: "b"
    });
    expect(withRepair).toMatchObject({ repairedNodeId: "b" });
  });

  it("refuses model/profile fields with a thrown error — they never become request fields", () => {
    for (const key of ["model", "modelId", "profile", "profileId", "profiles", "fallbackProfileId"]) {
      expect(() =>
        api.buildExpansionRequestPayload("c", "d".repeat(40), 4, { requesterRoleId: "coordinator", [key]: "override" })
      ).toThrow(/A02/);
    }
    expect(api.EXPANSION_FIELD_ALLOWLIST).toEqual(["requesterRoleId", "repairedNodeId"]);
  });

  it("requires the acting role (A04): the request must name who asks", () => {
    expect(() => api.buildExpansionRequestPayload("c", "d".repeat(40), 4, {})).toThrow(/A04/);
    expect(() =>
      api.buildExpansionRequestPayload("c", "d".repeat(40), 4, { requesterRoleId: "" })
    ).toThrow(/A04/);
  });
});

describe("expansionRequestFailureText — explicit refusal texts, never silent", () => {
  const api = loadPageApi();

  it("names the current revision for a 409 conflict and states the request was discarded", () => {
    const text = api.expansionRequestFailureText({
      status: 409,
      code: "GRAPH_REVISION_CONFLICT",
      currentGraphRevision: 3,
      message: "graph revision conflict"
    });
    expect(text).toContain("409");
    expect(text).toContain("当前 revision 3");
    expect(text).toContain("不会静默覆盖");
    expect(text).toContain("重新加载");
    expect(text).toContain("A38");
  });

  it("points a 403 permission refusal at the audited reason (A04)", () => {
    const text = api.expansionRequestFailureText({
      status: 403,
      code: "EXPANSION_PERMISSION_DENIED",
      message: "canCreateSubtasks = false"
    });
    expect(text).toContain("403");
    expect(text).toContain("子任务权限");
    expect(text).toContain("审计");
    expect(text).toContain("A04");
  });

  it("describes the A20 hold and the budget refusal in user terms", () => {
    const rounds = api.expansionRequestFailureText({
      status: 409,
      code: "REVIEW_ROUNDS_EXHAUSTED",
      message: "x"
    });
    expect(rounds).toContain("三轮审查上限");
    expect(rounds).toContain("等待用户");
    const held = api.expansionRequestFailureText({
      status: 409,
      code: "RUN_HELD_FOR_USER",
      message: "x"
    });
    expect(held).toContain("等待用户处理");
    const budget = api.expansionRequestFailureText({
      status: 400,
      code: "GRAPH_BUDGET_EXCEEDED",
      message: "max-nodes limit 64, request would need 65"
    });
    expect(budget).toContain("预算不足");
    expect(budget).toContain("64 节点");
    const fallback = api.expansionRequestFailureText({ status: 500, code: "INTERNAL", message: "boom" });
    expect(fallback).toContain("HTTP 500 INTERNAL");
  });
});

describe("the canvas keeps rendering expansion-minted nodes (SVG 数据)", () => {
  const api = loadPageApi();

  it("renders the minted pair as ordinary node groups in the inline SVG", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderRunGraph(container, {
      graphRevision: 1,
      nodes: [
        { nodeId: "dev_a", role: "developer", objective: "o", dependencies: [], state: "SUCCEEDED", editable: false },
        { nodeId: "review_0", role: "reviewer", objective: "o", dependencies: ["dev_a"], state: "FAILED", editable: false },
        { nodeId: "dev_a-fix-2", role: "developer", objective: "o", dependencies: ["dev_a"], state: "PENDING", editable: true },
        { nodeId: "dev_a-review-2", role: "reviewer", objective: "o", dependencies: ["dev_a-fix-2"], state: "PENDING", editable: true }
      ]
    });
    const html = container.innerHTML;
    expect(html).toContain('data-node-id="dev_a-fix-2"');
    expect(html).toContain('data-node-id="dev_a-review-2"');
    expect(html.match(/<g class="dag-node /g)).toHaveLength(4);
    expect(html.match(/<line class="dag-edge"/g)).toHaveLength(3);
    expect(html).toContain("node-state-FAILED");
  });
});
