import { describe, expect, it } from "vitest";
import {
  checkBearerToken,
  checkCsrfToken,
  checkHostHeader,
  checkOriginHeader,
  isKnownMethod,
  isLoopbackRemoteAddress,
  isMutatingMethod
} from "../src/index.js";

const PORT = 5151;
const TOKEN = "token-value-for-guard-tests-only";

describe("checkHostHeader (A30 + DNS-rebinding)", () => {
  it("accepts exactly 127.0.0.1:<port> and localhost:<port>", () => {
    expect(checkHostHeader(`127.0.0.1:${PORT}`, PORT)).toEqual({ ok: true });
    expect(checkHostHeader(`localhost:${PORT}`, PORT)).toEqual({ ok: true });
    expect(checkHostHeader(`LOCALHOST:${PORT}`, PORT)).toEqual({ ok: true }); // case-insensitive
  });

  it("rejects missing, portless, wrong-port and bracketed forms with 400", () => {
    for (const host of [undefined, "", `127.0.0.1:${PORT + 1}`, `localhost:${PORT + 1}`, "127.0.0.1", "localhost"]) {
      const decision = checkHostHeader(host, PORT);
      expect(decision.ok).toBe(false);
      expect(decision.ok ? null : decision.statusCode).toBe(400);
    }
  });

  it("rejects rebinding domains and dot-forms even when they resolve to loopback", () => {
    for (const host of [
      `attacker.example:${PORT}`, // resolves to 127.0.0.1 in the attack — still refused
      `127.0.0.1.nip.io:${PORT}`,
      `127.0.0.1.:${PORT}`,
      `[::1]:${PORT}`,
      `localhost.evil:${PORT}`,
      `127.0.0.1:${PORT} extra`
    ]) {
      const decision = checkHostHeader(host, PORT);
      expect(decision.ok).toBe(false);
      expect(decision.ok ? null : decision.code).toBe("HOST_NOT_ALLOWED");
    }
  });
});

describe("checkOriginHeader (A30)", () => {
  it("accepts a missing Origin for reads and both loopback origins", () => {
    expect(checkOriginHeader(undefined, PORT, false)).toEqual({ ok: true });
    expect(checkOriginHeader(`http://127.0.0.1:${PORT}`, PORT, false)).toEqual({ ok: true });
    expect(checkOriginHeader(`http://localhost:${PORT}`, PORT, true)).toEqual({ ok: true });
  });

  it("requires an Origin for mutating requests", () => {
    const decision = checkOriginHeader(undefined, PORT, true);
    expect(decision.ok).toBe(false);
    expect(decision.ok ? null : decision.statusCode).toBe(403);
    expect(decision.ok ? null : decision.code).toBe("ORIGIN_REQUIRED");
  });

  it("rejects cross-site, rebinding, wrong-port, https and null origins with 403", () => {
    for (const origin of [
      "https://evil.example",
      `http://attacker.example:${PORT}`,
      `http://127.0.0.1:${PORT + 1}`,
      `https://127.0.0.1:${PORT}`,
      `http://localhost.evildomain:${PORT}`,
      "null",
      "not-a-url"
    ]) {
      const decision = checkOriginHeader(origin, PORT, false);
      expect(decision.ok).toBe(false);
      expect(decision.ok ? null : decision.statusCode).toBe(403);
      expect(decision.ok ? null : decision.code).toBe("ORIGIN_NOT_ALLOWED");
    }
  });
});

describe("checkBearerToken", () => {
  it("accepts the exact session token", () => {
    expect(checkBearerToken(`Bearer ${TOKEN}`, TOKEN)).toEqual({ ok: true });
  });

  it("rejects missing, malformed and wrong tokens with 403", () => {
    for (const [header, expectedCode] of [
      [undefined, "TOKEN_REQUIRED"],
      ["", "TOKEN_MALFORMED"],
      [`Basic ${TOKEN}`, "TOKEN_MALFORMED"],
      ["Bearer", "TOKEN_MALFORMED"],
      [`Bearer ${TOKEN}x`, "TOKEN_INVALID"]
    ] as const) {
      const decision = checkBearerToken(header, TOKEN);
      expect(decision.ok).toBe(false);
      expect(decision.ok ? null : decision.statusCode).toBe(403);
      expect(decision.ok ? null : decision.code).toBe(expectedCode);
    }
  });
});

describe("checkCsrfToken", () => {
  const CSRF = "csrf-value-for-guard-tests";

  it("accepts the session-bound value", () => {
    expect(checkCsrfToken(CSRF, CSRF)).toEqual({ ok: true });
  });

  it("rejects missing and wrong values with 403", () => {
    expect(checkCsrfToken(undefined, CSRF).ok).toBe(false);
    const decision = checkCsrfToken(`${CSRF}x`, CSRF);
    expect(decision.ok).toBe(false);
    expect(decision.ok ? null : decision.statusCode).toBe(403);
    expect(decision.ok ? null : decision.code).toBe("CSRF_INVALID");
  });
});

describe("method classification", () => {
  it("treats GET/HEAD as reads and POST/PUT/PATCH/DELETE as mutating", () => {
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isMutatingMethod(method)).toBe(true);
    }
    for (const method of ["TRACE", "CONNECT", "OPTIONS", "PROPFIND", ""]) {
      expect(isKnownMethod(method)).toBe(false);
      expect(isMutatingMethod(method)).toBe(false);
    }
  });
});

describe("isLoopbackRemoteAddress", () => {
  it("accepts loopback forms and rejects everything else", () => {
    expect(isLoopbackRemoteAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("::1")).toBe(true);
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackRemoteAddress("::ffff:192.168.1.10")).toBe(false);
    expect(isLoopbackRemoteAddress(undefined)).toBe(false);
  });
});
