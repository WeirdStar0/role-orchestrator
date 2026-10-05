/**
 * M10-03 — the multi-node declaration layer, pinned as unit behavior:
 *
 *  1. validateWorkflowSpecs — the cross-field refusals BEFORE any write
 *     (budget, duplicate ids, unknown/self dependency, integration without
 *     parents, review dependency count, review role), each its typed 400
 *     carrier; the valid four-node plan passes.
 *  2. resolveNodeKind — the fail-closed dispatch matrix over a REAL migrated
 *     store: the v0.2.1 single-node shape answers "agent" with no book; a
 *     registered multi-node run answers its declared kinds; an unknown node
 *     on a registered run REFUSES (OrchestrationDriverError — the re-drive
     * after a restart); an unregistered multi-node shape refuses too; a
 *     review-kind node whose role a graph edit changed refuses.
 *  3. buildNodePrompt / nodePromptObjective — the deterministic role-context
 *     prompt (role header + objective + dependency artifact references; the
 *     M10-04 Memory/Context seam stays empty) and the single-node parity
 *     fallback (the bare run objective).
 *  4. objectiveOfNode — the newest non-placeholder declaration wins: a UI
 *     node edit (real objective) supersedes the initial revision.
 *  5. parseAgentReviewVerdict — the frozen ExecutionResultSchema.review
 *     channel read from persisted engine events (pass / fail+findings / no
 *     structured review).
 *  6. driver-ports guard — no validation-command field can appear on
 *     RunDriverPorts (the M8/M10-02 guard, type-pinned).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyControlledExpansionMigrations } from "@role-orchestrator/expand";
import { persistDrainedEvents } from "@role-orchestrator/engine";
import { ROLE_IDS, type RoleId } from "@role-orchestrator/contracts";
import {
  applyGraphNodeEdit,
  createRunGraph,
  listRunNodes,
  recordInitialGraphRevision
} from "@role-orchestrator/dag";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { createActiveAttempt, createProject } from "@role-orchestrator/store";
import {
  buildNodePrompt,
  createRunBook,
  nodePromptObjective,
  objectiveOfNode,
  OrchestrationDriverError,
  OrchestrationRejectionError,
  parseAgentReviewVerdict,
  resolveNodeKind,
  validateWorkflowSpecs,
  workflowTitleFor,
  type RunDriverPorts,
  type WorkflowNodeSpec
} from "../src/index.js";

/** Local structural-assertion helpers (the frozen contracts keep theirs private). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;
type Expect<T extends boolean> = T;

const T0 = "2026-09-22T00:00:00.000Z";

/**
 * Seed the four role bindings a run-snapshot creation requires (one synthetic
 * profile for every role; the snapshots are never executed in these units).
 */
async function seedRoleBindings(
  db: DatabaseSync,
  projectId: string,
  label: string
): Promise<void> {
  const profileId = `profile-${label}`;
  createProfile(db, {
    id: profileId,
    runtime: "claude",
    executable: "node",
    executionTarget: "windows-native",
    configDir: mkdtempSync(join(tmpdir(), `ro-mn-cfg-${label}-`)),
    credentialGroup: `creds-${label}`,
    maxConcurrency: 1,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, { profileId, model: null, externalConfigFiles: [], now: T0 });
  initializeProjectRoleBindings(db, { projectId, now: T0 });
  for (const roleId of ROLE_IDS) {
    setRoleBinding(db, { projectId, roleId, profileId, canCreateSubtasks: roleId === "coordinator", now: T0 });
  }
}

function planNode(spec: Partial<WorkflowNodeSpec> & { id: string }): WorkflowNodeSpec {
  return {
    role: "developer",
    kind: "agent",
    objective: `objective of ${spec.id}`,
    dependencies: [],
    ...spec
  };
}

const VALID_PLAN: readonly WorkflowNodeSpec[] = [
  planNode({ id: "plan", role: "coordinator" }),
  planNode({ id: "impl", dependencies: ["plan"] }),
  planNode({ id: "integrate", role: "architect", kind: "integration", dependencies: ["impl"] }),
  planNode({ id: "review", role: "reviewer", kind: "review", dependencies: ["integrate"] })
];

describe("M10-03 validateWorkflowSpecs (pre-write cross-field gates)", () => {
  /** Run the validator and answer its typed rejection, or fail the cell. */
  function refused(nodes: readonly WorkflowNodeSpec[]): OrchestrationRejectionError {
    try {
      validateWorkflowSpecs(nodes);
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationRejectionError);
      return error as OrchestrationRejectionError;
    }
    throw new Error("expected the workflow spec set to be refused");
  }

  it("accepts the valid four-node plan verbatim", () => {
    expect(validateWorkflowSpecs(VALID_PLAN)).toEqual(VALID_PLAN);
  });

  it("refuses the out-of-budget, duplicate-id, unknown-dependency and self-dependency shapes", () => {
    expect(
      refused(Array.from({ length: 65 }, (_, index) => planNode({ id: `n${String(index)}` }))).code
    ).toBe("WORKFLOW_NODES_OUT_OF_BUDGET");
    expect(
      refused([planNode({ id: "a" }), planNode({ id: "a", objective: "other" })]).code
    ).toBe("WORKFLOW_DUPLICATE_NODE_ID");
    expect(refused([planNode({ id: "a", dependencies: ["ghost"] })]).code).toBe(
      "WORKFLOW_UNKNOWN_DEPENDENCY"
    );
    expect(refused([planNode({ id: "a", dependencies: ["a"] })]).code).toBe(
      "WORKFLOW_SELF_DEPENDENCY"
    );
  });

  it("refuses integration nodes without parents and review nodes with the wrong shape or role", () => {
    const cells: readonly { readonly spec: WorkflowNodeSpec; readonly code: string }[] = [
      {
        spec: planNode({ id: "integ", role: "architect", kind: "integration", dependencies: [] }),
        code: "WORKFLOW_INTEGRATION_WITHOUT_PARENTS"
      },
      {
        spec: planNode({ id: "rev", role: "reviewer", kind: "review", dependencies: [] }),
        code: "WORKFLOW_REVIEW_DEPENDENCY_COUNT"
      },
      {
        spec: planNode({ id: "rev", role: "reviewer", kind: "review", dependencies: ["a", "b"] }),
        code: "WORKFLOW_REVIEW_DEPENDENCY_COUNT"
      },
      {
        spec: planNode({ id: "rev", role: "developer", kind: "review", dependencies: ["a"] }),
        code: "WORKFLOW_REVIEW_ROLE"
      }
    ];
    for (const cell of cells) {
      let rejection: unknown;
      try {
        validateWorkflowSpecs([planNode({ id: "a" }), planNode({ id: "b" }), cell.spec]);
      } catch (error) {
        rejection = error;
      }
      expect(rejection, cell.code).toBeInstanceOf(OrchestrationRejectionError);
      expect((rejection as OrchestrationRejectionError).code, cell.code).toBe(cell.code);
    }
  });
});

describe("M10-03 resolveNodeKind (fail-closed dispatch matrix)", () => {
  interface World {
    readonly db: DatabaseSync;
    readonly singleRunId: string;
    readonly multiRunId: string;
    readonly close: () => void;
  }

  async function buildWorld(label: string): Promise<World> {
    const db = new DatabaseSync(":memory:");
    void applyControlledExpansionMigrations(db, { now: T0 });
    createProject(db, {
      id: `proj-${label}`,
      repoRoot: mkdtempSync(join(tmpdir(), `ro-mn-${label}-`)),
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    await seedRoleBindings(db, `proj-${label}`, label);
    const baseSha = "a".repeat(40);
    const createRun = (runId: string, nodes: readonly { id: string; role: string; dependencies: string[] }[]): void => {
      createTaskRunWithProfileSnapshot(db, {
        runId,
        projectId: `proj-${label}`,
        taskId: `task-${runId}`,
        graphRevision: 0,
        baseSha,
        now: T0
      });
      const workflow = {
        id: `wf-${runId}`,
        name: "unit",
        nodes: nodes.map((node) => ({
          id: node.id,
          role: node.role,
          title: `t ${node.id}`,
          objective: `o ${node.id}`,
          dependencies: node.dependencies,
          capabilityTags: [],
          acceptanceCriteria: [`o ${node.id}`]
        }))
      };
      createRunGraph(db, { runId, workflow, definitionRevision: "1", now: T0 });
      recordInitialGraphRevision(db, { runId, workflow, now: T0 });
    };
    createRun(`run-single-${label}`, [{ id: "execute", role: "developer", dependencies: [] }]);
    createRun(`run-multi-${label}`, [
      { id: "plan", role: "coordinator", dependencies: [] },
      { id: "review", role: "reviewer", dependencies: ["plan"] }
    ]);
    return {
      db,
      singleRunId: `run-single-${label}`,
      multiRunId: `run-multi-${label}`,
      close: (): void => {
        db.close();
      }
    };
  }

  it("answers agent for the v0.2.1 single-node shape without any book", async () => {
    const world = await buildWorld("single");
    try {
      expect(resolveNodeKind(world.db, new Map(), world.singleRunId, "execute", "developer")).toBe(
        "agent"
      );
    } finally {
      world.close();
    }
  });

  it("answers the declared kinds for a registered run and refuses unknown nodes fail-closed", async () => {
    const world = await buildWorld("multi");
    try {
      const books = new Map(
        [[world.multiRunId, createRunBook([["plan", "agent"], ["review", "review"]])] as const]
      );
      expect(resolveNodeKind(world.db, books, world.multiRunId, "plan", "coordinator")).toBe("agent");
      expect(resolveNodeKind(world.db, books, world.multiRunId, "review", "reviewer")).toBe("review");
      // The registered run's UNKNOWN node (a re-drive whose book predates the
      // node, most defensively) refuses instead of guessing "agent".
      expect(() =>
        resolveNodeKind(world.db, books, world.multiRunId, "ghost", "developer")
      ).toThrow(OrchestrationDriverError);
      // A graph edit that moved a review node off the reviewer role refuses.
      expect(() =>
        resolveNodeKind(world.db, books, world.multiRunId, "review", "developer")
      ).toThrow(OrchestrationDriverError);
      // An UNREGISTERED multi-node-shaped run (post-restart re-drive) refuses.
      expect(() =>
        resolveNodeKind(world.db, new Map(), world.multiRunId, "plan", "coordinator")
      ).toThrow(OrchestrationDriverError);
    } finally {
      world.close();
    }
  });
});

describe("M10-03 role-context prompt (M6 seam; Memory/Context stays M10-04)", () => {
  it("assembles role header, objective and dependency artifact references deterministically", () => {
    const prompt = buildNodePrompt({
      role: "reviewer",
      nodeId: "review",
      objective: "对候选执行审查",
      dependencies: [
        { nodeId: "integrate", headSha: "b".repeat(40) }
      ]
    });
    expect(prompt).toBe(
      [
        "[role: reviewer] Reviewer：检查候选 SHA、diff、测试和验收，verdict 绑定 candidateSha。",
        "任务目标：对候选执行审查",
        "依赖产物：",
        `- 节点 integrate：accepted 输出 ${"b".repeat(40)}`,
        "（多节点工作流；Memory/Context 注入为后续批次接缝，本提示未携带。）"
      ].join("\n")
    );
  });

  it("declares the empty-dependency case honestly and truncates long titles for the frozen graph", () => {
    const prompt = buildNodePrompt({
      role: "developer",
      nodeId: "impl",
      objective: "写",
      dependencies: []
    });
    expect(prompt).toContain("依赖产物：无（基于 run 基线提交）。");
    expect(workflowTitleFor("x".repeat(300))).toHaveLength(200);
    expect(workflowTitleFor("short")).toBe("short");
  });

  it("falls back to the bare run objective for runs without a book (single-node parity)", async () => {
    const db = new DatabaseSync(":memory:");
    void applyControlledExpansionMigrations(db, { now: T0 });
    createProject(db, {
      id: "proj-prompt",
      repoRoot: mkdtempSync(join(tmpdir(), "ro-mn-prompt-")),
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    await seedRoleBindings(db, "proj-prompt", "prompt");
    createTaskRunWithProfileSnapshot(db, {
      runId: "run-prompt",
      projectId: "proj-prompt",
      taskId: "task-run-prompt",
      graphRevision: 0,
      baseSha: "c".repeat(40),
      now: T0
    });
    const workflow = {
      id: "wf-run-prompt",
      name: "unit",
      nodes: [
        {
          id: "execute",
          role: "developer",
          title: "执行任务",
          objective: "裸目标",
          dependencies: [],
          capabilityTags: [],
          acceptanceCriteria: ["裸目标"]
        }
      ]
    };
    createRunGraph(db, { runId: "run-prompt", workflow, definitionRevision: "1", now: T0 });
    recordInitialGraphRevision(db, { runId: "run-prompt", workflow, now: T0 });
    expect(nodePromptObjective(db, new Map(), "run-prompt", "execute", "developer", [])).toBe("裸目标");
    db.close();
  });
});

describe("M10-03 objectiveOfNode (placeholder-aware revision walk)", () => {
  it("answers the newest real declaration: a UI node edit supersedes the initial revision", async () => {
    const db = new DatabaseSync(":memory:");
    void applyControlledExpansionMigrations(db, { now: T0 });
    createProject(db, {
      id: "proj-obj",
      repoRoot: mkdtempSync(join(tmpdir(), "ro-mn-obj-")),
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    await seedRoleBindings(db, "proj-obj", "obj");
    createTaskRunWithProfileSnapshot(db, {
      runId: "run-obj",
      projectId: "proj-obj",
      taskId: "task-run-obj",
      graphRevision: 0,
      baseSha: "d".repeat(40),
      now: T0
    });
    const workflow = {
      id: "wf-run-obj",
      name: "unit",
      nodes: [
        {
          id: "plan",
          role: "coordinator",
          title: "t",
          objective: "initial objective",
          dependencies: [],
          capabilityTags: [],
          acceptanceCriteria: ["initial objective"]
        }
      ]
    };
    createRunGraph(db, { runId: "run-obj", workflow, definitionRevision: "1", now: T0 });
    recordInitialGraphRevision(db, { runId: "run-obj", workflow, now: T0 });
    expect(objectiveOfNode(db, "run-obj", "plan")).toBe("initial objective");
    const edited = applyGraphNodeEdit(db, {
      runId: "run-obj",
      nodeId: "plan",
      expectedGraphRevision: 0,
      patch: { objective: "edited objective" },
      now: T0
    });
    expect(edited.revision).toBe(1);
    expect(objectiveOfNode(db, "run-obj", "plan")).toBe("edited objective");
    expect(listRunNodes(db, "run-obj").map((node) => node.nodeId)).toEqual(["plan"]);
    db.close();
  });
});

describe("M10-03 parseAgentReviewVerdict (the frozen ExecutionResult.review channel)", () => {
  /** A migrated store with the execution row the events table references. */
  async function dbWithResult(businessResult: unknown): Promise<DatabaseSync> {
    const db = new DatabaseSync(":memory:");
    void applyControlledExpansionMigrations(db, { now: T0 });
    createProject(db, {
      id: "proj-rev",
      repoRoot: mkdtempSync(join(tmpdir(), "ro-mn-rev-")),
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    await seedRoleBindings(db, "proj-rev", "rev");
    createTaskRunWithProfileSnapshot(db, {
      runId: "run-rev",
      projectId: "proj-rev",
      taskId: "task-run-rev",
      graphRevision: 0,
      baseSha: "0".repeat(40),
      now: T0
    });
    createActiveAttempt(db, {
      id: "exec-rev-1",
      runId: "run-rev",
      nodeId: "review",
      definitionRevision: "1",
      attempt: 1,
      dispatchToken: "dt-exec-rev-1",
      phase: "RUNNING",
      now: T0
    });
    void persistDrainedEvents(db, "claude", "exec-rev-1", [
      {
        schemaVersion: 1,
        eventId: "evt-rev-1",
        executionId: "exec-rev-1",
        seq: 1,
        type: "result_reported",
        sourceType: "result",
        occurredAt: T0,
        payload: { businessResult }
      }
    ]);
    return db;
  }

  const base = {
    schemaVersion: 1,
    outcome: "completed",
    summary: "review finished",
    artifactRefs: [{ id: "artifact_review_report", kind: "report" }],
    memoryProposals: [],
    taskProposals: []
  };

  it("reads the structured fail verdict with its findings", async () => {
    const db = await dbWithResult({
      ...base,
      review: {
        verdict: "fail",
        candidateSha: "e".repeat(40),
        evidenceRefs: ["artifact_review_report"],
        findings: ["candidate misses src/feature/fix.txt"]
      }
    });
    expect(parseAgentReviewVerdict(db, "exec-rev-1")).toEqual({
      verdict: "fail",
      findings: ["candidate misses src/feature/fix.txt"]
    });
    db.close();
  });

  it("reads the structured pass verdict and answers null without a structured review", async () => {
    const pass = await dbWithResult({
      ...base,
      review: {
        verdict: "pass",
        candidateSha: "f".repeat(40),
        evidenceRefs: ["artifact_review_report"],
        findings: []
      }
    });
    expect(parseAgentReviewVerdict(pass, "exec-rev-1")).toEqual({ verdict: "pass", findings: [] });
    pass.close();

    const none = await dbWithResult(base);
    expect(parseAgentReviewVerdict(none, "exec-rev-1")).toBeNull();
    none.close();
  });
});

/**
 * The M8/M10-02 guard, continued onto the new port surface: the driver ports
 * may carry the output committer but NEVER a validation command — no argv,
 * no script, no command path can cross into the production review settlement
 * (its evidence is the reviewer agent's own engine-run, nothing injectable).
 */
type PortsHaveNoValidationCommandField = Expect<
  Equal<Extract<keyof RunDriverPorts, "validationScript" | "validationCommand" | "validationScriptPath">, never>
>;
const _portsGuard: PortsHaveNoValidationCommandField = true;
void _portsGuard;
