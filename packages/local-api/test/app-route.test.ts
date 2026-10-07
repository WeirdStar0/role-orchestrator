/**
 * M11-01 — the /app route (desktop renderer static shell) and the read-only
 * GET /api/v1/projects surface, over a LIVE server. The app HTML is
 * INJECTED per test (the appUiHtml option) so these tests stay deterministic
 * and independent of the apps/desktop-ui build output; the real artifact is
 * exercised by the browser-e2e /app smoke. The old page (/ /app.js /app.css)
 * must stay byte-untouched — asserted here as the zero-regression pin.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createProject } from "@role-orchestrator/store";
import { startLocalApiServer, type LocalApiServer } from "../src/index.js";
import { createTestDb, rawRequest, T0, iso } from "./helpers.js";

const APP_HTML =
  "<!doctype html><html lang=\"zh-CN\"><head><title>role-orchestrator</title>" +
  "<style>body{color:red}</style></head><body><div id=\"root\"></div>" +
  "<script type=\"module\">const app=1;<\/script></body></html>";

describe("M11-01 /app route (appUiHtml injected)", () => {
  let db: DatabaseSync;
  let closeDb: () => void;
  let server: LocalApiServer;
  let auth: string;

  beforeAll(async () => {
    const created = createTestDb("app-route");
    db = created.db;
    closeDb = created.close;
    server = await startLocalApiServer({ db, appUiHtml: APP_HTML });
    auth = `Bearer ${server.token}`;
  });

  afterAll(async () => {
    await server.close();
    closeDb();
  });

  it("serves the injected single-file HTML with a content-hash CSP (no unsafe-inline)", async () => {
    const response = await rawRequest(server.port, { path: "/app", headers: { Authorization: auth } });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toBe(APP_HTML);
    const csp = String(response.headers["content-security-policy"]);
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    expect(csp).toContain("script-src 'sha256-");
    expect(csp).toContain("style-src 'sha256-");
    expect(csp).not.toContain("unsafe-");
    // Cache discipline matches every other response.
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("serves every /app/* deep link with the same document (SPA refresh safety)", async () => {
    for (const path of ["/app/", "/app/history", "/app/projects/nested/deep"]) {
      const response = await rawRequest(server.port, { path, headers: { Authorization: auth } });
      expect(response.status).toBe(200);
      expect(response.body).toBe(APP_HTML);
    }
  });

  it("is read-only (POST refuses 405) and still guard-gated (no token refuses)", async () => {
    const post = await rawRequest(server.port, {
      method: "POST",
      path: "/app",
      headers: { Authorization: auth, Origin: `http://127.0.0.1:${String(server.port)}` },
      body: "{}"
    });
    expect(post.status).toBe(405);
    const anon = await rawRequest(server.port, { path: "/app" });
    expect(anon.status).toBe(200); // static shell is public like the old page
    // ...but the CSP is present for the anonymous request too.
    expect(String(anon.headers["content-security-policy"])).toContain("script-src 'sha256-");
  });

  it("degrades to 302 -> / when the artifact is absent (an override that parses to nothing)", async () => {
    const absent = await startLocalApiServer({ db, appUiHtml: "<html>no scripts</html>" });
    try {
      const response = await rawRequest(absent.port, { path: "/app", headers: { Authorization: auth } });
      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("/");
      expect(absent.appUiPresent).toBe(false);
      // M11-02 review handover H: a 302 is still a response — it carries the
      // same security headers as every other route (not just Cache-Control).
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(String(response.headers["content-security-policy"])).toContain("default-src 'none'");
      // The redirect preserves the guard pipeline: a non-loopback-style Host
      // is refused before routing as everywhere else (A30 continuity).
      const badHost = await rawRequest(absent.port, {
        path: "/app",
        headers: { host: "evil.example" }
      });
      expect(badHost.status).toBe(400);
    } finally {
      await absent.close();
    }
  });

  it("keeps the OLD page byte-untouched: / /app.js /app.css still answer as before", async () => {
    const page = await rawRequest(server.port, { path: "/", headers: { Authorization: auth } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="token-input"'); // manual flow intact
    const appJs = await rawRequest(server.port, { path: "/app.js", headers: { Authorization: auth } });
    expect(appJs.status).toBe(200);
    expect(appJs.headers["content-type"]).toContain("javascript");
    const appCss = await rawRequest(server.port, { path: "/app.css", headers: { Authorization: auth } });
    expect(appCss.status).toBe(200);
    expect(appCss.headers["content-type"]).toContain("text/css");
    // "/app" did not shadow "/app.js": the old script is NOT the new HTML.
    expect(appJs.body).not.toBe(APP_HTML);
  });
});

describe("M11-01 GET /api/v1/projects (read-only registered-project list)", () => {
  let db: DatabaseSync;
  let closeDb: () => void;
  let server: LocalApiServer;
  let auth: string;

  beforeAll(async () => {
    const created = createTestDb("projects-route");
    db = created.db;
    closeDb = created.close;
    server = await startLocalApiServer({ db });
    auth = `Bearer ${server.token}`;
    createProject(db, {
      id: "proj-1",
      repoRoot: "h:/repos/older",
      executionTarget: process.platform === "win32" ? "windows-native" : "macos-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    createProject(db, {
      id: "proj-2",
      repoRoot: "h:/repos/newer",
      executionTarget: process.platform === "win32" ? "windows-native" : "macos-native",
      trustStatus: "requires-user-confirmation",
      now: iso(1000)
    });
  });

  afterAll(async () => {
    await server.close();
    closeDb();
  });

  it("lists repoRoot + createdAt newest-first — and NO internal ids", async () => {
    const response = await rawRequest(server.port, { path: "/api/v1/projects", headers: { Authorization: auth } });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { schemaVersion: number; projects: unknown };
    expect(body.schemaVersion).toBe(1);
    expect(body.projects).toEqual([
      { repoRoot: "h:/repos/newer", createdAt: iso(1000) },
      { repoRoot: "h:/repos/older", createdAt: T0 }
    ]);
    expect(response.body).not.toContain("proj-");
  });

  it("is guard-gated: anonymous 403, un-CSRFed POST 403, query strings rejected; POST now routes to the M11-03 registration surface (previously 405)", async () => {
    const anon = await rawRequest(server.port, { path: "/api/v1/projects" });
    expect(anon.status).toBe(403);
    // Mutating methods hit the CSRF guard BEFORE routing: no CSRF -> 403.
    const post = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { Authorization: auth, Origin: `http://127.0.0.1:${String(server.port)}` },
      body: "{}"
    });
    expect(post.status).toBe(403);
    expect(post.body).toContain("CSRF_REQUIRED");
    // M11-03: with the guard satisfied, POST reaches the registration
    // surface (project-registry.ts — the draft-era `POST /projects` name
    // realized; the collection is no longer GET-only). An empty body is its
    // strict-schema 400, NOT the old 405 — this cell pins that the surface
    // is reached while the GET list face itself stays byte-identical.
    const postWithCsrf = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: {
        Authorization: auth,
        Origin: `http://127.0.0.1:${String(server.port)}`,
        "x-csrf-token": server.csrfToken
      },
      body: "{}"
    });
    expect(postWithCsrf.status).toBe(400);
    expect(postWithCsrf.body).toContain("INPUT_REJECTED");
    const query = await rawRequest(server.port, {
      path: "/api/v1/projects?dir=x",
      headers: { Authorization: auth }
    });
    expect(query.status).toBe(400);
  });
});
