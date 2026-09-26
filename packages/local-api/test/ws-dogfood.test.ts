/**
 * M5-04 end-to-end dogfood: a REAL execution runs through
 * @role-orchestrator/engine against the BUILT fake-cli dist bin (never a real
 * claude/codex), its protocol events land in the store, and the live
 * WebSocket subscription replays the ENTIRE stream from cursor 0 with zero
 * loss, zero duplicates, and the terminal events (`result_reported`,
 * `process_exited`, `lifecycle_outcome`) delivered — plus an
 * `execution-terminal` notice once caught up. A second connection resuming
 * from the LAST eventId receives an empty replay (pure catchup + terminal),
 * proving the cursor edge after full delivery.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { startExecution } from "@role-orchestrator/engine";
import { listEventsForExecution } from "@role-orchestrator/store";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { T0, createTestDb, makeWorkDir, seedFakeCliRun } from "./helpers.js";
import { LiveClient } from "./ws-helpers.js";

/**
 * The cells below execute through the engine launcher, which is implemented
 * for the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError); they are therefore win32-gated.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[local-api] non-Windows platform — launcher-driven cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


let server: LocalApiServer;
let closeDb: () => void;
let db: DatabaseSync;
let executionId: string;

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  const handle = createTestDb("ws-dogfood");
  closeDb = handle.close;
  db = handle.db;
  const seeded = await seedFakeCliRun(handle.db, { dialect: "claude" });
  executionId = "exec-node-1";
  const run = startExecution(handle.db, {
    executionId,
    runId: seeded.runId,
    roleId: "developer",
    nodeId: "node-1",
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: "dt-ws-dogfood-1",
    cwd: makeWorkDir("ws-dogfood"),
    prompt: "synthetic task prompt (ws live dogfood)",
    invocationArgs: ["--scenario", "success"],
    timeoutSeconds: 120,
    now: T0
  });
  const result = await run.result;
  if (result.finalPhase !== "SUCCEEDED") {
    throw new Error(`ws dogfood run did not succeed: ${JSON.stringify(result.reasons)}`);
  }
  server = await startLocalApiServer({
    db: handle.db,
    tokenFile: undefined,
    eventStream: { pollIntervalMs: 10, pingIntervalMs: 0 }
  });
}, 60_000);

afterAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  await server?.close();
  closeDb?.();
});

describe.skipIf(!LAUNCHER_APPLIES)("live subscription over a real fake-cli execution (cursor 0 replay)", () => {
  it("replays every stored event exactly once, terminal events included, then notifies terminal", async () => {
    const stored = listEventsForExecution(db, executionId);
    expect(stored.length).toBeGreaterThanOrEqual(3);

    const client = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await client.open();
    client.subscribe(executionId, { afterSeq: 0 });
    const ready = await client.waitFor((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", executionId, cursor: 0, phase: "SUCCEEDED" });

    await client.waitFor((frame) => frame.type === "catchup", 15_000);
    const events = client.received.filter((frame) => frame.type === "event");

    // Zero loss: the replayed ids equal the store's rows exactly (order too).
    const replayedIds = events.map((frame) => (frame.type === "event" ? frame.event.eventId : ""));
    expect(replayedIds).toEqual(stored.map((event) => event.id));
    // Zero duplication.
    expect(new Set(replayedIds).size).toBe(replayedIds.length);

    // Terminal evidence from the real stream is present.
    const types = new Set(events.map((frame) => (frame.type === "event" ? frame.event.type : "")));
    expect(types.has("started")).toBe(true);
    expect(types.has("result_reported")).toBe(true);
    expect(types.has("process_exited")).toBe(true);
    expect(types.has("lifecycle_outcome")).toBe(true);

    // The terminal notice arrives after catchup (phase is already SUCCEEDED).
    const terminal = await client.waitFor((frame) => frame.type === "execution-terminal", 10_000);
    expect(terminal).toEqual({ type: "execution-terminal", phase: "SUCCEEDED" });
    client.close();
  });

  it("a fresh connection resuming from the LAST eventId gets no replay and an immediate terminal", async () => {
    const stored = listEventsForExecution(db, executionId);
    const lastEventId = stored[stored.length - 1]?.id;
    expect(lastEventId).toBeTypeOf("string");

    const client = new LiveClient(server.port, { headers: { authorization: `Bearer ${server.token}` } });
    await client.open();
    client.subscribe(executionId, { afterEventId: lastEventId ?? "" });
    const ready = await client.waitFor((frame) => frame.type === "ready");
    expect(ready).toMatchObject({ type: "ready", cursor: stored[stored.length - 1]?.seq });
    const catchup = await client.waitFor((frame) => frame.type === "catchup");
    expect(catchup).toEqual({ type: "catchup", cursor: stored[stored.length - 1]?.seq });
    const terminal = await client.waitFor((frame) => frame.type === "execution-terminal");
    expect(terminal).toEqual({ type: "execution-terminal", phase: "SUCCEEDED" });
    expect(client.received.some((frame) => frame.type === "event")).toBe(false);
    client.close();
  });
});
