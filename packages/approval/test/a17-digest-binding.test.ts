/**
 * A17 (docs/ACCEPTANCE.md): 批准后改变命令/目标 SHA → 原审批无法消费.
 *
 * The approval is granted for ONE exact digest. After approval, changing ANY
 * element of the action (an argv element, the argv order, the target SHA,
 * the baseline, the cwd, the permission increments, the frozen profile
 * revision) recomputes a DIFFERENT digest at consumption time, the CAS
 * refuses, a typed error is thrown, and the original approval survives
 * intact — a failed attempt never burns it.
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalAlreadyConsumedError,
  ApprovalDigestMismatchError,
  approveApproval,
  consumeApproval,
  createApproval,
  requireApproval
} from "../src/index.js";
import type { ActionDescriptor } from "../src/index.js";
import { SHA_C, T0, T1, createApprovalWorld, highRiskAction } from "./helpers.js";

const USER = "user-1";
const EXECUTION = "exec-1";

/** Creates + approves one approval for the given action; returns its id. */
function approved(worldDb: Parameters<typeof createApproval>[0], action: ActionDescriptor, key: string): string {
  const { approval } = createApproval(worldDb, {
    idempotencyKey: key,
    action,
    ttlSeconds: 3600,
    now: T0
  });
  approveApproval(worldDb, { approvalId: approval.id, approvedBy: USER, now: T0 });
  return approval.id;
}

describe("A17: consumption is bound to the exact approved action", () => {
  it("consuming the exact approved action succeeds", () => {
    const world = createApprovalWorld("a17-happy");
    try {
      const action = highRiskAction();
      const id = approved(world.db, action, "a17-happy");
      const consumed = consumeApproval(world.db, {
        approvalId: id,
        action,
        consumedByExecutionId: EXECUTION,
        now: T1
      });
      expect(consumed.status).toBe("CONSUMED");
      expect(consumed.consumedByExecutionId).toBe(EXECUTION);
    } finally {
      world.close();
    }
  });

  const mutationCases: readonly [string, (action: ActionDescriptor) => ActionDescriptor][] = [
    ["one argv element changes", (a) => ({ ...a, argv: [...a.argv.slice(0, -1), "CHANGED"] })],
    ["argv order is permuted", (a) => ({ ...a, argv: [...a.argv].reverse() })],
    [
      "the target SHA changes",
      (a) => ({ ...a, repo: { ...a.repo, targetSha: SHA_C } })
    ],
    [
      "the baseline (baseSha) changes",
      (a) => ({ ...a, repo: { ...a.repo, baseSha: SHA_C } })
    ],
    ["the repo root changes", (a) => ({ ...a, repo: { ...a.repo, root: "h:/repos/other" } })],
    ["the working directory changes", (a) => ({ ...a, cwd: "h:/worktrees/other" })],
    [
      "the permission increments change",
      (a) => ({ ...a, grantedPermissions: [] })
    ],
    ["the frozen profile revision changes", (a) => ({ ...a, profileRevision: "rev-2" })],
    ["the runtime changes", (a) => ({ ...a, runtime: "claude" })],
    ["a dimension is added", (a) => ({ ...a, dimensions: [...a.dimensions, "delete"] })]
  ];

  for (const [label, mutate] of mutationCases) {
    it(`refuses consumption with a typed error when ${label}`, () => {
      const world = createApprovalWorld(`a17-${label.replace(/\W+/g, "-").toLowerCase()}`);
      try {
        const action = highRiskAction();
        const id = approved(world.db, action, "a17-mutation");
        const mutated = mutate(action);
        let error: unknown = null;
        try {
          consumeApproval(world.db, {
            approvalId: id,
            action: mutated,
            consumedByExecutionId: EXECUTION,
            now: T1
          });
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(ApprovalDigestMismatchError);
        const mismatch = error as ApprovalDigestMismatchError;
        expect(mismatch.approvalId).toBe(id);
        expect(mismatch.presentedDigest).not.toBe(mismatch.approvedDigest);
        // the original approval is NOT burned by the failed attempt
        const record = requireApproval(world.db, id);
        expect(record.status).toBe("APPROVED");
        expect(record.consumedByExecutionId).toBeNull();
        // and the ORIGINAL action can still be consumed afterwards
        const consumed = consumeApproval(world.db, {
          approvalId: id,
          action,
          consumedByExecutionId: EXECUTION,
          now: T1
        });
        expect(consumed.status).toBe("CONSUMED");
      } finally {
        world.close();
      }
    });
  }
});

describe("A17 interplay with A18", () => {
  it("after a successful consume, replaying the ORIGINAL action is rejected as consumed", () => {
    const world = createApprovalWorld("a17-a18");
    try {
      const action = highRiskAction();
      const id = approved(world.db, action, "a17-a18-key");
      consumeApproval(world.db, { approvalId: id, action, consumedByExecutionId: EXECUTION, now: T1 });
      expect(() =>
        consumeApproval(world.db, { approvalId: id, action, consumedByExecutionId: "exec-2", now: T1 })
      ).toThrow(ApprovalAlreadyConsumedError);
      const record = requireApproval(world.db, id);
      expect(record.status).toBe("CONSUMED");
      expect(record.consumedByExecutionId).toBe(EXECUTION);
    } finally {
      world.close();
    }
  });
});
