/**
 * M3-02 project_rule promotion — docs/MEMORY_AND_CONTEXT.md section 2:
 * "只有用户可以提升为 active 规则；不得授权自己提权".
 *
 * The promotion entry point accepts ONLY a user actor. Every one of the four
 * roles is refused with MemoryUserRequiredError and leaves a visible
 * `promotion-rejected` audit event; the user path records
 * promoted_by/promoted_via/promoted_at plus a `promoted` audit event.
 * Content never participates: an active rule exists only through this entry.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryLifecycleError,
  MemoryUserRequiredError,
  PROJECT_RULE_PROMOTION_ENTRY,
  getMemory,
  listActiveProjectRules,
  listMemoryEvents,
  listMemoryRevisions,
  promoteProjectRule,
  verifyMemory
} from "../src/index.js";
import {
  T0,
  T1,
  T2,
  USER_ALICE,
  createMemoryWorld,
  proposeRule,
  removeTreeRobust,
  roleActor,
  verifiedFact
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

describe("M3-02 提升：仅用户（人类操作员语义）", () => {
  it("四个角色都无法提升；每次尝试都留下 promotion-rejected 审计", () => {
    withWorld((world) => {
      const verified = proposeRule(world, world.projectA.projectId);
      const step = verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("reviewer"),
        now: T1
      });

      for (const role of ["coordinator", "architect", "developer", "reviewer"] as const) {
        expect(() =>
          promoteProjectRule(world.db, {
            projectId: world.projectA.projectId,
            memoryId: step.id,
            expectedVersion: step.version,
            actor: roleActor(role),
            now: T2
          })
        ).toThrowError(MemoryUserRequiredError);
      }

      // Status untouched by the refused attempts.
      expect(getMemory(world.db, { projectId: world.projectA.projectId, memoryId: step.id })?.status).toBe(
        "verified"
      );
      const rejections = listMemoryEvents(world.db, {
        projectId: world.projectA.projectId,
        memoryId: step.id,
        type: "promotion-rejected"
      });
      expect(rejections).toHaveLength(4);
      expect(rejections.map((event) => event.actor).sort()).toEqual([
        "role:architect",
        "role:coordinator",
        "role:developer",
        "role:reviewer"
      ]);
      expect(rejections[0]?.payload).toEqual({ action: "promote", reason: "user-required" });
    });
  });

  it("user 提升成功：promoted_by/via/at 落库，promoted 审计与 revision 记录齐备", () => {
    withWorld((world) => {
      const verified = proposeRule(world, world.projectA.projectId);
      const step = verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("reviewer"),
        now: T1
      });
      const active = promoteProjectRule(world.db, {
        projectId: world.projectA.projectId,
        memoryId: step.id,
        expectedVersion: step.version,
        actor: USER_ALICE,
        now: T2
      });
      expect(active.status).toBe("active");
      expect(active.version).toBe(3);
      expect(active.promotedBy).toBe("user:maintainer-alice");
      expect(active.promotedVia).toBe(PROJECT_RULE_PROMOTION_ENTRY);
      expect(active.promotedAt).toBe(T2);

      const events = listMemoryEvents(world.db, {
        projectId: world.projectA.projectId,
        memoryId: active.id
      });
      expect(events.map((event) => event.type)).toEqual(["proposed", "verified", "promoted"]);
      expect(events[2]?.payload).toEqual({
        promotedBy: "user:maintainer-alice",
        promotedVia: PROJECT_RULE_PROMOTION_ENTRY
      });

      const revisions = listMemoryRevisions(world.db, {
        projectId: world.projectA.projectId,
        memoryId: active.id
      });
      expect(revisions.map((revision) => revision.status)).toEqual([
        "proposed",
        "verified",
        "active"
      ]);
      expect(revisions[2]?.actor).toBe("user:maintainer-alice");
    });
  });

  it("user actor 缺少 displayName 被输入 Schema 拒绝（审计身份是必须项）", () => {
    withWorld((world) => {
      const verified = proposeRule(world, world.projectA.projectId);
      const step = verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("reviewer"),
        now: T1
      });
      expect(() =>
        promoteProjectRule(world.db, {
          projectId: world.projectA.projectId,
          memoryId: step.id,
          expectedVersion: step.version,
          actor: { kind: "user" },
          now: T2
        })
      ).toThrowError(/displayName/);
      expect(
        getMemory(world.db, { projectId: world.projectA.projectId, memoryId: step.id })?.status
      ).toBe("verified");
    });
  });
});

describe("M3-02 提升：入口守卫", () => {
  it("proposed 的规则即使 user 也不能提升（不能跳过验证）", () => {
    withWorld((world) => {
      const proposed = proposeRule(world, world.projectA.projectId);
      expect(() =>
        promoteProjectRule(world.db, {
          projectId: world.projectA.projectId,
          memoryId: proposed.id,
          expectedVersion: proposed.version,
          actor: USER_ALICE,
          now: T2
        })
      ).toThrowError(MemoryLifecycleError);
    });
  });

  it("只有 project_rule 可提升：verified fact + user 也被拒", () => {
    withWorld((world) => {
      const fact = verifiedFact(world, world.projectA.projectId);
      expect(() =>
        promoteProjectRule(world.db, {
          projectId: world.projectA.projectId,
          memoryId: fact.id,
          expectedVersion: fact.version,
          actor: USER_ALICE,
          now: T2
        })
      ).toThrowError(/only project_rule can be promoted/);
      expect(listActiveProjectRules(world.db, { projectId: world.projectA.projectId })).toEqual([]);
    });
  });

  it("提升后的规则进入 listActiveProjectRules（项目域内）", () => {
    withWorld((world) => {
      const verified = proposeRule(world, world.projectA.projectId);
      const step = verifyMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: verified.id,
        expectedVersion: verified.version,
        actor: roleActor("reviewer"),
        now: T1
      });
      const active = promoteProjectRule(world.db, {
        projectId: world.projectA.projectId,
        memoryId: step.id,
        expectedVersion: step.version,
        actor: USER_ALICE,
        now: T2
      });
      const rules = listActiveProjectRules(world.db, { projectId: world.projectA.projectId });
      expect(rules.map((rule) => rule.id)).toEqual([active.id]);
      // T0 import kept honest: proposal happened at T0.
      expect(rules[0]?.createdAt).toBe(T0);
    });
  });
});
