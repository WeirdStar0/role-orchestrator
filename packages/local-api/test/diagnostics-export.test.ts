/**
 * M5-04 — the secure run-diagnostic export (A36 落盘前脱敏 + A42 direction):
 * - the export (graph + executions + events + memory references + approvals)
 *   passes redactJsonValue AND redactText BEFORE the sink; the file bytes and
 *   the HTTP body are the SAME redacted bytes;
 * - raw transcript fields (message_delta.text, result_reported.resultText)
 *   are replaced by sha256 references — the raw session content is NOT in
 *   the export;
 * - memory content exports as excerpt + hash (never full text);
 * - oversized payloads become truncated hash references;
 * - the JSON form has no script surface (application/json + nosniff + CSP);
 *   the HTML form is script-free with every dynamic value escaped;
 * - dispatch capability material never enters the document.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApproval, type ActionDescriptor } from "@role-orchestrator/approval";
import { appendEvent, createActiveAttempt, setAttemptPhase } from "@role-orchestrator/store";
import { proposeMemory } from "@role-orchestrator/memory";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer, writeDiagnosticExportFile } from "../src/index.js";
import {
  T0,
  createM5TestDb,
  fakeSha40,
  rawRequest,
  seedEditableRun
} from "./helpers.js";

const RAW_TRANSCRIPT = "RAW USER TRANSCRIPT不可以出现在导出里 secret-not-even-a-secret";
const RAW_RESULT_TEXT = "RAW ASSISTANT RESULT TEXT must not appear either";
const HUGE_PAYLOAD_MARKER = "H".repeat(70_000);
const MEMORY_LONG_CONTENT =
  "discovery memory with a secret inside: token=supersecretvalue12345 and long padding to exceed the excerpt window. " +
  "x".repeat(400);
const SECRET_BEARER = "eyJhbGciOiJIUzI1NiJ9.diag.sig";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createM5TestDb>;

beforeAll(async () => {
  dbHandle = createM5TestDb("diagnostics");
  const db = dbHandle.db;
  const runId = "run-diag";
  await seedEditableRun(db, { runId });
  createActiveAttempt(db, {
    id: "exec-diag-1",
    runId,
    nodeId: "b",
    definitionRevision: "1",
    attempt: 1,
    dispatchToken: "dt-diag-exec-1",
    phase: "RUNNING",
    now: T0
  });
  setAttemptPhase(db, { id: "exec-diag-1", phase: "FAILED", wherePhaseIn: ["RUNNING"], now: T0 });
  const hostileCases: ReadonlyArray<{
    readonly seq: number;
    readonly id: string;
    readonly type: string;
    readonly payload: Record<string, unknown>;
  }> = [
    {
      seq: 1,
      id: "evt-diag-1",
      type: "started",
      payload: { summary: `Authorization: Bearer ${SECRET_BEARER} leaked into a log` }
    },
    {
      seq: 2,
      id: "evt-diag-2",
      type: "message_delta",
      payload: { text: RAW_TRANSCRIPT }
    },
    {
      seq: 3,
      id: "evt-diag-3",
      type: "result_reported",
      payload: { subtype: "success", isError: false, resultText: RAW_RESULT_TEXT }
    },
    {
      seq: 4,
      id: "evt-diag-4",
      type: "diagnostic",
      payload: { html: "<script>alert('export-xss')</script><img src=x onerror=alert(2)>", ansi: "\u001b[31mred\u001b[0m" }
    },
    {
      seq: 5,
      id: "evt-diag-5",
      type: "diagnostic",
      payload: { blob: HUGE_PAYLOAD_MARKER }
    }
  ];
  for (const event of hostileCases) {
    const result = appendEvent(db, {
      id: event.id,
      executionId: "exec-diag-1",
      seq: event.seq,
      type: event.type,
      payload: event.payload as never,
      occurredAt: T0
    });
    if (result !== "stored") throw new Error(`diag seed: ${event.id} not stored`);
  }
  const descriptor: ActionDescriptor = {
    runtime: "claude",
    argv: ["claude", "--print", "diagnostic fixture action"],
    cwd: "h:/worktrees/run-diag/b/1",
    repo: {
      root: "h:/repos/proj-x",
      baseSha: fakeSha40("run-diag-base"),
      targetSha: fakeSha40("run-diag-target")
    },
    profileRevision: "1",
    requiredPermissions: ["repo.read", "repo.write"],
    grantedPermissions: ["repo.read"],
    dimensions: ["write"],
    writeScope: "managed-worktree",
    requiredCapabilities: []
  };
  const approval = createApproval(db, {
    idempotencyKey: "idem-run-diag-1",
    action: descriptor,
    requestedBy: { runId, nodeId: "b", attempt: 1 },
    ttlSeconds: 2_592_000,
    now: T0
  });
  void approval;
  proposeMemory(db, {
    id: "mem-diag-1",
    projectId: `proj-${runId}`,
    type: "discovery",
    content: "short memory content",
    evidenceRefs: [],
    actor: { kind: "role", roleId: "developer" },
    now: T0
  });
  proposeMemory(db, {
    id: "mem-diag-2",
    projectId: `proj-${runId}`,
    type: "discovery",
    content: MEMORY_LONG_CONTENT,
    evidenceRefs: [],
    actor: { kind: "role", roleId: "developer" },
    now: T0
  });
  server = await startLocalApiServer({ db, tokenFile: undefined });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("writeDiagnosticExportFile — 落盘前脱敏 (A36)", () => {
  it("writes a file whose bytes are fully redacted, transcript-free and memory-bounded", () => {
    const outPath = join(tmpdir(), `diagnostic-run-diag-${String(process.pid)}.json`);
    const result = writeDiagnosticExportFile(dbHandle.db, "run-diag", outPath, { generatedAt: T0 });
    expect(result).not.toBeNull();
    const fileBytes = readFileSync(outPath, "utf8");
    // The reported sha256/byteCount are the FILE's bytes (pass-2 output).
    expect(result?.sha256).toBe(sha256(fileBytes));
    expect(result?.byteCount).toBe(Buffer.byteLength(fileBytes, "utf8"));
    expect(result?.documentRedactedCount).toBeGreaterThan(0);

    const document = JSON.parse(fileBytes) as Record<string, unknown>;
    expect(document).toMatchObject({ schemaVersion: 1, kind: "role-orchestrator-run-diagnostic-export" });

    // A36: no secret shape survives into the file.
    expect(fileBytes).not.toContain(SECRET_BEARER);
    expect(fileBytes).toContain("Bearer [REDACTED]");
    // A42: the raw transcript is NOT in the export — only its sha256 ref.
    expect(fileBytes).not.toContain(RAW_TRANSCRIPT);
    expect(fileBytes).not.toContain(RAW_RESULT_TEXT);
    const events = document["events"] as Array<Record<string, unknown>>;
    const messageDelta = events.find((event) => event["eventId"] === "evt-diag-2") as {
      payload: { textRef: { sha256: string; bytes: number }; text?: string };
    };
    expect(messageDelta.payload.text).toBeUndefined();
    expect(messageDelta.payload.textRef.sha256).toBe(sha256(RAW_TRANSCRIPT));
    const resultEvent = events.find((event) => event["eventId"] === "evt-diag-3") as {
      payload: { resultTextRef: { sha256: string }; resultText?: string };
    };
    expect(resultEvent.payload.resultText).toBeUndefined();
    expect(resultEvent.payload.resultTextRef.sha256).toBe(sha256(RAW_RESULT_TEXT));

    // Oversized payloads are truncated to hash references (never silent).
    const huge = events.find((event) => event["eventId"] === "evt-diag-5") as {
      payload: { exportTruncated: boolean; payloadSha256: string; payloadChars: number; blob?: string };
    };
    expect(huge.payload.blob).toBeUndefined();
    expect(huge.payload.exportTruncated).toBe(true);
    expect(huge.payload.payloadSha256).toBe(
      sha256(JSON.stringify({ blob: HUGE_PAYLOAD_MARKER }))
    );
    expect(fileBytes).not.toContain(HUGE_PAYLOAD_MARKER.slice(0, 1000));

    // Dispatch capability material never enters the document.
    expect(fileBytes).not.toContain("dt-diag-exec-1");
    expect(fileBytes).not.toContain("executionNonce");

    // Memory: excerpt + hash only — full text and its secret are absent.
    expect(fileBytes).not.toContain(MEMORY_LONG_CONTENT.slice(0, 200));
    expect(fileBytes).not.toContain("supersecretvalue12345");
    const memories = document["memoryReferences"] as Array<Record<string, unknown>>;
    const longMemory = memories.find((memory) => memory["memoryId"] === "mem-diag-2") as {
      excerpt: string;
      excerptTruncated: boolean;
      contentHash: string;
    };
    expect(longMemory.excerptTruncated).toBe(true);
    expect(longMemory.excerpt).toContain("discovery memory with");
    expect(longMemory.contentHash).toBeTypeOf("string");

    // Approvals are part of the export (actionDigest visible).
    const approvals = document["approvals"] as { approvals: Array<{ actionDigest: string }> };
    expect(approvals.approvals.length).toBeGreaterThanOrEqual(1);

    // Graph state is present.
    const graph = document["graph"] as { nodes: Array<{ nodeId: string }> };
    expect(graph.nodes.map((node) => node.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("returns null for an unknown run", () => {
    expect(writeDiagnosticExportFile(dbHandle.db, "run-missing", join(tmpdir(), "x.json"), { generatedAt: T0 })).toBeNull();
  });
});

describe("GET /api/v1/runs/:runId/diagnostics — HTTP forms", () => {
  it("serves the redacted JSON as an attachment with the strict response hygiene", async () => {
    const response = await rawRequest(server.port, {
      path: "/api/v1/runs/run-diag/diagnostics",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["cache-control"]).toBe("no-store");
    // Same A36/A42 properties as the file sink (identical pipeline).
    expect(response.body).not.toContain(SECRET_BEARER);
    expect(response.body).not.toContain(RAW_TRANSCRIPT);
    expect(response.body).toContain("Bearer [REDACTED]");
    const document = JSON.parse(response.body) as { kind: string };
    expect(document.kind).toBe("role-orchestrator-run-diagnostic-export");
  });

  it("serves the HTML form as script-free, escaped markup", async () => {
    const response = await rawRequest(server.port, {
      path: "/api/v1/runs/run-diag/diagnostics?format=html",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    // NO script element anywhere; hostile payloads appear only escaped.
    expect(response.body.toLowerCase()).not.toContain("<script");
    expect(response.body).not.toContain("onerror=");
    expect(response.body).toContain("&lt;script&gt;");
    // ANSI escape sequences are stripped; secrets are redacted.
    expect(response.body).not.toContain("\u001b[31m");
    expect(response.body).not.toContain(SECRET_BEARER);
    expect(response.body).toContain("Bearer [REDACTED]");
    // Raw transcript and full memory text stay out of the HTML too.
    expect(response.body).not.toContain(RAW_TRANSCRIPT);
    expect(response.body).not.toContain("supersecretvalue12345");
  });

  it("rejects unknown formats, wrong methods, missing tokens and unknown runs", async () => {
    const badFormat = await rawRequest(server.port, {
      path: "/api/v1/runs/run-diag/diagnostics?format=xml",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(badFormat.status).toBe(400);
    expect(badFormat.body).toContain("INPUT_REJECTED");

    const post = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/runs/run-diag/diagnostics",
      headers: {
        origin: `http://127.0.0.1:${String(server.port)}`,
        "x-csrf-token": server.csrfToken,
        ...{ authorization: `Bearer ${server.token}` }
      }
    });
    expect(post.status).toBe(405);

    const noToken = await rawRequest(server.port, {
      path: "/api/v1/runs/run-diag/diagnostics"
    });
    expect(noToken.status).toBe(403);

    const missing = await rawRequest(server.port, {
      path: "/api/v1/runs/run-diag-missing/diagnostics",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(missing.status).toBe(404);
  });
});
