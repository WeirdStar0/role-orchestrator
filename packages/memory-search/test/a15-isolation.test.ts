/**
 * M3-03 acceptance (A15): from project A, NOTHING of project B's memory is
 * reachable. The authorization layer enforces this on every entry point at
 * the QUERY layer (`WHERE project_id = <authorized>`), and a foreign id is
 * refused with a typed `CrossProjectAccessError`. The three pinned paths:
 *
 *   1. direct id QUERY  (get / require / requireVerified / history /
 *      source probes) — foreign id refused, message discloses neither the
 *      foreign project nor its content;
 *   2. RETRIEVAL        (search) — foreign rows are structurally invisible
 *      (no result filtering: the SQL cannot express them);
 *   3. CAS UPDATE       — a foreign id with even a CORRECT expectedVersion
 *      is refused before any read of the foreign row; the row is untouched.
 *
 * Plus: the refusal is side-effect free (no audit rows appear in either
 * project — writing one into the foreign project would itself be a
 * cross-project write), the session fails closed on unknown projects, and
 * an UNKNOWN id stays `UnknownMemoryError`/null instead of being confused
 * with the foreign case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CrossProjectAccessError,
  openMemoryAccess,
  type MemoryAccess
} from "../src/index.js";
import {
  MemoryCasConflictError,
  UnknownMemoryError,
  UnknownMemoryProjectError,
  listMemoryEvents
} from "@role-orchestrator/memory";
import {
  PROJECT_A,
  PROJECT_B,
  T2,
  T3,
  createSearchWorld,
  proposeDiscovery,
  removeTreeRobust,
  roleActor,
  verifiedFact,
  type World
} from "./helpers.js";

let world: World;
let accessA: MemoryAccess;
let accessB: MemoryAccess;

/** B's secret memory + the distinctive token only its content carries. */
const B_SECRET = "fact: module secret-only-token for project B quantum exfiltration key.";
const B_TOKEN = "exfiltration";

beforeEach(() => {
  world = createSearchWorld();
  accessA = world.accessA();
  accessB = world.accessB();
  // A has one verified fact; B has one verified fact with secret content.
  verifiedFact(world, PROJECT_A, { id: "fact-a-1", content: "fact: module X exports parseEvent; covered by tests." });
  verifiedFact(world, PROJECT_B, { id: "fact-b-secret", content: B_SECRET });
});

afterEach(() => {
  world.close();
  removeTreeRobust(world.scratchDir);
});

function expectCrossProject(
  fn: () => unknown,
  memoryId: string,
  authorizedProject: string = PROJECT_A
): CrossProjectAccessError {
  try {
    fn();
  } catch (error) {
    expect(error, "refusal must be the typed CrossProjectAccessError").toBeInstanceOf(
      CrossProjectAccessError
    );
    const refusal = error as CrossProjectAccessError;
    expect(refusal.projectId).toBe(authorizedProject);
    const foreignProject = authorizedProject === PROJECT_A ? PROJECT_B : PROJECT_A;
    expect(refusal.message).not.toContain(B_SECRET);
    expect(refusal.message).not.toContain(B_TOKEN);
    expect(refusal.message).not.toContain(foreignProject);
    expect(JSON.stringify(refusal)).not.toContain(B_SECRET);
    expect(JSON.stringify(refusal)).not.toContain(foreignProject);
    return refusal;
  }
  throw new Error(`expected CrossProjectAccessError for ${memoryId}, call succeeded`);
}

describe("路径一：跨项目直接 id 查询（A15）", () => {
  it("get/require/requireVerified/listRevisions/listEvents/sourceStatus 全部类型化拒绝", () => {
    for (const attempt of [
      () => accessA.get("fact-b-secret"),
      () => accessA.require("fact-b-secret"),
      () => accessA.requireVerified("fact-b-secret"),
      () => accessA.listRevisions("fact-b-secret"),
      () => accessA.listEvents({ memoryId: "fact-b-secret" }),
      () => accessA.sourceStatus("fact-b-secret"),
      () => accessA.listSourceChecks("fact-b-secret"),
      () =>
        accessA.attachSource({
          memoryId: "fact-b-secret",
          expectedVersion: 2,
          sourceSha: "a".repeat(40),
          now: T2
        })
    ]) {
      expectCrossProject(attempt, "fact-b-secret");
    }
  });

  it("B 的记忆完好：版本、内容、审计轨迹均未被触碰", () => {
    expectCrossProject(() => accessA.get("fact-b-secret"), "fact-b-secret");
    const record = accessB.require("fact-b-secret");
    expect(record.content).toBe(B_SECRET);
    expect(record.version).toBe(2);
    expect(record.status).toBe("verified");
    expect(accessB.listRevisions("fact-b-secret").map((revision) => revision.version)).toEqual([1, 2]);
  });

  it("拒绝无副作用：A、B 两个项目都没有新增审计事件", () => {
    const beforeB = listMemoryEvents(world.db, { projectId: PROJECT_B, memoryId: "fact-b-secret" }).length;
    expectCrossProject(() => accessA.update({
      memoryId: "fact-b-secret",
      expectedVersion: 2,
      actor: roleActor("developer"),
      content: "hijacked",
      now: T2
    }), "fact-b-secret");
    const afterB = listMemoryEvents(world.db, { projectId: PROJECT_B, memoryId: "fact-b-secret" }).length;
    expect(afterB).toBe(beforeB);
    const aEvents = world.db
      .prepare("SELECT COUNT(*) AS n FROM memory_events WHERE project_id = ?")
      .get(PROJECT_A) as { n: number };
    // Only A's own propose+verify events; a refusal must not write into A either.
    expect(Number(aEvents.n)).toBe(2);
  });

  it("未知 id 与外来 id 表现不同：未知 id 不是 CrossProjectAccessError", () => {
    expect(accessA.get("fact-never-existed")).toBeNull();
    expect(() => accessA.require("fact-never-existed")).toThrow(UnknownMemoryError);
    expect(() => accessA.require("fact-never-existed")).not.toThrow(CrossProjectAccessError);
  });

  it("会话绑定未知项目 fail-closed；双向（B→A）同样拒绝", () => {
    expect(() => openMemoryAccess(world.db, { projectId: "proj-missing" })).toThrow(
      UnknownMemoryProjectError
    );
    const refusal = expectCrossProject(
      () => accessB.get("fact-a-1"),
      "fact-a-1",
      PROJECT_B
    );
    expect(refusal.projectId).toBe(PROJECT_B);
  });

  it("A 的列表/规则/陈旧清单永远只含 A 自己的行", () => {
    expect(accessA.list().map((hit) => hit.projectId)).toEqual([PROJECT_A]);
    expect(accessB.list().map((hit) => hit.projectId)).toEqual([PROJECT_B]);
    expect(accessA.listActiveProjectRules().map((hit) => hit.id)).toEqual([]);
    const disputed = proposeDiscovery(world, PROJECT_B, { id: "disc-b-x" });
    expect(accessB.list({ status: "proposed" }).map((hit) => hit.id)).toEqual([disputed.id]);
    expect(accessA.list({ status: "proposed" })).toEqual([]);
  });
});

describe("路径二：检索隔离（A15）", () => {
  it("用 B 独有的 token 从 A 检索：结果为空且不含 B 的内容", () => {
    const hits = accessA.search({ query: B_TOKEN });
    expect(hits).toEqual([]);
    const alsoNothing = accessA.search({ query: "secret quantum key" });
    expect(alsoNothing).toEqual([]);
    // Control: the same query through B's own session finds it.
    expect(accessB.search({ query: B_TOKEN }).map((hit) => hit.id)).toEqual(["fact-b-secret"]);
  });

  it("共同 token 命中时只返回授权项目的行（WHERE 层强制，非结果过滤）", () => {
    // "fact" and "module" appear in BOTH projects' contents.
    const fromA = accessA.search({ query: "fact module" });
    expect(fromA.map((hit) => hit.id)).toEqual(["fact-a-1"]);
    const fromB = accessB.search({ query: "fact module" });
    expect(fromB.map((hit) => hit.id)).toEqual(["fact-b-secret"]);
    const serialized = JSON.stringify(fromA);
    expect(serialized).not.toContain(B_SECRET);
    expect(serialized).not.toContain(B_TOKEN);
  });

  it("stale 清单同样隔离：B 的陈旧记忆不出现在 A 的任何读路径里", () => {
    const run = accessB.checkSources({
      now: T3,
      resolve: () => ({ exists: false, currentSha: null })
    });
    expect(run.checkedCount).toBe(0); // B's fact carries no sourceSha yet
    const sourced = verifiedFact(world, PROJECT_B, {
      id: "fact-b-stale",
      content: "fact: another secret reference token baseline-gone."
    });
    accessB.attachSource({
      memoryId: sourced.id,
      expectedVersion: sourced.version,
      sourceSha: "b".repeat(40),
      now: T2
    });
    accessB.checkSources({ now: T3, resolve: () => ({ exists: false, currentSha: null }) });
    expect(accessB.listStale().map((hit) => hit.id)).toEqual(["fact-b-stale"]);
    expect(accessA.listStale()).toEqual([]);
    expect(accessA.search({ query: "baseline-gone" })).toEqual([]);
  });
});

describe("路径三：CAS 更新隔离（A15）", () => {
  it("A 用正确的 expectedVersion 也无法 CAS 更新 B 的记忆", () => {
    const foreign = accessB.require("fact-b-secret");
    expectCrossProject(
      () =>
        accessA.update({
          memoryId: foreign.id,
          expectedVersion: foreign.version, // correct — still refused
          actor: roleActor("developer"),
          content: "hijacked by A",
          now: T2
        }),
      foreign.id
    );
    const after = accessB.require("fact-b-secret");
    expect(after.content).toBe(B_SECRET);
    expect(after.version).toBe(foreign.version);
    expect(after.contentHash).toBe(foreign.contentHash);
  });

  it("A 无法通过 attachSource 污染 B 的来源引用", () => {
    expectCrossProject(
      () =>
        accessA.attachSource({
          memoryId: "fact-b-secret",
          expectedVersion: 2,
          sourceSha: "c".repeat(40),
          now: T2
        }),
      "fact-b-secret"
    );
    expect(accessB.sourceStatus("fact-b-secret").sourceSha).toBeNull();
  });

  it("attach 的 CAS 冲突可见：同版本竞写第二个不同 SHA 被类型化拒绝", () => {
    const memory = verifiedFact(world, PROJECT_A, { id: "fact-a-cas" });
    accessA.attachSource({
      memoryId: memory.id,
      expectedVersion: memory.version,
      sourceSha: "1".repeat(40),
      now: T2
    });
    expect(() =>
      accessA.attachSource({
        memoryId: memory.id,
        expectedVersion: memory.version,
        sourceSha: "2".repeat(40),
        now: T2
      })
    ).toThrow(/already carries a source SHA/);
    // Same sha again: idempotent, no conflict.
    expect(
      accessA.attachSource({
        memoryId: memory.id,
        expectedVersion: memory.version,
        sourceSha: "1".repeat(40),
        now: T2
      }).sourceSha
    ).toBe("1".repeat(40));
    // Stale expectedVersion: visible CAS conflict (never a silent win).
    expect(() =>
      accessA.attachSource({
        memoryId: memory.id,
        expectedVersion: memory.version - 1,
        sourceSha: "3".repeat(40),
        now: T2
      })
    ).toThrow(MemoryCasConflictError);
  });
});
