import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LocalApiServer } from "../src/index.js";
import { buildStaticPageAssets, startLocalApiServer } from "../src/index.js";
import {
  createTestDb,
  rawRequest,
  rawSocketRequest,
  seedHostileEvents,
  seedMatrixData,
  type MatrixSeed
} from "./helpers.js";

let server: LocalApiServer;
let dbHandle: ReturnType<typeof createTestDb>;
let seed: MatrixSeed;

beforeAll(async () => {
  dbHandle = createTestDb("matrix");
  seed = seedMatrixData(dbHandle.db);
  seedHostileEvents(dbHandle.db, seed.executionId);
  server = await startLocalApiServer({ db: dbHandle.db, tokenFile: undefined });
});

afterAll(async () => {
  await server?.close();
  dbHandle?.close();
});

const api = (path: string): string => `/api/v1/${path}`;

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("loopback binding assertion", () => {
  it("binds exactly 127.0.0.1 as observed by the kernel", async () => {
    expect(server.boundAddress).toBe("127.0.0.1");
    const address = server.server.address();
    expect(address).not.toBeNull();
    expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(server.port).toBeGreaterThan(0);
  });

  it("writes the session token to a file and serves its own csrf token", () => {
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("A30 forgery matrix — every forged request is refused", () => {
  // Path is computed per test: `seed` is only populated in beforeAll.
  const path = (): string => api(`executions/${seed.executionId}/events`);

  it("rejects a DNS-rebinding Host (attacker.example resolving to 127.0.0.1)", async () => {
    const response = await rawRequest(server.port, {
      path: path(),
      headers: { host: `attacker.example:${server.port}`, ...authHeaders(server.token) }
    });
    expect(response.status).toBe(400);
    expect(response.body).toContain("HOST_NOT_ALLOWED");
  });

  it("rejects a request with no Host header at all", async () => {
    const response = await rawSocketRequest(
      server.port,
      `GET ${path()} HTTP/1.1\r\nConnection: close\r\n\r\n`
    );
    // Node's HTTP parser itself refuses a Host-less HTTP/1.1 request with a
    // bare 400 before any handler could run — the refusal happens even
    // earlier than the guard pipeline's HOST_REQUIRED branch.
    expect(response.status).toBe(400);
    expect(response.body).not.toContain('"events"');
  });

  it("rejects a wrong-port Host", async () => {
    const response = await rawRequest(server.port, {
      path: path(),
      headers: { host: `127.0.0.1:${server.port + 1}`, ...authHeaders(server.token) }
    });
    expect(response.status).toBe(400);
  });

  it("rejects a cross-site Origin (malicious web page)", async () => {
    const response = await rawRequest(server.port, {
      path: path(),
      headers: { origin: "https://evil.example", ...authHeaders(server.token) }
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("ORIGIN_NOT_ALLOWED");
  });

  it("rejects a rebinding-shaped Origin even with a valid token", async () => {
    const response = await rawRequest(server.port, {
      path: path(),
      headers: { origin: `http://attacker.example:${server.port}`, ...authHeaders(server.token) }
    });
    expect(response.status).toBe(403);
  });

  it("rejects an API call without the session token", async () => {
    const response = await rawRequest(server.port, { path: path() });
    expect(response.status).toBe(403);
    expect(response.body).toContain("TOKEN_REQUIRED");
  });

  it("rejects an API call with a wrong token", async () => {
    const response = await rawRequest(server.port, {
      path: path(),
      headers: { authorization: `Bearer ${"A".repeat(43)}` }
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("TOKEN_INVALID");
  });

  it("rejects the mutating endpoint without the CSRF token", async () => {
    const response = await rawRequest(server.port, {
      method: "POST",
      path: api(`executions/${seed.executionId}/dispatch`),
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        ...authHeaders(server.token)
      }
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("CSRF_REQUIRED");
  });

  it("rejects the mutating endpoint with a wrong CSRF token", async () => {
    const response = await rawRequest(server.port, {
      method: "POST",
      path: api(`executions/${seed.executionId}/dispatch`),
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": `${server.csrfToken}x`,
        ...authHeaders(server.token)
      }
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("CSRF_INVALID");
  });

  it("rejects unknown methods (TRACE) and wrong methods (PUT) with 405", async () => {
    const trace = await rawRequest(server.port, { method: "TRACE", path: "/" });
    expect(trace.status).toBe(405);

    // PUT passes the guard pipeline (known, mutating, fully authenticated)
    // and is then refused at the routing level as a wrong method.
    const put = await rawRequest(server.port, {
      method: "PUT",
      path: api(`runs/${seed.runId}`),
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": server.csrfToken,
        ...authHeaders(server.token)
      }
    });
    expect(put.status).toBe(405);
    expect(put.body).toContain("METHOD_NOT_ALLOWED");
  });

  it("never emits CORS headers on any response", async () => {
    const response = await rawRequest(server.port, {
      path: api(`executions/${seed.executionId}`),
      headers: { origin: `http://127.0.0.1:${server.port}`, ...authHeaders(server.token) }
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("positive loopback flows", () => {
  it("serves execution status with secret fields projected away", async () => {
    const response = await rawRequest(server.port, {
      path: api(`executions/${seed.executionId}`),
      headers: authHeaders(server.token)
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      execution: Record<string, unknown>;
    };
    expect(body.execution).toMatchObject({ id: seed.executionId, phase: "RUNNING" });
    expect(JSON.stringify(body)).not.toContain(`dt-${seed.executionId}`); // dispatch token never leaves
    expect(JSON.stringify(body)).not.toContain("executionNonce");
  });

  it("serves run detail including its attempts", async () => {
    const response = await rawRequest(server.port, {
      path: api(`runs/${seed.runId}`),
      headers: authHeaders(server.token)
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { run: { executions: unknown[] } };
    expect(body.run.executions).toHaveLength(1);
  });

  it("returns 404 for unknown ids (after auth passes)", async () => {
    const response = await rawRequest(server.port, {
      path: api("executions/exec-missing"),
      headers: authHeaders(server.token)
    });
    expect(response.status).toBe(404);
  });

  it("rejects unknown query parameters (unknown fields default-deny)", async () => {
    const response = await rawRequest(server.port, {
      path: `${api(`executions/${seed.executionId}`)}?evil=1`,
      headers: authHeaders(server.token)
    });
    expect(response.status).toBe(400);
    expect(response.body).toContain("INPUT_REJECTED");
  });

  it("completes the authenticated mutation skeleton with an honest 501", async () => {
    const response = await rawRequest(server.port, {
      method: "POST",
      path: api(`executions/${seed.executionId}/dispatch`),
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": server.csrfToken,
        ...authHeaders(server.token)
      },
      body: ""
    });
    expect(response.status).toBe(501);
    expect(response.body).toContain("NOT_IMPLEMENTED");
  });

  it("accepts an empty JSON object body on the skeleton and rejects unknown fields", async () => {
    const ok = await rawRequest(server.port, {
      method: "POST",
      path: api(`executions/${seed.executionId}/dispatch`),
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": server.csrfToken,
        "content-type": "application/json",
        ...authHeaders(server.token)
      },
      body: "{}"
    });
    expect(ok.status).toBe(501);

    const fields = await rawRequest(server.port, {
      method: "POST",
      path: api(`executions/${seed.executionId}/dispatch`),
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": server.csrfToken,
        "content-type": "application/json",
        ...authHeaders(server.token)
      },
      body: '{"profileId":"override-attempt"}'
    });
    expect(fields.status).toBe(400);
    expect(fields.body).toContain("INPUT_REJECTED");
  });

  it("serves the static page assets byte-identical to the tested module output", async () => {
    const assets = buildStaticPageAssets();
    const page = await rawRequest(server.port, { path: "/" });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toBe(assets.indexHtml);
    const script = await rawRequest(server.port, { path: "/app.js" });
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toContain("application/javascript");
    expect(script.body).toBe(assets.appJs);
    const stylesheet = await rawRequest(server.port, { path: "/app.css" });
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.body).toBe(assets.appCss);
    // Static routes carry the same SECURITY_HEADERS as every other response.
    for (const response of [page, script, stylesheet]) {
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    }
  });

  it("sets strict security headers on API responses", async () => {
    const response = await rawRequest(server.port, {
      path: api(`executions/${seed.executionId}`),
      headers: authHeaders(server.token)
    });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("A36 output redaction and event paging", () => {
  it("redacts stored secrets before serving events; paging works", async () => {
    const response = await rawRequest(server.port, {
      path: api(`executions/${seed.executionId}/events`),
      headers: authHeaders(server.token)
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      schemaVersion: number;
      executionId: string;
      events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.executionId).toBe(seed.executionId);
    expect(body.events).toHaveLength(5);

    const text = JSON.stringify(body);
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9"); // bearer value gone
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).toContain("api-key=[REDACTED]");
    expect(text).toContain("token=short stays"); // negative sample preserved

    // The stored HTML is served as JSON data (render-time escaping is the
    // page's job and is tested separately against the served script).
    const scriptEvent = body.events.find((event) => event.seq === 2);
    expect(scriptEvent?.payload["html"]).toContain("<script>");

    const after = await rawRequest(server.port, {
      path: `${api(`executions/${seed.executionId}/events`)}?after=3&limit=1`,
      headers: authHeaders(server.token)
    });
    const afterBody = JSON.parse(after.body) as { events: Array<{ seq: number }> };
    expect(afterBody.events.map((event) => event.seq)).toEqual([4]);
  });
});
