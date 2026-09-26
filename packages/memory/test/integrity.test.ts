/**
 * M3-02 content_hash completeness and store-level integrity: every read
 * recomputes hashes, a tampered current row or revision history is LOUD
 * (MemoryIntegrityError), the revision chain must be contiguous, duplicate
 * proposals absorb instead of duplicating, and cross-project ids read as
 * unknown (A15 data-plane baseline). Also pins the migration chain 001..008.
 */
import { describe, expect, it } from "vitest";
import {
  DuplicateMemoryError,
  MemoryIntegrityError,
  MEMORY_MIGRATIONS,
  UnknownMemoryError,
  UnknownMemoryProjectError,
  getMemory,
  listMemoryEvents,
  listMemoryRevisions,
  proposeMemory,
  requireMemory,
  requireVerifiedMemory,
  updateMemory,
  verifyMemoryIntegrity
} from "../src/index.js";
import { appliedMigrationRecords, verifyMigrations } from "@role-orchestrator/store";
import {
  PROJECT_B,
  T0,
  T1,
  createMemoryWorld,
  proposeFact,
  proposeDiscovery,
  removeTreeRobust,
  roleActor,
  sha256Hex
} from "./helpers.js";

function withWorld<T>(fn: (world: ReturnType<typeof createMemoryWorld>) => T): T {
  const world = createMemoryWorld();
  try {
    return fn(world);
  } finally {
    world.close();
    removeTreeRobust(world.scratchDir);
  }
}

describe("迁移链", () => {
  it("001..008 全部应用，且 verifyMigrations 通过（含 008 memories）", () => {
    withWorld((world) => {
      const versions = appliedMigrationRecords(world.db).map((record) => record.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const verified = verifyMigrations(world.db, { migrations: MEMORY_MIGRATIONS });
      expect(verified.ok).toBe(true);
      expect(verified.checked).toBe(8);
    });
  });
});

describe("content_hash 完整性", () => {
  it("读取时重算：content 被篡改即抛 MemoryIntegrityError", () => {
    withWorld((world) => {
      const record = proposeFact(world, world.projectA.projectId);
      world.db
        .prepare("UPDATE memories SET content = content || ' TAMPERED' WHERE id = ?")
        .run(record.id);
      expect(() =>
        getMemory(world.db, { projectId: world.projectA.projectId, memoryId: record.id })
      ).toThrowError(MemoryIntegrityError);
      expect(() =>
        verifyMemoryIntegrity(world.db, {
          projectId: world.projectA.projectId,
          memoryId: record.id
        })
      ).toThrowError(/content_hash/);
    });
  });

  it("revision 历史被篡改同样可见；链不连续可检测", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const updated = updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id,
        expectedVersion: record.version,
        actor: roleActor("developer"),
        content: "discovery: corrected.",
        now: T1
      });

      world.db
        .prepare("UPDATE memory_revisions SET content = content || ' TAMPERED' WHERE memory_id = ? AND version = 1")
        .run(record.id);
      expect(() =>
        listMemoryRevisions(world.db, { projectId: world.projectA.projectId, memoryId: record.id })
      ).toThrowError(MemoryIntegrityError);
      world.db
        .prepare("UPDATE memory_revisions SET content = ? WHERE memory_id = ? AND version = 1")
        .run(record.content, record.id); // restore

      world.db.prepare("DELETE FROM memory_revisions WHERE memory_id = ? AND version = 1").run(record.id);
      expect(() =>
        verifyMemoryIntegrity(world.db, { projectId: world.projectA.projectId, memoryId: updated.id })
      ).toThrowError(/contiguous|expected/);
    });
  });

  it("干净记忆通过完整校验（当前行 = 链尾 revision）", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const updated = updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id,
        expectedVersion: record.version,
        actor: roleActor("developer"),
        content: "discovery: corrected.",
        now: T1
      });
      expect(
        verifyMemoryIntegrity(world.db, { projectId: world.projectA.projectId, memoryId: updated.id })
      ).toEqual({
        ok: true,
        memoryId: updated.id,
        contentHash: sha256Hex(updated.content),
        version: 2,
        checkedRevisions: 2
      });
    });
  });
});

describe("重复提案吸收（内容寻址，幂等重试不复制历史）", () => {
  it("同 id 同内容 → 同一行、无新审计；同内容不同 id → 吸收为已有行", () => {
    withWorld((world) => {
      const projectId = world.projectA.projectId;
      const input = {
        id: "disc-dedupe",
        projectId,
        type: "discovery" as const,
        content: "discovery: identical content proposed twice.",
        evidenceRefs: [],
        actor: roleActor("developer"),
        now: T0
      };
      const first = proposeMemory(world.db, input);
      const replay = proposeMemory(world.db, input);
      expect(replay.id).toBe(first.id);

      const otherId = proposeMemory(world.db, { ...input, id: "disc-dedupe-2", now: T1 });
      expect(otherId.id).toBe(first.id);

      const events = listMemoryEvents(world.db, { projectId, memoryId: first.id });
      expect(events.map((event) => event.type)).toEqual(["proposed"]); // replay adds nothing
      const rows = world.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content_hash = ?").get(
        sha256Hex(input.content)
      ) as { n: number };
      expect(Number(rows.n)).toBe(1);
    });
  });

  it("同 id 不同内容 → DuplicateMemoryError", () => {
    withWorld((world) => {
      const projectId = world.projectA.projectId;
      proposeFact(world, projectId, { id: "fact-fixed-id" });
      expect(() =>
        proposeFact(world, projectId, { id: "fact-fixed-id", content: "fact: different content." })
      ).toThrowError(DuplicateMemoryError);
    });
  });
});

describe("跨项目隔离（A15 数据面基调）", () => {
  it("B 项目的 memory 用 A 的 projectId 查询：不可见，且错误不泄漏他项目信息", () => {
    withWorld((world) => {
      const record = proposeFact(world, world.projectB.projectId, { id: "fact-in-b" });
      expect(
        getMemory(world.db, { projectId: world.projectA.projectId, memoryId: record.id })
      ).toBeNull();
      expect(() =>
        requireVerifiedMemory(world.db, { projectId: world.projectA.projectId, memoryId: record.id })
      ).toThrowError(UnknownMemoryError);
      try {
        requireMemory(world.db, { projectId: world.projectA.projectId, memoryId: record.id });
        throw new Error("expected UnknownMemoryError");
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownMemoryError);
        // The error echoes only the CALLER's own input (project A + the id it
        // asked about); it never names project B or any of its data.
        const message = (error as Error).message;
        expect(message).toContain("proj-a");
        expect(message).not.toContain(PROJECT_B);
      }
    });
  });

  it("未知 project 的提案被拒", () => {
    withWorld((world) => {
      expect(() =>
        proposeMemory(world.db, {
          id: "fact-nowhere",
          projectId: "proj-none",
          type: "fact",
          content: "fact for a project that does not exist.",
          evidenceRefs: ["artifact-evidence"],
          actor: roleActor("developer"),
          now: T0
        })
      ).toThrowError(UnknownMemoryProjectError);
    });
  });
});
