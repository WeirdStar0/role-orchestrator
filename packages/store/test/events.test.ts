import { describe, expect, it } from "vitest";
import {
  appendEvent,
  eventChecksum,
  getEvent,
  listEventPageForExecution,
  listEventsForExecution,
  parseJsonRecord,
  verifyEventChecksums
} from "../src/index.js";
import { T0, createMigratedMemoryDb, seedExecution } from "./helpers.js";

describe("durable events: replay idempotency and per-execution seq uniqueness", () => {
  it("stores an event with a verifiable checksum and round-trips the payload", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    const payload = { exitCode: 0, summary: "tests green" };
    const result = appendEvent(db, {
      id: "evt-1",
      executionId,
      seq: 0,
      type: "process_exited",
      payload,
      occurredAt: T0
    });
    expect(result).toBe("stored");

    const stored = getEvent(db, "evt-1");
    expect(stored?.executionId).toBe(executionId);
    expect(stored?.seq).toBe(0);
    expect(parseJsonRecord(stored?.payload ?? "", "events")).toEqual(payload);
    expect(stored?.checksum).toBe(eventChecksum(executionId, 0, "process_exited", stored?.payload ?? ""));
    expect(verifyEventChecksums(db)).toEqual([]);
  });

  it("replaying the same eventId produces no duplicate row", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    const event = {
      id: "evt-1",
      executionId,
      seq: 0,
      type: "process_exited",
      payload: { exitCode: 0 },
      occurredAt: T0
    };
    expect(appendEvent(db, event)).toBe("stored");
    expect(appendEvent(db, event)).toBe("duplicate");
    expect(appendEvent(db, event)).toBe("duplicate");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(1);
  });

  it("rejects a different eventId reusing an (execution, seq) pair", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    appendEvent(db, { id: "evt-1", executionId, seq: 3, type: "message_delta", payload: {}, occurredAt: T0 });
    expect(() =>
      appendEvent(db, { id: "evt-2", executionId, seq: 3, type: "message_delta", payload: {}, occurredAt: T0 })
    ).toThrowError(/UNIQUE constraint failed: events\.execution_id, events\.seq/);
  });

  it("keeps seq per-execution: same seq on different executions is fine", () => {
    const db = createMigratedMemoryDb();
    const first = seedExecution(db);
    const second = seedExecution(db, {
      projectId: "proj-2",
      runId: "run-2",
      executionId: "exec-2",
      nodeId: "node-2"
    });
    appendEvent(db, { id: "evt-a", executionId: first.executionId, seq: 0, type: "started", payload: {}, occurredAt: T0 });
    appendEvent(db, { id: "evt-b", executionId: second.executionId, seq: 0, type: "started", payload: {}, occurredAt: T0 });
    expect(listEventsForExecution(db, first.executionId).map((event) => event.id)).toEqual(["evt-a"]);
    expect(listEventsForExecution(db, second.executionId).map((event) => event.id)).toEqual(["evt-b"]);
  });

  it("events reference existing executions (foreign key on)", () => {
    const db = createMigratedMemoryDb();
    expect(() =>
      appendEvent(db, { id: "evt-x", executionId: "missing-exec", seq: 0, type: "started", payload: {}, occurredAt: T0 })
    ).toThrowError(/FOREIGN KEY constraint failed/);
  });

  it("flags tampered payloads via checksum verification", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    appendEvent(db, { id: "evt-1", executionId, seq: 0, type: "started", payload: { a: 1 }, occurredAt: T0 });
    db.prepare("UPDATE events SET payload = '{\"a\":2}' WHERE id = 'evt-1'").run();
    expect(verifyEventChecksums(db)).toEqual(["evt-1"]);
  });

  it("validates inputs: negative seq and non-object payloads are rejected", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    expect(() =>
      appendEvent(db, { id: "evt-neg", executionId, seq: -1, type: "started", payload: {}, occurredAt: T0 })
    ).toThrowError();
    expect(() =>
      appendEvent(db, {
        id: "evt-arr",
        executionId,
        seq: 0,
        type: "started",
        payload: "not-an-object" as never,
        occurredAt: T0
      })
    ).toThrowError();
  });
});

describe("listEventPageForExecution: the M5-04 memory-bounded replay page", () => {
  it("pages by cursor with hasMore, in seq order, without crossing executions", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    for (let seq = 1; seq <= 5; seq += 1) {
      appendEvent(db, {
        id: `evt-p${String(seq)}`,
        executionId,
        seq,
        type: "diagnostic",
        payload: { n: seq },
        occurredAt: T0
      });
    }
    const page1 = listEventPageForExecution(db, { executionId, afterSeq: 0, limit: 2, byteBudget: 1024 });
    expect(page1.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(page1.hasMore).toBe(true);
    const page2 = listEventPageForExecution(db, { executionId, afterSeq: 2, limit: 2, byteBudget: 1024 });
    expect(page2.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(page2.hasMore).toBe(true);
    const page3 = listEventPageForExecution(db, { executionId, afterSeq: 4, limit: 2, byteBudget: 1024 });
    expect(page3.events.map((event) => event.seq)).toEqual([5]);
    expect(page3.hasMore).toBe(false);
    // Past the tail: empty page, no more.
    const page4 = listEventPageForExecution(db, { executionId, afterSeq: 5, limit: 2, byteBudget: 1024 });
    expect(page4.events).toEqual([]);
    expect(page4.hasMore).toBe(false);
  });

  it("caps a page by the byte budget and still always returns progress", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    const big = "x".repeat(600);
    for (let seq = 1; seq <= 5; seq += 1) {
      appendEvent(db, {
        id: `evt-b${String(seq)}`,
        executionId,
        seq,
        type: "diagnostic",
        payload: { blob: big },
        occurredAt: T0
      });
    }
    // Serialized payload is {"blob":"<600 x>} = 611 bytes; a 1300-byte budget
    // fits exactly two rows and stops before the third.
    const page = listEventPageForExecution(db, { executionId, afterSeq: 0, limit: 100, byteBudget: 1300 });
    expect(page.events).toHaveLength(2);
    expect(page.approxPayloadBytes).toBe(1222);
    expect(page.hasMore).toBe(true);
    // A budget SMALLER than one payload still returns the first row (progress).
    const single = listEventPageForExecution(db, { executionId, afterSeq: 0, limit: 100, byteBudget: 1 });
    expect(single.events).toHaveLength(1);
    expect(single.events[0]?.seq).toBe(1);
    expect(single.hasMore).toBe(true);
  });

  it("respects the count limit and rejects invalid input (strict)", () => {
    const db = createMigratedMemoryDb();
    const { executionId } = seedExecution(db);
    for (let seq = 1; seq <= 4; seq += 1) {
      appendEvent(db, {
        id: `evt-c${String(seq)}`,
        executionId,
        seq,
        type: "diagnostic",
        payload: { n: seq },
        occurredAt: T0
      });
    }
    const page = listEventPageForExecution(db, { executionId, afterSeq: 0, limit: 3, byteBudget: 1 << 20 });
    expect(page.events).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(() =>
      listEventPageForExecution(db, {
        executionId,
        afterSeq: 0,
        limit: 3,
        byteBudget: 1024,
        extra: true
      } as never)
    ).toThrowError();
    expect(() =>
      listEventPageForExecution(db, { executionId, afterSeq: -1, limit: 3, byteBudget: 1024 })
    ).toThrowError();
  });
});
