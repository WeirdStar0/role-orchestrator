/**
 * M5-04 — the live execution-event WebSocket subscription (A39) over a REAL
 * `startLocalApiServer` socket:
 * - upgrade refusals carry the SAME guard semantics as HTTP (A30 continuity);
 * - first-message auth: no/wrong token closes the socket (never a silent open
 *   stream), a Bearer header at upgrade works for non-browser clients;
 * - cursor replay from `afterSeq` OR `afterEventId`, at-least-once delivery
 *   deduped by eventId across reconnects — the "断线 → 期间产生事件 → 重连
 *   cursor 重放 → 无丢失无重复" regression, INCLUDING the terminal events
 *   (result/process exit) plus the `execution-terminal` notice;
 * - live tailing of events appended while subscribed;
 * - the A36 egress redaction applies to stream frames too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvent, createActiveAttempt, setAttemptPhase } from "@role-orchestrator/store";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { T0, createTestDb, rawSocketRequest, seedHostileEvents, seedMatrixData } from "./helpers.js";
import { LiveClient } from "./ws-helpers.js";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createTestDb>;

beforeAll(async () => {
  dbHandle = createTestDb("ws-replay");
  seedMatrixData(dbHandle.db);
  seedHostileEvents(dbHandle.db, "exec-1");
  server = await startLocalApiServer({
    db: dbHandle.db,
    tokenFile: undefined,
    eventStream: { pollIntervalMs: 15, pingIntervalMs: 0, authTimeoutMs: 800 }
  });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

function upgradeRequest(port: number, headers: Record<string, string>): string {
  const lines = [
    "GET /api/v1/events/live HTTP/1.1",
    `Host: ${headers.host ?? `127.0.0.1:${String(port)}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers)
      .filter(([name]) => name !== "host")
      .map(([name, value]) => `${name}: ${value}`),
    "\r\n"
  ];
  return lines.join("\r\n");
}

async function openAuthed(executionId: string, cursor: { afterSeq?: number; afterEventId?: string } = {}): Promise<LiveClient> {
  const client = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
  await client.open();
  client.subscribe(executionId, cursor);
  return client;
}

describe("upgrade guards (A30 continuity on the WS endpoint)", () => {
  it("refuses a DNS-rebinding Host with 400 HOST_NOT_ALLOWED on the upgrading socket", async () => {
    const response = await rawSocketRequest(server.port, upgradeRequest(server.port, { host: `attacker.example:${String(server.port)}` }));
    expect(response.status).toBe(400);
    expect(response.body).toContain("HOST_NOT_ALLOWED");
  });

  it("refuses a cross-site Origin with 403 ORIGIN_NOT_ALLOWED", async () => {
    const response = await rawSocketRequest(server.port, upgradeRequest(server.port, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(response.body).toContain("ORIGIN_NOT_ALLOWED");
  });

  it("refuses query parameters (tokens never travel in URLs)", async () => {
    const response = await rawSocketRequest(
      server.port,
      `GET /api/v1/events/live?token=${encodeURIComponent(server.token)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${String(server.port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    expect(response.status).toBe(400);
    expect(response.body).toContain("INPUT_REJECTED");
    expect(response.body).not.toContain(server.token);
  });

  it("refuses a WRONG bearer header at upgrade with 403", async () => {
    const response = await rawSocketRequest(
      server.port,
      upgradeRequest(server.port, { authorization: `Bearer ${"A".repeat(43)}` })
    );
    expect(response.status).toBe(403);
    expect(response.body).toContain("TOKEN_INVALID");
  });

  it("refuses unknown WS paths with 404", async () => {
    const response = await rawSocketRequest(
      server.port,
      `GET /api/v1/other/live HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    expect(response.status).toBe(404);
  });
});

describe("first-message auth", () => {
  it("closes with 4001 when no auth frame arrives in time", async () => {
    const client = new LiveClient(server.port);
    await client.open();
    const closed = await client.waitUntilClosed(5_000);
    expect(closed.code).toBe(4001);
  }, 10_000);

  it("closes with 4002 on a wrong token", async () => {
    const client = new LiveClient(server.port);
    await client.open();
    client.auth("A".repeat(43));
    const closed = await client.waitUntilClosed(5_000);
    expect(closed.code).toBe(4002);
  }, 10_000);

  it("closes with 4003 when the first frame is a subscribe instead of auth", async () => {
    const client = new LiveClient(server.port);
    await client.open();
    client.subscribe("exec-1");
    const closed = await client.waitUntilClosed(5_000);
    expect(closed.code).toBe(4003);
  }, 10_000);

  it("accepts a correct first-message auth and then the subscribe", async () => {
    const client = new LiveClient(server.port);
    await client.open();
    client.auth(server.token);
    client.subscribe("exec-1", { afterSeq: 4 });
    const ready = await client.waitFor((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", executionId: "exec-1", cursor: 4, phase: "RUNNING" });
    const events = await client.collectEventFrames(1);
    expect(events[0]?.type === "event" && events[0].event.seq).toBe(5);
    client.close();
  });
});

describe("cursor replay and dedup (A39)", () => {
  it("replays from 0 in seq order with redacted envelopes, then catchup", async () => {
    const client = await openAuthed("exec-1", { afterSeq: 0 });
    const ready = await client.waitFor((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", executionId: "exec-1", cursor: 0, phase: "RUNNING" });
    const events = await client.collectEventFrames(5);
    const seqs = events.map((frame) => (frame.type === "event" ? frame.event.seq : -1));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    const catchup = await client.waitFor((frame) => frame.type === "catchup");
    expect(catchup).toEqual({ type: "catchup", cursor: 5 });
    // Envelope shape + A36 egress redaction on the stream.
    const second = events[1];
    if (second?.type !== "event") throw new Error("expected event frame");
    expect(second.event).toMatchObject({ schemaVersion: 1, projectId: "proj-1", runId: "run-1", executionId: "exec-1" });
    // The eventId is the store row id — the cli-events sha256(executionId +
    // line) derivation on the engine path; the client dedups on exactly it.
    expect(second.event.eventId).toBe("evt-matrix-2");
    expect(JSON.stringify(second.event.payload)).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(second.event.payload)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    client.close();
  });

  it("resolves an afterEventId cursor to its stored seq", async () => {
    const client = await openAuthed("exec-1", { afterEventId: "evt-matrix-3" });
    const ready = await client.waitFor((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", cursor: 3 });
    const events = await client.collectEventFrames(2);
    expect(events.map((frame) => (frame.type === "event" ? frame.event.eventId : ""))).toEqual([
      "evt-matrix-4",
      "evt-matrix-5"
    ]);
    client.close();
  });

  it("does not lose or duplicate events across a disconnect — terminal events included", async () => {
    // Session 1: receive the first two events, then "crash".
    const first = await openAuthed("exec-1", { afterSeq: 0 });
    await first.collectEventFrames(2);
    first.terminate();

    // While disconnected, the daemon produces more events AND the terminal
    // ones, then the execution reaches a terminal phase.
    const late: ReadonlyArray<{ readonly seq: number; readonly type: string; readonly payload: Record<string, unknown> }> = [
      { seq: 6, type: "diagnostic", payload: { summary: "late while offline" } },
      { seq: 7, type: "diagnostic", payload: { summary: "late two" } },
      { seq: 8, type: "diagnostic", payload: { summary: "late three" } },
      { seq: 9, type: "message_delta", payload: { text: "model output chunk" } },
      { seq: 10, type: "result_reported", payload: { subtype: "success", isError: false } },
      { seq: 11, type: "process_exited", payload: { exitCode: 0, signal: null } }
    ];
    for (const event of late) {
      const result = appendEvent(dbHandle.db, {
        id: `evt-matrix-${String(event.seq)}`,
        executionId: "exec-1",
        seq: event.seq,
        type: event.type,
        payload: event.payload as never,
        occurredAt: T0
      });
      expect(result).toBe("stored");
    }
    setAttemptPhase(dbHandle.db, { id: "exec-1", phase: "FAILED", wherePhaseIn: ["RUNNING"], now: T0 });

    // Session 2: reconnect from the LAST EVENT seen before the crash.
    const second = await openAuthed("exec-1", { afterEventId: "evt-matrix-2" });
    const replayed = await second.collectEventFrames(9);
    const terminal = await second.waitFor((frame) => frame.type === "execution-terminal");
    expect(terminal).toEqual({ type: "execution-terminal", phase: "FAILED" });

    // No loss: the replayed ids are exactly the events 3..11 (9 events).
    const replayedIds = replayed.map((frame) => (frame.type === "event" ? frame.event.eventId : ""));
    const expectedIds = Array.from({ length: 9 }, (_, index) => `evt-matrix-${String(index + 3)}`);
    expect(replayedIds).toEqual(expectedIds);
    // The terminal EVENTS are in the replay (断线不丢终态).
    expect(replayedIds).toContain("evt-matrix-10");
    expect(replayedIds).toContain("evt-matrix-11");

    // No duplication across the two sessions (client-side eventId dedup).
    const allIds = [
      "evt-matrix-1",
      "evt-matrix-2",
      ...replayedIds
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toHaveLength(11);
    second.close();
  });

  it("tails events appended while subscribed", async () => {
    const client = await openAuthed("exec-1", { afterSeq: 11 });
    await client.waitFor((frame) => frame.type === "catchup");
    appendEvent(dbHandle.db, {
      id: "evt-matrix-12",
      executionId: "exec-1",
      seq: 12,
      type: "diagnostic",
      payload: { summary: "live tail" },
      occurredAt: T0
    });
    const live = await client.waitFor((frame) => frame.type === "event" && frame.event.seq === 12, 5_000);
    expect(live.type === "event" && live.event.eventId).toBe("evt-matrix-12");
    client.close();
  });

  it("notifies terminal for a subscription opened on an already-terminal execution", async () => {
    const client = await openAuthed("exec-1", { afterSeq: 12 });
    await client.waitFor((frame) => frame.type === "catchup");
    const terminal = await client.waitFor((frame) => frame.type === "execution-terminal");
    expect(terminal).toEqual({ type: "execution-terminal", phase: "FAILED" });
    client.close();
  });
});

describe("cursor and execution errors", () => {
  it("closes 4004 for an unknown execution", async () => {
    const client = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await client.open();
    client.subscribe("exec-missing");
    const error = await client.waitFor((frame) => frame.type === "error");
    expect(error).toMatchObject({ type: "error", code: "NOT_FOUND" });
    const closed = await client.waitUntilClosed();
    expect(closed.code).toBe(4004);
  });

  it("closes 4004 when the cursor eventId is unknown or from another execution", async () => {
    // A second execution whose event id must not be usable as exec-1 cursor.
    createActiveAttempt(dbHandle.db, {
      id: "exec-2",
      runId: "run-1",
      nodeId: "node-2",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: "dt-exec-2",
      phase: "RUNNING",
      now: T0
    });
    appendEvent(dbHandle.db, {
      id: "evt-exec2-1",
      executionId: "exec-2",
      seq: 1,
      type: "diagnostic",
      payload: { summary: "other execution" },
      occurredAt: T0
    });
    appendEvent(dbHandle.db, {
      id: "evt-matrix-13",
      executionId: "exec-1",
      seq: 13,
      type: "diagnostic",
      payload: { summary: "one more" },
      occurredAt: T0
    });
    const unknownId = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await unknownId.open();
    unknownId.subscribe("exec-1", { afterEventId: "evt-not-in-this-execution" });
    const unknownError = await unknownId.waitFor((frame) => frame.type === "error");
    expect(unknownError).toMatchObject({ type: "error", code: "CURSOR_NOT_FOUND" });
    expect((await unknownId.waitUntilClosed()).code).toBe(4004);

    const foreignId = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await foreignId.open();
    foreignId.subscribe("exec-1", { afterEventId: "evt-exec2-1" });
    const foreignError = await foreignId.waitFor((frame) => frame.type === "error");
    expect(foreignError).toMatchObject({ type: "error", code: "CURSOR_NOT_FOUND" });
    expect((await foreignId.waitUntilClosed()).code).toBe(4004);
  });

  it("closes 4003 on a second subscribe (one subscription per connection)", async () => {
    const client = await openAuthed("exec-1", { afterSeq: 13 });
    await client.waitFor((frame) => frame.type === "ready");
    client.subscribe("exec-1", { afterSeq: 0 });
    const closed = await client.waitUntilClosed();
    expect(closed.code).toBe(4003);
  });
});
