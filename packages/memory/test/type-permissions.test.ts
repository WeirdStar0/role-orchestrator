/**
 * M3-02 type write-permissions — the 可提交者 matrix of
 * docs/MEMORY_AND_CONTEXT.md section 2, transcribed as a frozen constant and
 * enforced at every write. Expected matrix is HARD-CODED here (not imported
 * from the implementation) so a matrix change cannot test itself.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryEvidenceRequiredError,
  MemoryLifecycleError,
  MemoryWriteRefusedError,
  getMemory,
  proposeMemory,
  verifyMemory,
  type MemoryType
} from "../src/index.js";
import {
  T0,
  T1,
  createMemoryWorld,
  removeTreeRobust,
  roleActor,
  type TestRole
} from "./helpers.js";

const ALL_ROLES: readonly TestRole[] = ["coordinator", "architect", "developer", "reviewer"];

/** docs/MEMORY_AND_CONTEXT.md section 2, 可提交者 column — hard-coded expectation. */
const EXPECTED_MATRIX: Readonly<Record<MemoryType, readonly TestRole[]>> = Object.freeze({
  temporary: ALL_ROLES,
  fact: ALL_ROLES,
  discovery: ALL_ROLES,
  decision: ["architect", "coordinator"],
  project_rule: ["coordinator"]
});

const EVIDENCE_REQUIRED: readonly MemoryType[] = ["fact", "decision", "project_rule"];

function withWorld<T>(fn: (world: ReturnType<typeof createMemoryWorld>) => T): T {
  const world = createMemoryWorld();
  try {
    return fn(world);
  } finally {
    world.close();
    removeTreeRobust(world.scratchDir);
  }
}

describe("M3-02 类型写入权限（可提交者矩阵）", () => {
  for (const type of Object.keys(EXPECTED_MATRIX) as MemoryType[]) {
    it(`type "${type}": 允许的角色提交成功，其余角色被类型化错误拒绝`, () => {
      withWorld((world) => {
        const projectId = world.projectA.projectId;
        for (const role of ALL_ROLES) {
          const allowed = EXPECTED_MATRIX[type].includes(role);
          const input = {
            id: `${type}-${role}-probe`,
            projectId,
            type,
            content: `${type} content proposed by ${role}.`,
            evidenceRefs: EVIDENCE_REQUIRED.includes(type) ? ["artifact-evidence"] : [],
            actor: roleActor(role),
            ...(type === "temporary" ? { expiresAt: T1 } : {}),
            now: T0
          };
          if (allowed) {
            const record = proposeMemory(world.db, input);
            expect(record.proposedByRole).toBe(role);
          } else {
            expect(() => proposeMemory(world.db, input)).toThrowError(MemoryWriteRefusedError);
            // The refusal left no row behind.
            const rows = world.db
              .prepare("SELECT COUNT(*) AS n FROM memories WHERE id = ?")
              .get(input.id) as { n: number };
            expect(Number(rows.n)).toBe(0);
          }
        }
      });
    });
  }

  it("user 主体不能提案（操作员的权威通道是提升入口，不是提案）", () => {
    withWorld((world) => {
      expect(() =>
        proposeMemory(world.db, {
          id: "rule-by-user",
          projectId: world.projectA.projectId,
          type: "project_rule",
          content: "operator writing a rule directly — refused.",
          evidenceRefs: ["artifact-evidence"],
          actor: { kind: "user", displayName: "maintainer-alice" },
          now: T0
        })
      ).toThrowError(/proposals are submitted by roles/);
    });
  });
});

describe("M3-02 证据要求（contracts MemoryProposalSchema 语义）", () => {
  it("fact/decision/project_rule 无证据被拒；discovery/temporary 允许零证据", () => {
    withWorld((world) => {
      const projectId = world.projectA.projectId;
      for (const type of EVIDENCE_REQUIRED) {
        expect(() =>
          proposeMemory(world.db, {
            id: `no-evidence-${type}`,
            projectId,
            type,
            content: `${type} without evidence — refused.`,
            evidenceRefs: [],
            actor: roleActor(type === "fact" ? "developer" : "coordinator"),
            now: T0
          })
        ).toThrowError(MemoryEvidenceRequiredError);
      }
      for (const type of ["discovery", "temporary"] as const) {
        const record = proposeMemory(world.db, {
          id: `no-evidence-${type}`,
          projectId,
          type,
          content: `${type} without evidence — accepted.`,
          evidenceRefs: [],
          actor: roleActor("developer"),
          ...(type === "temporary" ? { expiresAt: T1 } : {}),
          now: T0
        });
        expect(record.evidenceRefs).toEqual([]);
      }
    });
  });
});

describe("M3-02 temporary 过期语义", () => {
  it("temporary 必须携带未来 expiresAt；其他类型必须省略 expiresAt", () => {
    withWorld((world) => {
      const projectId = world.projectA.projectId;
      expect(() =>
        proposeMemory(world.db, {
          id: "tmp-no-expiry",
          projectId,
          type: "temporary",
          content: "temporary without expiry — refused.",
          evidenceRefs: [],
          actor: roleActor("developer"),
          now: T0
        })
      ).toThrowError(/must carry a future expiresAt/);

      expect(() =>
        proposeMemory(world.db, {
          id: "tmp-past-expiry",
          projectId,
          type: "temporary",
          content: "temporary expiring in the past — refused.",
          evidenceRefs: [],
          actor: roleActor("developer"),
          expiresAt: "2026-09-22T00:00:00.000Z",
          now: T0
        })
      ).toThrowError(MemoryLifecycleError);

      expect(() =>
        proposeMemory(world.db, {
          id: "fact-with-expiry",
          projectId,
          type: "fact",
          content: "fact with a hidden expiry — refused.",
          evidenceRefs: ["artifact-evidence"],
          actor: roleActor("developer"),
          expiresAt: T1,
          now: T0
        })
      ).toThrowError(/only temporary memories are execution-scoped/);
    });
  });
});

describe("M3-02 verify 的角色门", () => {
  it("developer 与 user 主体都不能 verify（校验职责在 reviewer/architect/coordinator）", () => {
    withWorld((world) => {
      const byDeveloper = proposeMemory(world.db, {
        id: "fact-gate-developer",
        projectId: world.projectA.projectId,
        type: "fact",
        content: "fact awaiting a verifier that is not the developer role.",
        evidenceRefs: ["artifact-evidence"],
        actor: roleActor("developer"),
        now: T0
      });
      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: byDeveloper.id,
          expectedVersion: byDeveloper.version,
          actor: roleActor("developer"),
          now: T1
        })
      ).toThrowError(MemoryWriteRefusedError);

      expect(() =>
        verifyMemory(world.db, {
          projectId: world.projectA.projectId,
          memoryId: byDeveloper.id,
          expectedVersion: byDeveloper.version,
          actor: { kind: "user", displayName: "maintainer-alice" },
          now: T1
        })
      ).toThrowError(/verification is role work/);

      // Neither refusal changed the stored state.
      const after = getMemory(world.db, {
        projectId: world.projectA.projectId,
        memoryId: byDeveloper.id
      });
      expect(after?.status).toBe("proposed");
      expect(after?.version).toBe(1);
    });
  });
});
