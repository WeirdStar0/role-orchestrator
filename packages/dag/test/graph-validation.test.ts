import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowDefinition } from "@role-orchestrator/contracts";
import {
  createRunGraph,
  DependencyCycleError,
  DuplicateNodeIdError,
  EmptyGraphError,
  GraphBudgetExceededError,
  SelfDependencyError,
  UnknownDependencyError,
  UnknownNodeRoleError,
  WorkflowSchemaError
} from "../src/index.js";
import type { ValidatedPlan } from "../src/index.js";
import { distinctRolesOf, listRunNodes, validateWorkflowGraph, validateWorkflowPlan } from "../src/index.js";
import {
  createMigratedMemoryDb,
  diamondWorkflow,
  expectError,
  rawNode,
  rawWorkflow,
  seedReadyRun,
  T0
} from "./helpers.js";

describe("A08 graph legality — each defect is its own typed rejection", () => {
  it("rejects a positive-length cycle with the path", () => {
    const workflow = rawWorkflow([
      rawNode({ id: "a", role: "developer", dependencies: ["c"] }),
      rawNode({ id: "b", role: "developer", dependencies: ["a"] }),
      rawNode({ id: "c", role: "developer", dependencies: ["b"] })
    ]);
    const error = expectError(() => validateWorkflowPlan(workflow), DependencyCycleError);
    // DFS from "a": a -> c (its dep) -> b -> a.
    expect(error.cycle).toEqual(["a", "c", "b", "a"]);
  });

  it("rejects a nested 2-cycle under a root node", () => {
    const workflow = rawWorkflow([
      rawNode({ id: "a", role: "developer", dependencies: ["b"] }),
      rawNode({ id: "b", role: "developer", dependencies: ["c"] }),
      rawNode({ id: "c", role: "developer", dependencies: ["b"] })
    ]);
    const error = expectError(() => validateWorkflowPlan(workflow), DependencyCycleError);
    expect(error.cycle).toEqual(["b", "c", "b"]);
  });

  it("rejects a self dependency separately from multi-node cycles", () => {
    const workflow = rawWorkflow([
      rawNode({ id: "a", role: "developer", dependencies: ["a"] }),
      rawNode({ id: "b", role: "reviewer", dependencies: ["a"] })
    ]);
    const error = expectError(() => validateWorkflowPlan(workflow), SelfDependencyError);
    expect(error.nodeId).toBe("a");
  });

  it("rejects a missing dependency (dependency id declared nowhere)", () => {
    const workflow = rawWorkflow([
      rawNode({ id: "a", role: "developer" }),
      rawNode({ id: "b", role: "reviewer", dependencies: ["a", "ghost"] })
    ]);
    const error = expectError(() => validateWorkflowPlan(workflow), UnknownDependencyError);
    expect(error.nodeId).toBe("b");
    expect(error.dependencyId).toBe("ghost");
  });

  it("rejects duplicate node ids", () => {
    const workflow = rawWorkflow([
      rawNode({ id: "dup", role: "developer" }),
      rawNode({ id: "dup", role: "reviewer" })
    ]);
    const error = expectError(() => validateWorkflowPlan(workflow), DuplicateNodeIdError);
    expect(error.nodeId).toBe("dup");
  });

  it("rejects an unknown role with the raw role value and node id (A03)", () => {
    const workflow = rawWorkflow([
      rawNode({ id: "a", role: "developer" }),
      { ...rawNode({ id: "b", role: "developer" }), role: "tester" }
    ]);
    const error = expectError(() => validateWorkflowPlan(workflow), UnknownNodeRoleError);
    expect(error.offenders).toEqual([{ nodeId: "b", roleId: "tester" }]);
  });

  it("rejects an unknown role even when the input bypassed the schema (defense-in-depth)", () => {
    const typed = {
      id: "wf-1",
      name: "wf",
      nodes: [{ ...rawNode({ id: "a", role: "developer" }), role: "lead" }]
    } as unknown as WorkflowDefinition;
    const error = expectError(() => validateWorkflowGraph(typed), UnknownNodeRoleError);
    expect(error.offenders).toEqual([{ nodeId: "a", roleId: "lead" }]);
  });

  it("rejects an empty node list reaching the graph validator", () => {
    const typed = { id: "wf-1", name: "wf", nodes: [] } as unknown as WorkflowDefinition;
    expectError(() => validateWorkflowGraph(typed), EmptyGraphError);
  });

  it("rejects an empty workflow through the schema path with the schema error", () => {
    const error = expectError(() => validateWorkflowPlan(rawWorkflow([])), WorkflowSchemaError);
    expect(error.issues.some((issue) => issue.path === "nodes")).toBe(true);
  });

  it("rejects schema violations (override field, duplicate deps in one node) as WorkflowSchemaError", () => {
    const withModel = rawWorkflow([{ ...rawNode({ id: "a", role: "developer" }), model: "x" }]);
    expectError(() => validateWorkflowPlan(withModel), WorkflowSchemaError);

    const withDuplicateDeps = rawWorkflow([
      rawNode({ id: "a", role: "developer" }),
      rawNode({ id: "b", role: "reviewer", dependencies: ["a", "a"] })
    ]);
    expectError(() => validateWorkflowPlan(withDuplicateDeps), WorkflowSchemaError);
  });

  it("enforces node/depth budgets with the documented defaults and overrides", () => {
    // Default max-nodes = 64 (ORCHESTRATION.md section 5).
    const tooMany = rawWorkflow(
      Array.from({ length: 65 }, (_, i) => rawNode({ id: `n${String(i)}`, role: "developer" }))
    );
    const nodesError = expectError(() => validateWorkflowPlan(tooMany), GraphBudgetExceededError);
    expect(nodesError.kind).toBe("max-nodes");

    // Default max-depth = 16: a 19-node chain has depth 18.
    const chain = rawWorkflow(
      Array.from({ length: 19 }, (_, i) =>
        rawNode({
          id: `n${String(i)}`,
          role: "developer",
          dependencies: i === 0 ? [] : [`n${String(i - 1)}`]
        })
      )
    );
    const depthError = expectError(() => validateWorkflowPlan(chain), GraphBudgetExceededError);
    expect(depthError.kind).toBe("max-depth");
    expect(depthError.actual).toBe(18);

    // Caller-adjustable: the same chain passes with maxDepth 18.
    expect(validateWorkflowPlan(chain, { budgets: { maxDepth: 18 } }).nodes).toHaveLength(19);

    // A 16-deep chain (17 nodes) fits the default.
    const fits = rawWorkflow(
      Array.from({ length: 17 }, (_, i) =>
        rawNode({
          id: `n${String(i)}`,
          role: "developer",
          dependencies: i === 0 ? [] : [`n${String(i - 1)}`]
        })
      )
    );
    expect(validateWorkflowPlan(fits).nodes).toHaveLength(17);
  });
});

describe("executable plan derivation", () => {
  it("accepts a single-node graph with depth 0", () => {
    const plan = validateWorkflowPlan(rawWorkflow([rawNode({ id: "solo", role: "developer" })]));
    expect(plan.nodes.map((node) => node.id)).toEqual(["solo"]);
    expect(plan.depth.get("solo")).toBe(0);
  });

  it("derives stable topological order and depth for the diamond", () => {
    const plan = validateWorkflowPlan(diamondWorkflow()) as ValidatedPlan;
    expect(plan.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "d"]);
    expect(plan.order.get("d")).toBe(3);
    expect(plan.depth.get("a")).toBe(0);
    expect(plan.depth.get("b")).toBe(1);
    expect(plan.depth.get("c")).toBe(1);
    expect(plan.depth.get("d")).toBe(2);
    expect(plan.workflowId).toBe("wf-1");
  });

  it("reports every role the plan uses, in the fixed role order", () => {
    const plan = validateWorkflowPlan(diamondWorkflow());
    // coordinator (a), developer (b, c), reviewer (d) — architect unused.
    expect(distinctRolesOf(plan)).toEqual(["coordinator", "developer", "reviewer"]);
  });
});

// ---------------------------------------------------------------------------
// The A08 gate must hold BEFORE any spawn-capable step. The probe is the
// injection point: `dispatch` is what a scheduler would do with an executable
// plan (start a CLI). If validation ever let a defect through, the probe
// would fire — the assertions below pin it at zero.
// ---------------------------------------------------------------------------

describe("A08 rejection precedes any CLI start (injected spawn probe)", () => {
  function makeSpawnProbe() {
    const started: string[] = [];
    return {
      /** Stand-in for the CLI start boundary (never touches a real CLI). */
      start(workflowId: string): void {
        started.push(workflowId);
      },
      get count(): number {
        return started.length;
      }
    };
  }

  function dispatchIfExecutable(
    db: DatabaseSync,
    workflow: unknown,
    probe: ReturnType<typeof makeSpawnProbe>
  ): void {
    const result = createRunGraph(db, { runId: "run-probe", workflow, now: T0 });
    // Only reached for a fully validated + persisted plan:
    probe.start(result.plan.workflowId);
  }

  const illegalForms: readonly {
    readonly name: string;
    readonly workflow: () => unknown;
    readonly expected: new (...args: never[]) => Error;
  }[] = [
    {
      name: "positive cycle",
      workflow: () =>
        rawWorkflow([
          rawNode({ id: "a", role: "developer", dependencies: ["b"] }),
          rawNode({ id: "b", role: "developer", dependencies: ["a"] })
        ]),
      expected: DependencyCycleError
    },
    {
      name: "self dependency",
      workflow: () => rawWorkflow([rawNode({ id: "a", role: "developer", dependencies: ["a"] })]),
      expected: SelfDependencyError
    },
    {
      name: "missing dependency",
      workflow: () =>
        rawWorkflow([rawNode({ id: "a", role: "developer", dependencies: ["ghost"] })]),
      expected: UnknownDependencyError
    },
    {
      name: "duplicate node id",
      workflow: () =>
        rawWorkflow([
          rawNode({ id: "dup", role: "developer" }),
          rawNode({ id: "dup", role: "reviewer" })
        ]),
      expected: DuplicateNodeIdError
    },
    {
      name: "unknown role",
      workflow: () =>
        rawWorkflow([{ ...rawNode({ id: "a", role: "developer" }), role: "tester" }]),
      expected: UnknownNodeRoleError
    },
    {
      name: "empty graph",
      workflow: () => rawWorkflow([]),
      expected: WorkflowSchemaError
    }
  ];

  for (const form of illegalForms) {
    it(`no CLI start and no persisted rows for: ${form.name}`, async () => {
      const db = createMigratedMemoryDb();
      try {
        await seedReadyRun(db, { runId: "run-probe" });
        const probe = makeSpawnProbe();
        expectError(() => dispatchIfExecutable(db, form.workflow(), probe), form.expected);
        expect(probe.count).toBe(0);
        expect(listRunNodes(db, "run-probe")).toHaveLength(0);
      } finally {
        db.close();
      }
    });
  }

  it("positive control: a legal diamond reaches the probe exactly once", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-probe" });
      const probe = makeSpawnProbe();
      dispatchIfExecutable(db, diamondWorkflow(), probe);
      expect(probe.count).toBe(1);
      expect(listRunNodes(db, "run-probe")).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});
