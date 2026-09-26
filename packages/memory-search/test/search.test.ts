/**
 * Retrieval correctness (M3-03, A15 prerequisite): hit / miss / token
 * boundaries, AND semantics, ASCII case folding, wildcard escaping, the
 * verified+active default scope, type filters, and honest query rejection.
 * The selection (SQL LIKE over the authoritative table, no shadow index)
 * is documented in src/tokenize.ts — these tests pin its observable
 * behavior, including the CJK substring path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySearchQueryInvalidError, likeLiteral } from "../src/index.js";
import {
  PROJECT_A,
  T2,
  createSearchWorld,
  proposeDiscovery,
  proposeFact,
  removeTreeRobust,
  roleActor,
  type World
} from "./helpers.js";
import { verifyMemory } from "@role-orchestrator/memory";

let world: World;

beforeEach(() => {
  world = createSearchWorld();
  // One verified fact with mixed ASCII punctuation and one CJK discovery,
  // both verified by reviewer (proposer developer, 自审禁止).
  const fact = proposeFact(world, PROJECT_A, {
    id: "fact-hit",
    content: "fact: module X exports parseEvent; covered by tests/e2e."
  });
  verifyMemory(world.db, {
    projectId: PROJECT_A,
    memoryId: fact.id,
    expectedVersion: fact.version,
    actor: roleActor("reviewer"),
    now: T2
  });
  const cjk = proposeFact(world, PROJECT_A, {
    id: "fact-cjk",
    content: "决策：采用 SQLite 作为存储引擎。"
  });
  verifyMemory(world.db, {
    projectId: PROJECT_A,
    memoryId: cjk.id,
    expectedVersion: cjk.version,
    actor: roleActor("reviewer"),
    now: T2
  });
});

afterEach(() => {
  world.close();
  removeTreeRobust(world.scratchDir);
});

function accessA() {
  return world.accessA();
}

describe("命中与未命中", () => {
  it("单 token 精确命中；多 token AND：缺一即未命中", () => {
    const access = accessA();
    expect(access.search({ query: "parseEvent" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
    expect(access.search({ query: "module exports" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
    expect(access.search({ query: "module missing" })).toEqual([]);
    expect(access.search({ query: "module exports sqlite" })).toEqual([]);
  });

  it("子串语义：词内片段也命中", () => {
    const access = accessA();
    expect(access.search({ query: "arseEvent" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
    expect(access.search({ query: "covered" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
  });

  it("标点是分词边界：tests/e2e 拆出 e2e，可单独命中", () => {
    const access = accessA();
    expect(access.search({ query: "e2e" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
    expect(access.search({ query: "tests e2e" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
  });

  it("CJK 无空格：整段短语子串命中", () => {
    const access = accessA();
    expect(access.search({ query: "存储引擎" }).map((hit) => hit.id)).toEqual(["fact-cjk"]);
    expect(access.search({ query: "SQLite 作为存储引擎" }).map((hit) => hit.id)).toEqual(["fact-cjk"]);
    expect(access.search({ query: "存储 阵列" })).toEqual([]);
  });

  it("全未命中返回空数组（不是错误）", () => {
    expect(accessA().search({ query: "nonexistenttoken" })).toEqual([]);
  });
});

describe("大小写与通配符", () => {
  it("ASCII 大小写折叠：ParseEvent / PARSEEVENT 命中", () => {
    const access = accessA();
    expect(access.search({ query: "ParseEvent" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
    expect(access.search({ query: "PARSEEVENT" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
  });

  it("LIKE 通配符按字面处理：likeLiteral 转义 % _ \\", () => {
    expect(likeLiteral("100%")).toBe("100\\%");
    expect(likeLiteral("a_b")).toBe("a\\_b");
    expect(likeLiteral("back\\slash")).toBe("back\\\\slash");
  });

  it("分词器剥掉通配符后不会把查询变成模式", () => {
    // "parse%" tokenizes to ["parse"] — matches the real substring, and
    // "100%" (against the fact content) must NOT turn % into a wildcard hit.
    const access = accessA();
    expect(access.search({ query: "parse%" }).map((hit) => hit.id)).toEqual(["fact-hit"]);
    expect(access.search({ query: "x_X_x" }).map((hit) => hit.id)).toEqual(["fact-hit"]); // x tokens
    expect(access.search({ query: "zzzq" })).toEqual([]);
  });
});

describe("状态与类型过滤（默认 verified+active）", () => {
  it("proposed 默认不被检索；显式覆盖 statuses 后可见", () => {
    const access = accessA();
    proposeFact(world, PROJECT_A, {
      id: "fact-proposed",
      content: "fact: pendingtoken awaits verification."
    });
    expect(access.search({ query: "pendingtoken" })).toEqual([]);
    const widened = access.search({ query: "pendingtoken", statuses: ["proposed"] });
    expect(widened.map((hit) => hit.id)).toEqual(["fact-proposed"]);
    expect(widened.every((hit) => hit.status === "proposed")).toBe(true);
  });

  it("disputed 不属于默认检索面", () => {
    const access = accessA();
    const disputed = proposeFact(world, PROJECT_A, {
      id: "fact-disputed",
      content: "fact: disputetoken challenged."
    });
    world.db
      .prepare(
        "UPDATE memories SET status = 'disputed', disputed_by = ?, disputed_at = ?, version = version + 1, updated_at = ? " +
          "WHERE id = ? AND project_id = ?"
      )
      .run("role:reviewer", T2, T2, disputed.id, PROJECT_A);
    expect(access.search({ query: "disputetoken" })).toEqual([]);
  });

  it("types 过滤：同一 token 命中多种类型时按类型收窄", () => {
    const access = accessA();
    const discovery = proposeDiscovery(world, PROJECT_A, {
      id: "disc-shared",
      content: "discovery: module X exports parseEvent also mentioned here."
    });
    verifyMemory(world.db, {
      projectId: PROJECT_A,
      memoryId: discovery.id,
      expectedVersion: discovery.version,
      actor: roleActor("reviewer"),
      now: T2
    });
    const all = access.search({ query: "parseEvent" });
    expect(all.map((hit) => hit.type).sort()).toEqual(["discovery", "fact"]);
    const factsOnly = access.search({ query: "parseEvent", types: ["fact"] });
    expect(factsOnly.map((hit) => hit.type)).toEqual(["fact"]);
  });
});

describe("查询校验（诚实地拒绝，不猜测）", () => {
  it("空查询、纯标点、超量 token 都是类型化错误", () => {
    const access = accessA();
    expect(() => access.search({ query: "" })).toThrow(MemorySearchQueryInvalidError);
    expect(() => access.search({ query: "   " })).toThrow(MemorySearchQueryInvalidError);
    expect(() => access.search({ query: "!!!" })).toThrow(MemorySearchQueryInvalidError);
    expect(() => access.search({ query: Array.from({ length: 17 }, (_, i) => `t${String(i)}`).join(" ") })).toThrow(
      MemorySearchQueryInvalidError
    );
  });

  it("16 个 token 的查询仍可用", () => {
    const access = accessA();
    const tokens = Array.from({ length: 16 }, (_, i) => (i === 0 ? "parseEvent" : "filler"));
    // Only "parseEvent" exists; the AND of 16 tokens misses — but the query
    // itself must be ACCEPTED (not rejected as malformed).
    expect(access.search({ query: tokens.join(" ") })).toEqual([]);
  });
});

describe("检索结果是完整、带来源与过期标记的记录", () => {
  it("hit 携带 memoryId/version/contentHash/sourceSha/stale 全集", () => {
    const access = accessA();
    const [hit] = access.search({ query: "parseEvent" });
    expect(hit).toBeDefined();
    expect(hit?.version).toBe(2);
    expect(hit?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hit?.sourceSha).toBeNull();
    expect(hit?.stale).toBe(false);
    expect(hit?.staleReason).toBeNull();
    expect(hit?.projectId).toBe(PROJECT_A);
  });

  it("内容被篡改时检索响亮失败（每次读取都重算 content hash）", () => {
    world.db
      .prepare("UPDATE memories SET content = ? WHERE id = 'fact-hit'")
      .run("parseEvent tampered: content no longer hashes to its recorded digest");
    expect(() => accessA().search({ query: "parseEvent" })).toThrow(/failed integrity verification/);
  });
});
