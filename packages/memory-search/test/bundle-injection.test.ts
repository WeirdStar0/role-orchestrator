/**
 * Memory -> context bundle integration (M3-03): retrieval hits injected as
 * the context package's `memory` layer with full provenance
 * (memoryId + version + contentHash), M3-01 truncation semantics intact
 * (memory fragments dropped FIRST, project rules NEVER), staleness policy
 * enforced structurally (default exclude; explicit opt-in labels loudly),
 * persistence + reverse traceability working through migration 010, and
 * the injection path itself isolated (a foreign-project session refuses).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleContextBundleWithMemory,
  CrossProjectAccessError,
  openMemoryAccess,
  type MemoryAccess
} from "../src/index.js";
import {
  ContextBundleManifestSchema,
  StaleMemoryNotAdmittedError,
  assembleContextBundle,
  contentHashOf,
  findFragmentsBySource,
  getContextBundle,
  persistContextBundle,
  traceFragment,
  verifyContextBundle
} from "@role-orchestrator/context";
import type { ContextBundle } from "@role-orchestrator/context";
import {
  PROJECT_A,
  PROJECT_B,
  T3,
  createRunFixture,
  createSearchWorld,
  removeTreeRobust,
  roleActor,
  sha40,
  verifiedFact,
  type World
} from "./helpers.js";
import type { RunFixture } from "./helpers.js";

let world: World;
let runA: RunFixture;
let accessA: MemoryAccess;

beforeEach(() => {
  world = createSearchWorld();
  runA = createRunFixture(world, PROJECT_A);
  accessA = world.accessA();
});

afterEach(() => {
  world.close();
  removeTreeRobust(world.scratchDir);
});

function nodeDefinition(): {
  readonly id: string;
  readonly role: "developer";
  readonly title: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly capabilityTags: readonly ["backend"];
  readonly acceptanceCriteria: readonly string[];
} {
  return {
    id: runA.nodeId,
    role: "developer",
    title: "实现依赖方的功能",
    objective: "在依赖产物之上实现 impl-b 的目标。",
    dependencies: [runA.depNodeId],
    capabilityTags: ["backend"],
    acceptanceCriteria: ["全部测试通过", "不引入回归"]
  };
}

interface InjectOverrides {
  readonly budgetBytes?: number | null;
  readonly includeStaleMemories?: boolean;
  readonly query?: string;
  readonly projectId?: string;
}

function inject(overrides: InjectOverrides = {}): ContextBundle {
  return assembleContextBundleWithMemory(world.db, accessA, {
    projectId: overrides.projectId ?? PROJECT_A,
    bundle: {
      runId: runA.runId,
      nodeId: runA.nodeId,
      node: nodeDefinition(),
      roleResponsibility: "developer 在授权工作树内实现与测试，不自行扩大范围。",
      projectRules: [
        { ruleId: "rule-a-1", revision: 1, content: "project rule alpha: never bypass the gate." },
        { ruleId: "rule-a-2", revision: 1, content: "project rule beta: all changes need tests." }
      ],
      dependencies: [
        {
          sourceNodeId: runA.depNodeId,
          commitSha: sha40(`${PROJECT_A}-dep`),
          content: "dependency output: exported function implemented with unit tests."
        }
      ],
      budgetBytes: overrides.budgetBytes === undefined ? null : overrides.budgetBytes
    },
    memory: { query: overrides.query ?? "parseEvent exports" },
    includeStaleMemories: overrides.includeStaleMemories === true
  });
}

function seedMemoryHits(): void {
  verifiedFact(world, PROJECT_A, {
    id: "fact-inject-1",
    content: "fact: parseEvent exports remain stable across revisions."
  });
  verifiedFact(world, PROJECT_A, {
    id: "fact-inject-2",
    content: "fact: parseEvent callers were migrated; exports unchanged."
  });
}

describe("注入与可追溯（memoryId + version + contentHash）", () => {
  it("检索命中以 memory 层注入，来源引用三元组可校验", () => {
    seedMemoryHits();
    const bundle = inject();
    const memoryFragments = bundle.fragments.filter((fragment) => fragment.layer === "memory");
    expect(memoryFragments.map((fragment) => fragment.source.id)).toEqual([
      "fact-inject-1",
      "fact-inject-2"
    ]);
    for (const fragment of memoryFragments) {
      expect(fragment.source.kind).toBe("memory_entry");
      expect(fragment.source.revision).toBe("2"); // the memory's version
      expect(fragment.trust).toBe("untrusted-content");
      expect(fragment.contentHash).toBe(contentHashOf(fragment.content));
    }
    // Layer order: rules -> role -> task -> dependency -> memory.
    expect(bundle.fragments.map((fragment) => fragment.layer)).toEqual([
      "project_rule",
      "project_rule",
      "role",
      "task",
      "dependency",
      "memory",
      "memory"
    ]);
  });

  it("持久化后逐行可追溯：bundle_fragments 行、traceFragment、反查全部可用", () => {
    seedMemoryHits();
    const bundle = inject();
    const record = persistContextBundle(world.db, bundle, T3);
    expect(verifyContextBundle(world.db, record.id).ok).toBe(true);
    const readBack = getContextBundle(world.db, record.id);
    expect(readBack).not.toBeNull();
    const persistedMemory = readBack?.fragments.filter((fragment) => fragment.layer === "memory") ?? [];
    expect(persistedMemory).toHaveLength(2);
    for (const fragment of persistedMemory) {
      expect(fragment.source.kind).toBe("memory_entry");
      expect(fragment.source.profileId).toBeNull();
      const trace = traceFragment(world.db, { bundleId: record.id, sequence: fragment.sequence });
      expect(trace.source.id).toMatch(/^fact-inject-/);
      expect(trace.source.revision).toBe("2");
    }
    // Reverse lookup by memory id and by sourceSha.
    const byMemoryId = findFragmentsBySource(world.db, { sourceId: "fact-inject-1", projectId: PROJECT_A });
    expect(byMemoryId).toHaveLength(1);
    const sourced = verifiedFact(world, PROJECT_A, {
      id: "fact-inject-3",
      content: "fact: parseEvent exports provenance carries its source sha."
    });
    accessA.attachSource({
      memoryId: sourced.id,
      expectedVersion: sourced.version,
      sourceSha: "d".repeat(40),
      now: T3
    });
    const bundle2 = inject();
    const fragment = bundle2.fragments.find((entry) => entry.source.id === "fact-inject-3");
    expect(fragment?.source.commitSha).toBe("d".repeat(40));
  });
});

describe("stale 的下游策略：默认排除，显式 opt-in 必须响亮标注", () => {
  it("stale 记忆默认不进入 bundle；检索仍返回并带显式标记", () => {
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-stale-bundle" });
    accessA.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "a".repeat(40),
      now: T3
    });
    accessA.checkSources({ now: T3, resolve: () => ({ exists: false, currentSha: null }) });
    const bundle = inject({ query: "parseEvent" });
    expect(bundle.fragments.some((fragment) => fragment.source.id === "fact-stale-bundle")).toBe(false);
    const manifest = ContextBundleManifestSchema.parse(bundle.manifest);
    expect(manifest.omitted.some((entry) => entry.source.id === "fact-stale-bundle")).toBe(false);
    // But retrieval itself surfaces it with the explicit mark (marking,
    // never hiding):
    const [hit] = accessA.search({ query: "parseEvent" });
    expect(hit?.stale).toBe(true);
    expect(hit?.staleReason).toBe("missing");
  });

  it("直接把 stale 条目交给装配器（未开 opt-in）→ 结构性拒绝", () => {
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-stale-direct" });
    accessA.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "b".repeat(40),
      now: T3
    });
    accessA.checkSources({ now: T3, resolve: () => ({ exists: false, currentSha: null }) });
    expect(() =>
      assembleContextBundle(world.db, {
        projectId: PROJECT_A,
        runId: runA.runId,
        nodeId: runA.nodeId,
        node: nodeDefinition(),
        roleResponsibility: "developer duty",
        projectRules: [],
        dependencies: [
          { sourceNodeId: runA.depNodeId, commitSha: sha40(`${PROJECT_A}-dep`), content: "dep output" }
        ],
        memoryEntries: [
          {
            memoryId: "fact-stale-direct",
            version: 2,
            content: "parseEvent stale content",
            stale: true,
            staleReason: "missing"
          }
        ]
      })
    ).toThrow(StaleMemoryNotAdmittedError);
  });

  it("opt-in 注入 stale 记忆：内容带 [STALE MEMORY …] 显式标注，无提示复用不可能", () => {
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-stale-optin" });
    accessA.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "c".repeat(40),
      now: T3
    });
    accessA.checkSources({ now: T3, resolve: () => ({ exists: false, currentSha: null }) });
    const bundle = inject({ query: "parseEvent", includeStaleMemories: true });
    const stale = bundle.fragments.find((fragment) => fragment.source.id === "fact-stale-optin");
    expect(stale).toBeDefined();
    expect(stale?.content).toContain("[STALE MEMORY fact-stale-optin v2 reason=missing]");
    expect(stale?.content).toContain(memory.content);
    expect(stale?.contentHash).toBe(contentHashOf(stale?.content ?? ""));
  });
});

describe("截断保规则在 memory 注入路径同样成立", () => {
  it("预算超限时 memory 片段最先被截掉，规则永不丢弃，omitted 全程记录", () => {
    seedMemoryHits();
    const ruleBytes = "project rule alpha: never bypass the gate.".length +
      "project rule beta: all changes need tests.".length;
    // One byte SHORT of the rules alone: after every droppable layer is cut,
    // the kept rules still overflow — recorded as budgetExceeded, never hidden.
    const bundle = inject({ budgetBytes: ruleBytes - 1 });
    const manifest = ContextBundleManifestSchema.parse(bundle.manifest);
    expect(manifest.budgetExceeded).toBe(true); // rules alone overflow -> recorded, never hidden
    const keptLayers = bundle.fragments
      .filter((fragment) => fragment.included)
      .map((fragment) => fragment.layer);
    expect(keptLayers).toEqual(["project_rule", "project_rule"]);
    // omitted keeps assembly (sequence) order: rules > role > task > dep > memory.
    expect(manifest.omitted.map((entry) => entry.layer)).toEqual([
      "role",
      "task",
      "dependency",
      "memory",
      "memory"
    ]);
    expect(manifest.omittedReasons).toEqual(["budget-bytes-exceeded"]);
  });

  it("memory 层优先级最低：预算恰好挤掉 memory 片段时，其余层完整保留", () => {
    seedMemoryHits();
    const full = inject();
    const fullManifest = ContextBundleManifestSchema.parse(full.manifest);
    const totalBytes = fullManifest.byteCount;
    const memoryBytes = full.fragments
      .filter((fragment) => fragment.layer === "memory")
      .reduce((sum, fragment) => sum + fragment.contentBytes, 0);
    const squeezed = inject({ budgetBytes: totalBytes - memoryBytes });
    const manifest = ContextBundleManifestSchema.parse(squeezed.manifest);
    expect(manifest.omitted.map((entry) => entry.layer)).toEqual(["memory", "memory"]);
    expect(squeezed.fragments.filter((fragment) => fragment.included).map((fragment) => fragment.layer))
      .toEqual(["project_rule", "project_rule", "role", "task", "dependency"]);
    expect(manifest.budgetExceeded).toBe(false);
  });

  it("预算充足时注入不丢任何层；budgetExceeded=false", () => {
    seedMemoryHits();
    const bundle = inject();
    const manifest = ContextBundleManifestSchema.parse(bundle.manifest);
    expect(manifest.budgetExceeded).toBe(false);
    expect(manifest.omitted).toEqual([]);
    expect(bundle.manifest.fragments).toHaveLength(7);
  });
});

describe("注入路径的隔离（A15 延续）", () => {
  it("B 项目的检索结果永远进不了 A 的 bundle", () => {
    seedMemoryHits();
    // B has its own verified fact matching the SAME query tokens.
    verifiedFact(world, PROJECT_B, {
      id: "fact-b-inject",
      content: "fact: parseEvent exports of project B are NOT for A."
    });
    const bundle = inject();
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("fact-b-inject");
    expect(serialized).not.toContain("NOT for A");
    const memoryIds = bundle.fragments
      .filter((fragment) => fragment.layer === "memory")
      .map((fragment) => fragment.source.id);
    expect(memoryIds).toEqual(["fact-inject-1", "fact-inject-2"]);
  });

  it("用 B 的会话装配 A 的 bundle → CrossProjectAccessError", () => {
    const accessB = openMemoryAccess(world.db, { projectId: PROJECT_B });
    expect(() =>
      assembleContextBundleWithMemory(world.db, accessB, {
        projectId: PROJECT_A,
        bundle: {
          runId: runA.runId,
          nodeId: runA.nodeId,
          node: nodeDefinition(),
          roleResponsibility: "duty",
          projectRules: [],
          dependencies: [
            { sourceNodeId: runA.depNodeId, commitSha: sha40(`${PROJECT_A}-dep`), content: "dep" }
          ]
        },
        memory: { query: "anything" }
      })
    ).toThrow(CrossProjectAccessError);
    // The mirror case (B session, B bundle) assembles fine — proving the
    // refusal above is about the cross-project mismatch, not the session:
    const accessB2 = openMemoryAccess(world.db, { projectId: PROJECT_B });
    const runB = createRunFixture(world, PROJECT_B);
    expect(() =>
      assembleContextBundleWithMemory(world.db, accessB2, {
        projectId: PROJECT_B,
        bundle: {
          runId: runB.runId,
          nodeId: runB.nodeId,
          node: { ...nodeDefinition(), id: runB.nodeId },
          roleResponsibility: "duty",
          projectRules: [],
          dependencies: [
            { sourceNodeId: runB.depNodeId, commitSha: sha40(`${PROJECT_B}-dep`), content: "dep b" }
          ]
        },
        memory: { query: "anything" }
      })
    ).not.toThrow();
  });

  it("注入大量内容不改变 CAS/生命周期行为（A16 延伸：注入是纯读装配）", () => {
    seedMemoryHits();
    const bundle = inject();
    expect(bundle).toBeDefined();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-after-inject" });
    const updated = accessA.update({
      memoryId: memory.id,
      expectedVersion: memory.version,
      actor: roleActor("developer"),
      content: "fact: parseEvent post-injection update path intact.",
      now: T3
    });
    expect(updated.version).toBe(memory.version + 1);
  });
});
