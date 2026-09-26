/**
 * sourceSha staleness (M3-03): memories carry a source artifact/commit SHA;
 * when the source is GONE from the current repository or the baseline has
 * MOVED past it, the memory is explicitly marked stale, retrieval carries
 * the mark, and a later check that finds the source current clears it.
 * Old evidence is never silently reused: the mark is persisted, audited
 * (memory_source_checks), and surfaced end-to-end.
 *
 * Two layers are tested:
 * - the PORT (fake resolver): deterministic outcome matrix;
 * - the ADAPTER (createGitSourceResolver against a real fixture repo under
 *   the SYSTEM temp dir — the only git allowed in this suite): superseded
 *   / current / missing against real commits.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MemorySourceAttachConflictError,
  MemorySourceResolverError,
  createGitSourceResolver,
  type SourceShaResolver
} from "../src/index.js";
import {
  PROJECT_A,
  T2,
  T3,
  T4,
  T5,
  createGitFixtureRepo,
  createSearchWorld,
  proposeDiscovery,
  removeTreeRobust,
  verifiedFact,
  type World
} from "./helpers.js";

let world: World;

beforeEach(() => {
  world = createSearchWorld();
});

afterEach(() => {
  world.close();
  removeTreeRobust(world.scratchDir);
});

function accessA() {
  return world.accessA();
}

/** A fake port: sha -> observation table, default missing. */
function fakeResolver(
  table: Readonly<Record<string, { exists: boolean; currentSha: string | null }>>
): SourceShaResolver {
  return (sha) => table[sha] ?? { exists: false, currentSha: null };
}

describe("端口层：sourceSha 引用检查矩阵", () => {
  it("missing（来源 SHA 不存在）→ 显式 stale 标记 + 原因 + 审计", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-src" });
    access.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "a".repeat(40),
      now: T2
    });
    const run = access.checkSources({ now: T3, resolve: fakeResolver({}) });
    expect(run.checkedCount).toBe(1);
    expect(run.results[0]).toMatchObject({
      memoryId: "fact-src",
      sourceSha: "a".repeat(40),
      outcome: "missing",
      stale: true,
      staleReason: "missing"
    });
    const hit = access.require("fact-src");
    expect(hit.stale).toBe(true);
    expect(hit.staleSince).toBe(T3);
    expect(hit.staleReason).toBe("missing");
    const status = access.sourceStatus("fact-src");
    expect(status.stale).toBe(true);
    expect(status.lastCheck?.outcome).toBe("missing");
    expect(status.lastCheck?.observedSha).toBeNull();
    // The audit trail shows the failed check with the cited sha.
    expect(access.listSourceChecks("fact-src")).toHaveLength(1);
  });

  it("superseded（基线前进）→ stale；current（SHA 即基线）→ 保持新鲜", () => {
    const access = accessA();
    const moved = verifiedFact(world, PROJECT_A, {
      id: "fact-moved",
      content: "fact: moved citation parseEvent superseded-case."
    });
    access.attachSource({
      memoryId: moved.id,
      expectedVersion: moved.version,
      sourceSha: "b".repeat(40),
      now: T2
    });
    const fresh = verifiedFact(world, PROJECT_A, {
      id: "fact-fresh",
      content: "fact: fresh citation parseEvent current-case."
    });
    access.attachSource({
      memoryId: fresh.id,
      expectedVersion: fresh.version,
      sourceSha: "c".repeat(40),
      now: T2
    });
    const run = access.checkSources({
      now: T3,
      resolve: fakeResolver({
        [`${"b".repeat(40)}`]: { exists: true, currentSha: "d".repeat(40) },
        [`${"c".repeat(40)}`]: { exists: true, currentSha: "c".repeat(40) }
      })
    });
    // Both memories share created_at T0, so store order is by id; assert
    // on the outcome SET, and on each memory's own mark below.
    expect([...run.results.map((result) => result.outcome)].sort()).toEqual([
      "current",
      "superseded"
    ]);
    expect(access.require("fact-moved").stale).toBe(true);
    expect(access.require("fact-fresh").stale).toBe(false);
    expect(access.listStale().map((hit) => hit.id)).toEqual(["fact-moved"]);
  });

  it("exists + currentSha=null（仅断言存在）→ 不判过期", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-exists-only" });
    access.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "e".repeat(40),
      now: T2
    });
    access.checkSources({
      now: T3,
      resolve: fakeResolver({ [`${"e".repeat(40)}`]: { exists: true, currentSha: null } })
    });
    expect(access.require("fact-exists-only").stale).toBe(false);
  });

  it("恢复后再次检查：stale 标记被清除，审计保留两次记录", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-recover" });
    access.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "f".repeat(40),
      now: T2
    });
    access.checkSources({ now: T3, resolve: fakeResolver({}) });
    expect(access.require("fact-recover").stale).toBe(true);
    access.checkSources({
      now: T4,
      resolve: fakeResolver({ [`${"f".repeat(40)}`]: { exists: true, currentSha: "f".repeat(40) } })
    });
    const recovered = access.require("fact-recover");
    expect(recovered.stale).toBe(false);
    expect(recovered.staleSince).toBeNull();
    expect(recovered.staleReason).toBeNull();
    const checks = access.listSourceChecks("fact-recover");
    expect(checks.map((check) => check.outcome)).toEqual(["missing", "current"]);
    expect(access.sourceStatus("fact-recover").lastCheck?.checkedAt).toBe(T4);
  });

  it("无 sourceSha 的记忆不参与检查，也永远不会无提示地变 stale", () => {
    const access = accessA();
    verifiedFact(world, PROJECT_A, { id: "fact-plain" });
    const run = access.checkSources({ now: T3, resolve: fakeResolver({}) });
    expect(run.checkedCount).toBe(0);
    expect(access.require("fact-plain").stale).toBe(false);
    expect(access.listStale()).toEqual([]);
  });

  it("解析器返回垃圾 → MemorySourceResolverError，标记不变", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-badresolver" });
    access.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "9".repeat(40),
      now: T2
    });
    expect(() =>
      access.checkSources({
        now: T3,
        // @ts-expect-error — deliberately broken resolver for the refusal test
        resolve: () => ({ exists: "yes", currentSha: "zz" })
      })
    ).toThrow(MemorySourceResolverError);
    expect(access.require("fact-badresolver").stale).toBe(false);
  });
});

describe("适配器层：createGitSourceResolver 对真实 fixture 仓库", () => {
  it("SHA 变化被检出：旧提交 superseded、当前 HEAD current、未知 SHA missing", () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), "ro-memory-search-git-"));
    try {
      const { shaA, shaB } = createGitFixtureRepo(repoDir);
      const resolve = createGitSourceResolver(repoDir);

      expect(resolve(shaB)).toEqual({ exists: true, currentSha: shaB }); // current
      expect(resolve(shaA)).toEqual({ exists: true, currentSha: shaB }); // superseded
      expect(resolve("0".repeat(40))).toEqual({ exists: false, currentSha: null }); // missing

      // End-to-end through the access layer: a memory citing the OLD commit
      // is flagged stale after the baseline moved — the acceptance path.
      const access = accessA();
      const memory = verifiedFact(world, PROJECT_A, { id: "fact-git-stale" });
      access.attachSource({
        memoryId: memory.id,
        expectedVersion: memory.version,
        sourceSha: shaA,
        now: T2
      });
      const run = access.checkSources({ now: T5, resolve });
      expect(run.results[0]?.outcome).toBe("superseded");
      expect(access.require("fact-git-stale").stale).toBe(true);
      expect(access.listStale().map((hit) => hit.id)).toEqual(["fact-git-stale"]);
      // Retrieval carries the explicit mark; it does NOT hide the hit.
      const [hit] = access.search({ query: "parseEvent" });
      expect(hit?.id).toBe("fact-git-stale");
      expect(hit?.stale).toBe(true);
    } finally {
      removeTreeRobust(repoDir);
    }
  });

  it("仓库根不存在 → 构造时 fail-closed", () => {
    expect(() => createGitSourceResolver(path.join(os.tmpdir(), "definitely-missing-repo-xyz"))).toThrow(
      /does not exist/
    );
  });
});

describe("attachSource 守卫", () => {
  it("版本 CAS：stale expectedVersion 报 MemoryCasConflictError，携带当前摘要", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-cas" });
    expect(() =>
      access.attachSource({
        memoryId: memory.id,
        expectedVersion: memory.version - 1,
        sourceSha: "7".repeat(40),
        now: T2
      })
    ).toThrow(/compare-and-swap conflict/);
    expect(access.sourceStatus("fact-cas").sourceSha).toBeNull();
  });

  it("冲突可见：已挂不同 SHA 后再挂 → MemorySourceAttachConflictError", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-attach2" });
    access.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "8".repeat(40),
      now: T2
    });
    expect(() =>
      access.attachSource({
        memoryId: memory.id,
        expectedVersion: memory.version,
        sourceSha: "4".repeat(40),
        now: T2
      })
    ).toThrow(MemorySourceAttachConflictError);
  });

  it("provenance 不 bump version：CAS 内容语义完全不受影响", () => {
    const access = accessA();
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-nobump" });
    access.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "6".repeat(40),
      now: T2
    });
    expect(access.require("fact-nobump").version).toBe(memory.version);
    // A memory event history has no new entry: freshness/provenance is
    // metadata, the M3-02 lifecycle contract is untouched.
    expect(access.listEvents({ memoryId: memory.id }).map((event) => event.type)).toEqual([
      "proposed",
      "verified"
    ]);
  });

  it("discovery（无证据要求）同样可携带 sourceSha 并被检查", () => {
    const access = accessA();
    const discovery = proposeDiscovery(world, PROJECT_A, { id: "disc-src" });
    access.attachSource({
      memoryId: discovery.id,
      expectedVersion: discovery.version,
      sourceSha: "5".repeat(40),
      now: T2
    });
    const run = access.checkSources({ now: T3, resolve: fakeResolver({}) });
    expect(run.results.map((result) => result.memoryId)).toEqual(["disc-src"]);
    expect(run.results[0]?.stale).toBe(true);
  });
});
