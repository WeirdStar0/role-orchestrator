/**
 * Approval lifecycle tests (M4-01): guarded state machine, idempotent
 * creation (A18), expiry, and read-time corruption detection.
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalExpiredError,
  ApprovalStateError,
  approveApproval,
  createApproval,
  expirePendingApprovals,
  getApproval,
  getApprovalByIdempotencyKey,
  isApprovalExpired,
  listApprovalsForRun,
  rejectApproval,
  requireApproval
} from "../src/index.js";
import { UnknownApprovalError } from "../src/index.js";
import { ApprovalRecordCorruptError } from "../src/index.js";
import { T0, T1, T_PLUS_1H, createApprovalWorld, highRiskAction, sampleAction } from "./helpers.js";

describe("creation", () => {
  it("creates a PENDING row carrying digest, grade, expiry and requester identity", () => {
    const world = createApprovalWorld("create");
    try {
      const action = highRiskAction();
      const result = createApproval(world.db, {
        idempotencyKey: "idem-create-1",
        action,
        requestedBy: { runId: world.runId, nodeId: "node-1", attempt: 1 },
        ttlSeconds: 3600,
        now: T0
      });
      expect(result.created).toBe(true);
      const record = result.approval;
      expect(record.id).toMatch(/^approval-[0-9a-f]{40}$/);
      expect(record.status).toBe("PENDING");
      expect(record.riskGrade).toBe("high");
      expect(record.requiresApproval).toBe(true);
      expect(record.expiresAt).toBe(T_PLUS_1H);
      expect(record.requestedBy).toEqual({ runId: "run-1", nodeId: "node-1", attempt: 1 });
      expect(record.approvedBy).toBeNull();
      expect(record.consumedByExecutionId).toBeNull();
      expect(record.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      // the reasons frozen at creation include the elevation/network evidence
      expect(record.riskReasons.length).toBeGreaterThan(0);
    } finally {
      world.close();
    }
  });

  it("low-risk actions also get a row when explicitly requested, marked not-required", () => {
    const world = createApprovalWorld("create-low");
    try {
      const result = createApproval(world.db, {
        idempotencyKey: "idem-low",
        action: sampleAction(),
        ttlSeconds: 60,
        now: T0
      });
      expect(result.approval.riskGrade).toBe("low");
      expect(result.approval.requiresApproval).toBe(false);
    } finally {
      world.close();
    }
  });

  it("rejects a requester run that does not exist (foreign key)", () => {
    const world = createApprovalWorld("create-fk");
    try {
      expect(() =>
        createApproval(world.db, {
          idempotencyKey: "idem-fk",
          action: sampleAction(),
          requestedBy: { runId: "run-missing", nodeId: "node-1", attempt: 1 },
          ttlSeconds: 60,
          now: T0
        })
      ).toThrow(/does not exist/);
    } finally {
      world.close();
    }
  });
});

describe("A18: idempotent creation by idempotency key", () => {
  it("a replayed key returns the SAME approval row, never a new one", () => {
    const world = createApprovalWorld("idem-replay");
    try {
      const action = highRiskAction();
      const first = createApproval(world.db, {
        idempotencyKey: "double-click",
        action,
        ttlSeconds: 3600,
        now: T0
      });
      const second = createApproval(world.db, {
        idempotencyKey: "double-click",
        action,
        ttlSeconds: 3600,
        now: T1
      });
      expect(second.created).toBe(false);
      expect(second.approval.id).toBe(first.approval.id);
      expect(second.approval.createdAt).toBe(first.approval.createdAt);
      const rows = world.db.prepare("SELECT COUNT(*) AS n FROM approvals").get();
      expect(rows?.n).toBe(1);
    } finally {
      world.close();
    }
  });

  it("a replayed key with a DIFFERENT action is refused, not absorbed", () => {
    const world = createApprovalWorld("idem-conflict");
    try {
      createApproval(world.db, {
        idempotencyKey: "same-key",
        action: highRiskAction(),
        ttlSeconds: 3600,
        now: T0
      });
      const mutated = highRiskAction({ argv: ["fake-codex", "exec", "--json", "--scenario", "swapped"] });
      expect(() =>
        createApproval(world.db, { idempotencyKey: "same-key", action: mutated, ttlSeconds: 3600, now: T0 })
      ).toThrow(/replay only absorbs IDENTICAL/);
      const rows = world.db.prepare("SELECT COUNT(*) AS n FROM approvals").get();
      expect(rows?.n).toBe(1);
    } finally {
      world.close();
    }
  });

  it("getApprovalByIdempotencyKey resolves the same row", () => {
    const world = createApprovalWorld("idem-get");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "key-lookup",
        action: sampleAction(),
        ttlSeconds: 60,
        now: T0
      });
      expect(getApprovalByIdempotencyKey(world.db, "key-lookup")?.id).toBe(approval.id);
      expect(getApprovalByIdempotencyKey(world.db, "key-other")).toBeNull();
    } finally {
      world.close();
    }
  });
});

describe("guarded transitions", () => {
  it("approve: PENDING -> APPROVED with approver audit, double approve refused", () => {
    const world = createApprovalWorld("approve");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "approve-1",
        action: highRiskAction(),
        ttlSeconds: 3600,
        now: T0
      });
      const approved = approveApproval(world.db, { approvalId: approval.id, approvedBy: "user-1", now: T1 });
      expect(approved.status).toBe("APPROVED");
      expect(approved.approvedBy).toBe("user-1");
      expect(approved.approvedAt).toBe(T1);
      expect(() =>
        approveApproval(world.db, { approvalId: approval.id, approvedBy: "user-2", now: T1 })
      ).toThrow(ApprovalStateError);
    } finally {
      world.close();
    }
  });

  it("approve cannot mint a live approval from an EXPIRED request", () => {
    const world = createApprovalWorld("approve-expired");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "late-approve",
        action: highRiskAction(),
        ttlSeconds: 1,
        now: T0
      });
      let error: unknown = null;
      try {
        approveApproval(world.db, { approvalId: approval.id, approvedBy: "user-1", now: T1 });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ApprovalExpiredError);
      // the dead request is materialized EXPIRED forever
      expect(requireApproval(world.db, approval.id).status).toBe("EXPIRED");
      expect(() =>
        approveApproval(world.db, { approvalId: approval.id, approvedBy: "user-1", now: T1 })
      ).toThrow(ApprovalStateError);
    } finally {
      world.close();
    }
  });

  it("reject: PENDING -> REJECTED with reason; approve after reject refused", () => {
    const world = createApprovalWorld("reject");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "reject-1",
        action: highRiskAction(),
        ttlSeconds: 3600,
        now: T0
      });
      const rejected = rejectApproval(world.db, {
        approvalId: approval.id,
        rejectedBy: "user-1",
        reason: "unnecessary network access",
        now: T1
      });
      expect(rejected.status).toBe("REJECTED");
      expect(rejected.rejectionReason).toBe("unnecessary network access");
      expect(() =>
        approveApproval(world.db, { approvalId: approval.id, approvedBy: "user-2", now: T1 })
      ).toThrow(ApprovalStateError);
      expect(() =>
        rejectApproval(world.db, {
          approvalId: approval.id,
          rejectedBy: "user-2",
          reason: "again",
          now: T1
        })
      ).toThrow(ApprovalStateError);
    } finally {
      world.close();
    }
  });

  it("unknown approval ids are typed errors", () => {
    const world = createApprovalWorld("unknown");
    try {
      expect(() => requireApproval(world.db, "approval-missing")).toThrow(UnknownApprovalError);
      expect(() =>
        approveApproval(world.db, { approvalId: "approval-missing", approvedBy: "user-1", now: T0 })
      ).toThrow(UnknownApprovalError);
    } finally {
      world.close();
    }
  });
});

describe("expiry", () => {
  it("the sweep expires only PENDING rows past their time and returns the count", () => {
    const world = createApprovalWorld("sweep");
    try {
      const a = createApproval(world.db, {
        idempotencyKey: "sweep-a",
        action: highRiskAction(),
        ttlSeconds: 1,
        now: T0
      }).approval;
      const b = createApproval(world.db, {
        idempotencyKey: "sweep-b",
        action: highRiskAction({ argv: ["fake-codex", "exec", "--json", "--scenario", "b"] }),
        ttlSeconds: 3600,
        now: T0
      }).approval;
      approveApproval(world.db, { approvalId: b.id, approvedBy: "user-1", now: T0 });
      expect(expirePendingApprovals(world.db, { now: T1 })).toBe(1);
      expect(requireApproval(world.db, a.id).status).toBe("EXPIRED");
      // the APPROVED row keeps its status as evidence (expiry is enforced at consumption)
      expect(requireApproval(world.db, b.id).status).toBe("APPROVED");
      expect(expirePendingApprovals(world.db, { now: T1 })).toBe(0);
    } finally {
      world.close();
    }
  });

  it("isApprovalExpired is a pure row+clock comparison", () => {
    const world = createApprovalWorld("expired-flag");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "exp-flag",
        action: highRiskAction(),
        ttlSeconds: 1,
        now: T0
      });
      expect(isApprovalExpired(approval, T0)).toBe(false);
      expect(isApprovalExpired(approval, T1)).toBe(true);
    } finally {
      world.close();
    }
  });
});

describe("queries and read-time integrity", () => {
  it("listApprovalsForRun returns the run's approvals in creation order", () => {
    const world = createApprovalWorld("list");
    try {
      const first = createApproval(world.db, {
        idempotencyKey: "list-1",
        action: sampleAction(),
        requestedBy: { runId: world.runId, nodeId: "node-1", attempt: 1 },
        ttlSeconds: 60,
        now: T0
      }).approval;
      const second = createApproval(world.db, {
        idempotencyKey: "list-2",
        action: highRiskAction(),
        requestedBy: { runId: world.runId, nodeId: "node-2", attempt: 1 },
        ttlSeconds: 60,
        now: T1
      }).approval;
      const rows = listApprovalsForRun(world.db, world.runId);
      expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(listApprovalsForRun(world.db, "run-other")).toEqual([]);
    } finally {
      world.close();
    }
  });

  it("a tampered action JSON fails closed on read", () => {
    const world = createApprovalWorld("corrupt-action");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "corrupt-1",
        action: sampleAction(),
        ttlSeconds: 60,
        now: T0
      });
      world.db
        .prepare("UPDATE approvals SET action = ?, action_digest = ? WHERE id = ?")
        .run(JSON.stringify({ ...sampleAction(), cwd: "h:/tampered" }), approval.actionDigest, approval.id);
      expect(() => getApproval(world.db, approval.id)).toThrow(ApprovalRecordCorruptError);
    } finally {
      world.close();
    }
  });

  it("a tampered risk grade fails closed on read", () => {
    const world = createApprovalWorld("corrupt-grade");
    try {
      const { approval } = createApproval(world.db, {
        idempotencyKey: "corrupt-2",
        action: sampleAction(),
        ttlSeconds: 60,
        now: T0
      });
      world.db
        .prepare("UPDATE approvals SET risk_grade = 'high', requires_approval = 1 WHERE id = ?")
        .run(approval.id);
      expect(() => getApproval(world.db, approval.id)).toThrow(ApprovalRecordCorruptError);
    } finally {
      world.close();
    }
  });
});
