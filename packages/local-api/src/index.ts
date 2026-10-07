/**
 * @role-orchestrator/local-api — public entry point (M1-04).
 *
 * Loopback-only authenticated local API over node:http:
 *  - token: 256-bit session token, current-user-only token file,
 *    constant-time compares, session-bound CSRF derivation;
 *  - guard: fail-closed Host / Origin / CSRF / DNS-rebinding checks (A30);
 *  - views: read-only run / execution / event views over the store with
 *    secret-field projection and content redaction before output (A36);
 *    the redaction implementation itself is the shared @role-orchestrator/
 *    cli-events module, re-exported here (this API's egress pass is the
 *    SECOND layer; the engine already redacts before persisting);
 *  - sanitize: HTML escaping / ANSI stripping for the events page;
 *  - page: no-build static HTML + vanilla JS assets that escape every
 *    dynamic text before DOM insertion (A36);
 *  - server: 127.0.0.1-only listener with post-listen address assertion,
 *    strict response headers, no CORS, and the M9 orchestration surface
 *    (POST /api/v1/runs — 202 Accepted, async drive since M9-02 — +
 *    GET /api/v1/runs + GET /api/v1/profiles; the former per-execution
 *    dispatch skeleton answers 410 ENDPOINT_RETIRED). Since M9-03 also the
 *    profiles config-file surface: GET/PUT /api/v1/profiles/full (view +
 *    atomic write-back through the existing frozen parser);
 *  - profiles-config (M9-03): the read / atomic-write-back carrier behind
 *    /api/v1/profiles/full — strict JSON (frozen ProfilesFileSchema) via the
 *    EXISTING parser, temp-file + fsync + rename semantics, typed
 *    PROFILE_SOURCE_ABSENT / PROFILES_CONTENT_INVALID refusals;
 *  - ws-events (M5-04): the /api/v1/events/live WebSocket endpoint —
 *    guard-pipelined upgrades, first-message auth, cursor replay with
 *    at-least-once delivery deduped by eventId, byte-budgeted pages with
 *    bufferedAmount flow control, terminal notices (A39/A30);
 *  - diagnostics (M5-04): the redacted run-diagnostic export — graph +
 *    executions + events + memory references + approvals through
 *    redactJsonValue + redactText BEFORE any sink, transcript fields and
 *    memory full-text replaced by references (A42), script-free HTML;
 *  - serve (M8-03a): run this package as a standalone process for the
 *    desktop shell — zod-strict CLI parsing (--db/--port), store open
 *    (no implicit mkdir), the one-line listening diagnostic (a hint, never
 *    a success verdict) and an idempotent shutdown handle. Since M11-02 a
 *    declared-but-absent --profiles file is the honest first-run state
 *    (zero loaded profiles, source path remembered for setup first-run);
 *  - cli-discovery (M11-02): READ-ONLY claude/codex auto-discovery — PATH
 *    directories, ~/.local/bin, npm global prefix from the environment;
 *    pure functions over an injected file probe, zero shell, zero process
 *    execution (canary-pinned);
 *  - setup (M11-02): the first-run domain behind GET /api/v1/setup/status
 *    (zod-pinned view) and POST /api/v1/setup/first-run (default profiles
 *    through the existing atomic primitives; idempotent by refusal; no
 *    hot-reload — restartRequired is stated, never faked).
 */
export * from "./errors.js";
export * from "./orchestrator.js";
export * from "./token.js";
export * from "./guard.js";
export * from "./cli-discovery.js";
export * from "./setup.js";
export {
  DEFAULT_REDACTION_PATTERNS,
  SECRET_PLACEHOLDER,
  entropyBitsPerChar,
  redactJsonValue,
  redactText,
  type RedactionOptions,
  type RedactionPattern,
  type RedactionResult
} from "@role-orchestrator/cli-events";
export * from "./sanitize.js";
export * from "./views.js";
export * from "./graph.js";
export * from "./expansion.js";
export * from "./approval-view.js";
export * from "./diff-view.js";
export * from "./context-view.js";
export * from "./diagnostics.js";
export * from "./profiles-config.js";
export * from "./ws-events.js";
export * from "./app-ui.js";
export * from "./page.js";
export * from "./server.js";
export * from "./serve.js";
