/**
 * M3-01 acceptance: manifest traceability + verification. Any fragment
 * traces back to its artifact/SHA/revision reference, sources can be looked
 * up in reverse, and recomputing every hash exposes tampering or deletion —
 * M3-01 完成标准: 任意片段能追溯到 artifact/SHA/revision，manifest 可校验。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findFragmentsBySource,
  getContextBundle,
  listContextBundles,
  persistContextBundle,
  requireContextBundle as requireBundle,
  traceFragment,
  verifyContextBundle
} from "../src/persist.js";
import { assembleContextBundle } from "../src/assemble.js";
import {
  ContextManifestIntegrityError,
  UnknownContextBundleError,
  UnknownContextFragmentError
} from "../src/errors.js";
import {
  PROJECT_A,
  ROLE_RESPONSIBILITY,
  T0,
  createWorld,
  depContent,
  depOutputSha,
  nodeDefinition,
  removeTreeRobust,
  ruleContent,
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

function assembleAndPersist(fixture: ProjectFixture = world.projectB) {
  const bundle = assembleContextBundle(world.db, {
    projectId: fixture.projectId,
    runId: fixture.runId,
    nodeId: fixture.nodeId,
    node: nodeDefinition(fixture),
    roleResponsibility: ROLE_RESPONSIBILITY,
    projectRules: [
      { ruleId: "rule-tests", revision: 3, content: ruleContent("tests") },
      { ruleId: "rule-gate", revision: 1, content: ruleContent("gate") }
    ],
    dependencies: [
      {
        sourceNodeId: fixture.depNodeId,
        commitSha: depOutputSha(fixture),
        artifactId: "artifact-patch",
        content: depContent(fixture.projectId)
      }
    ]
  });
  return persistContextBundle(world.db, bundle, T0);
}

describe("manifest 追溯", () => {
  it("每个片段可反向追溯到 artifact/SHA/revision", () => {
    const record = assembleAndPersist();

    const rule = traceFragment(world.db, { bundleId: record.id, sequence: 0 });
    expect(rule.source).toEqual({
      kind: "project_rule",
      id: "rule-tests",
      revision: "3",
      profileId: null,
      commitSha: null,
      artifactId: null
    });

    const role = traceFragment(world.db, { bundleId: record.id, sequence: 2 });
    expect(role.source.kind).toBe("role_binding");
    expect(role.source.profileId).toBe(world.projectB.profileId);
    expect(role.source.revision).toBe("1");

    const task = traceFragment(world.db, { bundleId: record.id, sequence: 3 });
    expect(task.source).toEqual({
      kind: "task_node",
      id: world.projectB.nodeId,
      revision: "1",
      profileId: null,
      commitSha: null,
      artifactId: null
    });

    const dep = traceFragment(world.db, { bundleId: record.id, sequence: 4 });
    expect(dep.source.kind).toBe("dependency_output");
    expect(dep.source.commitSha).toBe(depOutputSha(world.projectB));
    expect(dep.source.artifactId).toBe("artifact-patch");
  });

  it("从来源反查：commit SHA、规则 id、artifact 引用都能找到引用它的 bundle", () => {
    const b = assembleAndPersist(world.projectB);
    const a = assembleAndPersist(world.projectA);

    const bySha = findFragmentsBySource(world.db, {
      sourceId: world.projectB.depNodeId,
      commitSha: depOutputSha(world.projectB)
    });
    expect(bySha.map((hit) => hit.bundleId)).toEqual([b.id]);
    expect(bySha[0]?.layer).toBe("dependency");

    // The SAME dependency node id exists in both runs; the SHA separates them.
    const bothRuns = findFragmentsBySource(world.db, { sourceId: world.projectB.depNodeId });
    expect(new Set(bothRuns.map((hit) => hit.bundleId))).toEqual(new Set([a.id, b.id]));

    const rulesB = findFragmentsBySource(world.db, {
      sourceId: "rule-tests",
      sourceKind: "project_rule",
      projectId: world.projectB.projectId
    });
    expect(rulesB.map((hit) => hit.bundleId)).toEqual([b.id]);
    expect(rulesB.map((hit) => hit.sequence)).toEqual([0]);

    const noneUnderA = findFragmentsBySource(world.db, {
      sourceId: "rule-tests",
      sourceKind: "project_rule",
      projectId: PROJECT_A
    });
    expect(noneUnderA.map((hit) => hit.bundleId)).toEqual([a.id]);
  });

  it("查询按 project 作用域：listContextBundles 只返回本项目的 bundle", () => {
    const b = assembleAndPersist(world.projectB);
    const a = assembleAndPersist(world.projectA);

    const listB = listContextBundles(world.db, { projectId: world.projectB.projectId });
    expect(listB.map((row) => row.id)).toEqual([b.id]);
    expect(listB[0]?.contentHash).toBe(b.contentHash);

    const listA = listContextBundles(world.db, { projectId: world.projectA.projectId });
    expect(listA.map((row) => row.id)).toEqual([a.id]);

    expect(listContextBundles(world.db, { projectId: "proj-none" })).toEqual([]);
  });

  it("bundle / fragment 不存在 -> 类型化错误", () => {
    const record = assembleAndPersist();
    expect(() => requireBundle(world.db, "ctx-missing")).toThrow(UnknownContextBundleError);
    expect(() => traceFragment(world.db, { bundleId: record.id, sequence: 99 })).toThrow(
      UnknownContextFragmentError
    );
  });
});

describe("manifest 校验：篡改与缺失必被重算发现", () => {
  it("干净 bundle 通过校验", () => {
    const record = assembleAndPersist();
    expect(verifyContextBundle(world.db, record.id)).toEqual({
      ok: true,
      bundleId: record.id,
      checkedFragments: 5,
      contentHash: record.contentHash,
      manifestHash: record.manifestHash
    });
  });

  it("篡改片段内容 -> fragment-hash", () => {
    const record = assembleAndPersist();
    world.db
      .prepare("UPDATE bundle_fragments SET content = content || ' FORGED' WHERE bundle_id = ? AND sequence = 4")
      .run(record.id);
    try {
      verifyContextBundle(world.db, record.id);
      throw new Error("expected ContextManifestIntegrityError");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextManifestIntegrityError);
      if (error instanceof ContextManifestIntegrityError) {
        expect(error.kind).toBe("fragment-hash");
      }
    }
    // Reads refuse the tampered bundle too.
    expect(() => requireBundle(world.db, record.id)).toThrow(ContextManifestIntegrityError);
  });

  it("删除片段行 -> count-mismatch（manifest 指向不存在的片段）", () => {
    const record = assembleAndPersist();
    world.db.prepare("DELETE FROM bundle_fragments WHERE bundle_id = ? AND sequence = 1").run(record.id);
    expect(() => verifyContextBundle(world.db, record.id)).toThrow(ContextManifestIntegrityError);
  });

  it("篡改 manifest JSON -> manifest-hash；篡改 content_hash 列 -> bundle-hash", () => {
    const record = assembleAndPersist();
    world.db
      .prepare("UPDATE context_bundles SET manifest = json_set(manifest, '$.byteCount', 1) WHERE id = ?")
      .run(record.id);
    expect(() => verifyContextBundle(world.db, record.id)).toThrow(ContextManifestIntegrityError);
  });

  it("content_hash 列被单独改写 -> bundle-hash", () => {
    const record = assembleAndPersist();
    world.db
      .prepare("UPDATE context_bundles SET content_hash = ? WHERE id = ?")
      .run("f".repeat(64), record.id);
    try {
      verifyContextBundle(world.db, record.id);
      throw new Error("expected ContextManifestIntegrityError");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextManifestIntegrityError);
      if (error instanceof ContextManifestIntegrityError) {
        expect(error.kind).toBe("bundle-hash");
      }
    }
  });

  it("getContextBundle 每次读取都复核 manifest 哈希（预算信息与行一致）", () => {
    const record = assembleAndPersist();
    const reread = getContextBundle(world.db, record.id);
    expect(reread).not.toBeNull();
    expect(reread?.manifest.schemaVersion).toBe(1);
    expect(reread?.manifest.fragments).toHaveLength(5);
    expect(reread?.manifest.omitted).toHaveLength(0);
    expect(reread?.budgetBytes).toBeNull();
  });
});
