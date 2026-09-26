import { describe, expect, it } from "vitest";
import {
  applyReconcileOutcomeToNode,
  assertNodeTransition,
  computeReadinessTransitions,
  createRunGraph,
  getNodeState,
  IllegalNodeTransitionError,
  isLegalNodeTransition,
  legalNodePredecessors,
  legalNodeSuccessors,
  nodeActionForReconcileOutcome,
  NODE_STATES,
  NODE_TRANSITIONS,
  propagateNodeStates,
  requireNodeState,
  transitionNodeState,
  UnknownNodeError,
  UnknownRunError,
  UnknownReconcileOutcomeError,
  type NodeState
} from "../src/index.js";
import { NoRowUpdatedError } from "@role-orchestrator/store";
import {
  createMigratedMemoryDb,
  diamondWorkflow,
  expectError,
  iso,
  rawNode,
  rawWorkflow,
  seedReadyRun,
  T0
} from "./helpers.js";

describe("node state machine vocabulary (ORCHESTRATION.md section 3)", () => {
  it("every documented edge is legal, exactly as transcribed", () => {
    expect(NODE_TRANSITIONS).toHaveLength(18);
    for (const edge of NODE_TRANSITIONS) {
      expect(isLegalNodeTransition(edge.from, edge.to)).toBe(true);
    }
  });

  it("BLOCKED, SUCCEEDED and CANCELLED have no outgoing edges", () => {
    for (const terminal of ["BLOCKED", "SUCCEEDED", "CANCELLED"] as const satisfies readonly NodeState[]) {
      expect(legalNodeSuccessors(terminal)).toEqual([]);
    }
  });

  it("representative illegal transitions are rejected with the typed error", () => {
    const illegal: readonly (readonly [NodeState, NodeState])[] = [
      ["PENDING", "SUCCEEDED"], // skipping the lifecycle
      ["PENDING", "RUNNING"],
      ["READY", "SUCCEEDED"],
      ["RUNNING", "READY"], // no direct back-transition
      ["SUCCEEDED", "RUNNING"], // terminal
      ["BLOCKED", "READY"], // blocked stays blocked (new TaskRun instead)
      ["CANCELLED", "READY"], // terminal
      ["FAILED", "READY"], // retry must pass RETRY_PENDING
      ["RETRY_PENDING", "RUNNING"],
      ["WAITING_APPROVAL", "RUNNING"],
      ["INTERRUPTED", "READY"], // must pass RECOVERY_REQUIRED first
      ["RECOVERY_REQUIRED", "RUNNING"]
    ];
    for (const [from, to] of illegal) {
      const error = expectError(() => assertNodeTransition(from, to), IllegalNodeTransitionError);
      expect(error.from).toBe(from);
      expect(error.to).toBe(to);
    }
  });

  it("default guards derive from the inverted edge set", () => {
    expect(legalNodePredecessors("READY")).toEqual([
      "PENDING",
      "RETRY_PENDING",
      "WAITING_APPROVAL",
      "RECOVERY_REQUIRED"
    ]);
    expect(legalNodePredecessors("SUCCEEDED")).toEqual(["RUNNING"]);
    expect(legalNodePredecessors("RECOVERY_REQUIRED")).toEqual(["INTERRUPTED"]);
    // The state enum is the SQL CHECK vocabulary (single-sourced).
    expect(NODE_STATES).toHaveLength(11);
  });
});

describe("computeReadinessTransitions (pure propagation)", () => {
  const view = (nodeId: string, state: NodeState, dependencies: string[]) => ({
    nodeId,
    state,
    dependencies
  });

  it("a node with zero dependencies goes PENDING -> READY (vacuously all deps SUCCEEDED)", () => {
    const transitions = computeReadinessTransitions({
      nodes: [view("a", "PENDING", [])]
    });
    expect(transitions).toEqual([{ nodeId: "a", from: "PENDING", to: "READY" }]);
  });

  it("diamond: a SUCCEEDED makes b and c READY, d stays PENDING", () => {
    const transitions = computeReadinessTransitions({
      nodes: [
        view("a", "SUCCEEDED", []),
        view("b", "PENDING", ["a"]),
        view("c", "PENDING", ["a"]),
        view("d", "PENDING", ["b", "c"])
      ]
    });
    expect(transitions).toEqual([
      { nodeId: "b", from: "PENDING", to: "READY" },
      { nodeId: "c", from: "PENDING", to: "READY" }
    ]);
  });

  it("a FAILED dependency blocks dependents from PENDING and from READY", () => {
    const transitions = computeReadinessTransitions({
      nodes: [
        view("a", "SUCCEEDED", []),
        view("failed", "FAILED", ["a"]),
        view("pendingChild", "PENDING", ["failed"]),
        view("readyChild", "READY", ["failed"])
      ]
    });
    expect(transitions).toEqual([
      { nodeId: "pendingChild", from: "PENDING", to: "BLOCKED" },
      { nodeId: "readyChild", from: "READY", to: "BLOCKED" }
    ]);
  });

  it("blocked propagates transitively in one topological pass", () => {
    const transitions = computeReadinessTransitions({
      nodes: [
        view("a", "FAILED", []),
        view("b", "PENDING", ["a"]),
        view("c", "PENDING", ["b"])
      ]
    });
    expect(transitions).toEqual([
      { nodeId: "b", from: "PENDING", to: "BLOCKED" },
      { nodeId: "c", from: "PENDING", to: "BLOCKED" }
    ]);
  });

  it("WAITING_APPROVAL and RECOVERY_REQUIRED dependencies do not block — downstream just stays PENDING", () => {
    const transitions = computeReadinessTransitions({
      nodes: [
        view("a", "SUCCEEDED", []),
        view("approval", "WAITING_APPROVAL", ["a"]),
        view("recovery", "RECOVERY_REQUIRED", ["a"]),
        view("child", "PENDING", ["approval", "recovery"])
      ]
    });
    expect(transitions).toEqual([]);
  });

  it("RUNNING nodes are never rewritten by propagation", () => {
    const transitions = computeReadinessTransitions({
      nodes: [
        view("a", "RUNNING", []),
        view("b", "PENDING", ["a"])
      ]
    });
    // a not SUCCEEDED, not blocking -> b stays PENDING; a untouched.
    expect(transitions).toEqual([]);
  });

  it("a dependency id without a view is fail-closed (no transition)", () => {
    const transitions = computeReadinessTransitions({
      nodes: [view("b", "PENDING", ["ghost"])]
    });
    expect(transitions).toEqual([]);
  });
});

describe("node state machine over the store (diamond run)", () => {
  it("createRunGraph persists PENDING rows and the first propagation readies the roots", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      const graph = createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });
      expect(graph.nodes.map((node) => node.nodeId)).toEqual(["a", "b", "c", "d"]);
      expect(graph.nodes.map((node) => node.state)).toEqual([
        "READY",
        "PENDING",
        "PENDING",
        "PENDING"
      ]);
      expect(graph.initialTransitions).toEqual([{ nodeId: "a", from: "PENDING", to: "READY" }]);
      // Dependency snapshots are frozen on the rows.
      expect(graph.nodes.find((node) => node.nodeId === "d")?.dependencies).toEqual(["b", "c"]);
      expect(graph.nodes.every((node) => node.definitionRevision === "1")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("SUCCEEDED dependencies propagate READY downstream; nothing starts ahead of its deps", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "RUNNING", now: iso(1) });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "SUCCEEDED", now: iso(2) });

      const transitions = propagateNodeStates(db, { runId: "run-fsm", now: iso(3) });
      expect(transitions).toEqual([
        { nodeId: "b", from: "PENDING", to: "READY" },
        { nodeId: "c", from: "PENDING", to: "READY" }
      ]);
      expect(getNodeState(db, { runId: "run-fsm", nodeId: "d" })?.state).toBe("PENDING");
    } finally {
      db.close();
    }
  });

  it("partial failure: the failed branch blocks the sink, the sibling may still finish", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "RUNNING", now: iso(1) });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "SUCCEEDED", now: iso(2) });
      propagateNodeStates(db, { runId: "run-fsm", now: iso(3) });

      // b fails, c succeeds.
      transitionNodeState(db, { runId: "run-fsm", nodeId: "b", to: "RUNNING", now: iso(4) });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "b", to: "FAILED", now: iso(5) });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "c", to: "RUNNING", now: iso(6) });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "c", to: "SUCCEEDED", now: iso(7) });

      const transitions = propagateNodeStates(db, { runId: "run-fsm", now: iso(8) });
      expect(transitions).toEqual([{ nodeId: "d", from: "PENDING", to: "BLOCKED" }]);

      // The sink never starts: BLOCKED has no outgoing edges, and further
      // propagation is a no-op.
      expect(requireNodeState(db, { runId: "run-fsm", nodeId: "d" }).state).toBe("BLOCKED");
      expect(propagateNodeStates(db, { runId: "run-fsm", now: iso(9) })).toEqual([]);
      expectError(
        () => transitionNodeState(db, { runId: "run-fsm", nodeId: "d", to: "RUNNING", now: iso(10) }),
        IllegalNodeTransitionError
      );
    } finally {
      db.close();
    }
  });

  it("illegal transitions are rejected with the current state on the error and leave the row unchanged", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });

      const error = expectError(
        () => transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "SUCCEEDED", now: iso(1) }),
        IllegalNodeTransitionError
      );
      expect(error.from).toBe("READY");
      expect(error.to).toBe("SUCCEEDED");
      expect(requireNodeState(db, { runId: "run-fsm", nodeId: "a" }).state).toBe("READY");

      // An explicit guard containing an illegal predecessor is rejected before SQL.
      expectError(
        () =>
          transitionNodeState(db, {
            runId: "run-fsm",
            nodeId: "a",
            to: "SUCCEEDED",
            whereStateIn: ["PENDING"],
            now: iso(1)
          }),
        IllegalNodeTransitionError
      );
    } finally {
      db.close();
    }
  });

  it("the optimistic whereStateIn guard refuses a stale writer", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });

      // a is READY; a writer that saw PENDING loses.
      expectError(
        () =>
          transitionNodeState(db, {
            runId: "run-fsm",
            nodeId: "a",
            to: "RUNNING",
            whereStateIn: ["PENDING"],
            now: iso(1)
          }),
        IllegalNodeTransitionError
      );
      // The correct guard lands.
      const row = transitionNodeState(db, {
        runId: "run-fsm",
        nodeId: "a",
        to: "RUNNING",
        whereStateIn: ["READY"],
        now: iso(2)
      });
      expect(row.state).toBe("RUNNING");
      // A repeat of the same guarded write now finds RUNNING — refused.
      expectError(
        () =>
          transitionNodeState(db, {
            runId: "run-fsm",
            nodeId: "a",
            to: "RUNNING",
            whereStateIn: ["READY"],
            now: iso(3)
          }),
        IllegalNodeTransitionError
      );
    } finally {
      db.close();
    }
  });

  it("references to unknown nodes and unknown runs are typed rejections", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });

      const nodeError = expectError(
        () => requireNodeState(db, { runId: "run-fsm", nodeId: "ghost" }),
        UnknownNodeError
      );
      expect(nodeError.nodeId).toBe("ghost");
      expect(getNodeState(db, { runId: "run-fsm", nodeId: "ghost" })).toBeNull();
      expectError(
        () => transitionNodeState(db, { runId: "run-fsm", nodeId: "ghost", to: "READY", now: iso(1) }),
        NoRowUpdatedError
      );
      expectError(
        () => propagateNodeStates(db, { runId: "run-missing", now: iso(1) }),
        UnknownRunError
      );
    } finally {
      db.close();
    }
  });

  it("a legal full path walks PENDING -> READY -> RUNNING -> SUCCEEDED", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, {
        runId: "run-fsm",
        workflow: rawWorkflow([rawNode({ id: "solo", role: "developer" })]),
        now: T0
      });
      const readState = (): NodeState =>
        requireNodeState(db, { runId: "run-fsm", nodeId: "solo" }).state;
      expect(readState()).toBe("READY"); // root: readied by the initial propagation
      transitionNodeState(db, { runId: "run-fsm", nodeId: "solo", to: "RUNNING", now: iso(1) });
      expect(readState()).toBe("RUNNING");
      transitionNodeState(db, { runId: "run-fsm", nodeId: "solo", to: "SUCCEEDED", now: iso(2) });
      expect(readState()).toBe("SUCCEEDED");
    } finally {
      db.close();
    }
  });
});

describe("reconcile outcome -> node state bridge (A22 landing spot)", () => {
  it("interrupted then recovery-required walks RUNNING -> INTERRUPTED -> RECOVERY_REQUIRED", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "RUNNING", now: iso(1) });

      applyReconcileOutcomeToNode(db, {
        runId: "run-fsm",
        nodeId: "a",
        outcome: "interrupted",
        now: iso(2)
      });
      expect(requireNodeState(db, { runId: "run-fsm", nodeId: "a" }).state).toBe("INTERRUPTED");

      applyReconcileOutcomeToNode(db, {
        runId: "run-fsm",
        nodeId: "a",
        outcome: "recovery-required",
        now: iso(3)
      });
      expect(requireNodeState(db, { runId: "run-fsm", nodeId: "a" }).state).toBe("RECOVERY_REQUIRED");

      // observed-running changes nothing.
      const untouched = applyReconcileOutcomeToNode(db, {
        runId: "run-fsm",
        nodeId: "a",
        outcome: "observed-running",
        now: iso(4)
      });
      expect(untouched.state).toBe("RECOVERY_REQUIRED");
    } finally {
      db.close();
    }
  });

  it("recovery-required is refused from a RUNNING node (guard = INTERRUPTED only)", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedReadyRun(db, { runId: "run-fsm" });
      createRunGraph(db, { runId: "run-fsm", workflow: diamondWorkflow(), now: T0 });
      transitionNodeState(db, { runId: "run-fsm", nodeId: "a", to: "RUNNING", now: iso(1) });
      expectError(
        () =>
          applyReconcileOutcomeToNode(db, {
            runId: "run-fsm",
            nodeId: "a",
            outcome: "recovery-required",
            now: iso(2)
          }),
        IllegalNodeTransitionError
      );
    } finally {
      db.close();
    }
  });

  it("an unknown reconcile outcome string is a typed rejection, never a guessed no-op", () => {
    expectError(
      () => nodeActionForReconcileOutcome("kill-it" as never),
      UnknownReconcileOutcomeError
    );
  });
});
