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
 *
 * M9-01 "点火" replaces the authenticated dispatch SKELETON with real
 * orchestration: `POST /api/v1/runs` (orchestrator.ts) creates a run over a
 * real user directory — strict body {objective, projectDir} (M10-01:
 * profileId removed; see the M10-01 paragraph below),
 * fail-closed project validation — and the serve process drives it through
 * the scheduler + engine chain with the loaded profiles; `GET /api/v1/runs`
 * is the minimal task list. Approval checkpoints produced during a run go
 * through the EXISTING guarded approval surface (view + decision endpoint);
 * nothing here batch-grants or bypasses A17. The per-execution
 * `/dispatch` path answers 410 ENDPOINT_RETIRED — dispatch semantics moved
 * to run creation (see orchestrator.ts for the drive model).
 *
 * M9-02 "工作台" makes the served page open ON the task workbench and
 * decouples creation from the drive: `POST /api/v1/runs` answers 202
 * Accepted with {runId, status: "queued"} as soon as the fast creation chain
 * settles (orchestrator.ts) — the response never waits behind an in-flight
 * node execution — and `GET /api/v1/profiles` serves the loaded profiles
 * (id/runtime/executionTarget/model/timeoutSeconds only) behind the same
 * guard pipeline; the workbench page renders the new-task form, the run
 * list and the per-run live progress (WS) while the M5 observatory moves
 * under the 高级 tab unchanged.
 *
 * M9-03 "角色与模型配置页" adds the profiles CONFIG FILE surface and the
 * shell-side wiring close-out: `GET /api/v1/profiles/full` serves the
 * source path + the file's current full text + its parse result through the
 * EXISTING frozen ProfilesFileSchema parser, `PUT /api/v1/profiles/full`
 * validates the submitted text through the SAME parser and atomically
 * replaces the source file (temp file + fsync + rename; a refusal — 400
 * shape, 422 parse, 409 absent source — never touches the original). A
 * process without a profiles source answers 409 PROFILE_SOURCE_ABSENT on
 * both routes (the honest 壳未接线 state the config page guides on). The
 * served page gains the 配置 tab (view/editor/atomic write-back) next to
 * 工作台 and 高级.
 *
 * M10-01 "创建任务零副作用" removes the last creation-time configuration
 * write: POST /api/v1/runs no longer carries `profileId` (BREAKING — a body
 * that still sends it is a plain 400 unknown-field) and never writes
 * role_bindings; it READS the project's existing bindings, refuses with 422
 * ROLE_BINDINGS_INCOMPLETE when any of the four roles is unbound, and
 * otherwise freezes them exactly as M9-01 did (snapshot chain unchanged).
 * Profile configuration moves to its own guarded surface:
 * `PUT /api/v1/projects/:id/role-bindings` (strict body, exactly the four
 * built-in roles, loaded-profiles-only, executionTarget mismatch → typed
 * 422 instead of the M9-01-era 500) and `GET
 * /api/v1/projects/role-bindings?projectDir=<abs>` (the workbench page's
 * read-only view of the developer binding, resolved by repo root).
 *
 * M11-02 "首启零配置" adds the setup surface (setup.ts owns the domain):
 * `GET /api/v1/setup/status` — READ-ONLY CLI auto-discovery (claude/codex
 * through PATH directories, ~/.local/bin and the npm global prefix taken
 * from the environment ONLY; zero shell, zero process execution of probed
 * paths — cli-discovery.ts and its canary test pin the red line) plus the
 * current profiles-file state and the recommended default role→runtime
 * template; and `POST /api/v1/setup/first-run` — generates the default
 * profiles.json (recommended combination, safe bounds) through the EXISTING
 * atomic write-back primitives. First-run is IDEMPOTENT BY REFUSAL (409
 * PROFILES_ALREADY_CONFIGURED when the current file parses with ≥1
 * profile), never hot-reloads (the response carries restartRequired: true),
 * and answers honestly when there is no wired profiles source (409) or no
 * CLI is found (422 CLIS_NOT_FOUND with the miss list).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { redactText } from "@role-orchestrator/cli-events";
import { getProjectByRepoRoot } from "@role-orchestrator/store";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import { listRoleBindings } from "@role-orchestrator/runtime-profile";
import { GitRunner } from "@role-orchestrator/worktree";
import {
  buildAppUiAsset,
  loadAppUiAssetFromModuleLocation,
  sha256Hex,
  type AppUiAsset
} from "./app-ui.js";
import {
  buildRunDiagnosticExport,
  renderDiagnosticHtml
} from "./diagnostics.js";
import {
  createOrchestrator,
  type CreatedRunView,
  type Orchestrator,
  type OrchestrationOptions,
  type ProjectRoleBindingsView,
  RunCreateBodySchema
} from "./orchestrator.js";
import { OrchestrationRejectionError } from "@role-orchestrator/orchestration";
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
  allowedMethodsHeader,
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
import { readProfilesFull, writeProfilesFullAtomic } from "./profiles-config.js";
import {
  applySetupFirstRun,
  buildSetupStatusView,
  createSetupService,
  SetupFirstRunBodySchema,
  type CliDiscoveryOptions,
  type SetupService
} from "./setup.js";
import { deriveCsrfToken, generateSessionToken, writeSessionTokenFile } from "./token.js";
import {
  getExecutionStatus,
  getRunDetail,
  listExecutionEventViews,
  listProjectSummaryViews,
  listRunSummaryViews
} from "./views.js";
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
  /**
   * M9-01: when provided, POST /api/v1/runs creates and DRIVES real runs
   * (orchestrator.ts). When absent the route answers 503
   * ORCHESTRATION_NOT_CONFIGURED — an honest refusal, never a pretend run.
   */
  readonly orchestration?: OrchestrationOptions | undefined;
  /**
   * M11-01: explicit override of the /app renderer HTML (tests, unusual
   * installs). When absent, the built artifact is located through
   * appUiCandidatePaths (install-adjacent desktop-ui.html, then the repo
   * dev layout). Absent artifact is NOT an error: /app then 302s to / (the
   * old page) so every deployment shape stays usable.
   */
  readonly appUiHtml?: string | undefined;
  /**
   * M11-02: injection points for the setup surface's READ-ONLY CLI
   * discovery (env snapshot / platform / regular-file probe). Absent
   * fields default to the real process environment, the host platform and
   * a statSync-based regular-file check. Discovery itself stays
   * request-time (an install while the server runs is picked up by the
   * next GET /api/v1/setup/status) and touches nothing but file metadata.
   */
  readonly cliDiscovery?: CliDiscoveryOptions | undefined;
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
  /** The M9-01 run orchestrator, when the server was started with one. */
  readonly orchestrator: Orchestrator | null;
  /**
   * M11-01: whether the /app renderer artifact was found and loaded. false
   * = /app 302s to the old page (absence degrades, never breaks).
   */
  readonly appUiPresent: boolean;
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
 * M11-01: the /app renderer asset, resolved from the build layout (override
 * flows through startLocalApiServer's appUiHtml option). null = artifact
 * absent/unparsable — the honest state the /app route answers with a 302 to
 * the old page.
 *
 * M11-02 review handover B: the locator is app-ui.ts's SINGLE
 * fileURLToPath-based loader (the previously dead export — the inline
 * `new URL(…).pathname.replace(…)` hand-decode that stood in for it mangled
 * install paths containing spaces or non-ASCII characters, because
 * `.pathname` keeps percent-escapes encoded; fileURLToPath is the canonical
 * decoder). Resolution is LAZY — the first server start, not module import:
 * importing this module no longer touches the filesystem at all.
 */
let defaultAppUiAssetCache: AppUiAsset | null | undefined;
function defaultAppUiAsset(): AppUiAsset | null {
  defaultAppUiAssetCache ??= loadAppUiAssetFromModuleLocation(
    (candidate) => existsSync(candidate),
    (candidate) => {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        return null;
      }
    }
  );
  return defaultAppUiAssetCache;
}

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

/**
 * M10-02 error-carrier inversion (strategy ⑦): the orchestration package
 * refuses with its OWN typed family; this serving layer maps a refusal to
 * the SAME wire envelope the former in-package GraphEditRejectionError
 * produced — status, machine code, message text and structured details all
 * verbatim (the runs-orchestration HTTP contract suite, zero test changes,
 * is the regression anchor proving the mapping byte-identical). The DOMAIN
 * decides status+code; the HTTP layer only forwards (errors.ts philosophy).
 */
function mapOrchestrationRejection(error: unknown): GraphEditRejectionError | null {
  return error instanceof OrchestrationRejectionError
    ? new GraphEditRejectionError(error.statusCode, error.code, error.message, {
        cause: error,
        details: error.details
      })
    : null;
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

/**
 * M9-03 profiles write-back body. STRICT: the only field is `content` — the
 * FULL profiles-file text (strict JSON per the M9-01 serve contract) to be
 * validated by the existing frozen ProfilesFileSchema parser and then
 * atomically written back to the source path. There is deliberately no other
 * field: the endpoint edits one file and nothing else. The 1 MiB HTTP body
 * cap bounds the envelope; 1,000,000 characters leave room for the JSON
 * framing while staying inside it. (No A02 carrier scan here — unlike graph
 * edits/expansions/decisions, this endpoint's entire purpose IS the profile
 * definition file, the configuration surface where `model` is a frozen
 * ProfileConfig field; the envelope itself carries no other key to scan.)
 */
const ProfilesFullWriteBodySchema = z.strictObject({
  content: z.string().min(1).max(1_000_000)
});

/**
 * M10-01 role-bindings write body. STRICT: exactly one field `bindings`, an
 * array of EXACTLY FOUR {roleId, profileId} entries — one per built-in role,
 * no duplicates (a partial or ambiguous configuration is refused before any
 * write). roleId reuses the frozen contracts RoleIdSchema (A03); profileId
 * the frozen IdSchema. There is deliberately NO model/revision/permission
 * field: a binding pins the profile's LATEST revision at bind time (the
 * runtime-profile service's own semantics) and the coordinator's
 * canCreateSubtasks follows the shipped convention; the per-role permission
 * surface is not an HTTP input. Whether each profileId exists among the
 * LOADED profiles is a typed domain check (422 UNKNOWN_PROFILE), not a
 * schema concern.
 */
const RoleBindingsWriteBodySchema = z
  .strictObject({
    bindings: z
      .array(
        z.strictObject({
          roleId: RoleIdSchema,
          profileId: IdSchema
        })
      )
      .length(4)
  })
  .refine(
    (body) => new Set(body.bindings.map((entry) => entry.roleId)).size === body.bindings.length,
    { message: "bindings must contain each of the four built-in roles exactly once (no duplicates)" }
  );

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
  orchestrator: Orchestrator | null,
  appUi: AppUiAsset | null,
  setup: SetupService,
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
      // Allow lists EVERY method this server understands, derived from the
      // same set the predicate above consults (M9-04 review handover #63:
      // the hardcoded "GET, HEAD, POST" was incomplete).
      sendError(res, 405, "METHOD_NOT_ALLOWED", `method ${method} is not supported`, {
        Allow: allowedMethodsHeader()
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
    const outcome = await routeRequest(db, runtime, orchestrator, appUi, setup, {
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
  orchestrator: Orchestrator | null,
  appUi: AppUiAsset | null,
  setup: SetupService,
  parsed: ParsedRequest,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  const { method, pathname, query } = parsed;
  const isRead = method === "GET" || method === "HEAD";

  // ---- M11-01: the registered-project list (read-only, guard-gated like
  //      every /api route). The new UI's project picker consumes repoRoot +
  //      createdAt ONLY — internal ids are deliberately NOT served here so
  //      they cannot reach any default view. Directory browsing/registration
  //      stays future scope (M11-03).
  if (pathname === "/api/v1/projects") {
    if (!isRead) return rejectMethod(res, "the projects list is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    const list = listProjectSummaryViews(db);
    sendJson(res, 200, { schemaVersion: 1, ...list });
    return { status: 200, note: `projects:${String(list.projects.length)}` };
  }

  // ---- M9-01: run creation + the minimal task list ------------------------
  if (pathname === "/api/v1/runs") {
    if (isRead) {
      if ([...query.keys()].length > 0) {
        return rejectQuery(res, "unknown query parameters are not accepted");
      }
      const list = listRunSummaryViews(db);
      sendJson(res, 200, { schemaVersion: 1, ...list });
      return { status: 200, note: `run-list:${String(list.runs.length)}` };
    }
    if (method !== "POST") {
      return rejectMethod(res, "the runs collection answers GET (list) and POST (create)", "GET, HEAD, POST");
    }
    return await serveRunCreate(orchestrator, query, req, res);
  }

  // ---- M9-02: the minimal profiles list (the new-task form's dropdown) ----
  // Read-only, guard-gated like every /api route. Served from the SAME
  // validated definitions POST /api/v1/runs selects from; a process started
  // without orchestration answers an honest empty list (it can drive nothing
  // and offers nothing to select).
  if (pathname === "/api/v1/profiles") {
    if (!isRead) return rejectMethod(res, "the profiles list is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    const profiles = orchestrator === null ? [] : orchestrator.listProfiles();
    sendJson(res, 200, { schemaVersion: 1, profiles });
    return { status: 200, note: `profiles:${String(profiles.length)}` };
  }

  // ---- M9-03: the profiles CONFIG FILE surface (view + atomic write-back) -
  // Same guard pipeline as every /api route (token; CSRF on the mutating
  // PUT). GET serves the source path, the file's CURRENT full text and its
  // parse result; PUT validates the submitted text through the EXISTING
  // frozen ProfilesFileSchema parser and atomically replaces the source file
  // (temp file + rename; a refusal never touches the original). A process
  // without a profiles source (no --profiles, or in-process orchestration
  // without a file) answers 409 PROFILE_SOURCE_ABSENT on BOTH routes — the
  // honest "壳未接线/未传 --profiles" state the config page guides on.
  if (pathname === "/api/v1/profiles/full") {
    if (isRead) return serveProfilesFullGet(orchestrator, query, res);
    if (method !== "PUT") {
      return rejectMethod(
        res,
        "the profiles config answers GET (view) and PUT (atomic write-back)",
        "GET, HEAD, PUT"
      );
    }
    return await serveProfilesFullPut(orchestrator, query, req, res);
  }

  // ---- M10-01: project role bindings — the ONLY profile-selection write ----
  // GET /api/v1/projects/role-bindings?projectDir=<abs> is the workbench
  // page's read-only lookup (repo root -> project -> the four binding rows,
  // unbound roles included as nulls so the page can guide). PUT
  // /api/v1/projects/:id/role-bindings configures all four roles in one
  // guarded, all-or-nothing call. Both pass the same guard pipeline as every
  // /api route (token; CSRF on the mutating PUT).
  if (pathname === "/api/v1/projects/role-bindings") {
    if (!isRead) {
      return rejectMethod(
        res,
        "the projectDir binding lookup is read-only; configuration is PUT /api/v1/projects/:id/role-bindings",
        "GET, HEAD"
      );
    }
    return serveProjectBindingsByDir(db, query, res);
  }
  const projectBindingsMatch = /^\/api\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/role-bindings$/.exec(pathname);
  if (projectBindingsMatch !== null) {
    if (isRead) {
      return rejectMethod(
        res,
        "project role bindings answer PUT (configure); read them via GET /api/v1/projects/role-bindings?projectDir=<abs>",
        "PUT"
      );
    }
    if (method !== "PUT") {
      return rejectMethod(
        res,
        "project role bindings answer PUT (configure); use GET /api/v1/projects/role-bindings?projectDir=<abs> to read",
        "PUT"
      );
    }
    return await serveProjectBindingsPut(orchestrator, projectBindingsMatch[1] ?? "", query, req, res);
  }

  // ---- M11-02: first-run zero-config setup --------------------------------
  // GET /api/v1/setup/status — READ-ONLY detection (cli-discovery.ts: file
  // probing only, zero shell, zero process execution) + the current
  // profiles-file state + the recommended default role→runtime template;
  // the response shape is zod-pinned (setup.ts). POST
  // /api/v1/setup/first-run — the ONE setup write: generates the default
  // profiles.json through the EXISTING atomic primitives, idempotent by
  // refusal, never hot-reloads (restartRequired: true). Both pass the same
  // guard pipeline as every /api route (token; CSRF on the mutating POST).
  if (pathname === "/api/v1/setup/status") {
    if (!isRead) return rejectMethod(res, "the setup status is read-only; use GET", "GET, HEAD");
    if ([...query.keys()].length > 0) {
      return rejectQuery(res, "unknown query parameters are not accepted");
    }
    return serveSetupStatus(setup, orchestrator, res);
  }
  if (pathname === "/api/v1/setup/first-run") {
    if (isRead) return rejectMethod(res, "first-run is a mutating setup action; use POST", "POST");
    if (method !== "POST") {
      return rejectMethod(res, "first-run answers POST only", "POST");
    }
    return await serveSetupFirstRun(setup, orchestrator, query, req, res);
  }

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

  // ---- M11-01: the desktop renderer at /app (and every /app/* deep link;
  //      the SPA is one inline single-file HTML with a content-hash CSP).
  //      When the built artifact is absent (old installer / unbuilt tree)
  //      the route answers 302 -> / so the operator always lands on a
  //      working page — absence degrades to the old UI, never to a 404.
  //      The OLD page and its assets (/ /app.js /app.css) are untouched:
  //      "/app" (no extension) never collides with "/app.js".
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    if (!isRead) return rejectMethod(res, "the app renderer is read-only; use GET", "GET, HEAD");
    if (appUi === null) {
      // M11-02 review handover H: the degradation redirect carries the SAME
      // security headers as every other response — a 302 is still a response
      // (the Location target is served with its own headers; these cover
      // this one).
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      res.setHeader("Location", "/");
      res.writeHead(302, { "Content-Length": "0" });
      res.end();
      return { status: 302, note: "app-ui-absent-redirect" };
    }
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    // The strict per-build CSP (inline content hash-pinned) replaces the
    // generic header for THIS route only.
    res.setHeader("Content-Security-Policy", appUi.cspHeader);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(method === "HEAD" ? undefined : appUi.html);
    return { status: 200, note: "app-ui" };
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
    return await serveApprovalDecision(db, orchestrator, decisionMatch[1] ?? "", method, query, req, res);
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
    return serveDispatchRetired(executionId, method, res);
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
  orchestrator: Orchestrator | null,
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
    // M9-01: the decision itself never executes anything (A17 — consumption
    // stays with the checkpoint continuation). When this process drives runs,
    // an APPROVED checkpoint is the one signal that wakes the pump, which
    // then performs exactly the digest-bound continuation.
    if (orchestrator !== null && result.status === "APPROVED") {
      orchestrator.onApprovalDecided(approvalId);
    }
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
 * M9-01: the per-execution dispatch SKELETON (an honest 501 through M8) is
 * retired — dispatch semantics moved to run creation (`POST /api/v1/runs`,
 * orchestrator.ts owns the scheduler/engine drive). The path still answers,
 * so an old client gets a machine-readable, guarded refusal instead of a
 * 404: 410 ENDPOINT_RETIRED with the migration pointer. The guard pipeline
 * (token, Origin, CSRF) has already passed when this runs.
 */
function serveDispatchRetired(executionId: string, method: string, res: ServerResponse): RouteOutcome {
  if (method !== "POST") {
    return rejectMethod(res, "this path only ever accepted POST; it is retired", "POST");
  }
  sendError(
    res,
    410,
    "ENDPOINT_RETIRED",
    `execution-level dispatch for "${executionId}" is retired since M9-01: orchestration is ` +
      "run-level — create a run with POST /api/v1/runs and the server drives its executions"
  );
  return { status: 410, note: "dispatch-retired" };
}

/**
 * M9-01 run creation (see orchestrator.ts for the drive model and the M10-01
 * A02 stance). Full guard pipeline (session token, Origin, session-bound
 * CSRF) has passed when this runs. Order of refusals:
 *   1. orchestration not configured in this process → 503;
 *   2. malformed JSON / strict schema (unknown fields — including any
 *      `model` carrier AND, since M10-01, `profileId` — bad bounds) → 400
 *      INPUT_REJECTED;
 *   3. typed domain gates via GraphEditRejectionError: projectDir not
 *      absolute / missing / not a directory / not a git repo (400,
 *      fail-closed before anything is written), incomplete role bindings
 *      (422 ROLE_BINDINGS_INCOMPLETE — creation is READ-ONLY over them).
 * M9-02: a SUCCESSFUL creation answers 202 Accepted (async drive — the
 * response no longer waits behind an in-flight node execution on the serial
 * drive chain; orchestrator.ts owns the creation/drive chain split).
 * M10-01 BREAKING: the body no longer carries `profileId` (v0.2.0 did). The
 * executing profile resolves through the project's role bindings, which
 * creation freezes but never writes; configuration lives at PUT
 * /api/v1/projects/:id/role-bindings.
 */
async function serveRunCreate(
  orchestrator: Orchestrator | null,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if (orchestrator === null) {
    sendError(
      res,
      503,
      "ORCHESTRATION_NOT_CONFIGURED",
      "this server process was started without orchestration (no profiles/worktrees configured); " +
        "runs cannot be created here — see orchestrator.ts / serve --profiles"
    );
    return { status: 503, note: "orchestration-not-configured" };
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(res, "the run body must be JSON with objective and projectDir (an absolute path to an existing git directory)");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  const parsed = RunCreateBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the run body must carry objective (1..10000 chars, not blank) and projectDir (absolute path to an " +
        "existing git directory); profileId is no longer accepted (M10-01: the executing profile comes " +
        "from the project role bindings — configure them via PUT /api/v1/projects/:id/role-bindings); " +
        "unknown fields are rejected"
    );
  }
  try {
    const created: CreatedRunView = await orchestrator.createRun(parsed.data);
    // M9-02: 202 Accepted — the response returns as soon as the run row
    // exists and its drive is enqueued (the creation chain, orchestrator.ts);
    // the pump drives the run asynchronously. `status` is the accept state
    // ("queued"), never a pretend terminal state; the durable row status is
    // polled at statusEndpoint with the frozen vocabulary's values.
    sendJson(res, 202, { schemaVersion: 1, ...created });
    return { status: 202, note: `run-accepted:${created.runId}` };
  } catch (error) {
    // M10-02: the driver's typed refusal (its OWN error family since the
    // extraction) maps to the same envelope verbatim; local-api's own typed
    // refusals (schema layer etc.) pass through unchanged.
    const rejection = error instanceof GraphEditRejectionError ? error : mapOrchestrationRejection(error);
    if (rejection !== null) {
      const extras = Object.keys(rejection.details).length === 0 ? {} : { ...rejection.details };
      sendJson(res, rejection.statusCode, {
        error: { code: rejection.code, message: rejection.message },
        ...extras
      });
      return { status: rejection.statusCode, note: rejection.code.toLowerCase() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * M9-03 GET /api/v1/profiles/full — the config page's data source: the
 * profiles source path, the file's CURRENT full text and the parse result
 * derived from THAT text through the existing frozen parser. Order of
 * refusals:
 *   1. unknown query parameters → 400;
 *   2. no profiles source in this process (no orchestration, or in-process
 *      composition without a file) → 409 PROFILE_SOURCE_ABSENT — the honest
 *      "壳未接线/未传 --profiles" state; no path is invented;
 *   3. the file itself is gone/unreadable → 409 PROFILE_SOURCE_ABSENT
 *      (nothing to view, nothing to write back to);
 *   4. a currently unparseable file is still a VIEW (200 with rawText +
 *      parseError, profiles: null) so the editor can repair exactly what is
 *      on disk.
 */
function serveProfilesFullGet(
  orchestrator: Orchestrator | null,
  query: URLSearchParams,
  res: ServerResponse
): RouteOutcome {
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const sourcePath = orchestrator?.profilesSourcePath ?? null;
  if (sourcePath === null) {
    sendError(
      res,
      409,
      "PROFILE_SOURCE_ABSENT",
      "this server process has no profiles source file (the shell did not pass --profiles, or it " +
        "was started without orchestration); there is no config file to view or write back — " +
        "place the per-user profiles.json (see the desktop shell README) or start serve with --profiles <file.json>"
    );
    return { status: 409, note: "profile-source-absent" };
  }
  let view;
  try {
    view = readProfilesFull(sourcePath);
  } catch (error) {
    if (error instanceof GraphEditRejectionError) {
      sendError(res, error.statusCode, error.code, error.message);
      return { status: error.statusCode, note: error.code.toLowerCase() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
  sendJson(res, 200, { schemaVersion: 1, ...view });
  return {
    status: 200,
    note: view.parseError === null ? `profiles-full:${String(view.profiles?.length ?? 0)}` : "profiles-full-unparseable"
  };
}

/**
 * M9-03 PUT /api/v1/profiles/full — guarded atomic write-back of the
 * profiles config file. Full guard pipeline (session token, Origin,
 * session-bound CSRF) has passed when this runs. Order of refusals (kept in
 * sync with the code below; M9-04 review handover #54 — the doc previously
 * listed the 409 before the 400):
 *   1. unknown query parameters → 400;
 *   2. no profiles source → 409 PROFILE_SOURCE_ABSENT (nothing to write to;
 *      no file anywhere is touched);
 *   3. malformed JSON / strict envelope shape (only `content`, 1..1,000,000
 *      chars) → 400 INPUT_REJECTED;
 *   4. content that fails the EXISTING frozen ProfilesFileSchema parser →
 *      422 PROFILES_CONTENT_INVALID with the parser's readable reason; the
 *      original file is untouched (validation precedes any filesystem
 *      mutation);
 *   5. an OS-level write/rename failure (incl. the short-write refusal,
 *      profiles-config.ts) → 500 INTERNAL (redacted); the temp file is
 *      removed and the original is still untouched.
 * Success does NOT hot-reload this process: the running orchestrator keeps
 * its startup definitions; the write-back is picked up at the next serve
 * start (stated in the response note and on the config page).
 */
async function serveProfilesFullPut(
  orchestrator: Orchestrator | null,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const sourcePath = orchestrator?.profilesSourcePath ?? null;
  if (sourcePath === null) {
    sendError(
      res,
      409,
      "PROFILE_SOURCE_ABSENT",
      "this server process has no profiles source file (the shell did not pass --profiles, or it " +
        "was started without orchestration); there is nowhere to write the config back to — " +
        "the submitted content was validated against nothing and NO file was modified"
    );
    return { status: 409, note: "profile-source-absent" };
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(res, "the write-back body must be JSON with the full profiles file text in `content`");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  const parsed = ProfilesFullWriteBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the write-back body must carry exactly one field `content` (1..1000000 chars: the FULL " +
        "profiles file text, strict JSON matching the frozen ProfilesFileSchema); unknown fields are rejected"
    );
  }
  try {
    const profiles = writeProfilesFullAtomic(sourcePath, parsed.data.content);
    sendJson(res, 200, {
      schemaVersion: 1,
      sourcePath,
      bytesWritten: Buffer.byteLength(parsed.data.content, "utf8"),
      profiles,
      note:
        "atomic write-back complete (temp file + rename); the RUNNING process keeps its " +
        "startup-loaded profiles — restart serve to apply. After the write, NEW tasks run on " +
        "the revision frozen at the profile's first creation; later same-id edits (model " +
        "included) neither mint a new revision nor affect already-created tasks — to change a " +
        "model, create a profile with a different id. The drift gate (409 " +
        "PROFILE_DEFINITION_CONFLICT) compares exactly runtime/executable/executionTarget/" +
        "configDir/credentialGroup/maxConcurrency/timeoutSeconds (seven fields)"
    });
    return { status: 200, note: `profiles-full-written:${String(profiles.length)}` };
  } catch (error) {
    if (error instanceof GraphEditRejectionError) {
      sendError(res, error.statusCode, error.code, error.message);
      return { status: error.statusCode, note: error.code.toLowerCase() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * M10-01 PUT /api/v1/projects/:id/role-bindings — configure a project's four
 * role bindings in one guarded call (the ONLY profile-selection write
 * surface; task creation is read-only over bindings). Full guard pipeline
 * (session token, Origin, session-bound CSRF) has passed when this runs.
 * Order of refusals:
 *   1. orchestration not configured in this process → 503 (bindings may only
 *      point at loaded profiles; nothing else can validate them);
 *   2. unknown query parameters → 400;
 *   3. malformed JSON / strict schema (exactly four {roleId, profileId},
 *      each built-in role exactly once) → 400 INPUT_REJECTED;
 *   4. unknown project id → 404 PROJECT_NOT_FOUND;
 *   5. a profileId not among the loaded profiles → 422 UNKNOWN_PROFILE;
 *   6. profile definition drift (the seven-field gate) → 409
 *      PROFILE_DEFINITION_CONFLICT;
 *   7. executionTarget mismatch (A29, target-differ or path-form) → 422
 *      EXECUTION_TARGET_MISMATCH — the typed refusal the M9-01 era answered
 *      with a 500 (review-registered defect, fixed here);
 *   8. unknown profile/revision at the DB level → 422 (fail-closed).
 * The whole write is transactional: a refusal leaves the project's previous
 * bindings byte-identical. Success answers 200 with the four resulting
 * bindings (ROLE_IDS order, each pinned to the profile's latest revision).
 */
async function serveProjectBindingsPut(
  orchestrator: Orchestrator | null,
  projectId: string,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if (orchestrator === null) {
    sendError(
      res,
      503,
      "ORCHESTRATION_NOT_CONFIGURED",
      "this server process was started without orchestration (no profiles/worktrees configured); " +
        "role bindings may only point at loaded profiles, so none can be configured here — " +
        "see orchestrator.ts / serve --profiles"
    );
    return { status: 503, note: "orchestration-not-configured" };
  }
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(
      res,
      "the binding body must be JSON {bindings:[{roleId,profileId} x4]} — exactly the four built-in roles, no duplicates"
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  const parsed = RoleBindingsWriteBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the binding body must carry exactly one field `bindings`: four {roleId, profileId} entries " +
        "(coordinator/architect/developer/reviewer, each exactly once; profileId is one of the " +
        "loaded profiles); unknown fields are rejected"
    );
  }
  try {
    const view: ProjectRoleBindingsView = await orchestrator.setProjectRoleBindings(
      projectId,
      parsed.data.bindings
    );
    sendJson(res, 200, { schemaVersion: 1, ...view });
    return { status: 200, note: `role-bindings:${String(view.bindings.length)}` };
  } catch (error) {
    // M10-02: the driver's typed refusal (its OWN error family since the
    // extraction) maps to the same envelope verbatim.
    const rejection = error instanceof GraphEditRejectionError ? error : mapOrchestrationRejection(error);
    if (rejection !== null) {
      const extras = Object.keys(rejection.details).length === 0 ? {} : { ...rejection.details };
      sendJson(res, rejection.statusCode, {
        error: { code: rejection.code, message: rejection.message },
        ...extras
      });
      return { status: rejection.statusCode, note: rejection.code.toLowerCase() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
}

/**
 * M10-01 GET /api/v1/projects/role-bindings?projectDir=<abs> — the workbench
 * page's read-only developer-binding lookup. Read-only like every GET: the
 * session token guard has passed; no CSRF (not a mutating method). Order of
 * refusals:
 *   1. query must be EXACTLY one parameter projectDir → 400;
 *   2. projectDir not an absolute path → 400 PROJECT_DIR_NOT_ABSOLUTE;
 *   3. no project registered for that directory → 404 PROJECT_UNKNOWN (a
 *      project row appears with the first run creation; nothing is invented).
 * Success answers 200 with the project id, its executionTarget and ALL FOUR
 * binding rows in ROLE_IDS order — an unbound role is `{roleId, profileId:
 * null, ...}`, the honest state the page guides on. The endpoint NEVER
 * initializes rows: it renders what is.
 */
function serveProjectBindingsByDir(db: DatabaseSync, query: URLSearchParams, res: ServerResponse): RouteOutcome {
  const projectDir = query.get("projectDir");
  const extraKeys = [...query.keys()].filter((key) => key !== "projectDir");
  if (projectDir === null || projectDir === "" || extraKeys.length > 0) {
    return rejectQuery(res, "the binding lookup takes exactly one query parameter: projectDir (absolute path)");
  }
  if (!isAbsolute(projectDir)) {
    sendError(res, 400, "PROJECT_DIR_NOT_ABSOLUTE", "projectDir must be an absolute path");
    return { status: 400, note: "project-dir-not-absolute" };
  }
  // The projects table stores the repo root EXACTLY as its creator supplied
  // it (POST /runs stores the resolved path; composition roots that seed a
  // project from git's canonical report store git's forward-slash form). The
  // lookup therefore tries the resolved form first, then the raw string —
  // two reads, still zero writes, still fail-closed (PROJECT_UNKNOWN when
  // neither matches).
  const project = getProjectByRepoRoot(db, resolve(projectDir)) ?? getProjectByRepoRoot(db, projectDir);
  if (project === null) {
    sendError(
      res,
      404,
      "PROJECT_UNKNOWN",
      "no project is registered for this directory; a project row is created with the first " +
        "POST /api/v1/runs over the directory, after which its role bindings can be configured"
    );
    return { status: 404, note: "project-unknown" };
  }
  const bindings = listRoleBindings(db, project.id).map((row) => ({
    roleId: row.roleId,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    canCreateSubtasks: row.canCreateSubtasks
  }));
  sendJson(res, 200, {
    schemaVersion: 1,
    projectId: project.id,
    executionTarget: project.executionTarget,
    bindings
  });
  return { status: 200, note: `project-bindings:${String(bindings.length)}` };
}

/**
 * M11-02 GET /api/v1/setup/status — the first-run wizard's read-only data
 * source. Guard pipeline has passed when this runs (read: token only, no
 * CSRF). The view is built through setup.ts and zod-parsed there before it
 * is served: a code drift breaks loudly (500), never silently serves a
 * drifted shape. Refusals: unknown query parameters → 400. Detection is
 * request-time (an install while the server runs shows up on the next
 * poll) and pure file probing (cli-discovery.ts — zero shell, zero process
 * execution, zero privilege escalation).
 */
function serveSetupStatus(
  setup: SetupService,
  orchestrator: Orchestrator | null,
  res: ServerResponse
): RouteOutcome {
  const view = buildSetupStatusView({
    setup,
    profilesSourcePath: orchestrator?.profilesSourcePath ?? null,
    loadedProfiles: orchestrator === null ? 0 : orchestrator.listProfiles().length
  });
  sendJson(res, 200, view);
  return { status: 200, note: `setup-status:${String(view.profiles.usableProfiles)}` };
}

/**
 * M11-02 POST /api/v1/setup/first-run — the one setup write. Full guard
 * pipeline (session token, Origin, session-bound CSRF) has passed when this
 * runs. Order of refusals:
 *   1. unknown query parameters / malformed JSON / non-empty strict body
 *      (the endpoint takes NO parameters — any key, override vocabulary
 *      included, is a plain 400 INPUT_REJECTED; no A02 carrier scan needed
 *      because the schema is EMPTY-strict, the same reasoning as the
 *      profiles write-back envelope) → 400 INPUT_REJECTED;
 *   2. no profiles wiring → 409 PROFILE_SOURCE_ABSENT (no path invented);
 *   3. already-configured → 409 PROFILES_ALREADY_CONFIGURED (idempotent by
 *      refusal; the original file is untouched);
 *   4. neither CLI found → 422 CLIS_NOT_FOUND (details.notFound);
 *   5. no usable home directory → 422 HOME_DIRECTORY_UNAVAILABLE;
 *   6. the atomic primitives' own refusals (422/409) pass through.
 * Success never hot-reloads: the response carries `restartRequired: true`
 * plus an explicit note — the running process keeps its startup profiles
 * until the next serve start (the no-hot-reload constraint, stated
 * honestly for the wizard to surface).
 */
async function serveSetupFirstRun(
  setup: SetupService,
  orchestrator: Orchestrator | null,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse
): Promise<RouteOutcome> {
  if ([...query.keys()].length > 0) {
    return rejectQuery(res, "unknown query parameters are not accepted");
  }
  const body = await readBody(req);
  if (body.length === 0) {
    return rejectQuery(
      res,
      "the first-run body must be an empty JSON object {} — the endpoint takes no parameters and works from detection alone"
    );
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return rejectQuery(res, "request body must be valid JSON");
  }
  const parsed = SetupFirstRunBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return rejectQuery(
      res,
      "the first-run body must be exactly {}; unknown fields are rejected (detection drives everything)"
    );
  }
  try {
    const result = applySetupFirstRun({
      setup,
      profilesSourcePath: orchestrator?.profilesSourcePath ?? null
    });
    sendJson(res, 200, { schemaVersion: 1, ...result });
    return { status: 200, note: `first-run:${result.mode}:${String(result.profiles.length)}` };
  } catch (error) {
    if (error instanceof GraphEditRejectionError) {
      // Structured details (notFound on CLIS_NOT_FOUND, usableProfiles on
      // PROFILES_ALREADY_CONFIGURED) ride beside the error envelope so the
      // wizard can react without parsing message text.
      const extras = Object.keys(error.details).length === 0 ? {} : { ...error.details };
      sendJson(res, error.statusCode, {
        error: { code: error.code, message: error.message },
        ...extras
      });
      return { status: error.statusCode, note: error.code.toLowerCase() };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, "INTERNAL", redactText(message).text);
    return { status: 500, note: "internal-error" };
  }
}

export async function startLocalApiServer(options: LocalApiServerOptions): Promise<LocalApiServer> {
  const { db } = options;
  const requestedPort = options.port ?? 0;

  // ---- 0. M9-01 orchestrator (when configured) -----------------------------
  // Created BEFORE anything listens: a misconfigured orchestration option is
  // a startup fault, not a per-request surprise. Its construction is
  // synchronous (option validation + the worktrees-root mkdir).
  const orchestrator = options.orchestration === undefined ? null : createOrchestrator(db, options.orchestration);

  // ---- 1. session token in a current-user-only file ------------------------
  const token = generateSessionToken();
  const tokenFile =
    options.tokenFile ??
    join(tmpdir(), "role-orchestrator-local-api", `session-token-${randomBytes(8).toString("hex")}.txt`);
  writeSessionTokenFile(tokenFile, token);

  // ---- 2. loopback binding with post-listen assertion ----------------------
  const runtime: RuntimeBinding = { port: 0, token, csrfToken: "" };
  const appUiAsset: AppUiAsset | null =
    options.appUiHtml === undefined ? defaultAppUiAsset() : buildAppUiAsset(options.appUiHtml, sha256Hex);
  // M11-02: the setup service (read-only CLI discovery injection points).
  const setup = createSetupService(options.cliDiscovery);
  const server = createServer((req, res) => {
    void handleRequest(db, runtime, orchestrator, appUiAsset, setup, req, res);
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
    orchestrator,
    appUiPresent: appUiAsset !== null,
    close: () =>
      new Promise<void>((resolve) => {
        // M9-01 ordering: in-flight executions are cancelled through the
        // engine's tree-kill and the drive chain settles its DB writes
        // BEFORE the event stream and the listener close (the caller closes
        // the store after this resolves).
        const closeRest = (): void => {
          void eventStream.close().then(() => {
            server.close(() => resolve());
          });
        };
        if (orchestrator === null) {
          closeRest();
          return;
        }
        void orchestrator.shutdown().then(closeRest, closeRest);
      })
  };
}
