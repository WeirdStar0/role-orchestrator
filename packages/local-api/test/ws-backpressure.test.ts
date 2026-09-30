/**
 * M5-04 — long-log backpressure: a 64 MiB-scale synthetic event log must be
 * streamable through the live subscription WITHOUT the daemon buffering it
 * unboundedly, and WITHOUT losing a single event.
 *
 * Mechanism under test (ws-events.ts): replay pages come from
 * `listEventPageForExecution` (≤ pageLimitEvents rows AND ≤ pageByteBudget
 * payload bytes per page — one page in memory at a time), and the pump only
 * fetches the next page once the socket's `bufferedAmount` has drained below
 * `highWaterBytes`. A PAUSED reader therefore pins the outbound queue at the
 * high-water mark (plus at most one page) instead of growing it to the log
 * size — asserted here through the server's own observability handle while
 * the client socket is stopped. After the reader resumes, ALL events arrive
 * exactly once, in seq order, and the stream finishes with `catchup`.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvent } from "@role-orchestrator/store";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { T0, createTestDb, seedMatrixData } from "./helpers.js";
import { LiveClient, waitForCondition } from "./ws-helpers.js";

const EVENT_COUNT = 16_384;
const PAYLOAD_BYTES_PER_EVENT = 4_000; // ≈ 4_022 serialized → ~64 MiB total
const PAGE_BYTE_BUDGET = 65_536; // 64 KiB payload per page
const HIGH_WATER_BYTES = 262_144; // 256 KiB outbound queue cap

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createTestDb>;

beforeAll(async () => {
  dbHandle = createTestDb("ws-backpressure");
  seedMatrixData(dbHandle.db);
  const blob = "x".repeat(PAYLOAD_BYTES_PER_EVENT);
  dbHandle.db.exec("BEGIN");
  try {
    for (let seq = 1; seq <= EVENT_COUNT; seq += 1) {
      const result = appendEvent(dbHandle.db, {
        id: `evt-big-${String(seq)}`,
        executionId: "exec-1",
        seq,
        type: "diagnostic",
        payload: { blob, n: seq },
        occurredAt: T0
      });
      if (result !== "stored") throw new Error(`seed: event ${String(seq)} not stored`);
    }
    dbHandle.db.exec("COMMIT");
  } catch (error) {
    dbHandle.db.exec("ROLLBACK");
    throw error;
  }
  server = await startLocalApiServer({
    db: dbHandle.db,
    tokenFile: undefined,
    eventStream: {
      pollIntervalMs: 10,
      pingIntervalMs: 0,
      pageLimitEvents: 200,
      pageByteBudget: PAGE_BYTE_BUDGET,
      highWaterBytes: HIGH_WATER_BYTES
    }
  });
}, 240_000);

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
  // The 64 MiB fixture DB lives in its own temp dir; clean it up.
  if (dbHandle !== undefined) rmSync(dirname(dbHandle.dbPath), { recursive: true, force: true });
  // 60 s hook budget (vitest default is 10 s): closing a server whose socket
  // carries a 64 MiB-scale flood can exceed the default under a starved
  // parallel run — observed 2026-09-30 as a cascade failure when the first
  // test aborted before client.close() and this hook absorbed the teardown.
}, 60_000);

describe("64 MiB-scale replay through a bounded buffer", () => {
  it("pins the outbound queue at the high-water mark for a paused reader, then delivers everything exactly once", async () => {
    const client = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await client.open();
    client.subscribe("exec-1", { afterSeq: 0 });
    const ready = await client.waitFor((frame) => frame.type === "ready", 10_000);
    expect(ready).toMatchObject({ type: "ready", executionId: "exec-1", cursor: 0 });

    // Let the first page arrive, then STOP READING (a stuck consumer).
    await client.waitFor((frame) => frame.type === "event", 10_000);
    client.pauseSocket();

    // Sample the daemon-side outbound queue while the reader is stuck.
    // Exit on SAMPLE COUNT (≥40) bounded by a generous deadline, not on wall
    // time alone: the 10 ms sleep between samples stretches under a full
    // turbo parallel run (measured ~37 ms/iteration at worst, 2026-09-30),
    // so a pure 600 ms window yielded only 16 samples and failed the ≥20
    // density assertion below while the queue bound itself held (M8-06
    // 返修 1). The paused reader keeps the queue pinned at the high-water
    // mark indefinitely, so sampling longer observes the SAME property —
    // assertions below are unchanged.
    const samples: number[] = [];
    const sampleUntil = Date.now() + 2_000;
    while (Date.now() < sampleUntil && samples.length < 40) {
      for (const bytes of server.eventStream.connectionBufferedBytes()) {
        samples.push(bytes);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const maxQueued = samples.reduce((max, bytes) => Math.max(max, bytes), 0);
    // The queue may exceed the high-water mark by AT MOST one page plus frame
    // overhead — never by the remaining log size (tens of MiB).
    const bound = HIGH_WATER_BYTES + PAGE_BYTE_BUDGET + 65_536;
    expect(samples.length).toBeGreaterThanOrEqual(20);
    expect(maxQueued).toBeGreaterThan(0); // flow actually happened
    expect(maxQueued).toBeLessThanOrEqual(bound);

    // Resume; the whole 64 MiB log must arrive, exactly once, in order.
    client.resumeSocket();
    await client.waitFor((frame) => frame.type === "catchup", 240_000);

    const events = client.received.filter((frame) => frame.type === "event");
    expect(events).toHaveLength(EVENT_COUNT);
    const seenIds = new Set<string>();
    let previousSeq = 0;
    let payloadBytes = 0;
    for (const frame of events) {
      if (frame.type !== "event") throw new Error("unreachable");
      seenIds.add(frame.event.eventId);
      expect(frame.event.seq).toBe(previousSeq + 1);
      previousSeq = frame.event.seq;
      payloadBytes += JSON.stringify(frame.event.payload).length;
    }
    expect(seenIds.size).toBe(EVENT_COUNT);
    expect(payloadBytes).toBeGreaterThanOrEqual(EVENT_COUNT * PAYLOAD_BYTES_PER_EVENT);
    const catchup = client.received.find((frame) => frame.type === "catchup");
    expect(catchup).toEqual({ type: "catchup", cursor: EVENT_COUNT });
    // Still terminal-less (execution stays RUNNING here); no terminal frame.
    expect(client.received.some((frame) => frame.type === "execution-terminal")).toBe(false);
    client.close();
  }, 300_000);

  it("keeps connection accounting honest (opens and closes are observed)", async () => {
    // The previous test's client may still be tearing down; start from a
    // quiescent server.
    await waitForCondition(() => server.eventStream.connectionCount() === 0, {
      timeoutMs: 15_000,
      message: "server should be quiescent before the test"
    });
    const client = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await client.open();
    // Subscribe PAST the stream tail so this test measures connection
    // accounting without competing with the 64 MiB replay flood (which, on a
    // CPU-starved parallel run, would delay the close handshake).
    client.subscribe("exec-1", { afterSeq: EVENT_COUNT });
    await client.waitFor((frame) => frame.type === "catchup", 10_000);
    await waitForCondition(() => server.eventStream.connectionCount() === 1, {
      timeoutMs: 15_000,
      message: "connection count should be 1 while subscribed"
    });
    client.close();
    await waitForCondition(() => server.eventStream.connectionCount() === 0, {
      timeoutMs: 15_000,
      message: "connection count should return to 0 after close"
    });
  }, 60_000);
});
