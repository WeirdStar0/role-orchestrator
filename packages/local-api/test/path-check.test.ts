/**
 * M11-07 接入配置管理面 — GET /api/v1/profiles/path-check, the management
 * face's read-only existence probe (the browser cannot stat the filesystem).
 * HERMETIC: the route touches the filesystem with EXACTLY one statSync per
 * request and never reads content — the cells below assert the whole
 * contract:
 *
 *   ① an existing FILE → {exists:true, isFile:true, isDirectory:false};
 *  ② an existing DIRECTORY → {exists:true, isFile:false, isDirectory:true};
 *  ③ a missing path → {exists:false, ...} (200 — "no" is the answer, not
 *     an error); the same for a path whose parent does not exist;
 *  ④ guard pipeline: no token → 403, non-GET → 405, missing `path` /
 *     unknown extra query parameter → 400 (zod strict).
 *
 * The path is never echoed: the response carries only schemaVersion and the
 * three booleans (asserted on the exact key set), and the server's request
 * log strips query strings (pinned by the log discipline tests elsewhere;
 * the note here is a shape word, not a path).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { createM5TestDb, rawRequest } from "./helpers.js";

describe("M11-07 GET /api/v1/profiles/path-check", () => {
  let dbHandle: ReturnType<typeof createM5TestDb>;
  let server: LocalApiServer;
  let scratch: string;
  let existingFile: string;
  let existingDir: string;

  const check = (server_: LocalApiServer, query: string, overrides: Record<string, string> = {}) =>
    rawRequest(server_.port, {
      path: `/api/v1/profiles/path-check${query}`,
      headers: {
        authorization: `Bearer ${server_.token}`,
        host: `127.0.0.1:${String(server_.port)}`,
        ...overrides
      }
    });

  beforeAll(async () => {
    dbHandle = createM5TestDb("pathcheck");
    scratch = mkdtempSync(join(tmpdir(), "ro-localapi-pathcheck-"));
    existingFile = join(scratch, "wrapper.cmd");
    writeFileSync(existingFile, "placeholder — never read back\n", "utf8");
    existingDir = join(scratch, "config");
    mkdirSync(existingDir, { recursive: true });
    server = await startLocalApiServer({ db: dbHandle.db });
  });

  afterAll(async () => {
    await server?.close();
    dbHandle?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("① answers isFile for an existing file, with exactly the four keys", async () => {
    const response = await check(server, `?path=${encodeURIComponent(existingFile)}`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["exists", "isDirectory", "isFile", "schemaVersion"]);
    expect(body["schemaVersion"]).toBe(1);
    expect(body["exists"]).toBe(true);
    expect(body["isFile"]).toBe(true);
    expect(body["isDirectory"]).toBe(false);
    expect(response.body).not.toContain("wrapper");
  });

  it("② answers isDirectory for an existing directory", async () => {
    const response = await check(server, `?path=${encodeURIComponent(existingDir)}`);
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body["exists"]).toBe(true);
    expect(body["isFile"]).toBe(false);
    expect(body["isDirectory"]).toBe(true);
  });

  it("③ answers exists:false (200) for a missing path and for a missing parent", async () => {
    for (const candidate of [join(scratch, "nope.cmd"), join(scratch, "absent-parent", "inner.txt")]) {
      const response = await check(server, `?path=${encodeURIComponent(candidate)}`);
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body).toMatchObject({ schemaVersion: 1, exists: false, isFile: false, isDirectory: false });
    }
  });

  it("④ refuses without the bearer token (403), non-GET (405) and bad queries (400)", async () => {
    const noToken = await rawRequest(server.port, {
      path: `/api/v1/profiles/path-check?path=${encodeURIComponent(existingFile)}`
    });
    expect(noToken.status).toBe(403);

    const notGet = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/profiles/path-check",
      headers: {
        authorization: `Bearer ${server.token}`,
        host: `127.0.0.1:${String(server.port)}`,
        origin: `http://127.0.0.1:${String(server.port)}`,
        "x-csrf-token": server.csrfToken,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(notGet.status).toBe(405);

    const missingParam = await check(server, "");
    expect(missingParam.status).toBe(400);

    const unknownParam = await check(server, `?path=${encodeURIComponent(existingFile)}&extra=1`);
    expect(unknownParam.status).toBe(400);
  });
});
