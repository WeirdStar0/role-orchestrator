import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { persistDrainedEvents, startExecution } from "@role-orchestrator/engine";
import { getEvent, verifyEventChecksums } from "@role-orchestrator/store";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { T0, createTestDb, makeWorkDir, seedFakeCliRun, rawRequest } from "./helpers.js";

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


/**
 * End-to-end dogfood (the task's design): a REAL execution runs through
 * @role-orchestrator/engine against the BUILT fake-cli dist bin, its events
 * land in the store ALREADY redacted (A36 落盘前脱敏, asserted against the
 * raw stored rows), and the loopback API serves them — authenticated, with
 * a second egress redaction pass as defence in depth — while the dispatch
 * skeleton stays an honest 501.
 */
let server: LocalApiServer;
let closeDb: () => void;
let db: DatabaseSync;
let executionId: string;
let runId: string;

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  const handle = createTestDb("dogfood");
  closeDb = handle.close;
  db = handle.db;
  const seeded = await seedFakeCliRun(handle.db, { dialect: "claude" });
  runId = seeded.runId;
  executionId = "exec-node-1";

  const run = startExecution(handle.db, {
    executionId,
    runId,
    roleId: "developer",
    nodeId: "node-1",
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: "dt-dogfood-1",
    cwd: makeWorkDir("dogfood"),
    prompt: "synthetic task prompt (local-api dogfood)",
    invocationArgs: ["--scenario", "success"],
    timeoutSeconds: 120,
    now: T0
  });
  const result = await run.result;
  if (result.finalPhase !== "SUCCEEDED") {
    throw new Error(`dogfood run did not succeed: ${JSON.stringify(result.reasons)}`);
  }

  // One extra hostile event through the ENGINE persistence path (A36
  // 落盘前脱敏): persistDrainedEvents must redact the payload BEFORE the
  // row reaches the events table (asserted against the raw row below).
  const batch = persistDrainedEvents(handle.db, "claude", executionId, [
    {
      schemaVersion: 1,
      eventId: "evt-diag-dogfood-secret",
      executionId,
      seq: 900,
      type: "diagnostic",
      sourceType: "synthetic.diagnostic",
      occurredAt: "2026-09-22T00:01:00.000Z",
      payload: { summary: "upstream said Authorization: Bearer livecred1234567890" }
    }
  ]);
  if (batch.stored !== 1) throw new Error("dogfood: hostile event not stored");

  server = await startLocalApiServer({ db: handle.db });
}, 60_000);

afterAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  await server?.close();
  closeDb?.();
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe.skipIf(!LAUNCHER_APPLIES)("fake-cli dogfood through the authenticated local API", () => {
  it("serves the real execution as SUCCEEDED with its recorded pid", async () => {
    const response = await rawRequest(server.port, {
      path: `/api/v1/executions/${executionId}`,
      headers: auth(server.token)
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      execution: { id: string; phase: string; attempt: number; pid: number | null; sessionId: string | null };
    };
    expect(body.execution.phase).toBe("SUCCEEDED");
    expect(body.execution.attempt).toBe(1);
    expect(body.execution.pid).toBeGreaterThan(0); // the fake-cli process, recorded by the engine
    expect(body.execution.sessionId).toBeTypeOf("string");
  });

  it("serves the run detail with the fake-cli attempt attached", async () => {
    const response = await rawRequest(server.port, {
      path: `/api/v1/runs/${runId}`,
      headers: auth(server.token)
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      run: { taskId: string; executions: Array<{ id: string; phase: string }> };
    };
    expect(body.run.taskId).toBe("task-1");
    expect(body.run.executions.map((execution) => execution.id)).toContain(executionId);
  });

  it("serves the persisted protocol events of the real run, redacted", async () => {
    const response = await rawRequest(server.port, {
      path: `/api/v1/executions/${executionId}/events`,
      headers: auth(server.token)
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
    };
    const types = body.events.map((event) => event.type);
    expect(types).toContain("started");
    expect(types).toContain("result_reported");
    expect(types).toContain("process_exited");

    const hostile = body.events.find((event) => event.seq === 900);
    expect(hostile?.payload["summary"]).toBe("upstream said Authorization: Bearer [REDACTED]");
  });

  it("stores engine-written events ALREADY redacted in the events table (A36 落盘前)", () => {
    // Read the RAW row back from the events table — the exact stored payload
    // text, not an API view. The secret must be gone BEFORE storage; the
    // egress redaction the API applies is only the second layer.
    const raw = getEvent(db, "evt-diag-dogfood-secret");
    expect(raw).not.toBeNull();
    expect(raw?.payload).not.toContain("livecred1234567890");
    expect(raw?.payload).toContain("Bearer [REDACTED]");
    // The checksum is computed over the exact stored (redacted) payload.
    expect(verifyEventChecksums(db)).toEqual([]);
  });

  it("answers the retired dispatch path 410 behind full authentication (A30, M9-01)", async () => {
    const fullyAuthed = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/executions/${executionId}/dispatch`,
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": server.csrfToken,
        ...auth(server.token)
      }
    });
    expect(fullyAuthed.status).toBe(410);
    expect(fullyAuthed.body).toContain("ENDPOINT_RETIRED");

    const noCsrf = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/executions/${executionId}/dispatch`,
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        ...auth(server.token)
      }
    });
    expect(noCsrf.status).toBe(403);
  });
});
