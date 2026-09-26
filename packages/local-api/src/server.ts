/**
 * Loopback-only authenticated HTTP API (M1-04), node:http only.
 *
 * Start sequence, fail-closed at every step:
 *   1. generate a 256-bit session token and write it to a current-user-only
 *      token file (token.ts) — the server refuses to start otherwise;
 *   2. bind `127.0.0.1` (never `0.0.0.0`/`::`) and, AFTER listening, assert
 *      the kernel-observed address really is 127.0.0.1 — any deviation
 *      closes the server and throws;
 *   3. derive the session-bound CSRF token (HMAC over the session token
 *      with a per-start random secret, never persisted). The port the
 *      handler checks against is assigned after listen; a request racing
 *      ahead of it sees port 0 and fails the Host check (fail-closed).
 *
 * Every request passes the guard pipeline (guard.ts) BEFORE any routing:
 * loopback peer → known method → exact-loopback Host (DNS-rebinding-safe) →
 * bearer session token on /api → Origin allowlist → CSRF on mutating
 * requests. Forged external-web requests are refused with explicit
 * 400/403/405 codes and reasons; no handler ever sees them.
 *
 * Response hygiene on every response: `Cache-Control: no-store`,
 * `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a
 * strict CSP (`default-src 'none'`…) that pairs with the escaped page
 * rendering. No CORS headers are ever emitted — cross-origin browser reads
 * fail by construction. The request log records method, path and outcome
 * only, passed through redaction; headers (which carry the bearer token)
 * are never logged.
 *
 * M5-01 adds the run-graph surface (same guard pipeline, same headers):
 * `GET /api/v1/runs/:runId/graph` (SVG-canvas data), `POST
 * /api/v1/runs/:runId/graph/edits` (graphRevision-optimistic node edits —
 * A02 override carriers are refused 403 before parsing, stale revisions and
 * running nodes are refused 409, and an edit never starts an execution) and
 * `GET /api/v1/session` (hands the session-bound CSRF token to the already
 * authenticated page so it can make mutating calls).
 *
 * M5-02 adds the controlled-expansion surface: `GET
 * /api/v1/runs/:runId/expansions` (the Proposal view — pending fail triggers
 * with findings, executed expansions with their requester, the unresolved A20
 * hold and the node/depth budget headroom) and `POST
 * /api/v1/runs/:runId/expansions` — a UI-initiated expansion is FORWARDED to
 * expand's `requestControlledExpansion` (A04 permission gate with the denial
 * reason durably audited → 403; A38 optimistic `expectedGraphRevision` gate →
 * 409 with the current revision; three-round cap and user hold → 409; the
 * M4-03 composed-graph re-validation runs unchanged). A 409 never silently
 * overwrites: the response carries `currentGraphRevision` so the client can
 * reload and retry.
 *
 * M5-03 adds the approval / diff / context surfaces:
 * `GET /api/v1/runs/:runId/approvals` (every digest constituent visible
 * BEFORE a decision — argv, target/base SHA, permission increments, risk
 * grade, expiry — plus the A17 invalidation states), `POST
 * /api/v1/approvals/:approvalId/decision` (per-actionDigest approve/reject
 * through the approval package's guarded transitions; candidate-changed or
 * expired approvals are refused 409 — never globally granted), `GET
 * /api/v1/runs/:runId/diff?nodeId=` (git-sourced unified diff of the
 * integrated candidate vs the baseline, read-only, capped, with the A12
 * three-state verdict binding) and `GET /api/v1/runs/:runId/contexts` (the
 * context bundle fragment inventory with layer/trust/truncation markers and
 * the traceFragment provenance).
 *
 * M5-04 adds live events and the secure diagnostic export (A36/A39/A42):
 * `WS /api/v1/events/live` (see ws-events.ts — same guard pipeline on the
 * upgrade, first-message auth, cursor replay with at-least-once delivery
 * deduped by eventId, byte-budgeted pages with bufferedAmount flow control,
 * a terminal notice once the execution phase is final) and `GET
 * /api/v1/runs/:runId/diagnostics?format=json|html` (the redacted,
 * script-free diagnostic package — see diagnostics.ts; the JSON bytes pass
 * redactJsonValue + redactText BEFORE leaving the process, and the HTML is
 * rendered only from the redacted document with zero script surface).
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { redactText } from "@role-orchestrator/cli-events";
import { RoleIdSchema } from "@role-orchestrator/contracts";
import { GitRunner } from "@role-orchestrator/worktree";
import {
  buildRunDiagnosticExport,
  renderDiagnosticHtml
} from "./diagnostics.js";
import {
  applyApprovalDecision,
  getRunApprovalView,
  mapApprovalDecisionError,
  type ApprovalDecisionRequest
} from "./approval-view.js";
import { getRunContextView } from "./context-view.js";
import { getRunDiffView } from "./diff-view.js";
import { LocalApiConfigurationError, LocalApiError } from "./errors.js";
import {
  checkBearerToken,
  checkCsrfToken,
  checkHostHeader,
  checkOriginHeader,
  isKnownMethod,
  isLoopbackRemoteAddress,
  isMutatingMethod,
  type GuardDecision,
  type GuardReject
} from "./guard.js";
import { applyRunNodeEdit, findOverrideFieldKey, getRunGraphView } from "./graph.js";
import { GraphEditRejectionError } from "./errors.js";
import {
  applyRunExpansion,
  getRunExpansionView,
  mapExpansionError
} from "./expansion.js";
import { buildStaticPageAssets } from "./page.js";
import { deriveCsrfToken, generateSessionToken, writeSessionTokenFile } from "./token.js";
import { getExecutionStatus, getRunDetail, listExecutionEventViews } from "./views.js";
import {
  attachEventStreamServer,
  type EventStreamHandle,
  type EventStreamOptions
} from "./ws-events.js";

const LOOPBACK_ADDRESS = "127.0.0.1";
const MAX_BODY_BYTES = 1_048_576;
const CSP_HEADER =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface LocalApiServerOptions {
  /** Store handle the read-only views are served from. The server never writes. */
  readonly db: DatabaseSync;
  /** TCP port; default 0 (ephemeral). */
  readonly port?: number | undefined;
  /** Token file path; default under the user temp directory, unique per start. */
  readonly tokenFile?: string | undefined;
  /** M5-04 live-event stream tuning (poll/paging/backpressure bounds). */
  readonly eventStream?: EventStreamOptions | undefined;
}

export interface LocalApiServer {
  readonly port: number;
  /** Post-listen kernel address; guaranteed to be "127.0.0.1" (asserted). */
  readonly boundAddress: string;
  readonly token: string;
  readonly csrfToken: string;
  readonly tokenFile: string;
  readonly server: Server;
  /** The M5-04 live-event WebSocket endpoint (observability + lifecycle). */
  readonly eventStream: EventStreamHandle;
  close(): Promise<void>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": CSP_HEADER
};

const pageAssets = buildStaticPageAssets();

/**
 * The M5-03 diff source: the worktree package's GitRunner (the single spawn
 * point, argv arrays only). Stateless — the repo cwd comes from the run's
 * project row per request, and every diff argv is read-only `git diff`.
 */
const diffGitRunner = new GitRunner();

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

type ExtraHeaders = Readonly<Record<string, string>>;

function sendJson(res: ServerResponse, statusCode: number, body: unknown, extra?: ExtraHeaders): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  for (const [name, value] of Object.entries(extra ?? {})) res.setHeader(name, value);
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(payload.length)
  });
  res.end(res.req?.method === "HEAD" ? undefined : payload);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  extra?: ExtraHeaders
): void {
  const body: ErrorBody = { error: { code, message } };
  sendJson(res, statusCode, body, extra);
}

function sendGuardReject(res: ServerResponse, reject: GuardReject): void {
  sendError(res, reject.statusCode, reject.code, reject.reason);
}

/** First guard reject wins; accepts pass through. */
function firstReject(...decisions: readonly GuardDecision[]): GuardReject | null {
  for (const decision of decisions) {
    if (!decision.ok) return decision;
  }
  return null;
}

const EventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional()
});

/** The dispatch skeleton accepts NO fields: real orchestration is a later milestone. */
const DispatchBodySchema = z.strictObject({});

/**
 * M5-01 node-edit body. STRICT: the only fields are the optimistic-lock
 * revision, the target node and the patch (role / objective / dependencies).
 * There is deliberately NO model/profile field anywhere (A02) — carriers of
 * the override vocabulary are refused with 403 by `findOverrideFieldKey`
 * BEFORE this schema runs; any other unknown field is a plain 400. The
 * four-role enum reuses the frozen contracts RoleIdSchema (A03).
 */
const NodeEditPatchSchema = z
  .strictObject({
    role: RoleIdSchema.optional(),
    objective: z.string().min(1).max(10000).optional(),
    dependencies: z.array(z.string().min(1).max(128)).max(63).optional()
  })
  .refine(
    (patch) =>
      patch.role !== undefined || patch.objective !== undefined || patch.dependencies !== undefined,
    { message: "a node edit must change at least one of role/objective/dependencies" }
  );

const GraphEditBodySchema = z.strictObject({
  expectedGraphRevision: z.number().int().min(0),
  nodeId: z.string().min(1).max(128),
  patch: NodeEditPatchSchema
});

/**
 * M5-02 controlled-expansion body. STRICT: the optimistic-lock revision, the
 * failed review trigger (node + exact candidateSha), the acting role and the
 * optional explicit repair target. There is deliberately NO model/profile
 * field anywhere (A02) — the same carrier scan refuses override vocabulary
 * 403 BEFORE this schema runs. The candidateSha mirror here (40-hex) fails
 * fast; expand's schema re-validates authoritatively.
 */
const ExpansionBodySchema = z.strictObject({
  expectedGraphRevision: z.number().int().min(0),
  reviewNodeId: z.string().min(1).max(128),
  candidateSha: z.string().regex(/^[0-9a-f]{40}$/, {
    message: "candidateSha must be a full lowercase 40-hex git commit SHA"
  }),
  requesterRoleId: RoleIdSchema,
  repairedNodeId: z.string().min(1).max(128).optional()
});

/**
 * M5-03 approval-decision body. STRICT: the decision, the human decider and
 * (for reject) the reason. There is deliberately NO model/profile field and
 * NO batch/scope field anywhere — a decision addresses exactly ONE
 * actionDigest (A17); the same carrier scan refuses override vocabulary 403
 * BEFORE this schema runs.
 */
const ApprovalDecisionBodySchema = z
  .strictObject({
    decision: z.enum(["approve", "reject"]),
    decidedBy: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(2000).optional()
  })
  .refine(
    (body) => body.decision !== "reject" || body.reason !== undefined,
    { message: "a rejection requires a reason (1..2000 chars)" }
  );

/** The only accepted query parameter of the diff route. */
const DiffQuerySchema = z.strictObject({
  nodeId: z.string().min(1).max(128)
});

/** M5-04 diagnostic export: json (default) or html; unknown params rejected. */
const DiagnosticsQuerySchema = z.strictObject({
  format: z.enum(["json", "html"]).optional()
});

class BodyTooLargeError extends LocalApiError {
  constructor() {
    super("request body exceeds 1 MiB");
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safePathname(url: string | undefined): string {
  if (url === undefined) return "-";
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function logRequestLine(method: string, pathname: string, status: number, note: string): void {
  // Query strings are stripped before this point; the line is redacted again
  // as defence in depth. Headers (bearer token) are never logged.
  const base = `${method} ${pathname} -> ${String(status)}${note === "" ? "" : ` (${note})`}`;
  process.stdout.write(`${redactText(base).text}\n`);
}

interface RuntimeBinding {
  port: number;
  token: string;
  csrfToken: string;
}

async function handleRequest(
  db: DatabaseSync,
  runtime: RuntimeBinding,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const finish = (status: number, note: string): void => {
    if (!res.writableEnded) {
      sendError(res, 500, "INTERNAL", "unhandled request state"); // safety net
    }
    logRequestLine(req.method ?? "-", safePathname(req.url), status, note);
  };

  try {
    // ---- guard pipeline: no routing before every check passed -------------
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      sendError(res, 403, "REMOTE_NOT_LOOPBACK", "this API only serves loopback connections");
      finish(403, "remote-not-loopback");
      return;
    }
    if (req.url === undefined) {
      sendError(res, 400, "URL_MALFORMED", "the request URL could not be parsed");
      finish(400, "url-malformed");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, `http://${LOOPBACK_ADDRESS}:${String(runtime.port)}`);
    } catch {
      sendError(res, 400, "URL_MALFORMED", "the request URL could not be parsed");
      finish(400, "url-malformed");
      return;
    }
    const method = (req.method ?? "").toUpperCase();
    if (!isKnownMethod(method)) {
      sendError(res, 405, "METHOD_NOT_ALLOWED", `method ${method} is not supported`, {
        Allow: "GET, HEAD, POST"
      });
      finish(405, "method-not-allowed");
      return;
    }
    const mutating = isMutatingMethod(method);
    const originHeader = req.headers["origin"];
    const rejects = firstReject(
      checkHostHeader(req.headers["host"], runtime.port),
      checkOriginHeader(typeof originHeader === "string" ? originHeader : undefined, runtime.port, mutating)
    );
    if (rejects !== null) {
      sendGuardReject(res, rejects);
      finish(rejects.statusCode, rejects.code);
      return;
    }
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (isApi) {
      const tokenDecision = checkBearerToken(req.headers["authorization"], runtime.token);
      if (!tokenDecision.ok) {
        sendGuardReject(res, tokenDecision);
        finish(tokenDecision.statusCode, tokenDecision.code);
        return;
      }
      if (mutating) {
        const csrfHeader = req.headers["x-csrf-token"];
        const csrfDecision = checkCsrfToken(
          typeof csrfHeader === "string" ? csrfHeader : undefined,
          runtime.csrfToken
        );
        if (!csrfDecision.ok) {
          sendGuardReject(res, csrfDecision);
          finish(csrfDecision.statusCode, csrfDecision.code);
          return;
        }
      }
    }

    // ---- routing (only reachable with all guards passed) -------------------
    const outcome = await routeRequest(db, runtime, {
      method,
      pathname: url.pathname,
      query: url.searchParams
    }, req, res);
    finish(outcome.status, outcome.note);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", "request body exceeds 1 MiB");
      finish(413, "payload-too-large");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Redact before the message can reach client or log.
    sendError(res, 500, "INTERNAL", redactText(message).text);
    finish(500, "internal-error");
  }
}

interface ParsedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
}

interface RouteOutcome {
  readonly status: number;
  readonly note: string;
}

function rejectQuery(res: ServerResponse, message: string): RouteOutcome {
  sendError(res, 400, "INPUT_REJECTED", message);
  return { status: 400, note: "input-rejected" };
}

function rejectMethod(res: ServerResponse, message: string, allow: string): RouteOutcome {
  sendError(res, 405, "METHOD_NOT_ALLOWED", message, { Allow: allow });
  return { status: 405, note: "method-not-allowed" };
}

function rejectNotFound(res: ServerResponse, message: string): RouteOutcome {
  sendError(res, 404, "NOT_FOUND", message);
  return { status: 404, note: "not-found" };
}

async function routeRequest(
  db: DatabaseSync,
  runtime: RuntimeBinding,
  parsed: ParsedRequest,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  const { method, pathname, query } = parsed;
  const isRead = method === "GET" || method === "HEAD";

  // ---- static page assets (no secrets in them; still guard-gated and
  //      carrying the same SECURITY_HEADERS as every other response) --------
  if (pathname === "/" || pathname === "/index.html") {
    if (!isRead) return rejectMethod(res, "the page is read-only; use GET", "GET, HEAD");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(isRead && method === "HEAD" ? undefined : pageAssets.indexHtml);
    return { status: 200, note: "page" };
  }
  if (pathname === "/app.js") {
    if (!isRead) return rejectMethod(res, "the page script is read-only; use GET", "GET, HEAD");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(method === "HEAD" ? undefined : pageAssets.appJs);
    return { status: 200, note: "app.js" };
  }
  if (pathname === "/app.css") {
    if (!isRead) return rejectMethod(res, "the page stylesheet is read-only; use GET", "GET, HEAD");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(method === "HEAD" ? undefined : pageAssets.appCss);
    return { status: 200, note: "app.css" };
  }

  const apiMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  if (apiMatch !== null) {
    if (!isRead) return rejectMethod(res, "run detail is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    const detail = getRunDetail(db, apiMatch[1] ?? "");
    if (detail === null) return rejectNotFound(res, "no such run");
    sendJson(res, 200, { schemaVersion: 1, run: detail });
    return { status: 200, note: "run-detail" };
  }

  // ---- M5-01: the run-graph view and the guarded node-edit endpoint -------
  const graphEditMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/graph\/edits$/.exec(pathname);
  if (graphEditMatch !== null) {
    return await serveGraphEdit(db, graphEditMatch[1] ?? "", method, query, req, res);
  }

  const graphMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/graph$/.exec(pathname);
  if (graphMatch !== null) {
    if (!isRead) return rejectMethod(res, "the run graph is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    const graph = getRunGraphView(db, graphMatch[1] ?? "");
    if (graph === null) return rejectNotFound(res, "no such run");
    sendJson(res, 200, { schemaVersion: 1, graph });
    return { status: 200, note: `run-graph:${String(graph.nodes.length)}` };
  }

  // ---- M5-02: the controlled-expansion view and the forwarded request -----
  const expansionMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/expansions$/.exec(pathname);
  if (expansionMatch !== null) {
    if (isRead) return serveExpansionView(db, expansionMatch[1] ?? "", query, res);
    return await serveExpansionRequest(db, expansionMatch[1] ?? "", method, query, req, res);
  }

  // ---- M5-03: approvals (A17), the candidate diff (A12) and the context ----
  //     inventory views.
  const approvalsMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/approvals$/.exec(pathname);
  if (approvalsMatch !== null) {
    if (!isRead) return rejectMethod(res, "the approval view is read-only; decisions use POST /api/v1/approvals/:id/decision", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    const view = getRunApprovalView(db, approvalsMatch[1] ?? "");
    if (view === null) return rejectNotFound(res, "no such run");
    sendJson(res, 200, { schemaVersion: 1, approval: view });
    return { status: 200, note: `run-approvals:${String(view.approvals.length)}` };
  }

  const decisionMatch = /^\/api\/v1\/approvals\/([A-Za-z0-9_-]{1,128})\/decision$/.exec(pathname);
  if (decisionMatch !== null) {
    return await serveApprovalDecision(db, decisionMatch[1] ?? "", method, query, req, res);
  }

  const diffMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/diff$/.exec(pathname);
  if (diffMatch !== null) {
    if (!isRead) return rejectMethod(res, "the candidate diff is read-only; use GET", "GET, HEAD");
    return await serveDiffView(db, diffMatch[1] ?? "", query, res);
  }

  const contextsMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/contexts$/.exec(pathname);
  if (contextsMatch !== null) {
    if (!isRead) return rejectMethod(res, "the context view is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    const view = getRunContextView(db, contextsMatch[1] ?? "");
    if (view === null) return rejectNotFound(res, "no such run");
    sendJson(res, 200, { schemaVersion: 1, context: view });
    return { status: 200, note: `run-contexts:${String(view.bundles.length)}` };
  }

  // ---- M5-04: the redacted diagnostic export (A36/A42) --------------------
  const diagnosticsMatch = /^\/api\/v1\/runs\/([A-Za-z0-9_-]{1,128})\/diagnostics$/.exec(pathname);
  if (diagnosticsMatch !== null) {
    if (!isRead) return rejectMethod(res, "the diagnostic export is read-only; use GET", "GET, HEAD");
    return serveDiagnostics(db, diagnosticsMatch[1] ?? "", query, res);
  }

  if (pathname === "/api/v1/session") {
    if (!isRead) return rejectMethod(res, "the session view is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    // For the already-authenticated local operator only: the session-bound
    // CSRF token the page must echo back on mutating requests (x-csrf-token).
    sendJson(res, 200, { schemaVersion: 1, csrfToken: runtime.csrfToken });
    return { status: 200, note: "session" };
  }

  const executionMatch = /^\/api\/v1\/executions\/([A-Za-z0-9_-]{1,128})(?:\/(events|dispatch))?$/.exec(
    pathname
  );
  if (executionMatch !== null) {
    const executionId = executionMatch[1] ?? "";
    const sub = executionMatch[2];
    if (sub === undefined) return serveExecutionStatus(db, executionId, method, query, res);
    if (sub === "events") return serveEvents(db, executionId, method, query, res);
    return serveDispatchSkeleton(executionId, method, query, req, res);
  }

  return rejectNotFound(res, "unknown path");
}

function serveExecutionStatus(
  db: DatabaseSync,
  executionId: string,
  method: string,
  query: URLSearchParams,
  res: ServerResponse
): RouteOutcome {
  if (method !== "GET" && method !== "HEAD") {
    return rejectMethod(res, "execution status is read-only; use GET", "GET, HEAD");
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const status = getExecutionStatus(db, executionId);
  if (status === null) return rejectNotFound(res, "no such execution");
  sendJson(res, 200, { schemaVersion: 1, execution: status });
  return { status: 200, note: "execution-status" };
}

function serveEvents(
  db: DatabaseSync,
  executionId: string,
  method: string,
  query: URLSearchParams,
  res: ServerResponse
): RouteOutcome {
  if (method !== "GET" && method !== "HEAD") {
    return rejectMethod(res, "the event log is read-only; use GET", "GET, HEAD");
  }
  const parsedQuery = EventsQuerySchema.safeParse(Object.fromEntries(query.entries()));
  if (!parsedQuery.success) {
    return rejectQuery(res, "query parameters must be after (>=0) and limit (1..200); others are rejected");
  }
  const page = listExecutionEventViews(db, executionId, {
    after: parsedQuery.data.after,
    limit: parsedQuery.data.limit
  });
  if (page === null) return rejectNotFound(res, "no such execution");
  sendJson(res, 200, { schemaVersion: 1, executionId, events: page.events });
  return { status: 200, note: `events:${String(page.events.length)}` };
}

/**
 * The M5-04 diagnostic export (A36/A42). The bytes were built through
 * redactJsonValue + redactText BEFORE this function runs (see
 * diagnostics.ts) — the response body and the on-disk file are the SAME
 * redacted bytes. `format=json` (default) serves `application/json` with an
 * attachment disposition — with `nosniff` and the strict CSP a JSON body has
 * no script surface. `format=html` serves the script-free report rendered
 * ONLY from the redacted document (every dynamic value escaped, zero
 * <script> elements), under the same strict CSP.
 */
function serveDiagnostics(
  db: DatabaseSync,
  runId: string,
  query: URLSearchParams,
  res: ServerResponse
): RouteOutcome {
  const parsedQuery = DiagnosticsQuerySchema.safeParse(Object.fromEntries(query.entries()));
  if (!parsedQuery.success) {
    return rejectQuery(res, "the only accepted query parameter is format (json|html); others are rejected");
  }
  const build = buildRunDiagnosticExport(db, runId, { generatedAt: new Date().toISOString() });
  if (build === null) return rejectNotFound(res, "no such run");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (parsedQuery.data.format === "html") {
    const html = renderDiagnosticHtml(build);
    const payload = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(payload.length)
    });
    res.end(res.req?.method === "HEAD" ? undefined : payload);
    return { status: 200, note: `diagnostics-html:${String(build.byteCount)}` };
  }
  const payload = Buffer.from(build.json, "utf8");
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="diagnostic-${runId}.json"`,
    "Content-Length": String(payload.length)
  });
  res.end(res.req?.method === "HEAD" ? undefined : payload);
  return { status: 200, note: `diagnostics-json:${String(build.byteCount)}` };
}

/**
 * The M5-01 graph-edit endpoint (A02/A38). Full guard pipeline (session
 * token, Origin, session-bound CSRF) has passed when this runs. Order of
 * refusals, each with its explicit code:
 *   1. malformed JSON / wrong shape → 400 INPUT_REJECTED;
 *   2. ANY override-vocabulary key (model/profile/...) at any depth →
 *      403 PROFILE_OVERRIDE_REJECTED — the A02 API layer, before schema
 *      parsing so a carrier is never even schema-checked away;
 *   3. strict schema (unknown fields, bad types, empty patch) → 400;
 *   4. dag's typed domain rules via applyRunNodeEdit: stale revision →
 *      409 GRAPH_REVISION_CONFLICT, running/finished node → 409
 *      NODE_NOT_EDITABLE, invalid post-edit graph → 400 (A08 codes),
 *      unknown run/node → 404.
 * A successful edit NEVER starts an execution — it persists the change as a
 * NEW graph revision; scheduling remains the existing chain's job.
 */
async function serveGraphEdit(
  db: DatabaseSync,
  runId: string,
  method: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if (method !== "POST") {
    return rejectMethod(res, "graph edits are mutating; use POST", "POST");
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(
      res,
      "the edit body must be JSON with expectedGraphRevision, nodeId and patch"
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  // A02 API layer — refuse override carriers before anything else sees them.
  const overrideKey = findOverrideFieldKey(parsedBody);
  if (overrideKey !== null) {
    sendError(
      res,
      403,
      "PROFILE_OVERRIDE_REJECTED",
      `the edit body carries the override field "${overrideKey}"; node edits cannot set model/Profile ` +
        "(A02: configuration resolves only through Project RoleBinding -> pinned ProfileRevision)"
    );
    return { status: 403, note: "profile-override-rejected" };
  }
  const parsed = GraphEditBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the edit body must carry expectedGraphRevision (>=0), nodeId and a patch with at least one of " +
        "role (four built-ins) / objective / dependencies; unknown fields are rejected"
    );
  }
  try {
    const result = applyRunNodeEdit(db, runId, parsed.data);
    sendJson(res, 200, {
      schemaVersion: 1,
      runId: result.runId,
      revision: result.revision,
      node: result.node
    });
    return { status: 200, note: `graph-edit:${String(result.revision)}` };
  } catch (error) {
    if (error instanceof GraphEditRejectionError) {
      // Structured details (e.g. currentGraphRevision on a 409, A38) ride on
      // the JSON body beside the error envelope so the client can refresh and
      // retry without parsing the message.
      const extras = Object.keys(error.details).length === 0 ? {} : { ...error.details };
      sendJson(res, error.statusCode, {
        error: { code: error.code, message: error.message },
        ...extras
      });
      return { status: error.statusCode, note: error.code.toLowerCase() };
    }
    // LocalApiStateError (composition-root faults) and anything else: the
    // outer catch would redact-and-500 anyway; keep the message redacted.
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * The M5-02 controlled-expansion endpoints.
 *
 * GET — the Proposal view (pending fail triggers with findings, executed
 * expansions with their requester, the unresolved A20 hold, budget headroom).
 *
 * POST — a UI-initiated expansion FORWARDED to expand's
 * `requestControlledExpansion`. Order of refusals, each explicit:
 *   1. malformed JSON / wrong shape → 400 INPUT_REJECTED;
 *   2. ANY override-vocabulary key at any depth → 403
 *      PROFILE_OVERRIDE_REJECTED (the A02 API layer, before schema parsing);
 *   3. strict schema → 400;
 *   4. expand's typed domain gates via mapExpansionError: disabled
 *      subtask-permission / no binding → 403 EXPANSION_PERMISSION_DENIED
 *      (reason durably audited, A04); stale revision → 409
 *      GRAPH_REVISION_CONFLICT with currentGraphRevision (A38); rounds
 *      exhausted / run held / no fail verdict / not a review node → 409;
 *      budget exhausted (64 nodes / depth 16) → 400
 *      GRAPH_BUDGET_EXCEEDED with limit and actual; unknown run/node → 404.
 * A successful expansion NEVER starts an execution.
 */
async function serveExpansionView(
  db: DatabaseSync,
  runId: string,
  query: URLSearchParams,
  res: ServerResponse
): Promise<RouteOutcome> {
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const view = getRunExpansionView(db, runId);
  if (view === null) return rejectNotFound(res, "no such run");
  sendJson(res, 200, { schemaVersion: 1, expansion: view });
  return { status: 200, note: `run-expansions:${String(view.expansions.length)}` };
}

async function serveExpansionRequest(
  db: DatabaseSync,
  runId: string,
  method: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if (method !== "POST") {
    return rejectMethod(res, "the expansion view is read-only; expansions are mutating; use POST", "GET, HEAD, POST");
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(
      res,
      "the expansion body must be JSON with expectedGraphRevision, reviewNodeId, candidateSha and requesterRoleId"
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  // A02 API layer — refuse override carriers before anything else sees them.
  const overrideKey = findOverrideFieldKey(parsedBody);
  if (overrideKey !== null) {
    sendError(
      res,
      403,
      "PROFILE_OVERRIDE_REJECTED",
      `the expansion body carries the override field "${overrideKey}"; expansions cannot set model/Profile ` +
        "(A02: configuration resolves only through Project RoleBinding -> pinned ProfileRevision)"
    );
    return { status: 403, note: "profile-override-rejected" };
  }
  const parsed = ExpansionBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the expansion body must carry expectedGraphRevision (>=0), reviewNodeId, candidateSha " +
        "(40-hex) and requesterRoleId (four built-ins); repairedNodeId is optional; unknown fields are rejected"
    );
  }
  try {
    const result = applyRunExpansion(db, runId, parsed.data);
    sendJson(res, result.created ? 201 : 200, { schemaVersion: 1, ...result });
    return { status: result.created ? 201 : 200, note: `expansion:${String(result.generation)}` };
  } catch (error) {
    const mapped = mapExpansionError(runId, error);
    if (mapped instanceof GraphEditRejectionError) {
      // Structured details (currentGraphRevision on a 409, denialReason on a
      // 403) ride on the JSON body beside the error envelope so the client
      // can refresh/retry or show the audited reason without parsing text.
      const extras = Object.keys(mapped.details).length === 0 ? {} : { ...mapped.details };
      sendJson(res, mapped.statusCode, {
        error: { code: mapped.code, message: mapped.message },
        ...extras
      });
      return { status: mapped.statusCode, note: mapped.code.toLowerCase() };
    }
    // LocalApiStateError (composition-root faults): the outer catch would
    // redact-and-500 anyway; keep the message redacted.
    sendError(res, 500, "INTERNAL", redactText(mapped.message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * The M5-03 approval-decision endpoint (A17). Full guard pipeline (session
 * token, Origin, session-bound CSRF) has passed when this runs. Order of
 * refusals, each with its explicit code:
 *   1. malformed JSON / wrong shape → 400 INPUT_REJECTED (reject without a
 *      reason is a 400 too);
 *   2. ANY override-vocabulary key at any depth → 403
 *      PROFILE_OVERRIDE_REJECTED (the A02 API layer, before schema parsing);
 *   3. applyApprovalDecision's mapping: unknown approval → 404; candidate
 *      changed / already decided → 409 APPROVAL_INVALIDATED (A17); expired →
 *      409 APPROVAL_EXPIRED.
 * A decision NEVER executes the action, NEVER consumes the approval and
 * NEVER starts an execution — consumption stays with the checkpoint
 * continuation, which re-checks the actionDigest (A17/A18).
 */
async function serveApprovalDecision(
  db: DatabaseSync,
  approvalId: string,
  method: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if (method !== "POST") {
    return rejectMethod(res, "approval decisions are mutating; use POST", "POST");
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(
      res,
      "the decision body must be JSON with decision (approve|reject), decidedBy and, for reject, a reason"
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  // A02 API layer — refuse override carriers before anything else sees them.
  const overrideKey = findOverrideFieldKey(parsedBody);
  if (overrideKey !== null) {
    sendError(
      res,
      403,
      "PROFILE_OVERRIDE_REJECTED",
      `the decision body carries the override field "${overrideKey}"; decisions cannot set model/Profile ` +
        "(A02: configuration resolves only through Project RoleBinding -> pinned ProfileRevision)"
    );
    return { status: 403, note: "profile-override-rejected" };
  }
  const parsed = ApprovalDecisionBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the decision body must carry decision (approve|reject), decidedBy (1..128 chars) and, " +
        "for reject, a reason (1..2000 chars); unknown fields are rejected"
    );
  }
  const request: ApprovalDecisionRequest = {
    decision: parsed.data.decision,
    decidedBy: parsed.data.decidedBy,
    ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {})
  };
  try {
    const result = applyApprovalDecision(db, approvalId, request);
    sendJson(res, 200, { schemaVersion: 1, ...result });
    return { status: 200, note: `approval-decision:${result.status.toLowerCase()}` };
  } catch (error) {
    const mapped = mapApprovalDecisionError(error);
    if (mapped instanceof GraphEditRejectionError) {
      // Structured details (currentCandidateSha on the A17 409) ride on the
      // JSON body beside the error envelope.
      const extras = Object.keys(mapped.details).length === 0 ? {} : { ...mapped.details };
      sendJson(res, mapped.statusCode, {
        error: { code: mapped.code, message: mapped.message },
        ...extras
      });
      return { status: mapped.statusCode, note: mapped.code.toLowerCase() };
    }
    sendError(res, 500, "INTERNAL", redactText(mapped.message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * The M5-03 candidate-diff endpoint (A12). Read-only; the only accepted
 * query parameter is `nodeId`. The diff itself is git-sourced (M2-04/M2-05
 * semantics) through the worktree GitRunner; failures of git reality against
 * the durable record surface as 409 DIFF_SOURCE_UNAVAILABLE, a node outside
 * the run as 404.
 */
async function serveDiffView(
  db: DatabaseSync,
  runId: string,
  query: URLSearchParams,
  res: ServerResponse
): Promise<RouteOutcome> {
  const parsedQuery = DiffQuerySchema.safeParse(Object.fromEntries(query.entries()));
  if (!parsedQuery.success) {
    return rejectQuery(res, "the diff route requires exactly one query parameter: nodeId");
  }
  try {
    const view = await getRunDiffView(db, diffGitRunner, runId, parsedQuery.data.nodeId);
    if (view === null) return rejectNotFound(res, "no such run");
    sendJson(res, 200, { schemaVersion: 1, diff: view });
    return {
      status: 200,
      note: `run-diff:${view.nodeId}:${String(view.diff?.files.length ?? 0)}`
    };
  } catch (error) {
    if (error instanceof GraphEditRejectionError) {
      sendJson(res, error.statusCode, {
        error: { code: error.code, message: error.message },
        ...(Object.keys(error.details).length === 0 ? {} : { ...error.details })
      });
      return { status: error.statusCode, note: error.code.toLowerCase() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * The authenticated mutation skeleton: full guard pipeline (session token,
 * Origin, session-bound CSRF) has passed when this runs; the actual launch
 * orchestration is a later milestone, so the endpoint answers with an
 * honest typed 501 instead of pretending to dispatch.
 */
async function serveDispatchSkeleton(
  executionId: string,
  method: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if (method !== "POST") {
    return rejectMethod(res, "dispatch is a mutating endpoint; use POST", "POST");
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length > 0) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      return rejectQuery(res, "request body must be valid JSON");
    }
    if (!DispatchBodySchema.safeParse(parsedBody).success) {
      return rejectQuery(res, "dispatch accepts no fields in this milestone; unknown fields are rejected");
    }
  }
  sendError(
    res,
    501,
    "NOT_IMPLEMENTED",
    `dispatch orchestration for execution "${executionId}" is not implemented in this milestone; authentication checks are complete`
  );
  return { status: 501, note: "dispatch-skeleton" };
}

export async function startLocalApiServer(options: LocalApiServerOptions): Promise<LocalApiServer> {
  const { db } = options;
  const requestedPort = options.port ?? 0;

  // ---- 1. session token in a current-user-only file ------------------------
  const token = generateSessionToken();
  const tokenFile =
    options.tokenFile ??
    join(tmpdir(), "role-orchestrator-local-api", `session-token-${randomBytes(8).toString("hex")}.txt`);
  writeSessionTokenFile(tokenFile, token);

  // ---- 2. loopback binding with post-listen assertion ----------------------
  const runtime: RuntimeBinding = { port: 0, token, csrfToken: "" };
  const server = createServer((req, res) => {
    void handleRequest(db, runtime, req, res);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, LOOPBACK_ADDRESS, () => resolve());
    });
  } catch (error) {
    throw new LocalApiConfigurationError(
      `cannot bind the local API to ${LOOPBACK_ADDRESS}:${String(requestedPort)}`,
      { cause: error }
    );
  }
  const address = server.address();
  if (address === null || typeof address !== "object" || address.address !== LOOPBACK_ADDRESS) {
    server.close();
    throw new LocalApiConfigurationError(
      `server did not bind to ${LOOPBACK_ADDRESS}; refusing to serve (observed ${JSON.stringify(address)})`
    );
  }
  runtime.port = address.port;

  // ---- 3. session-bound CSRF token ----------------------------------------
  runtime.csrfToken = deriveCsrfToken(token, randomBytes(32));

  // ---- 4. M5-04 live-event WebSocket endpoint -----------------------------
  // Attached AFTER the loopback assertion so the upgrade guard always sees
  // the final port; tokens for its first-message auth are the same session
  // token, compared constant-time (ws-events.ts).
  const eventStream = attachEventStreamServer(server, db, { port: runtime.port, token }, options.eventStream);

  return {
    port: address.port,
    boundAddress: LOOPBACK_ADDRESS,
    token,
    csrfToken: runtime.csrfToken,
    tokenFile,
    server,
    eventStream,
    close: () =>
      new Promise<void>((resolve) => {
        void eventStream.close().then(() => {
          server.close(() => resolve());
        });
      })
  };
}
