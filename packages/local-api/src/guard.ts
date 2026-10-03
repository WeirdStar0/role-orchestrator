/**
 * Request guard pipeline (A30: "外部网页请求 localhost API/WS →
 * Host/Origin/会话检查阻止访问"), per docs/SECURITY_MODEL.md:
 *
 *   1. remote address must be loopback (defence in depth beyond binding);
 *   2. Host header must be EXACTLY `127.0.0.1:<port>` or `localhost:<port>`
 *      — this is also the DNS-rebinding defence: `attacker.example` that
 *      resolves to 127.0.0.1 still sends `Host: attacker.example:<port>`,
 *      which never matches the allowlist (and neither do dotless-portless,
 *      bracketed-IPv6 or trailing-dot forms);
 *   3. every API request must carry `Authorization: Bearer <session token>`;
 *      a forged web page has no way to read the user-only token file;
 *   4. an Origin header, WHEN PRESENT, must be an allowed loopback origin
 *      (`http://127.0.0.1:<port>` / `http://localhost:<port>`) — cross-site
 *      origins are refused; mutating requests additionally REQUIRE the
 *      origin (a browser same-site fetch always sends it);
 *   5. mutating requests must carry the session-bound CSRF token.
 *
 * All checks return typed decisions instead of throwing, so every forged
 * request maps to an explicit 400/403/405 with an actionable reason. Secret
 * comparisons run in constant time (token + CSRF).
 */
import { constantTimeEquals } from "./token.js";

export type GuardRejectCode = 400 | 403 | 405;

export interface GuardAccept {
  readonly ok: true;
}

export interface GuardReject {
  readonly ok: false;
  readonly statusCode: GuardRejectCode;
  /** Machine-readable code for the error envelope. */
  readonly code: string;
  /** Actionable, secret-free reason (safe to send to the client and log). */
  readonly reason: string;
}

export type GuardDecision = GuardAccept | GuardReject;

export function guardAccept(): GuardAccept {
  return { ok: true };
}

export function guardReject(statusCode: GuardRejectCode, code: string, reason: string): GuardReject {
  return { ok: false, statusCode, code, reason };
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
/** Methods that never mutate state; everything else is treated as mutating. */
const READ_METHODS = new Set(["GET", "HEAD"]);
/** Methods this server understands at all; anything else is 405 before auth. */
const KNOWN_METHODS = new Set([...READ_METHODS, "POST", "PUT", "PATCH", "DELETE"]);

export function isKnownMethod(method: string): boolean {
  return KNOWN_METHODS.has(method);
}

export function isMutatingMethod(method: string): boolean {
  return isKnownMethod(method) && !READ_METHODS.has(method);
}

/**
 * The complete Allow header for the guard-level 405: every method this server
 * understands at all (KNOWN_METHODS), derived from the same set as
 * isKnownMethod so the header cannot drift from the predicate (M9-04 review
 * handover #63 — the previous hardcoded "GET, HEAD, POST" omitted PUT, PATCH
 * and DELETE, which this server does route). Per-route 405s answer through
 * the router's rejectMethod with the route-specific Allow value.
 */
export function allowedMethodsHeader(): string {
  return [...KNOWN_METHODS].join(", ");
}

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:127.0.0.1%0"]);

/** Defence in depth: even if the socket binding changed, refuse non-loopback peers. */
export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  return LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress.toLowerCase());
}

/**
 * DNS-rebinding-safe Host check (A30): the header must be exactly
 * `<loopback-hostname>:<expectedPort>`. Any other form — a rebinding domain
 * (`attacker.example:3000` pointing at 127.0.0.1), a portless host, an
 * IPv6 bracket form, or a trailing-dot FQDN — is rejected with 400.
 */
export function checkHostHeader(hostHeader: string | undefined, expectedPort: number): GuardDecision {
  if (hostHeader === undefined || hostHeader.trim() === "") {
    return guardReject(400, "HOST_REQUIRED", "request has no Host header; a loopback host with the exact port is required");
  }
  const host = hostHeader.trim().toLowerCase();
  for (const hostname of LOOPBACK_HOSTNAMES) {
    if (host === `${hostname}:${expectedPort}`) {
      return guardAccept();
    }
  }
  return guardReject(
    400,
    "HOST_NOT_ALLOWED",
    `Host header must be exactly "127.0.0.1:${expectedPort}" or "localhost:${expectedPort}"; ` +
      "other hosts (including DNS-rebinding domains) are refused"
  );
}

function isAllowedLoopbackOrigin(origin: string, expectedPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  // URL normalizes the default port away; the server never listens on 80,
  // so an explicit port match is the only accepted form.
  return parsed.port === String(expectedPort);
}

/**
 * Origin check (A30). Read requests accept a MISSING Origin (curl-style
 * same-machine clients never send one) but never a mismatched one.
 * Mutating requests require a valid loopback Origin: a cross-site form POST
 * or fetch always carries `Origin: https://attacker.example`, which lands
 * here as 403 before any handler runs.
 */
export function checkOriginHeader(
  origin: string | undefined,
  expectedPort: number,
  mutating: boolean
): GuardDecision {
  if (origin === undefined || origin.trim() === "") {
    if (mutating) {
      return guardReject(
        403,
        "ORIGIN_REQUIRED",
        "mutating requests must carry a loopback Origin header matching this server"
      );
    }
    return guardAccept();
  }
  const trimmed = origin.trim();
  // The `null` origin (sandboxed iframe / redirected POST) is never allowed.
  if (trimmed.toLowerCase() === "null") {
    return guardReject(403, "ORIGIN_NOT_ALLOWED", "Origin \"null\" is not an allowed loopback origin");
  }
  if (isAllowedLoopbackOrigin(trimmed, expectedPort)) {
    return guardAccept();
  }
  return guardReject(
    403,
    "ORIGIN_NOT_ALLOWED",
    `Origin "${trimmed}" is not an allowed loopback origin for this server; cross-site requests are refused`
  );
}

/**
 * Session-token check: the header must be exactly `Bearer <token>` and the
 * token must match the server's session token in constant time. Missing,
 * malformed and wrong tokens are all a plain 403 — no distinction that
 * could help an attacker probe the token space.
 */
export function checkBearerToken(authorization: string | undefined, sessionToken: string): GuardDecision {
  if (authorization === undefined) {
    return guardReject(403, "TOKEN_REQUIRED", "API requests must carry the session token as \"Authorization: Bearer <token>\"");
  }
  const match = /^Bearer\s+(.+)$/.exec(authorization.trim());
  if (match === null || match[1] === undefined) {
    return guardReject(403, "TOKEN_MALFORMED", "Authorization header must have the form \"Bearer <token>\"");
  }
  if (!constantTimeEquals(match[1], sessionToken)) {
    return guardReject(403, "TOKEN_INVALID", "the presented session token is not valid for this server");
  }
  return guardAccept();
}

/**
 * CSRF check for mutating requests: the `x-csrf-token` header must equal
 * the token derived from the session (constant-time compare). A cross-site
 * page that somehow obtained a valid session token still cannot guess the
 * session-bound CSRF value, and cannot read it cross-origin either.
 */
export function checkCsrfToken(csrfHeader: string | undefined, expectedCsrfToken: string): GuardDecision {
  if (csrfHeader === undefined || csrfHeader.trim() === "") {
    return guardReject(403, "CSRF_REQUIRED", "mutating requests must carry the session-bound CSRF token in \"x-csrf-token\"");
  }
  if (!constantTimeEquals(csrfHeader.trim(), expectedCsrfToken)) {
    return guardReject(403, "CSRF_INVALID", "the presented CSRF token is not valid for this session");
  }
  return guardAccept();
}
