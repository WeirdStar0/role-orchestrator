/**
 * A18 (docs/ACCEPTANCE.md): 同一 Approval 双击/重复请求 → 单次有效，重放幂等.
 *
 * Creation: the same idempotency key resolves to the SAME row (already
 * covered in lifecycle.test.ts; here the double-click case under a second
 * connection). Consumption: the first consume wins, the second is rejected
 * CONSUMED — sequentially, and under real connection contention (one caller
 * holds the write lock, the other must lose exactly once).
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalAlreadyConsumedError,
  approveApproval,
  consumeApproval,
  createApproval,
  requireApproval
} from "../src/index.js";
import { openDatabase } from "@role-orchestrator/store";
import { T0, T1, createApprovalWorld, highRiskAction } from "./helpers.js";

const USER = "user-1";
const BUSY_MS = 150;

function approvedAction(
  world: ReturnType<typeof createApprovalWorld>,
  key: string,
  action: ReturnType<typeof highRiskAction>
): string {
  const { approval } = createApproval(world.db, {
    idempotencyKey: key,
    action,
    ttlSeconds: 3600,
    now: T0
  });
  approveApproval(world.db, { approvalId: approval.id, approvedBy: USER, now: T0 });
  return approval.id;
}

describe("A18: single effective consumption", () => {
  it("two consume attempts, identical action: first wins, second is rejected CONSUMED", () => {
    const world = createApprovalWorld("a18-sequential");
    try {
      const action = highRiskAction();
      const id = approvedAction(world, "a18-seq", action);
      const first = consumeApproval(world.db, {
        approvalId: id,
        action,
        consumedByExecutionId: "exec-1",
        now: T1
      });
      expect(first.status).toBe("CONSUMED");
      expect(() =>
        consumeApproval(world.db, { approvalId: id, action, consumedByExecutionId: "exec-2", now: T1 })
      ).toThrow(ApprovalAlreadyConsumedError);
      const record = requireApproval(world.db, id);
      expect(record.status).toBe("CONSUMED");
      // the consumption record names exactly the winning execution
      expect(record.consumedByExecutionId).toBe("exec-1");
      expect(record.consumedAt).toBe(T1);
    } finally {
      world.close();
    }
  });

  it("a PENDING approval cannot be consumed at all", () => {
    const world = createApprovalWorld("a18-pending");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "a18-pending",
        action: highRiskAction(),
        ttlSeconds: 3600,
        now: T0
      });
      expect(() =>
        consumeApproval(world.db, {
          approvalId: approval.id,
          action: highRiskAction(),
          consumedByExecutionId: "exec-1",
          now: T0
        })
      ).toThrow(/is PENDING, expected APPROVED/);
      expect(requireApproval(world.db, approval.id).status).toBe("PENDING");
    } finally {
      world.close();
    }
  });
});

describe("A18: creation is idempotent under a second connection", () => {
  it("double-click across two connections resolves to one row", () => {
    const world = createApprovalWorld("a18-two-conn-create");
    try {
      const action = highRiskAction();
      const second = openDatabase(world.dbPath, { busyTimeoutMs: BUSY_MS });
      try {
        const first = createApproval(world.db, {
          idempotencyKey: "double-click-conn",
          action,
          ttlSeconds: 3600,
          now: T0
        });
        const replay = createApproval(second, {
          idempotencyKey: "double-click-conn",
          action,
          ttlSeconds: 3600,
          now: T1
        });
        expect(replay.created).toBe(false);
        expect(replay.approval.id).toBe(first.approval.id);
        const rows = world.db.prepare("SELECT COUNT(*) AS n FROM approvals").get();
        expect(rows?.n).toBe(1);
      } finally {
        second.close();
      }
    } finally {
      world.close();
    }
  });
});

describe("A18: concurrent double consumption — exactly one winner", () => {
  it("the loser blocked on the write lock fails with BUSY, then loses on CONSUMED state", () => {
    const world = createApprovalWorld("a18-race");
    try {
      const action = highRiskAction();
      const id = approvedAction(world, "a18-race", action);
      const winner = openDatabase(world.dbPath, { busyTimeoutMs: BUSY_MS });
      const loser = openDatabase(world.dbPath, { busyTimeoutMs: BUSY_MS });
      try {
        // The winner holds the write lock with an open transaction while it
        // "consumes" (raw BEGIN, mirroring the store's own contention tests).
        winner.exec("BEGIN IMMEDIATE");
        try {
          const claim = winner
            .prepare("SELECT status FROM approvals WHERE id = ?")
            .get(id);
          expect(claim?.status).toBe("APPROVED");
          // The loser's consume must block on the write lock and surface BUSY.
          let loserError: unknown = null;
          try {
            consumeApproval(loser, {
              approvalId: id,
              action,
              consumedByExecutionId: "exec-loser",
              now: T1
            });
          } catch (caught) {
            loserError = caught;
          }
          expect(loserError).toBeInstanceOf(Error);
          expect((loserError as Error).message).toMatch(/database is locked/);
          // Winner commits its consumption.
          winner
            .prepare(
              "UPDATE approvals SET status = 'CONSUMED', consumed_by_execution_id = ?, consumed_at = ?, updated_at = ? WHERE id = ?"
            )
            .run("exec-winner", T1, T1, id);
          winner.exec("COMMIT");
        } catch (error) {
          winner.exec("ROLLBACK");
          throw error;
        }

        // After the winner committed, the loser's retry loses on the CAS
        // guard (status is CONSUMED) — the typed single-use error.
        expect(() =>
          consumeApproval(loser, { approvalId: id, action, consumedByExecutionId: "exec-loser", now: T1 })
        ).toThrow(ApprovalAlreadyConsumedError);

        const record = requireApproval(world.db, id);
        expect(record.status).toBe("CONSUMED");
        expect(record.consumedByExecutionId).toBe("exec-winner");
      } finally {
        winner.close();
        loser.close();
      }
    } finally {
      world.close();
    }
  });
});
