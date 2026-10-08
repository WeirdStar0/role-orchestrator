/**
 * M11-03 — the wizard's multi-node draft layer: the 人话预检 mirrors the
 * server's v1 declaration gates (multi-node.ts) BEFORE the round trip; the
 * server remains the authority. Each test cell names the server carrier the
 * problem corresponds to, so a server-side tightening that outruns the
 * preflight is visible here as a coverage gap — and vice versa.
 */
import { describe, expect, it } from "vitest";
import {
  freshDraftNodeId,
  kindLabel,
  roleLabel,
  validateWorkflowDraft,
  workflowToRequest,
  WORKFLOW_NODE_BUDGET,
  type WorkflowDraftNode
} from "./workflowDraft";

function node(overrides: Partial<WorkflowDraftNode> = {}): WorkflowDraftNode {
  return {
    id: overrides.id ?? "node-a",
    role: overrides.role ?? "developer",
    kind: overrides.kind ?? "agent",
    objective: overrides.objective ?? "do a thing",
    dependencies: overrides.dependencies ?? []
  };
}

describe("validateWorkflowDraft (M11-03 多节点高级表单的人话预检)", () => {
  it("empty draft = single-node run, valid by definition", () => {
    expect(validateWorkflowDraft([])).toEqual([]);
  });

  it("a plain two-node agent chain with dependencies is valid", () => {
    const draft = [node({ id: "node-a" }), node({ id: "node-b", dependencies: ["node-a"] })];
    expect(validateWorkflowDraft(draft)).toEqual([]);
  });

  it("over-budget drafts name the limit (server carrier: WORKFLOW_NODES_OUT_OF_BUDGET)", () => {
    const many = Array.from({ length: WORKFLOW_NODE_BUDGET + 1 }, (_, index) => node({ id: `node-${String(index)}` }));
    const problems = validateWorkflowDraft(many);
    expect(problems.some((problem) => problem.includes("64"))).toBe(true);
    expect(validateWorkflowDraft(many.slice(0, WORKFLOW_NODE_BUDGET))).toEqual([]);
  });

  it("blank node objectives are refused with one human sentence", () => {
    const problems = validateWorkflowDraft([node({ objective: "  " })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("目标");
  });

  it("integration needs a parent (server carrier: WORKFLOW_INTEGRATION_WITHOUT_PARENTS)", () => {
    const problems = validateWorkflowDraft([node({ kind: "integration" })]);
    expect(problems.some((problem) => problem.includes("集成节点"))).toBe(true);
    expect(validateWorkflowDraft([node({ kind: "integration", dependencies: ["node-b"] }), node({ id: "node-b" })])).toEqual([]);
  });

  it("review needs EXACTLY one dependency and the reviewer role (server carriers: WORKFLOW_REVIEW_DEPENDENCY_COUNT / WORKFLOW_REVIEW_ROLE)", () => {
    const others = [node({ id: "node-b" }), node({ id: "node-c" })];
    const noDependency = [node({ kind: "review", role: "reviewer" }), ...others];
    expect(validateWorkflowDraft(noDependency).some((problem) => problem.includes("评审节点"))).toBe(true);

    const twoDependencies = [
      node({ kind: "review", role: "reviewer", dependencies: ["node-b", "node-c"] }),
      ...others
    ];
    expect(validateWorkflowDraft(twoDependencies).some((problem) => problem.includes("只能依赖一个"))).toBe(true);

    const wrongRole = [node({ kind: "review", role: "developer", dependencies: ["node-b"] }), node({ id: "node-b" })];
    expect(validateWorkflowDraft(wrongRole).some((problem) => problem.includes("「评审」"))).toBe(true);

    const validReview = [node({ kind: "review", role: "reviewer", dependencies: ["node-b"] }), node({ id: "node-b" })];
    expect(validateWorkflowDraft(validReview)).toEqual([]);
  });

  it("two integration nodes are refused with the product's v1 sentence (server carrier: WORKFLOW_INTEGRATION_NODE_COUNT)", () => {
    const draft = [
      node({ id: "node-a" }),
      node({ id: "node-b", kind: "integration", dependencies: ["node-a"] }),
      node({ id: "node-c", kind: "integration", dependencies: ["node-a"] })
    ];
    const problems = validateWorkflowDraft(draft);
    // M11-04 (review handover ⑦): the preflight sentence is worded exactly as
    // the server's own INTEGRATION_NODE_LIMIT_REASON (每任务, not 每个任务).
    expect(problems.some((problem) => problem.includes("当前版本每任务支持一个集成节点"))).toBe(true);
  });

  it("labels are the product words, never raw enum-ish jargon", () => {
    expect(kindLabel("agent")).toContain("执行");
    expect(kindLabel("integration")).toContain("集成");
    expect(kindLabel("review")).toContain("评审");
    expect(roleLabel("coordinator")).toBe("协调");
    expect(roleLabel("architect")).toBe("架构");
    expect(roleLabel("developer")).toBe("开发");
    expect(roleLabel("reviewer")).toBe("评审");
  });
});

describe("workflowToRequest (the exact POST /runs allowlist per node)", () => {
  it("null when nothing is declared; trimmed objectives and copied dependencies otherwise", () => {
    expect(workflowToRequest([])).toBeNull();
    const draft = [node({ objective: "  ship it  ", dependencies: ["node-b"] }), node({ id: "node-b" })];
    const request = workflowToRequest(draft);
    expect(request).toEqual([
      { id: "node-a", role: "developer", kind: "agent", objective: "ship it", dependencies: ["node-b"] },
      { id: "node-b", role: "developer", kind: "agent", objective: "do a thing", dependencies: [] }
    ]);
  });

  it("fresh ids satisfy the id vocabulary and never repeat (1..N same-tick draws)", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = freshDraftNodeId();
      expect(id).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
      seen.add(id);
    }
    // 200 draws into a >2^25 space colliding is astronomically unlikely;
    // a collision here is itself the signal the generator broke.
    expect(seen.size).toBeGreaterThan(190);
  });
});
