/**
 * M3-02 lifecycle guards (docs/MEMORY_AND_CONTEXT.md sections 2/3/6):
 * proposed -> verified -> active (project_rule only, user-only), disputed,
 * superseded relation, temporary expiry — every transition guarded, audited,
 * version-bumped. Promotion-specific guards live in promotion.test.ts; the
 * CAS mechanics live in cas.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DisputeMemoryInputSchema,
  MemoryUserRequiredError,
  MemoryWriteRefusedError,
  disputeMemory,
  expireDueTemporaries,
  listActiveProjectRules,
  listMemoryEvents,
  listMemoryRevisions,
  promoteProjectRule,
  proposeMemory,
  requireMemory,
  requireVerifiedMemory,
  updateMemory,
  verifyMemory,
  type MemoryRecord
} from "../src/index.js";
import {
  T0,
  T1,
  T2,
  USER_ALICE,
  createMemoryWorld,
  nextId,
  proposeDiscovery,
  proposeFact,
  proposeRule,
  removeTreeRobust,
  roleActor,
  sha256Hex,
  verifiedFact,
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

describe("M3-02 生命周期：提案与审计", () => {
  it("提案落库为 proposed/version 1，content_hash 正确，revision+event 审计齐备", () => {
    withWorld((world) => {
      const content = "fact: module X exports parseEvent; covered by tests/e2e.";
      const record = proposeFact(world, world.projectA.projectId, { content });
      expect(record.status).toBe("proposed");
      expect(record.version).toBe(1);
      expect(record.scope).toBe("project");
      expect(record.contentHash).toBe(sha256Hex(content));
      expect(record.proposedBy).toBe("role:developer");
      expect(record.verifiedBy).toBeNull();
      expect(record.promotedBy).toBeNull();

      const revisions = listMemoryRevisions(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id
      });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({ version: 1, status: "proposed", transition: "propose" });

      const events = listMemoryEvents(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id
      });
      expect(events.map((event) => event.type)).toEqual(["proposed"]);
    });
  });
});

describe("M3-02 生命周期：verify 守卫", () => {
  it("proposed 不能直接 promote 为 active（必须先 verified）", () => {
    withWorld((world) => {
      const proposed = proposeRule(world, world.projectA.projectId);
      expect(() =>
        promoteProjectRule(world.db, {
          projectId: world.projectA.projectId,
          memoryId: proposed.id,
          expectedVersion: proposed.version,
          actor: USER_ALICE,
          now: T1
        })
      ).toThrowError(/promotion requires the verified state/);
    });
  });

  it("reviewer 校验后进入 verified；重复 verify 被拒", () => {
    withWorld((world) => {
      const proposed = proposeFact(world, world.projectA.projectId);
      const verified = verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: proposed.id,
        expectedVersion: proposed.version,
        actor: roleActor("reviewer"),
        now: T1
      });
      expect(verified.status).toBe("verified");
      expect(verified.version).toBe(2);
      expect(verified.verifiedBy).toBe("role:reviewer");
      expect(verified.verifiedAt).toBe(T1);

      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: verified.id,
          expectedVersion: verified.version,
          actor: roleActor("architect"),
          now: T2
        })
      ).toThrowError(/only a proposed memory can be verified/);
    });
  });

  it("developer 不能 verify；提案角色不能自审", () => {
    withWorld((world) => {
      const byDeveloper = proposeFact(world, world.projectA.projectId);
      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: byDeveloper.id,
          expectedVersion: byDeveloper.version,
          actor: roleActor("developer"),
          now: T1
        })
      ).toThrowError(MemoryWriteRefusedError);

      const rule = proposeRule(world, world.projectA.projectId, { proposer: "coordinator" });
      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: rule.id,
          expectedVersion: rule.version,
          actor: roleActor("coordinator"),
          now: T1
        })
      ).toThrowError(/cannot verify its own proposal/);
    });
  });

  it("temporary 不能 verify（执行范围，不进入已验证链）", () => {
    withWorld((world) => {
      const temp = proposeMemory(world.db, {
        id: nextId("tmp", world.projectA.projectId),
        projectId: world.projectA.projectId,
        type: "temporary",
        content: "temporary: working on parseEvent; scratch notes.",
        evidenceRefs: [],
        actor: roleActor("developer"),
        expiresAt: T1,
        now: T0
      });
      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: temp.id,
          expectedVersion: temp.version,
          actor: roleActor("reviewer"),
          now: T0
        })
      ).toThrowError(/never verified/);
    });
  });
});

describe("M3-02 生命周期：disputed 质疑态", () => {
  it("disputed 不能被引用为已验证（requireVerifiedMemory 携带实际状态拒绝）", () => {
    withWorld((world) => {
      const verified = verifiedFact(world, world.projectA.projectId);
      const disputed = disputeMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("developer"),
        reason: "evidence SHA points at a rebased commit",
        now: T2
      });
      expect(disputed.status).toBe("disputed");
      expect(disputed.disputedBy).toBe("role:developer");

      expect(() =>
        requireVerifiedMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: disputed.id
        })
      ).toThrowError(/status "disputed".*cannot be referenced as verified/);
    });
  });

  it("disputed 不能直接 verify：必须重新提案", () => {
    withWorld((world) => {
      const verified = verifiedFact(world, world.projectA.projectId);
      const disputed = disputeMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("architect"),
        reason: "stale",
        now: T2
      });
      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: disputed.id,
          expectedVersion: disputed.version,
          actor: roleActor("reviewer"),
          now: T2
        })
      ).toThrowError(/only a proposed memory can be verified/);
    });
  });

  it("active 规则不能被任何角色 dispute（撤销是用户通道，M3-03）", () => {
    withWorld((world) => {
      const verified = verifiedRule(world, world.projectA.projectId);
      const active = promoteProjectRule(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: USER_ALICE,
        now: T2
      });
      expect(active.status).toBe("active");
      for (const role of ["coordinator", "architect", "developer", "reviewer"] as const) {
        expect(() =>
          disputeMemory(world.db, {
            projectId: world.projectA.projectId,
            memoryId: active.id,
            expectedVersion: active.version,
            actor: roleActor(role),
            reason: "challenge",
            now: T2
          })
        ).toThrowError(/not role-disputable/);
      }
      expect(
        listActiveProjectRules(world.db, { projectId: world.projectA.projectId }).map((r) => r.id)
      ).toEqual([active.id]);
    });
  });

  it("dispute 输入走严格 Schema（未知字段拒绝）", () => {
    expect(() =>
      DisputeMemoryInputSchema.parse({
        projectId: "proj-a",
        memoryId: "mem-1",
        expectedVersion: 1,
        actor: { kind: "role", roleId: "developer" },
        reason: "x",
        now: T0,
        forceOverride: true
      })
    ).toThrowError(/Unrecognized key|unrecognized/i);
  });
});

describe("M3-02 生命周期：active 规则与更新", () => {
  it("active 规则仅用户可改内容；用户改动后保持 active 且提升审计保留", () => {
    withWorld((world) => {
      const verified = verifiedRule(world, world.projectA.projectId);
      const active = promoteProjectRule(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: USER_ALICE,
        now: T2
      });
      expect(() =>
        updateMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: active.id,
          expectedVersion: active.version,
          actor: roleActor("coordinator"),
          content: "project rule: rewritten by a role (must be refused).",
          now: T2
        })
      ).toThrowError(MemoryUserRequiredError);

      const edited = updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: active.id,
        expectedVersion: active.version,
        actor: USER_ALICE,
        content: "project rule: tightened by the operator; tests remain mandatory.",
        now: T2
      });
      expect(edited.status).toBe("active");
      expect(edited.version).toBe(active.version + 1);
      expect(edited.promotedBy).toBe("user:maintainer-alice");
      expect(edited.supersedesVersion).toBe(active.version);
    });
  });

  it("verified 记忆更新内容后回到 proposed（旧证据不覆盖新内容）", () => {
    withWorld((world) => {
      const verified = verifiedFact(world, world.projectA.projectId);
      const updated = updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("developer"),
        content: "fact: module X exports parseEvent AND parseReply; covered by tests/e2e.",
        now: T2
      });
      expect(updated.status).toBe("proposed");
      expect(updated.version).toBe(3);
    });
  });

  it("update 记录 superseded 关系并保留旧值（revisions 追加，不覆盖）", () => {
    withWorld((world) => {
      const record = proposeDiscovery(world, world.projectA.projectId);
      const oldContent = record.content;
      const updated = updateMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id,
        expectedVersion: record.version,
        actor: roleActor("developer"),
        content: "discovery: build cache moved to .ro/cache; old path still readable.",
        now: T1
      });
      expect(updated.supersedesVersion).toBe(1);
      const revisions = listMemoryRevisions(world.db, {
        projectId: world.projectA.projectId,
        memoryId: record.id
      });
      expect(revisions.map((revision) => revision.version)).toEqual([1, 2]);
      expect(revisions[0]?.content).toBe(oldContent);
      expect(revisions[1]?.content).toBe(updated.content);
    });
  });
});

describe("M3-02 生命周期：temporary 过期", () => {
  it("未到期不清；到期后 expireDueTemporaries 清理并审计；过期后为终态", () => {
    withWorld((world) => {
      const temp = proposeMemory(world.db, {
        id: nextId("tmp", world.projectA.projectId),
        projectId: world.projectA.projectId,
        type: "temporary",
        content: "temporary: scratch plan for today's run.",
        evidenceRefs: [],
        actor: roleActor("coordinator"),
        expiresAt: T1,
        now: T0
      });

      expect(
        expireDueTemporaries(world.db, { projectId: world.projectA.projectId, now: T0 })
          .expiredMemoryIds
      ).toEqual([]);

      const swept = expireDueTemporaries(world.db, { projectId: world.projectA.projectId, now: T2 });
      expect(swept.expiredMemoryIds).toEqual([temp.id]);

      const expired: MemoryRecord = requireMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: temp.id
      });
      expect(expired.status).toBe("expired");
      expect(expired.version).toBe(2);

      expect(() =>
        updateMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: temp.id,
          expectedVersion: expired.version,
          actor: USER_ALICE,
          content: "resurrect?",
          now: T2
        })
      ).toThrowError(/terminal/);

      const events = listMemoryEvents(world.db, {
        projectId: world.projectA.projectId,
        memoryId: temp.id
      });
      expect(events.map((event) => event.type)).toEqual(["proposed", "expired"]);
    });
  });
});
