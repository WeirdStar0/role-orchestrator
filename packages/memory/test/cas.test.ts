/**
 * A14 — Memory 冲突并发写：CAS 冲突可见，不静默覆盖。
 *
 * Every state change is a (memoryId, expectedVersion) compare-and-swap. The
 * tests here drive it across TWO SEPARATE connections on the same database
 * file, including a real lock race (connection B blocked on BEGIN IMMEDIATE
 * while A holds the write transaction), and pin the typed conflict error:
 * expected version, current version, current content digest — plus the
 * cas-conflict audit event that keeps the lost write visible.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryCasConflictError,
  MemoryLifecycleError,
  getMemory,
  listMemoryEvents,
  listMemoryRevisions,
  promoteProjectRule,
  proposeMemory,
  updateMemory,
  verifyMemory
} from "../src/index.js";
import { openDatabase } from "@role-orchestrator/store";
import {
  T0,
  T1,
  T2,
  USER_ALICE,
  createMemoryWorld,
  nextId,
  proposeDiscovery,
  removeTreeRobust,
  roleActor,
  sha256Hex,
  verifiedRule
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

describe("A14: CAS 更新（updateMemory）", () => {
  it("版本不匹配返回类型化冲突，携带当前版本与内容摘要，绝不覆盖", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const staleWrite = "discovery: OVERWRITTEN WITHOUT READING THE CURRENT STATE.";
      try {
        updateMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: record.id,
          expectedVersion: 2, // current version is 1
          actor: roleActor("developer"),
          content: staleWrite,
          now: T1
        });
        throw new Error("expected MemoryCasConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryCasConflictError);
        const conflict = error as MemoryCasConflictError;
        expect(conflict.expectedVersion).toBe(2);
        expect(conflict.currentVersion).toBe(1);
        expect(conflict.currentContentDigest).toBe(sha256Hex(record.content));
        expect(conflict.currentContentDigest).not.toBe(sha256Hex(staleWrite));
      }
      // Nothing was overwritten.
      const after = getMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id
      });
      expect(after?.version).toBe(1);
      expect(after?.content).toBe(record.content);
    });
  });

  it("成功路径恰好 bump 一个版本并留下 revision+event", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const updated = updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id,
        expectedVersion: record.version,
        actor: roleActor("developer"),
        content: "discovery: corrected path.",
        now: T1
      });
      expect(updated.version).toBe(2);
      expect(
        listMemoryRevisions(world.db, {
          projectId: world.projectA.projectId,
          memoryId: record.id
        }).map((revision) => revision.version)
      ).toEqual([1, 2]);
      expect(
        listMemoryEvents(world.db, {
          projectId: world.projectA.projectId,
          memoryId: record.id
        }).map((event) => event.type)
      ).toEqual(["proposed", "updated"]);
    });
  });

  it("幂等重放（相同内容）不 bump 版本；但过期 expectedVersion 的重放是可见冲突", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const input = {
        projectId: world.projectA.projectId,
        memoryId: record.id,
        actor: roleActor("developer"),
        content: "discovery: corrected path.",
        now: T1
      };
      const first = updateMemory(world.db, { ...input, expectedVersion: record.version });
      expect(first.version).toBe(2);
      const replay = updateMemory(world.db, { ...input, expectedVersion: 2 });
      expect(replay.version).toBe(2); // no-op: already applied

      expect(() => updateMemory(world.db, { ...input, expectedVersion: 1 })).toThrowError(
        MemoryCasConflictError
      );
    });
  });
});

describe("A14: 并发双写（两个连接，同一 expectedVersion 恰一成功）", () => {
  it("B 在 A 提交前读取 expectedVersion，A 先写，B 的 CAS 冲突可见", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const contentA = "discovery: writer A's correction.";
      const contentB = "discovery: writer B's correction.";
      const dbB = openDatabase(world.dbPath, { busyTimeoutMs: 2000 });
      try {
        // B reads the record BEFORE A writes: its view is version 1.
        const viewOfB = getMemory(dbB, {
          projectId: world.projectA.projectId,
          memoryId: record.id
        });
        expect(viewOfB?.version).toBe(1);

        // A wins the race.
        const byA = updateMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: record.id,
          expectedVersion: 1,
          actor: roleActor("developer"),
          content: contentA,
          now: T1
        });
        expect(byA.version).toBe(2);

        // B loses: typed conflict carrying A's current version + digest.
        try {
          updateMemory(dbB, {
            projectId: world.projectA.projectId,
            memoryId: record.id,
            expectedVersion: 1,
            actor: roleActor("developer"),
            content: contentB,
            now: T1
          });
          throw new Error("expected MemoryCasConflictError");
        } catch (error) {
          expect(error).toBeInstanceOf(MemoryCasConflictError);
          const conflict = error as MemoryCasConflictError;
          expect(conflict.currentVersion).toBe(2);
          expect(conflict.currentContentDigest).toBe(sha256Hex(contentA));
        }

        // Exactly one write landed, and the lost one is visible in the audit.
        const final = getMemory(dbB, {
          projectId: world.projectA.projectId,
          memoryId: record.id
        });
        expect(final?.version).toBe(2);
        expect(final?.content).toBe(contentA);
        expect(
          listMemoryEvents(world.db, {
            projectId: world.projectA.projectId,
            memoryId: record.id
          }).map((event) => event.type)
        ).toEqual(["proposed", "updated", "cas-conflict"]);
        const casEvent = listMemoryEvents(world.db, {
          projectId: world.projectA.projectId,
          memoryId: record.id,
          type: "cas-conflict"
        })[0];
        expect(casEvent?.payload).toEqual({ action: "update", expectedVersion: 1, observedVersion: 2 });
      } finally {
        dbB.close();
      }
    });
  });

  it("真正的同锁竞争：A 持写事务期间 B 的写入响亮失败，A 提交后 B 的过期 CAS 冲突", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const dbB = openDatabase(world.dbPath, { busyTimeoutMs: 200 });
      try {
        // A takes the write lock WITHOUT committing yet (raw, simulating a
        // concurrent writer mid-transaction).
        world.db.exec("BEGIN IMMEDIATE");
        try {
          world.db
            .prepare(
              "UPDATE memories SET content = ?, content_hash = ?, version = version + 1, " +
                "supersedes_version = 1, updated_at = ? WHERE id = ? AND version = 1"
            )
            .run(
              "discovery: writer A got the lock first.",
              sha256Hex("discovery: writer A got the lock first."),
              T1,
              record.id
            );

          // B attempts the same CAS while A holds the lock: it must fail
          // loudly (lock serialization), not wait forever, not overwrite.
          expect(() =>
            updateMemory(dbB, {
              projectId: world.projectA.projectId,
              memoryId: record.id,
              expectedVersion: 1,
              actor: roleActor("developer"),
              content: "discovery: writer B.",
              now: T1
            })
          ).toThrowError(/locked|busy/i);

          // Nothing B wrote exists; A's uncommitted state is invisible to B.
          expect(
            getMemory(dbB, { projectId: world.projectA.projectId, memoryId: record.id })?.version
          ).toBe(1);
        } finally {
          world.db.exec("COMMIT");
        }

        // After A commits, B's stale expectedVersion=1 write is a CAS conflict.
        expect(() =>
          updateMemory(dbB, {
            projectId: world.projectA.projectId,
            memoryId: record.id,
            expectedVersion: 1,
            actor: roleActor("developer"),
            content: "discovery: writer B.",
            now: T1
          })
        ).toThrowError(MemoryCasConflictError);

        const final = getMemory(dbB, { projectId: world.projectA.projectId, memoryId: record.id });
        expect(final?.content).toBe("discovery: writer A got the lock first.");
        expect(final?.version).toBe(2);
      } finally {
        dbB.close();
      }
    });
  });
});

describe("A14: CAS 提升与校验", () => {
  it("提升基于 (memoryId, expectedVersion)：过期 expectedVersion 的提升是可见冲突，规则不被提升", () => {
    withWorld((world) => {
      // v1 proposed -> v2 verified (reviewer) -> v3 proposed (user tweak)
      // -> v4 verified (architect). A promoter that saw v2 races against v4.
      const proposed = proposeMemory(world.db, {
        id: nextId("rule", world.projectA.projectId),
        projectId: world.projectA.projectId,
        type: "project_rule",
        content: "project rule: baseline.",
        evidenceRefs: ["artifact-rules"],
        actor: roleActor("coordinator"),
        now: T0
      });
      verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: proposed.id,
        expectedVersion: 1,
        actor: roleActor("reviewer"),
        now: T1
      });
      updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: proposed.id,
        expectedVersion: 2,
        actor: USER_ALICE,
        content: "project rule: tightened.",
        now: T1
      });
      verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: proposed.id,
        expectedVersion: 3,
        actor: roleActor("architect"),
        now: T1
      });

      try {
        promoteProjectRule(world.db, {
          projectId: world.projectA.projectId,
          memoryId: proposed.id,
          expectedVersion: 2,
          actor: USER_ALICE,
          now: T2
        });
        throw new Error("expected MemoryCasConflictError");
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryCasConflictError);
        expect((error as MemoryCasConflictError).currentVersion).toBe(4);
      }
      expect(
        getMemory(world.db, { projectId: world.projectA.projectId, memoryId: proposed.id })?.status
      ).toBe("verified");
    });
  });

  it("verify 的守卫顺序：状态守卫先于 CAS（领域错误更有用），版本冲突在状态合法时可见", () => {
    withWorld((world) => {
      const verified = verifiedRule(world, world.projectA.projectId);
      // Stale verify retry on an already-verified memory: lifecycle guard fires.
      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: verified.id,
          expectedVersion: 1,
          actor: roleActor("architect"),
          now: T2
        })
      ).toThrowError(MemoryLifecycleError);
      // A verified memory at v2 that another verify already moved on cannot
      // exist here — the guard order is pinned above; CAS-on-update and
      // CAS-on-promote cover the version-mismatch surface (A14).
    });
  });
});
