import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  claimOutboxMessages,
  completeOutboxMessage,
  countOutboxMessages,
  createProject,
  enqueueOutboxMessage,
  getOutboxMessage,
  listPendingOutboxMessages,
  releaseOutboxClaim,
  withTransaction
} from "../src/index.js";
import { T0, createMigratedMemoryDb, iso } from "./helpers.js";

describe("outbox atomicity", () => {
  it("rolls the outbox back together with the business write", () => {
    const db = createMigratedMemoryDb();
    expect(() =>
      withTransaction(db, () => {
        createProject(db, {
          id: "proj-1",
          repoRoot: "h:/repos/proj-1",
          executionTarget: "windows-native",
          trustStatus: "requires-user-confirmation",
          now: T0
        });
        enqueueOutboxMessage(db, {
          id: "msg-1",
          aggregateId: "proj-1",
          type: "project.created",
          payload: { repoRoot: "h:/repos/proj-1" },
          now: T0
        });
        throw new Error("business rule failed after both writes");
      })
    ).toThrowError(/business rule failed/);

    // No residue: neither the project nor the outbox message survived.
    expect(countOutboxMessages(db, { pendingOnly: false })).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(0);
  });

  it("commits the outbox entry atomically with the business write", () => {
    const db = createMigratedMemoryDb();
    withTransaction(db, () => {
      createProject(db, {
        id: "proj-1",
        repoRoot: "h:/repos/proj-1",
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });
      enqueueOutboxMessage(db, {
        id: "msg-1",
        aggregateId: "proj-1",
        type: "project.created",
        payload: { repoRoot: "h:/repos/proj-1" },
        now: T0
      });
    });
    expect(countOutboxMessages(db, { pendingOnly: true })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(1);
  });
});

describe("outbox dispatch (lease semantics)", () => {
  it("absorbs duplicate message ids for idempotent producers", () => {
    const db = createMigratedMemoryDb();
    const input = {
      id: "msg-1",
      aggregateId: "proj-1",
      type: "project.created",
      payload: { repoRoot: "h:/repos/proj-1" },
      now: T0
    };
    expect(enqueueOutboxMessage(db, input)).toBe("stored");
    expect(enqueueOutboxMessage(db, input)).toBe("duplicate");
    expect(countOutboxMessages(db, { pendingOnly: false })).toBe(1);
  });

  it("claims in FIFO order up to the limit and tracks attempt counts", () => {
    const db = createMigratedMemoryDb();
    for (let i = 1; i <= 3; i++) {
      enqueueOutboxMessage(db, {
        id: `msg-${i}`,
        aggregateId: "agg-1",
        type: "test.message",
        payload: { index: i },
        now: iso(i * 1_000)
      });
    }
    const claimed = claimOutboxMessages(db, { claimToken: "tok-1", now: iso(10_000), leaseMs: 60_000, limit: 2 });
    expect(claimed.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
    expect(claimed.every((message) => message.attempts === 1)).toBe(true);
    expect(claimed[0]?.claimToken).toBe("tok-1");

    // Completing with the wrong token fails; the right token publishes.
    expect(completeOutboxMessage(db, { id: "msg-1", claimToken: "tok-other", now: iso(11_000) })).toBe(false);
    expect(completeOutboxMessage(db, { id: "msg-1", claimToken: "tok-1", now: iso(11_000) })).toBe(true);
    expect(getOutboxMessage(db, "msg-1")?.publishedAt).toBe(iso(11_000));
    expect(getOutboxMessage(db, "msg-1")?.claimToken).toBeNull();
  });

  it("reclaims messages after the claim lease expires and never double-publishes", () => {
    const db = createMigratedMemoryDb();
    enqueueOutboxMessage(db, {
      id: "msg-1",
      aggregateId: "agg-1",
      type: "test.message",
      payload: {},
      now: T0
    });

    const first = claimOutboxMessages(db, { claimToken: "tok-a", now: T0, leaseMs: 100 });
    expect(first).toHaveLength(1);

    // Still leased: a second dispatcher gets nothing.
    expect(claimOutboxMessages(db, { claimToken: "tok-b", now: iso(50), leaseMs: 60_000 })).toHaveLength(0);

    // Lease expired: the message becomes claimable again (at-least-once).
    const second = claimOutboxMessages(db, { claimToken: "tok-b", now: iso(200), leaseMs: 60_000 });
    expect(second.map((message) => message.id)).toEqual(["msg-1"]);
    expect(second[0]?.attempts).toBe(2);

    // The zombie dispatcher with the expired token cannot mask redelivery.
    expect(completeOutboxMessage(db, { id: "msg-1", claimToken: "tok-a", now: iso(300) })).toBe(false);
    expect(completeOutboxMessage(db, { id: "msg-1", claimToken: "tok-b", now: iso(300) })).toBe(true);
    expect(listPendingOutboxMessages(db)).toHaveLength(0);
  });

  it("releaseOutboxClaim returns a message to the pending queue immediately", () => {
    const db = createMigratedMemoryDb();
    enqueueOutboxMessage(db, {
      id: "msg-1",
      aggregateId: "agg-1",
      type: "test.message",
      payload: {},
      now: T0
    });
    claimOutboxMessages(db, { claimToken: "tok-a", now: T0, leaseMs: 60_000 });
    expect(releaseOutboxClaim(db, { id: "msg-1", claimToken: "tok-wrong" })).toBe(false);
    expect(releaseOutboxClaim(db, { id: "msg-1", claimToken: "tok-a" })).toBe(true);
    expect(listPendingOutboxMessages(db)).toHaveLength(1);
    expect(getOutboxMessage(db, "msg-1")?.attempts).toBe(1);
  });
});

describe("outbox input validation", () => {
  it("rejects unknown fields and non-object payloads", () => {
    const db = createMigratedMemoryDb();
    expect(() =>
      enqueueOutboxMessage(db, {
        id: "msg-x",
        aggregateId: "agg-1",
        type: "test.message",
        payload: {},
        now: T0,
        unexpectedField: true
      } as never)
    ).toThrowError(z.ZodError);
    expect(() =>
      enqueueOutboxMessage(db, {
        id: "msg-y",
        aggregateId: "agg-1",
        type: "test.message",
        payload: ["not", "an", "object"] as unknown as Record<string, never>,
        now: T0
      })
    ).toThrowError(z.ZodError);
  });
});
