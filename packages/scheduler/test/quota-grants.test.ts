import { describe, expect, it } from "vitest";
import { withTransaction } from "@role-orchestrator/store";
import {
  GLOBAL_RESOURCE_KEY,
  DuplicateGrantError,
  QuotaFullSignal,
  acquireQuotaSlots,
  acquireQuotaSlotsInTransaction,
  countLiveQuotaGrants,
  credentialResourceKey,
  getQuotaGrant,
  listQuotaGrants,
  profileResourceKey,
  projectResourceKey,
  releaseExecutionQuotaGrants,
  releaseExpiredQuotaGrants,
  releaseQuotaGrant
} from "../src/index.js";
import {
  T0,
  createMigratedMemoryDb,
  expectError,
  iso,
  seedExecution
} from "./helpers.js";

const GLOBAL_SLOT = { dimension: "global" as const, resourceKey: GLOBAL_RESOURCE_KEY, max: 2 };

describe("acquireQuotaSlots", () => {
  it("grants all requested slots in one transaction with distinct per-key fencing tokens", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    const result = acquireQuotaSlots(db, {
      executionId: a.executionId,
      slots: [
        GLOBAL_SLOT,
        { dimension: "project", resourceKey: projectResourceKey(a.projectId), max: 1 },
        { dimension: "profile", resourceKey: profileResourceKey("claude-main"), max: 2 },
        { dimension: "credential", resourceKey: credentialResourceKey("personal"), max: 1 }
      ],
      leaseMs: 60_000,
      now: T0
    });
    expect(result.granted).toBe(true);
    if (!result.granted) return;
    expect(result.grants).toHaveLength(4);
    const byDimension = new Map(result.grants.map((grant) => [grant.dimension, grant]));
    expect(byDimension.get("global")?.fencingToken).toBe(1);
    expect(byDimension.get("project")?.resourceKey).toBe(projectResourceKey(a.projectId));
    expect(byDimension.get("credential")?.fencingToken).toBe(1);
    expect(byDimension.get("credential")?.expiresAt).toBe(iso(60_000));
    for (const grant of result.grants) {
      const stored = getQuotaGrant(db, grant.id);
      expect(stored?.releasedAt).toBeNull();
    }
  });

  it("counts live grants per key and refuses the (max+1)-th with quota-full, persisting NOTHING", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    const b = seedExecution(db, { executionId: "exec-b", nodeId: "node-2", runId: "run-2" });
    expect(
      acquireQuotaSlots(db, { executionId: a.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 }).granted
    ).toBe(true);
    expect(
      acquireQuotaSlots(db, { executionId: b.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 }).granted
    ).toBe(true);
    const c = seedExecution(db, { executionId: "exec-c", nodeId: "node-3", runId: "run-3" });
    const blocked = acquireQuotaSlots(db, {
      executionId: c.executionId,
      slots: [
        { dimension: "profile", resourceKey: profileResourceKey("other"), max: 4 },
        GLOBAL_SLOT
      ],
      leaseMs: 60_000,
      now: T0
    });
    expect(blocked).toEqual({
      granted: false,
      reason: "quota-full",
      blockedBy: {
        dimension: "global",
        resourceKey: "global",
        max: 2,
        liveCount: 2,
        expiredHeld: 0
      }
    });
    // The earlier (non-full) slot of the failed acquisition left no rows.
    expect(listQuotaGrants(db, { liveOnly: true })).toHaveLength(2);
    expect(countLiveQuotaGrants(db, { resourceKey: "profile:other", now: T0 }).total).toBe(0);
  });

  it("rejects an acquisition that names the same dimension twice", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    expectError(
      () =>
        acquireQuotaSlots(db, {
          executionId: a.executionId,
          slots: [
            { dimension: "global", resourceKey: GLOBAL_RESOURCE_KEY, max: 4 },
            { dimension: "global", resourceKey: GLOBAL_RESOURCE_KEY, max: 4 }
          ],
          leaseMs: 60_000,
          now: T0
        }),
      Error
    );
  });

  it("refuses a second grant for the same (execution, dimension) — never double-counted", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    expect(
      acquireQuotaSlots(db, { executionId: a.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 }).granted
    ).toBe(true);
    expectError(
      () =>
        acquireQuotaSlots(db, { executionId: a.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 }),
      DuplicateGrantError
    );
  });
});

describe("fencing tokens", () => {
  it("derive MAX+1 per key across releases — strictly monotonic, never reused", () => {
    const db = createMigratedMemoryDb();
    const holders = ["exec-a", "exec-b", "exec-c", "exec-d"];
    holders.forEach((executionId, index) => {
      seedExecution(db, { executionId, nodeId: `node-${index}`, runId: `run-${index}` });
    });
    const tokens: number[] = [];
    for (const executionId of holders) {
      const result = acquireQuotaSlots(db, {
        executionId,
        slots: [{ dimension: "credential", resourceKey: credentialResourceKey("personal"), max: 1 }],
        leaseMs: 60_000,
        now: T0
      });
      if (!result.granted) continue; // expected: max 1, holders beyond the first are rejected
      tokens.push(result.grants[0]?.fencingToken ?? -1);
      releaseExecutionQuotaGrants(db, { executionId, now: T0 });
    }
    // Each new grant observed the full history (including released rows).
    expect(tokens).toEqual([1, 2, 3, 4]);
  });

  it("are unique per key at the constraint level (A07 backstop)", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    acquireQuotaSlots(db, { executionId: a.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 });
    expectError(() => {
      db.prepare(
        "INSERT INTO quota_grants(id, execution_id, dimension, resource_key, fencing_token, expires_at, released_at, granted_at) " +
          "VALUES ('qg-forged', 'exec-a', 'global', 'global', 1, ?, NULL, ?)"
      ).run(iso(60_000), T0);
    }, Error);
  });

  it("signal quota-full from inside a caller transaction and roll that transaction back", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    const a2 = seedExecution(db, { executionId: "exec-a2" });
    const b = seedExecution(db, { executionId: "exec-b" });
    // Fill the global dimension to its max of 2.
    acquireQuotaSlots(db, { executionId: a.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 });
    acquireQuotaSlots(db, { executionId: a2.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 });
    expectError(() => {
      withTransaction(db, () => {
        // A sibling write in the same claim transaction (as the dispatch
        // claim would do) — must vanish together with the rolled-back grant.
        db.prepare(
          "INSERT INTO quota_grants(id, execution_id, dimension, resource_key, fencing_token, expires_at, released_at, granted_at) " +
            "VALUES ('qg-sibling', 'exec-b', 'profile', 'profile:p', 1, ?, NULL, ?)"
        ).run(iso(60_000), T0);
        acquireQuotaSlotsInTransaction(db, {
          executionId: b.executionId,
          slots: [GLOBAL_SLOT],
          leaseMs: 60_000,
          now: T0
        });
      });
    }, QuotaFullSignal);
    // Rollback left the sibling write undone too — nothing is half-claimed.
    expect(listQuotaGrants(db, { liveOnly: true })).toHaveLength(2);
    expect(getQuotaGrant(db, "qg-sibling")).toBeNull();
  });
});

describe("release paths", () => {
  it("releaseExecutionQuotaGrants frees exactly that execution's live grants", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    const b = seedExecution(db, { executionId: "exec-b", nodeId: "node-2", runId: "run-2" });
    acquireQuotaSlots(db, {
      executionId: a.executionId,
      slots: [GLOBAL_SLOT, { dimension: "profile", resourceKey: profileResourceKey("p"), max: 2 }],
      leaseMs: 60_000,
      now: T0
    });
    acquireQuotaSlots(db, {
      executionId: b.executionId,
      slots: [GLOBAL_SLOT],
      leaseMs: 60_000,
      now: T0
    });
    expect(releaseExecutionQuotaGrants(db, { executionId: a.executionId, now: iso(1_000) })).toBe(2);
    const live = countLiveQuotaGrants(db, { resourceKey: GLOBAL_RESOURCE_KEY, now: iso(1_000) });
    expect(live.total).toBe(1); // exec-b still holds the global slot
    expect(releaseExecutionQuotaGrants(db, { executionId: a.executionId, now: iso(2_000) })).toBe(0);
  });

  it("expired grants KEEP counting until releaseExpiredQuotaGrants (timeout never auto-steals)", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    const b = seedExecution(db, { executionId: "exec-b", nodeId: "node-2", runId: "run-2" });
    // exec-a holds the single slot, grant expires at T0+60s.
    acquireQuotaSlots(db, {
      executionId: a.executionId,
      slots: [{ dimension: "credential", resourceKey: credentialResourceKey("personal"), max: 1 }],
      leaseMs: 60_000,
      now: T0
    });
    const after = iso(120_000);
    // Expired but unreleased: still occupies the slot, and the refusal says so.
    const blocked = acquireQuotaSlots(db, {
      executionId: b.executionId,
      slots: [{ dimension: "credential", resourceKey: credentialResourceKey("personal"), max: 1 }],
      leaseMs: 60_000,
      now: after
    });
    expect(blocked.granted).toBe(false);
    if (!blocked.granted) {
      expect(blocked.blockedBy.expiredHeld).toBe(1);
      expect(blocked.blockedBy.liveCount).toBe(1);
    }
    // Explicit reconcile frees it; the queue can then proceed.
    expect(releaseExpiredQuotaGrants(db, { now: after })).toBe(1);
    expect(
      acquireQuotaSlots(db, {
        executionId: b.executionId,
        slots: [{ dimension: "credential", resourceKey: credentialResourceKey("personal"), max: 1 }],
        leaseMs: 60_000,
        now: after
      }).granted
    ).toBe(true);
  });

  it("releaseQuotaGrant returns false for absent or already-released grants", () => {
    const db = createMigratedMemoryDb();
    const a = seedExecution(db, { executionId: "exec-a" });
    const result = acquireQuotaSlots(db, { executionId: a.executionId, slots: [GLOBAL_SLOT], leaseMs: 60_000, now: T0 });
    if (!result.granted) throw new Error("expected grant");
    const grantId = result.grants[0]?.id ?? "";
    expect(releaseQuotaGrant(db, { id: grantId, now: iso(1_000) })).toBe(true);
    expect(releaseQuotaGrant(db, { id: grantId, now: iso(2_000) })).toBe(false);
    expect(releaseQuotaGrant(db, { id: "qg-does-not-exist", now: iso(2_000) })).toBe(false);
  });
});
