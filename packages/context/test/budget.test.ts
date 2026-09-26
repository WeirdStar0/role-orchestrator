/**
 * M3-01 acceptance: byte-budget truncation. Drop order is dependency ->
 * task -> role (later sequences first inside a layer), every drop is
 * recorded in the manifest, and project rules are NEVER dropped — a budget
 * smaller than the rules alone yields a bundle that exceeds its budget and
 * says so. 预算再小，规则也不丢。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleContextBundle } from "../src/assemble.js";
import { persistContextBundle, verifyContextBundle } from "../src/persist.js";
import { BUDGET_OMITTED_REASON } from "../src/manifest.js";
import {
  ROLE_RESPONSIBILITY,
  addIntegrationParent,
  createWorld,
  depContent,
  depOutputSha,
  nodeDefinition,
  removeTreeRobust,
  ruleContent,
  type World
} from "./helpers.js";

let world: World;

beforeEach(() => {
  world = createWorld();
});

afterEach(() => {
  world.close();
  removeTreeRobust(world.scratchDir);
});

const RULES = [
  { ruleId: "rule-tests", revision: 3, content: ruleContent("tests") },
  { ruleId: "rule-gate", revision: 1, content: ruleContent("gate") }
];

function assembleWithBudget(budgetBytes: number | null) {
  return assembleContextBundle(world.db, {
    projectId: world.projectB.projectId,
    runId: world.projectB.runId,
    nodeId: world.projectB.nodeId,
    node: nodeDefinition(world.projectB),
    roleResponsibility: ROLE_RESPONSIBILITY,
    projectRules: RULES,
    dependencies: [
      {
        sourceNodeId: world.projectB.depNodeId,
        commitSha: depOutputSha(world.projectB),
        content: depContent(world.projectB.projectId)
      }
    ],
    budgetBytes
  });
}

describe("预算截断：dependency -> task -> role ->（绝不）project_rule", () => {
  it("预算充足：无截断、budgetExceeded=false", () => {
    const bundle = assembleWithBudget(null);
    expect(bundle.fragments.every((fragment) => fragment.included)).toBe(true);
    expect(bundle.manifest.omitted).toEqual([]);
    expect(bundle.manifest.budgetExceeded).toBe(false);
  });

  it("预算超限：依赖最先被丢（中间预算只丢依赖），丢弃行为完整记录在 manifest", () => {
    const bytesOf = (content: string): number => Buffer.byteLength(content, "utf8");
    const rulesBytes = RULES.reduce((sum, rule) => sum + bytesOf(rule.content), 0);
    const full = assembleWithBudget(null);
    const layerBytes = (layer: string): number =>
      full.fragments
        .filter((fragment) => fragment.layer === layer)
        .reduce((sum, fragment) => sum + fragment.contentBytes, 0);
    const roleBytes = layerBytes("role");
    const taskBytes = layerBytes("task");

    // Drop-order pin #1: budget exactly fits rules + role + task -> ONLY the
    // dependency is dropped. Dependency is the first to go.
    const keepRoleTask = assembleWithBudget(rulesBytes + roleBytes + taskBytes);
    expect(keepRoleTask.manifest.omitted.map((fragment) => fragment.layer)).toEqual(["dependency"]);
    expect(
      keepRoleTask.fragments.filter((fragment) => fragment.included).map((fragment) => fragment.layer)
    ).toEqual(["project_rule", "project_rule", "role", "task"]);

    // Drop-order pin #2: budget fits only the rules -> role, task and
    // dependency are all dropped. manifest.omitted is in bundle (sequence)
    // order; the PRIORITY is pinned by what SURVIVES.
    const bundle = assembleWithBudget(rulesBytes + 1);
    expect(bundle.manifest.omitted.map((fragment) => fragment.layer)).toEqual([
      "role",
      "task",
      "dependency"
    ]);
    expect(
      bundle.manifest.omitted.map((fragment) => fragment.omittedReason)
    ).toEqual([BUDGET_OMITTED_REASON, BUDGET_OMITTED_REASON, BUDGET_OMITTED_REASON]);
    expect(bundle.manifest.omittedReasons).toEqual([BUDGET_OMITTED_REASON]);
    expect(bundle.manifest.budgetExceeded).toBe(false);
    // Every omitted fragment keeps its full provenance and content hash.
    const depOmitted = bundle.manifest.omitted.find((fragment) => fragment.layer === "dependency");
    expect(depOmitted?.source.kind).toBe("dependency_output");
    expect(depOmitted?.source.commitSha).toBe(depOutputSha(world.projectB));
    expect(depOmitted?.contentHash).toBe(
      bundle.fragments.find((fragment) => fragment.layer === "dependency")?.contentHash
    );
    // The kept content hash covers ONLY the kept fragments.
    expect(bundle.manifest.byteCount).toBe(rulesBytes);
  });

  it("预算再小规则也不丢：budget < 单条规则字节，规则全部保留且 budgetExceeded=true", () => {
    const bundle = assembleWithBudget(1);

    const keptRules = bundle.fragments.filter(
      (fragment) => fragment.layer === "project_rule" && fragment.included
    );
    expect(keptRules.map((fragment) => fragment.source.id)).toEqual(["rule-tests", "rule-gate"]);
    expect(keptRules.map((fragment) => fragment.content)).toEqual([
      ruleContent("tests"),
      ruleContent("gate")
    ]);
    expect(bundle.manifest.budgetExceeded).toBe(true);
    expect(bundle.manifest.byteCount).toBeGreaterThan(1);
    expect(
      bundle.manifest.omitted.every((fragment) => fragment.layer !== "project_rule")
    ).toBe(true);

    // The honest bundle still persists and verifies.
    const record = persistContextBundle(world.db, bundle, "2026-09-23T00:00:00.000Z");
    expect(record.budgetExceeded).toBe(true);
    expect(verifyContextBundle(world.db, record.id).ok).toBe(true);
  });

  it("同层内后序片段先丢（两条同尺寸依赖只容得下一条时，留下快照顺序中的第一条）", () => {
    world.db
      .prepare("INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) VALUES (?, ?, '1', 'developer', ?, 'READY', ?, ?)")
      .run(world.projectB.runId, "dep-y", "[]", "2026-09-23T00:00:00.000Z", "2026-09-23T00:00:00.000Z");
    world.db
      .prepare("UPDATE task_nodes SET dependencies = ? WHERE run_id = ? AND node_id = ?")
      .run(JSON.stringify(["dep-x", "dep-y"]), world.projectB.runId, world.projectB.nodeId);

    const bigDep = "x".repeat(400);
    const depYSha = "1".repeat(40);
    addIntegrationParent(world, world.projectB, "dep-y", depYSha);
    const assembleTwo = (budgetBytes: number | null) =>
      assembleContextBundle(world.db, {
        projectId: world.projectB.projectId,
        runId: world.projectB.runId,
        nodeId: world.projectB.nodeId,
        node: { ...nodeDefinition(world.projectB), dependencies: ["dep-x", "dep-y"] },
        roleResponsibility: ROLE_RESPONSIBILITY,
        projectRules: RULES,
        dependencies: [
          { sourceNodeId: "dep-x", commitSha: depOutputSha(world.projectB), content: bigDep },
          { sourceNodeId: "dep-y", commitSha: depYSha, content: bigDep }
        ],
        budgetBytes
      });

    const full = assembleTwo(null);
    const total = full.manifest.byteCount;
    // Exactly one dependency must be dropped: total - 400 + 1.
    const tight = assembleTwo(total - 400 + 1);
    expect(tight.manifest.omitted.map((fragment) => fragment.source.id)).toEqual(["dep-y"]);
    expect(
      tight.fragments
        .filter((fragment) => fragment.layer === "dependency" && fragment.included)
        .map((fragment) => fragment.source.id)
    ).toEqual(["dep-x"]);
    expect(tight.manifest.budgetExceeded).toBe(false);
  });

  it("不同截断结果产生不同保留集、不同 manifest 哈希与不同 bundleId（截断可审计）", () => {
    const generous = assembleWithBudget(null);
    const tight = assembleWithBudget(1);
    expect(tight.manifest.bundleId).not.toBe(generous.manifest.bundleId);
    expect(generous.manifest.fragments).toHaveLength(5);
    expect(tight.manifest.fragments).toHaveLength(2);
    expect(tight.manifest.fragments.every((fragment) => fragment.layer === "project_rule")).toBe(true);
    expect(tight.manifest.contentHash).not.toBe(generous.manifest.contentHash);
    expect(tight.manifest.omitted).toHaveLength(3);
    expect(generous.manifest.omitted).toHaveLength(0);
  });
});
