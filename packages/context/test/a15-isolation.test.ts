/**
 * M3-01 acceptance (A15 data-plane baseline): a project's dependency
 * artifacts never leak into another project's bundle. The data layer
 * enforces this three ways, each pinned by a test:
 * 1. assembly refuses a bundle whose run belongs to another project;
 * 2. a dependency fragment must sit in the node's OWN frozen snapshot, so a
 *    foreign node id cannot be smuggled in;
 * 3. every stored row carries its project id and every query is
 *    project-scoped — project A's fragments are invisible from project B.
 * (The M3-03 authorization layer goes on TOP of these properties.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleContextBundle } from "../src/assemble.js";
import {
  findFragmentsBySource,
  getContextBundle,
  listContextBundles,
  persistContextBundle,
  traceFragment
} from "../src/persist.js";
import { CrossProjectSourceError, ForeignDependencyError } from "../src/errors.js";
import {
  PROJECT_A,
  ROLE_RESPONSIBILITY,
  createWorld,
  depContent,
  depOutputSha,
  nodeDefinition,
  removeTreeRobust,
  type ProjectFixture,
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

function assembleFor(fixture: ProjectFixture) {
  return assembleContextBundle(world.db, {
    projectId: fixture.projectId,
    runId: fixture.runId,
    nodeId: fixture.nodeId,
    node: nodeDefinition(fixture),
    roleResponsibility: ROLE_RESPONSIBILITY,
    projectRules: [{ ruleId: `rule-${fixture.projectId}`, revision: 1, content: `rule of ${fixture.projectId}` }],
    dependencies: [
      {
        sourceNodeId: fixture.depNodeId,
        commitSha: depOutputSha(fixture),
        content: depContent(fixture.projectId)
      }
    ]
  });
}

describe("跨项目来源不串（A15 数据面）", () => {
  it("装配拒绝跨项目：project A 的 project id 配 project B 的 run -> 拒绝", () => {
    expect(() =>
      assembleContextBundle(world.db, {
        projectId: PROJECT_A,
        runId: world.projectB.runId,
        nodeId: world.projectB.nodeId,
        node: nodeDefinition(world.projectB),
        roleResponsibility: ROLE_RESPONSIBILITY,
        projectRules: [],
        dependencies: [
          {
            sourceNodeId: world.projectB.depNodeId,
            commitSha: depOutputSha(world.projectB),
            content: depContent("stolen")
          }
        ]
      })
    ).toThrow(CrossProjectSourceError);
  });

  it("project A 的依赖片段无法混入 project B 的 bundle（快照不含外来节点）", () => {
    expect(() =>
      assembleContextBundle(world.db, {
        projectId: world.projectB.projectId,
        runId: world.projectB.runId,
        nodeId: world.projectB.nodeId,
        node: nodeDefinition(world.projectB),
        roleResponsibility: ROLE_RESPONSIBILITY,
        projectRules: [],
        dependencies: [
          {
            sourceNodeId: world.projectA.depNodeId,
            commitSha: depOutputSha(world.projectA),
            content: depContent(world.projectA.projectId)
          }
        ]
      })
    ).toThrow(ForeignDependencyError);
  });

  it("落库后按 project 查询：B 看不到 A 的 bundle，B 的片段全部指向 B 自己的节点", () => {
    const a = persistContextBundle(world.db, assembleFor(world.projectA), "2026-09-23T00:00:00.000Z");
    const b = persistContextBundle(world.db, assembleFor(world.projectB), "2026-09-23T00:00:00.000Z");

    expect(listContextBundles(world.db, { projectId: world.projectB.projectId }).map((row) => row.id)).toEqual([b.id]);
    expect(listContextBundles(world.db, { projectId: PROJECT_A }).map((row) => row.id)).toEqual([a.id]);

    const bundleB = getContextBundle(world.db, b.id);
    expect(bundleB?.projectId).toBe(world.projectB.projectId);
    const foreignSourceIds = (bundleB?.fragments ?? [])
      .map((fragment) => fragment.source.id)
      .filter((id) => id.includes(PROJECT_A));
    expect(foreignSourceIds).toEqual([]);

    // Reverse lookup scoped to B never surfaces A's rows: the shared node id
    // "dep-x" exists in BOTH runs, and each project's scope resolves only
    // its own fragment.
    const depId = world.projectB.depNodeId;
    const scopedB = findFragmentsBySource(world.db, { sourceId: depId, projectId: world.projectB.projectId });
    expect(scopedB.map((hit) => hit.bundleId)).toEqual([b.id]);
    expect(scopedB.map((hit) => hit.projectId)).toEqual([world.projectB.projectId]);
    const scopedA = findFragmentsBySource(world.db, { sourceId: depId, projectId: PROJECT_A });
    expect(scopedA.map((hit) => hit.bundleId)).toEqual([a.id]);
    expect(scopedA.map((hit) => hit.projectId)).toEqual([PROJECT_A]);

    for (const sequence of bundleB?.manifest.fragments.map((fragment) => fragment.sequence) ?? []) {
      const trace = traceFragment(world.db, { bundleId: b.id, sequence });
      expect(trace.projectId).toBe(world.projectB.projectId);
      expect(trace.runId).toBe(world.projectB.runId);
    }
  });

  it("B 的 bundle 内容里不出现 A 的规则/依赖文本（内容级隔离抽查）", () => {
    const b = persistContextBundle(world.db, assembleFor(world.projectB), "2026-09-23T00:00:00.000Z");
    const bundleB = getContextBundle(world.db, b.id);
    const joined = (bundleB?.fragments ?? []).map((fragment) => fragment.content).join("\n");
    expect(joined).not.toContain(`rule of ${PROJECT_A}`);
    expect(joined).not.toContain(depContent(PROJECT_A));
  });
});
