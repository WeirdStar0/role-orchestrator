/**
 * M5-04 — the secure run-diagnostic export (A36 落盘前脱敏 + A42 direction).
 *
 * ONE document per run — graph state + executions + events + memory
 * references + approval records — collected through the SAME project-scoped,
 * allowlisted surfaces the API views use, then redacted TWICE before any
 * sink (the M3-04 `exportDiagnosticPackage` pipeline, reused as pattern):
 *
 *   1. COLLECT — run/executions via the secret-free projection views
 *      (`dispatchToken` and pid-identity NEVER enter the document), graph via
 *      the M5-01 view, events via the store replay order, memories via the
 *      AUTHORIZED `MemoryAccess` session (never a raw cross-project query,
 *      A15), approvals via the M5-03 view (digest re-verified at read).
 *   2. A42 BOUNDARY (before any redaction pass):
 *      - raw conversation transcript fields (`message_delta.text`,
 *        `result_reported.resultText`) are replaced by one-way sha256
 *        references — the raw session content never reaches the document;
 *      - memory CONTENT is exported as a truncated excerpt (≤160 chars,
 *        marked) plus its contentHash — 引用与摘要, never full text;
 *      - event payloads serialized above 64 Ki chars are replaced by
 *        {sha256, bytes} references (truncation recorded, never silent —
 *        large content belongs in artifacts per docs/API_AND_EVENTS.md).
 *   3. REDACT pass 1 — `redactJsonValue` deep-redacts every remaining string
 *      (Bearer/token/api-key shapes) BEFORE serialization.
 *   4. REDACT pass 2 — the serialized JSON text passes `redactText`
 *      immediately before the sink (file write OR HTTP response body); the
 *      sink never sees an unredacted byte.
 *   5. NO EXECUTABLE CONTENT — the JSON form is served as
 *      `application/json` with `X-Content-Type-Options: nosniff` and the
 *      strict CSP (no script surface by content type + sniff refusal). The
 *      HTML form is rendered ONLY from the already-redacted document, passes
 *      every dynamic value through `sanitizeDisplayText` (ANSI strip +
 *      HTML escape), contains ZERO <script> elements and no inline handlers
 *      — hostile payloads in stored events can only appear as inert text.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@role-orchestrator/contracts";
import { redactJsonValue, redactText } from "@role-orchestrator/cli-events";
import { MemoryAccess } from "@role-orchestrator/memory-search";
import { listEventsForExecution, listExecutionsForRun, getTaskRun } from "@role-orchestrator/store";
import { getRunApprovalView, type RunApprovalView } from "./approval-view.js";
import { LocalApiStateError } from "./errors.js";
import { getRunGraphView, type RunGraphView } from "./graph.js";
import { sanitizeDisplayText } from "./sanitize.js";
import { getRunDetail, type ExecutionStatusView } from "./views.js";

/** Memory content longer than this is exported as an excerpt + hash (A42). */
const MEMORY_EXCERPT_CHARS = 160;
/** Event payloads serialized above this many chars become hash references. */
const MAX_EXPORTED_PAYLOAD_CHARS = 65_536;

/** The raw-conversation fields, by normalized event type (A42 boundary). */
const TRANSCRIPT_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  message_delta: ["text"],
  result_reported: ["resultText"]
};

/** Internal document shape BEFORE the redaction passes (never leaves the process unredacted). */
interface DiagnosticDocument {
  readonly schemaVersion: 1;
  readonly kind: "role-orchestrator-run-diagnostic-export";
  readonly generatedAt: string;
  readonly run: {
    readonly id: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly graphRevision: number;
    readonly status: string;
    readonly baseSha: string;
    readonly createdAt: string;
  };
  readonly graph: RunGraphView;
  readonly executions: readonly ExecutionStatusView[];
  readonly events: readonly {
    readonly executionId: string;
    readonly eventId: string;
    readonly seq: number;
    readonly type: string;
    readonly occurredAt: string;
    readonly payload: Record<string, JsonValue>;
  }[];
  readonly memoryReferences: readonly {
    readonly memoryId: string;
    readonly version: number;
    readonly type: string;
    readonly status: string;
    readonly contentHash: string;
    /** ≤160-char excerpt; the full content NEVER enters the export (A42). */
    readonly excerpt: string;
    readonly excerptTruncated: boolean;
    readonly evidenceRefCount: number;
  }[];
  readonly approvals: RunApprovalView;
}

export interface DiagnosticExportBuild {
  /** The REDACTED document (pass 1 applied) — the only shape ever rendered. */
  readonly document: DiagnosticDocument;
  /** Pass-2-redacted serialized JSON — the exact bytes for a JSON sink. */
  readonly json: string;
  readonly documentRedactedCount: number;
  readonly textRedactions: Readonly<Record<string, number>>;
  readonly sha256: string;
  readonly byteCount: number;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A42: replace raw transcript strings with one-way sha256 references. */
function stripRawTranscript(
  type: string,
  payload: Record<string, JsonValue>
): Record<string, JsonValue> {
  const fields = TRANSCRIPT_FIELDS_BY_TYPE[type];
  if (fields === undefined) return payload;
  const out: Record<string, JsonValue> = { ...payload };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "string") {
      delete out[field];
      out[`${field}Ref`] = { sha256: sha256Hex(value), bytes: Buffer.byteLength(value, "utf8") };
    }
  }
  return out;
}

/** Large payloads become hash references (truncation recorded, never silent). */
function capExportedPayload(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= MAX_EXPORTED_PAYLOAD_CHARS) return payload;
  return {
    exportTruncated: true,
    payloadSha256: sha256Hex(serialized),
    payloadChars: serialized.length
  };
}

function parsePayload(payloadJson: string, eventId: string): Record<string, JsonValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new LocalApiStateError(`stored payload of event "${eventId}" is not valid JSON`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalApiStateError(`stored payload of event "${eventId}" is not a JSON record`);
  }
  return parsed as Record<string, JsonValue>;
}

function collectDocument(db: DatabaseSync, runId: string, generatedAt: string): DiagnosticDocument {
  const run = getTaskRun(db, runId);
  if (run === null) {
    throw new LocalApiStateError(`diagnostic export: unknown run "${runId}"`);
  }
  const detail = getRunDetail(db, runId);
  const graph = getRunGraphView(db, runId);
  const approvals = getRunApprovalView(db, runId);
  if (detail === null || graph === null || approvals === null) {
    // All three re-read the run; a vanishing row is durable corruption.
    throw new LocalApiStateError(`diagnostic export: run "${runId}" vanished between reads`);
  }
  // Authorized session bound to the run's project (A15) — never a raw query.
  const memorySession = MemoryAccess.open(db, { projectId: run.projectId });

  const executions = listExecutionsForRun(db, runId);
  return {
    schemaVersion: 1,
    kind: "role-orchestrator-run-diagnostic-export",
    generatedAt,
    run: {
      id: detail.id,
      projectId: detail.projectId,
      taskId: detail.taskId,
      graphRevision: detail.graphRevision,
      status: detail.status,
      baseSha: detail.baseSha,
      createdAt: detail.createdAt
    },
    graph,
    executions: detail.executions,
    events: executions.flatMap((execution) =>
      listEventsForExecution(db, execution.id).map((event) => ({
        executionId: execution.id,
        eventId: event.id,
        seq: event.seq,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: capExportedPayload(
          stripRawTranscript(event.type, parsePayload(event.payload, event.id))
        )
      }))
    ),
    memoryReferences: memorySession.list().map((memory) => ({
      memoryId: memory.id,
      version: memory.version,
      type: memory.type,
      status: memory.status,
      contentHash: memory.contentHash,
      excerpt: memory.content.slice(0, MEMORY_EXCERPT_CHARS),
      excerptTruncated: memory.content.length > MEMORY_EXCERPT_CHARS,
      evidenceRefCount: memory.evidenceRefs.length
    })),
    approvals
  };
}

/**
 * Build the fully redacted export document + JSON bytes. `null` when the run
 * id is unknown (caller maps to 404). Every sink (file or HTTP body) starts
 * from `build.json` — already through BOTH redaction passes.
 */
export function buildRunDiagnosticExport(
  db: DatabaseSync,
  runId: string,
  input: { readonly generatedAt: string }
): DiagnosticExportBuild | null {
  // Unknown run → null (the caller maps to 404) — never a thrown state fault.
  if (getTaskRun(db, runId) === null) return null;
  const document = collectDocument(db, runId, input.generatedAt);
  // Pass 1: deep-redact the structured document (pre-serialization).
  const documentPass = redactJsonValue(document as unknown as JsonValue);
  const redactedDocument = documentPass.value as unknown as DiagnosticDocument;
  // Pass 2: redact the serialized text immediately before the sink (A36).
  const serialized = JSON.stringify(redactedDocument, null, 2);
  const textPass = redactText(serialized);
  return {
    document: redactedDocument,
    json: textPass.text,
    documentRedactedCount: documentPass.redactedCount,
    textRedactions: textPass.redactions,
    sha256: sha256Hex(textPass.text),
    byteCount: Buffer.byteLength(textPass.text, "utf8")
  };
}

/**
 * The 落盘 (file) sink: identical pipeline to the HTTP body, ending in a
 * file write that never sees unredacted bytes (M3-04 precedent).
 */
export function writeDiagnosticExportFile(
  db: DatabaseSync,
  runId: string,
  outPath: string,
  input: { readonly generatedAt: string }
): { readonly outPath: string; readonly sha256: string; readonly byteCount: number; readonly documentRedactedCount: number; readonly textRedactions: Readonly<Record<string, number>> } | null {
  const build = buildRunDiagnosticExport(db, runId, input);
  if (build === null) return null;
  writeFileSync(outPath, build.json, "utf8");
  return {
    outPath,
    sha256: build.sha256,
    byteCount: build.byteCount,
    documentRedactedCount: build.documentRedactedCount,
    textRedactions: build.textRedactions
  };
}

function esc(text: string): string {
  return sanitizeDisplayText(text);
}

/**
 * Render the HTML report from the ALREADY-REDACTED document. Zero <script>
 * elements, zero inline handlers, zero style attributes — every dynamic
 * value passes `sanitizeDisplayText` (ANSI strip + HTML escape), so hostile
 * stored content can only surface as inert text.
 */
export function renderDiagnosticHtml(build: DiagnosticExportBuild): string {
  const doc = build.document;
  const eventBlocks = doc.events
    .map(
      (event) =>
        `<div class="event"><h3>${esc(`${String(event.seq)} ${event.type}`)}</h3>` +
        `<p class="meta">${esc(`${event.executionId} ${event.eventId} ${event.occurredAt}`)}</p>` +
        `<pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></div>`
    )
    .join("\n");
  const nodeRows = doc.graph.nodes
    .map(
      (node) =>
        `<tr><td>${esc(node.nodeId)}</td><td>${esc(node.role)}</td><td>${esc(node.state)}</td>` +
        `<td>${esc(node.dependencies.join(", "))}</td><td>${esc(String(node.editable))}</td></tr>`
    )
    .join("\n");
  const executionRows = doc.executions
    .map(
      (execution) =>
        `<tr><td>${esc(execution.id)}</td><td>${esc(execution.nodeId)}</td><td>${esc(execution.phase)}</td>` +
        `<td>${esc(String(execution.attempt))}</td></tr>`
    )
    .join("\n");
  const memoryRows = doc.memoryReferences
    .map(
      (memory) =>
        `<tr><td>${esc(memory.memoryId)}</td><td>${esc(`${memory.type}/${memory.status} v${String(memory.version)}`)}</td>` +
        `<td><code>${esc(memory.contentHash)}</code></td>` +
        `<td>${esc(memory.excerpt)}${memory.excerptTruncated ? " …[truncated]" : ""}</td></tr>`
    )
    .join("\n");
  const approvalRows = doc.approvals.approvals
    .map(
      (approval) =>
        `<tr><td><code>${esc(approval.actionDigest)}</code></td><td>${esc(approval.status)}</td>` +
        `<td>${esc(approval.riskGrade)}</td>` +
        `<td>${esc(approval.invalidations.length === 0 ? "-" : approval.invalidations.join(", "))}</td>` +
        `<td>${esc(approval.action.argv.join(" "))}</td></tr>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>role-orchestrator 诊断导出 ${esc(doc.run.id)}</title>
</head>
<body>
<main>
<h1>运行诊断导出</h1>
<p class="meta">${[
    `run: ${doc.run.id} (project ${doc.run.projectId}, task ${doc.run.taskId})`,
    `status: ${doc.run.status}, graphRevision: ${String(doc.run.graphRevision)}, baseSha: ${doc.run.baseSha}`,
    `generatedAt: ${doc.generatedAt}; redactions: document ${String(build.documentRedactedCount)}, text ${String(Object.values(build.textRedactions).reduce((sum, count) => sum + count, 0))}`
  ]
    .map((line) => esc(line))
    .join("<br>")}</p>
<h2>任务图节点</h2>
<table><tbody>${nodeRows}</tbody></table>
<h2>执行</h2>
<table><tbody>${executionRows}</tbody></table>
<h2>事件（已脱敏，原文 transcript 以 sha256 引用替代）</h2>
${eventBlocks}
<h2>记忆引用（摘要 + hash，非全文）</h2>
<table><tbody>${memoryRows}</tbody></table>
<h2>审批记录</h2>
<table><tbody>${approvalRows}</tbody></table>
</main>
</body>
</html>
`;
}
