/**
 * Migration 011 tests: the approvals table joins the composed chain
 * (001..010 + 011), its constraints enforce the lifecycle invariants at the
 * SQL level, and the unique idempotency index backs the A18 replay.
 */
import { describe, expect, it } from "vitest";
import { appliedMigrationRecords, openDatabase, verifyMigrations } from "@role-orchestrator/store";
import { APPROVAL_MIGRATIONS, APPROVAL_SCHEMA_MIGRATION, applyApprovalMigrations } from "../src/index.js";
import { T0, createApprovalWorld, sampleAction } from "./helpers.js";

describe("migration chain", () => {
  it("applies 001..011 on a fresh file database and verifies cleanly", () => {
    const world = createApprovalWorld("migration-fresh");
    try {
      const records = appliedMigrationRecords(world.db);
      expect(records.map((record) => record.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(records[10]?.name).toBe("011-approvals");
      const verification = verifyMigrations(world.db, { migrations: APPROVAL_MIGRATIONS });
      expect(verification).toEqual({ ok: true, checked: 11, versions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    } finally {
      world.close();
    }
  });

  it("is idempotent: re-applying the composed chain applies nothing", async () => {
    const world = createApprovalWorld("migration-idempotent");
    try {
      const result = await applyApprovalMigrations(world.db, { now: T0 });
      expect(result.appliedVersions).toEqual([]);
      expect(result.backupPath).toBeNull();
    } finally {
      world.close();
    }
  });

  it("exposes the migration definition with the pinned version and name", () => {
    expect(APPROVAL_SCHEMA_MIGRATION.version).toBe(11);
    expect(APPROVAL_SCHEMA_MIGRATION.name).toBe("011-approvals");
    expect(APPROVAL_MIGRATIONS.length).toBe(11);
    expect(APPROVAL_MIGRATIONS[10]).toBe(APPROVAL_SCHEMA_MIGRATION);
  });

  it("works on an in-memory database too", async () => {
    const db = openDatabase(":memory:");
    try {
      const result = await applyApprovalMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      db.close();
    }
  });
});

describe("SQL-level invariants", () => {
  it("rejects an unknown status value (no invented states like PAUSED)", () => {
    const world = createApprovalWorld("check-status");
    try {
      const { approvalId } = insertMinimal(world);
      expect(() =>
        world.db.prepare("UPDATE approvals SET status = 'PAUSED' WHERE id = ?").run(approvalId)
      ).toThrow(/CHECK constraint failed/);
    } finally {
      world.close();
    }
  });

  it("an APPROVED row without an approver cannot exist", () => {
    const world = createApprovalWorld("check-approver");
    try {
      const { approvalId } = insertMinimal(world);
      expect(() =>
        world.db
          .prepare("UPDATE approvals SET status = 'APPROVED', approved_at = ? WHERE id = ?")
          .run(T0, approvalId)
      ).toThrow(/CHECK constraint failed/);
    } finally {
      world.close();
    }
  });

  it("a CONSUMED row without a consuming execution cannot exist", () => {
    const world = createApprovalWorld("check-consumer");
    try {
      const { approvalId } = insertMinimal(world);
      world.db
        .prepare(
          "UPDATE approvals SET status = 'APPROVED', approved_by = 'user', approved_at = ? WHERE id = ?"
        )
        .run(T0, approvalId);
      expect(() =>
        world.db
          .prepare(
            "UPDATE approvals SET status = 'CONSUMED', consumed_at = ? WHERE id = ?"
          )
          .run(T0, approvalId)
      ).toThrow(/CHECK constraint failed/);
    } finally {
      world.close();
    }
  });

  it("the idempotency key is unique at the SQL level (A18 foundation)", () => {
    const world = createApprovalWorld("check-unique-key");
    try {
      insertMinimal(world, { key: "dup-key" });
      expect(() => insertMinimal(world, { key: "dup-key" })).toThrow(
        /UNIQUE constraint failed: approvals.idempotency_key/
      );
    } finally {
      world.close();
    }
  });

  it("the requester run id is foreign-key enforced", () => {
    const world = createApprovalWorld("check-fk");
    try {
      const action = sampleAction();
      expect(() =>
        world.db
          .prepare(
            "INSERT INTO approvals(id, idempotency_key, action_digest, action, status, risk_grade, requires_approval, risk_reasons, runtime, argv, cwd, repo_root, base_sha, target_sha, profile_revision, permission_increments, requested_by_run_id, requested_by_node_id, requested_by_attempt, expires_at, created_at, updated_at) " +
              "VALUES ('approval-x', 'k', 'd', ?, 'PENDING', 'low', 0, '[]', 'codex', '[]', 'c', 'r', ?, NULL, 'rev', '[]', 'run-missing', 'node-1', 1, ?, ?, ?)"
          )
          .run(
            JSON.stringify(action),
            action.repo.baseSha,
            "2099-01-01T00:00:00.000Z",
            T0,
            T0
          )
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      world.close();
    }
  });

  it("STRICT typing rejects type-mismatched writes", () => {
    const world = createApprovalWorld("check-strict");
    try {
      const { approvalId } = insertMinimal(world);
      expect(() =>
        world.db.prepare("UPDATE approvals SET requires_approval = 'yes' WHERE id = ?").run(approvalId)
      ).toThrow(/cannot store TEXT value in INTEGER column/);
    } finally {
      world.close();
    }
  });
});

/** Raw minimal insert used to exercise SQL constraints directly. */
function insertMinimal(
  world: ReturnType<typeof createApprovalWorld>,
  overrides: { readonly key?: string } = {}
): { readonly approvalId: string } {
  const action = sampleAction();
  world.db
    .prepare(
      "INSERT INTO approvals(id, idempotency_key, action_digest, action, status, risk_grade, requires_approval, risk_reasons, runtime, argv, cwd, repo_root, base_sha, target_sha, profile_revision, permission_increments, expires_at, created_at, updated_at) " +
        "VALUES ('approval-min', ?, 'digest-min', ?, 'PENDING', 'low', 0, '[]', 'codex', ?, ?, 'r', ?, NULL, 'rev', '[]', ?, ?, ?)"
    )
    .run(
      overrides.key ?? "min-key",
      JSON.stringify(action),
      JSON.stringify(action.argv),
      action.cwd,
      action.repo.baseSha,
      "2099-01-01T00:00:00.000Z",
      T0,
      T0
    );
  return { approvalId: "approval-min" };
}
