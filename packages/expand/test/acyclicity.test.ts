/**
 * Acyclicity guarantee of the A20 expansion (M4-03):
 * - the FULL composed graph is re-validated with dag's own validator after an
 *   expansion and stays legal (the test re-derives the graph from task_nodes
 *   and re-checks it INDEPENDENTLY of the expander's internal validation);
 * - a back edge — a new node added as the dependency of an EXISTING node — is
 *   rejected by dag in both shapes: before the new node exists (unknown
 *   dependency) and after it exists (dependency cycle);
 * - the expander never rewrites an existing node's dependency snapshot;
 * - a blown graph budget is a typed dag rejection with ZERO rows written.
 */
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowDefinition } from "@role-orchestrator/contracts";
import { DEFAULT_GRAPH_BUDGETS, listRunNodes, validateWorkflowGraph } from "@role-orchestrator/dag";
import {
  DependencyCycleError,
  GraphBudgetExceededError,
  UnknownDependencyError,
  validateWorkflowPlan
} from "@role-orchestrator/dag";
import { requestReviewExpansion } from "../src/index.js";
import {
  createExpandedDb,
  expectError,
  fakeSha,
  rawNode,
  recordVerdict,
  seedExpansionRun,
  T0
} from "./helpers.js";

/** Rebuild the composed RAW workflow from the STORED graph (structure only). */
function composedWorkflow(db: DatabaseSync, runId: string): WorkflowDefinition {
  return {
    id: runId,
    name: `recheck-${runId}`,
    nodes: listRunNodes(db, runId).map((row) => ({
      id: row.nodeId,
      role: row.roleId,
      title: `node-${row.nodeId}`,
      objective: "structural re-validation node",
      dependencies: [...row.dependencies],
      capabilityTags: [],
      acceptanceCriteria: ["structural re-validation"]
    }))
  };
}

describe("A20 expansion keeps the graph acyclic and within budget", () => {
  it("the expanded graph passes dag's validator, and a back edge is refused in both shapes", async () => {
    const testDb = createExpandedDb("a20-acyclic");
    try {
      const { db } = testDb;
      const runId = "run-acyclic";
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: "dev_a", role: "developer" }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })
        ]
      });
      const candidateSha = fakeSha("cyclic-candidate");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: T0 });
      const outcome = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        now: T0
      });
      expect(outcome.created).toBe(true);

      // 1. INDEPENDENT re-validation: the stored graph (including the minted
      //    pair) is a legal dag plan — acyclic, no duplicates, budgets hold.
      //    (Kahn's queue is fed in stored-row order — created_at then node
      //    id — so the minted pair precedes review_0; only the topological
      //    property matters, and the depth is the chain's proof.)
      const plan = validateWorkflowGraph(composedWorkflow(db, runId));
      expect(plan.nodes.map((node) => node.id)).toEqual([
        "dev_a",
        "dev_a-fix-2",
        "review_0",
        "dev_a-review-2"
      ]);
      expect(plan.depth.get("dev_a-review-2")).toBe(2);

      // 2. Back edge BEFORE the new node exists: a plan whose existing node
      //    depends on a not-yet-minted expansion id is refused (unknown
      //    dependency — the A08 缺失依赖 shape).
      const premature = {
        id: "wf-back-edge",
        name: "back-edge-before-mint",
        nodes: [
          rawNode({ id: "dev_a", role: "developer", dependencies: ["dev_a-fix-2"] }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })
        ]
      };
      expectError(() => validateWorkflowPlan(premature), UnknownDependencyError);

      // 3. Back edge AFTER the new node exists: adding the minted re-review
      //    as the dependency of the EXISTING dev_a closes a positive-length
      //    cycle (dev_a -> dev_a-review-2 -> dev_a-fix-2 -> dev_a) and dag
      //    refuses it — an expansion can never be rewired into a back edge.
      const backEdge = composedWorkflow(db, runId);
      const mutableNodes = backEdge.nodes.map((node) =>
        node.id === "dev_a" ? { ...node, dependencies: ["dev_a-review-2"] } : node
      );
      const cycleGraph: WorkflowDefinition = { ...backEdge, nodes: mutableNodes };
      const cycleError = expectError(
        () => validateWorkflowGraph(cycleGraph),
        DependencyCycleError
      );
      expect(cycleError.cycle).toContain("dev_a");

      // 4. The stored graph was never touched by the attempted rewires —
      //    the expander has no rewrite path at all; existing dependency
      //    snapshots are byte-identical to what createRunGraph froze.
      const rows = listRunNodes(db, runId);
      // (listRunNodes orders by created_at then node id, hence the minted
      // rows between dev_a and review_0.)
      expect(rows.map((row) => [row.nodeId, [...row.dependencies]])).toEqual([
        ["dev_a", []],
        ["dev_a-fix-2", ["dev_a"]],
        ["dev_a-review-2", ["dev_a-fix-2"]],
        ["review_0", ["dev_a"]]
      ]);
    } finally {
      testDb.close();
    }
  });

  it("a blown node budget is a typed dag rejection with zero rows written", async () => {
    const testDb = createExpandedDb("a20-budget");
    try {
      const { db } = testDb;
      const runId = "run-budget";
      await seedExpansionRun(db, {
        runId,
        nodes: [
          rawNode({ id: "dev_a", role: "developer" }),
          rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })
        ]
      });
      const candidateSha = fakeSha("budget-candidate");
      recordVerdict(db, { runId, nodeId: "review_0", candidateSha, verdict: "fail", now: T0 });

      // 2 stored + 2 minted = 4 nodes > maxNodes 3 -> the dag budget error
      // propagates out of the expander UNCHANGED (the caller sees exactly
      // which dag law the expansion would have broken).
      const error = expectError(
        () =>
          requestReviewExpansion(
            db,
            { runId, reviewNodeId: "review_0", candidateSha, now: T0 },
            { budgets: { maxNodes: 3 } }
          ),
        GraphBudgetExceededError
      );
      expect(error.kind).toBe("max-nodes");
      expect(error.limit).toBe(3);
      expect(error.actual).toBe(4);

      // Fail-closed: no partial write — no minted nodes, no expansion row.
      expect(listRunNodes(db, runId).map((row) => row.nodeId)).toEqual(["dev_a", "review_0"]);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM review_expansions").get()
      ).toEqual({ n: 0 });

      // The same request within the default budget succeeds — the refusal
      // was the budget's, not the expansion's.
      const outcome = requestReviewExpansion(db, {
        runId,
        reviewNodeId: "review_0",
        candidateSha,
        now: T0
      });
      expect(outcome.created).toBe(true);
      expect(DEFAULT_GRAPH_BUDGETS.maxNodes).toBe(64);
    } finally {
      testDb.close();
    }
  });
});
