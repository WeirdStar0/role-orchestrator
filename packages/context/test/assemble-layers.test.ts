/**
 * M3-01 acceptance: migration chain composition (CONTEXT_MIGRATIONS =
 * REVIEW_MIGRATIONS + 007) and the layered assembly — order, sources,
 * provenance, and every data-plane rejection (A15 baseline, foreign
 * dependencies, definition mismatch).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, verifyMigrations } from "@role-orchestrator/store";
import { assembleContextBundle } from "../src/assemble.js";
import {
  CONTEXT_MIGRATIONS,
  CONTEXT_SCHEMA_MIGRATION,
  applyContextMigrations,
  persistContextBundle
} from "../src/persist.js";
import { REVIEW_MIGRATIONS } from "@role-orchestrator/review";
import {
  CrossProjectSourceError,
  ForeignDependencyError,
  NodeDefinitionMismatchError,
  UnknownContextTargetError
} from "../src/errors.js";
import {
  PROJECT_A,
  ROLE_RESPONSIBILITY,
  T0,
  addIntegrationParent,
  createWorld,
  depContent,
  depOutputSha,
  nodeDefinition,
  removeTreeRobust,
  ruleContent,
  sha40,
  type World
} from "./helpers.js";

interface Suite {
  readonly world: World;
}

function withWorld(fn: (suite: Suite) => void): void {
  const world = createWorld();
  try {
    fn({ world });
  } finally {
    world.close();
    removeTreeRobust(world.scratchDir);
  }
}

function assemble(world: World, fixture = world.projectB) {
  return assembleContextBundle(world.db, {
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
        content: depContent(fixture.projectId)
      }
    ]
  });
}

describe("M3-01 迁移 007：组合链", () => {
  it("CONTEXT_MIGRATIONS = REVIEW_MIGRATIONS + 007，版本 1..7 且 verify 通过", async () => {
    expect(CONTEXT_SCHEMA_MIGRATION.version).toBe(7);
    expect(CONTEXT_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(CONTEXT_MIGRATIONS.slice(0, 6)).toEqual(REVIEW_MIGRATIONS);

    const dir = mkdtempSync(path.join(os.tmpdir(), "ro-context-mig-"));
    const db = openDatabase(path.join(dir, "mig.db"));
    try {
      const applied = await applyContextMigrations(db, { now: T0 });
      expect(applied.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(verifyMigrations(db, { migrations: CONTEXT_MIGRATIONS })).toEqual({
        ok: true,
        checked: 7,
        versions: [1, 2, 3, 4, 5, 6, 7]
      });
      // Idempotent: a second application applies nothing.
      const again = await applyContextMigrations(db, { now: T0 });
      expect(again.appliedVersions).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("007 建表：context_bundles 与 bundle_fragments 存在", () => {
    withWorld(({ world }) => {
      const tables = world.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('context_bundles', 'bundle_fragments') ORDER BY name"
        )
        .all() as { name: string }[];
      expect(tables.map((row) => row.name)).toEqual(["bundle_fragments", "context_bundles"]);
    });
  });
});

describe("M3-01 分层装配：顺序与来源", () => {
  it("片段顺序 = project_rule -> role -> task -> dependency，来源完整且内容哈希正确", () => {
    withWorld(({ world }) => {
      const bundle = assemble(world);
      expect(bundle.fragments.map((fragment) => fragment.layer)).toEqual([
        "project_rule",
        "project_rule",
        "role",
        "task",
        "dependency"
      ]);

      const [rule1, rule2, role, task, dep] = bundle.fragments;
      expect(rule1?.source).toEqual({
        kind: "project_rule",
        id: "rule-tests",
        revision: "3",
        profileId: null,
        commitSha: null,
        artifactId: null
      });
      expect(rule2?.source.id).toBe("rule-gate");
      expect(role?.source).toEqual({
        kind: "role_binding",
        id: "developer",
        revision: "1",
        profileId: world.projectB.profileId,
        commitSha: null,
        artifactId: null
      });
      expect(task?.source).toEqual({
        kind: "task_node",
        id: world.projectB.nodeId,
        revision: "1",
        profileId: null,
        commitSha: null,
        artifactId: null
      });
      expect(dep?.source).toEqual({
        kind: "dependency_output",
        id: world.projectB.depNodeId,
        revision: null,
        profileId: null,
        commitSha: depOutputSha(world.projectB),
        artifactId: null
      });
      expect(role?.content).toBe(ROLE_RESPONSIBILITY);
      expect(task?.content).toContain("objective: 在依赖产物之上实现 impl-b 的目标。");
      expect(task?.content).toContain("- 全部测试通过");

      for (const fragment of bundle.fragments) {
        expect(fragment.trust).toBe(fragment.layer === "dependency" ? "verified-evidence" : "policy");
        expect(fragment.contentBytes).toBe(Buffer.byteLength(fragment.content, "utf8"));
      }
      expect(bundle.manifest.roleId).toBe("developer");
      expect(bundle.manifest.budgetMethod).toBe("estimated-bytes");
      expect(bundle.manifest.budgetBytes).toBeNull();
      expect(bundle.manifest.budgetExceeded).toBe(false);
      expect(bundle.manifest.omitted).toEqual([]);
      expect(bundle.manifest.omittedReasons).toEqual([]);
    });
  });

  it("依赖片段遵循冻结快照顺序，而非调用方数组顺序", () => {
    withWorld(({ world }) => {
      // Give B a second dependency node, a snapshot [dep-y, dep-x] and the
      // matching second integration parent.
      world.db
        .prepare("INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) VALUES (?, ?, '1', 'developer', ?, 'READY', ?, ?)")
        .run(world.projectB.runId, "dep-y", "[]", T0, T0);
      world.db
        .prepare("UPDATE task_nodes SET dependencies = ? WHERE run_id = ? AND node_id = ?")
        .run(JSON.stringify(["dep-y", "dep-x"]), world.projectB.runId, world.projectB.nodeId);
      addIntegrationParent(world, world.projectB, "dep-y", sha40("dep-y-output"));

      const bundle = assembleContextBundle(world.db, {
        projectId: world.projectB.projectId,
        runId: world.projectB.runId,
        nodeId: world.projectB.nodeId,
        node: {
          ...nodeDefinition(world.projectB),
          dependencies: ["dep-y", "dep-x"]
        },
        roleResponsibility: ROLE_RESPONSIBILITY,
        projectRules: [],
        // Caller hands them in the OPPOSITE order; the snapshot order wins.
        dependencies: [
          { sourceNodeId: "dep-x", commitSha: depOutputSha(world.projectB), content: depContent("x") },
          { sourceNodeId: "dep-y", commitSha: sha40("dep-y-output"), content: depContent("y") }
        ]
      });
      const depLayers = bundle.fragments
        .filter((fragment) => fragment.layer === "dependency")
        .map((fragment) => fragment.source.id);
      expect(depLayers).toEqual(["dep-y", "dep-x"]);
    });
  });

  it("同一装配内容 -> 同一 bundleId（内容寻址）；规则内容变化 -> 不同 bundleId", () => {
    withWorld(({ world }) => {
      const first = assemble(world);
      const second = assemble(world);
      expect(second.manifest.bundleId).toBe(first.manifest.bundleId);

      const different = assembleContextBundle(world.db, {
        projectId: world.projectB.projectId,
        runId: world.projectB.runId,
        nodeId: world.projectB.nodeId,
        node: nodeDefinition(world.projectB),
        roleResponsibility: ROLE_RESPONSIBILITY,
        projectRules: [
          { ruleId: "rule-tests", revision: 4, content: ruleContent("tests-v4") }
        ],
        dependencies: [
          {
            sourceNodeId: world.projectB.depNodeId,
            commitSha: depOutputSha(world.projectB),
            content: depContent(world.projectB.projectId)
          }
        ]
      });
      expect(different.manifest.bundleId).not.toBe(first.manifest.bundleId);
    });
  });
});

describe("M3-01 数据面拒绝：跨项目与外来源", () => {
  it("run 属于其他 project 时拒绝（A15 数据面）", () => {
    withWorld(({ world }) => {
      expect(() =>
        assembleContextBundle(world.db, {
          projectId: PROJECT_A,
          runId: world.projectB.runId,
          nodeId: world.projectB.nodeId,
          node: nodeDefinition(world.projectB),
          roleResponsibility: ROLE_RESPONSIBILITY,
          projectRules: [],
          dependencies: []
        })
      ).toThrow(CrossProjectSourceError);
    });
  });

  it("依赖节点不在冻结快照内 -> ForeignDependencyError（外项目节点无法混入）", () => {
    withWorld(({ world }) => {
      // Project A's dependency node id, smuggled into project B's assembly.
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
  });

  it("依赖 SHA 与集成记录的父输出不符 -> ForeignDependencyError", () => {
    withWorld(({ world }) => {
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
              sourceNodeId: world.projectB.depNodeId,
              commitSha: sha40("forged"),
              content: depContent("forged")
            }
          ]
        })
      ).toThrow(ForeignDependencyError);
    });
  });

  it("节点定义与冻结行不一致（角色/快照） -> NodeDefinitionMismatchError", () => {
    withWorld(({ world }) => {
      expect(() =>
        assembleContextBundle(world.db, {
          projectId: world.projectB.projectId,
          runId: world.projectB.runId,
          nodeId: world.projectB.nodeId,
          node: { ...nodeDefinition(world.projectB), role: "reviewer" },
          roleResponsibility: ROLE_RESPONSIBILITY,
          projectRules: [],
          dependencies: []
        })
      ).toThrow(NodeDefinitionMismatchError);

      expect(() =>
        assembleContextBundle(world.db, {
          projectId: world.projectB.projectId,
          runId: world.projectB.runId,
          nodeId: world.projectB.nodeId,
          node: { ...nodeDefinition(world.projectB), dependencies: [] },
          roleResponsibility: ROLE_RESPONSIBILITY,
          projectRules: [],
          dependencies: []
        })
      ).toThrow(NodeDefinitionMismatchError);
    });
  });

  it("run 或节点不存在 -> UnknownContextTargetError；快照缺依赖内容 -> ForeignDependencyError", () => {
    withWorld(({ world }) => {
      expect(() =>
        assembleContextBundle(world.db, {
          projectId: world.projectB.projectId,
          runId: "run-missing",
          nodeId: world.projectB.nodeId,
          node: nodeDefinition(world.projectB),
          roleResponsibility: ROLE_RESPONSIBILITY,
          projectRules: [],
          dependencies: []
        })
      ).toThrow(UnknownContextTargetError);

      expect(() =>
        assembleContextBundle(world.db, {
          projectId: world.projectB.projectId,
          runId: world.projectB.runId,
          nodeId: world.projectB.nodeId,
          node: nodeDefinition(world.projectB),
          roleResponsibility: ROLE_RESPONSIBILITY,
          projectRules: [],
          dependencies: []
        })
      ).toThrow(ForeignDependencyError);
    });
  });

  it("persist 后 manifest 哈希与 content hash 均可独立复核（幂等吸收重复装配）", () => {
    withWorld(({ world }) => {
      const bundle = assemble(world);
      const first = persistContextBundle(world.db, bundle, T0);
      expect(first.createdAt).toBe(T0);
      expect(first.fragmentCount).toBe(5);
      expect(first.includedCount).toBe(5);

      // Same assembly persisted again -> absorbed into the same row.
      const again = persistContextBundle(world.db, assemble(world), "2026-09-23T01:00:00.000Z");
      expect(again.id).toBe(first.id);
      expect(again.createdAt).toBe(T0);

      const count = (db: DatabaseSync): number =>
        Number(
          (db.prepare("SELECT COUNT(*) AS n FROM context_bundles").get() as { n: number }).n
        );
      expect(count(world.db)).toBe(1);
    });
  });
});
