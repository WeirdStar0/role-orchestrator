/**
 * M9-03 "角色与模型配置页" — the profiles CONFIG FILE surface end-to-end,
 * HERMETIC (no CLI is ever spawned: these routes only view and atomically
 * write back the profiles source file; no run is driven):
 *
 *   ① GET with a source: 200 {sourcePath, rawText == on-disk bytes,
 *      parseError: null, profiles == the loaded definitions} (the raw text
 *      already carries every field, so the parsed entries are served in
 *      full — unlike the reduced selection dropdown GET /api/v1/profiles);
 *   ② the honest absence refusals: a process without orchestration answers
 *      409 PROFILE_SOURCE_ABSENT on GET and PUT (no path is invented);
 *   ③ the guard pipeline: no token 403 TOKEN_REQUIRED, no CSRF 403, unknown
 *      query parameters 400, non-GET/PUT methods 405;
 *   ④ PUT round-trip: 200, the on-disk file equals the submitted bytes
 *      EXACTLY, no temporary file is left behind (the atomic temp+rename
 *      discipline), and the response carries the parsed result;
 *   ⑤ PUT refusals never touch the original (byte-compared after each):
 *      content failing the EXISTING frozen ProfilesFileSchema parser
 *      (broken JSON, unknown field, wrong top-level shape, empty list)
 *      → 422 PROFILES_CONTENT_INVALID;
 *   ⑥ malformed envelopes (bad JSON, missing/extra/non-string content,
 *      query params) → 400 INPUT_REJECTED, original untouched;
 *   ⑦ a hand-broken file is still a VIEW (200, rawText as on disk,
 *      parseError set, profiles null) and can be repaired through PUT; a
 *      file deleted after start → 409 on GET and PUT.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfilesOrchestration } from "../src/serve.js";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { createM5TestDb, makeConfigDir, rawRequest } from "./helpers.js";

const PROFILE_ID = "profile-pfull-claude";

const VALID_PROFILES_JSON = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      id: PROFILE_ID,
      runtime: "claude",
      executable: "C:/tmp/fake-claude.cmd",
      executionTarget: "windows-native",
      configDir: makeConfigDir(),
      model: null,
      credentialGroup: "pfull-claude",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      extraArgs: []
    }
  ]
});

function authed(server_: LocalApiServer, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${server_.token}`,
    origin: `http://127.0.0.1:${server_.port}`,
    "x-csrf-token": server_.csrfToken,
    ...extra
  };
}

describe("M9-03 GET/PUT /api/v1/profiles/full", () => {
  let dbHandle: ReturnType<typeof createM5TestDb>;
  let server: LocalApiServer; // orchestration WITH a source file
  let bareServer: LocalApiServer; // no orchestration at all
  let sourceDir: string;
  let sourceFile: string;

  const getFull = (server_: LocalApiServer, path = "/api/v1/profiles/full") =>
    rawRequest(server_.port, { path, headers: authed(server_) });

  const putFull = async (
    server_: LocalApiServer,
    body: string,
    overrides: Record<string, string> = {},
    path = "/api/v1/profiles/full"
  ) =>
    rawRequest(server_.port, {
      method: "PUT",
      path,
      headers: authed(server_, { "content-type": "application/json", ...overrides }),
      body
    });

  /** The on-disk state of the source directory (temp-file leak detector). */
  const dirEntries = (): string[] => readdirSync(sourceDir).sort();

  beforeAll(async () => {
    dbHandle = createM5TestDb("pfull");
    sourceDir = mkdtempSync(join(tmpdir(), "ro-localapi-pfull-"));
    sourceFile = join(sourceDir, "profiles.json");
    writeFileSync(sourceFile, VALID_PROFILES_JSON, "utf8");
    server = await startLocalApiServer({
      db: dbHandle.db,
      orchestration: {
        // Same composition loadProfilesOrchestration performs, spelled out so
        // the worktrees scratch stays OUT of the observed source directory.
        profiles: (JSON.parse(VALID_PROFILES_JSON) as { profiles: unknown[] }).profiles as never,
        worktreesRoot: mkdtempSync(join(tmpdir(), "ro-localapi-pfull-wt-")),
        profilesSourcePath: sourceFile
      }
    });
    bareServer = await startLocalApiServer({ db: dbHandle.db });
  });

  afterAll(async () => {
    await bareServer?.close();
    await server?.close();
    dbHandle?.close();
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("① serves sourcePath + the exact on-disk text + the parsed definitions", async () => {
    const response = await getFull(server);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(response.body) as {
      schemaVersion: number;
      sourcePath: string;
      rawText: string;
      parseError: string | null;
      profiles: ReadonlyArray<Record<string, unknown>>;
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.sourcePath).toBe(sourceFile);
    expect(body.rawText).toBe(readFileSync(sourceFile, "utf8"));
    expect(body.parseError).toBeNull();
    expect(body.profiles).toHaveLength(1);
    // The full config-file surface: every frozen ProfileConfig field rides
    // along (the rawText already carries them — withholding them in the
    // parsed view would only desync the two representations).
    expect(body.profiles[0]).toMatchObject({
      id: PROFILE_ID,
      runtime: "claude",
      executionTarget: "windows-native",
      model: null,
      maxConcurrency: 2,
      timeoutSeconds: 600
    });
  });

  it("② answers 409 PROFILE_SOURCE_ABSENT without a source (GET and PUT)", async () => {
    const got = await getFull(bareServer);
    expect(got.status).toBe(409);
    expect(got.body).toContain("PROFILE_SOURCE_ABSENT");
    expect(got.body).toContain("--profiles");

    const put = await putFull(bareServer, JSON.stringify({ content: VALID_PROFILES_JSON }));
    expect(put.status).toBe(409);
    expect(put.body).toContain("PROFILE_SOURCE_ABSENT");
    expect(put.body).toContain("NO file was modified");
  });

  it("③ keeps the guard pipeline: token, CSRF, query params, methods", async () => {
    const noToken = await rawRequest(server.port, { path: "/api/v1/profiles/full" });
    expect(noToken.status).toBe(403);
    expect(noToken.body).toContain("TOKEN_REQUIRED");

    // Mutating PUT without the session-bound CSRF token → 403.
    const noCsrf = await rawRequest(server.port, {
      method: "PUT",
      path: "/api/v1/profiles/full",
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${server.port}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ content: VALID_PROFILES_JSON })
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toContain("CSRF");

    const withQuery = await getFull(server, "/api/v1/profiles/full?x=1");
    expect(withQuery.status).toBe(400);

    const post = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/profiles/full",
      headers: authed(server, { "content-type": "application/json" }),
      body: "{}"
    });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD, PUT");

    const del = await rawRequest(server.port, {
      method: "DELETE",
      path: "/api/v1/profiles/full",
      headers: authed(server)
    });
    expect(del.status).toBe(405);
  });

  it("④ PUT round-trip: validates, replaces the file byte-exactly, leaves no temp file", async () => {
    const before = dirEntries();
    const updated = VALID_PROFILES_JSON.replace('"maxConcurrency":2', '"maxConcurrency":4');
    expect(updated).not.toBe(VALID_PROFILES_JSON); // the cell must really change the bytes

    const response = await putFull(server, JSON.stringify({ content: updated }));
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      sourcePath: string;
      bytesWritten: number;
      profiles: ReadonlyArray<{ maxConcurrency: number }>;
      note: string;
    };
    expect(body.sourcePath).toBe(sourceFile);
    expect(Buffer.byteLength(updated, "utf8")).toBe(body.bytesWritten);
    expect(body.profiles[0]?.maxConcurrency).toBe(4);
    // The disk holds EXACTLY the submitted text — no reformatting, no
    // trailing-newline surprises.
    expect(readFileSync(sourceFile, "utf8")).toBe(updated);
    // Atomic discipline: the temp file is gone after the rename.
    expect(dirEntries()).toEqual(before);
    expect(body.note).toContain("restart");
  });

  it("⑤ refuses invalid content with 422 and never touches the original", async () => {
    const before = dirEntries();
    const originalBytes = readFileSync(sourceFile, "utf8");

    const cases: ReadonlyArray<readonly [string, string]> = [
      ["broken JSON", "{not json at all"],
      [
        "unknown field inside a profile",
        JSON.stringify({
          schemaVersion: 1,
          profiles: [
            {
              id: "x",
              runtime: "claude",
              executable: "e",
              executionTarget: "windows-native",
              configDir: "c",
              model: null,
              credentialGroup: "g",
              maxConcurrency: 1,
              timeoutSeconds: 30,
              extraArgs: [],
              modelOverride: "sneaky"
            }
          ]
        })
      ],
      ["wrong top-level shape", JSON.stringify([])],
      ["empty profiles list", JSON.stringify({ schemaVersion: 1, profiles: [] })]
    ];
    for (const [label, content] of cases) {
      const response = await putFull(server, JSON.stringify({ content }));
      expect(response.status, label).toBe(422);
      expect(response.body, label).toContain("PROFILES_CONTENT_INVALID");
      expect(response.body, label).toContain("was NOT modified");
      expect(readFileSync(sourceFile, "utf8"), label).toBe(originalBytes);
    }
    expect(dirEntries()).toEqual(before); // no temp leftovers on refusal paths
  });

  it("⑥ refuses malformed envelopes with 400 and never touches the original", async () => {
    const originalBytes = readFileSync(sourceFile, "utf8");

    const notJson = await putFull(server, "this is not json");
    expect(notJson.status).toBe(400);

    const emptyBody = await putFull(server, "");
    expect(emptyBody.status).toBe(400);

    const missingContent = await putFull(server, JSON.stringify({ text: VALID_PROFILES_JSON }));
    expect(missingContent.status).toBe(400);
    expect(missingContent.body).toContain("INPUT_REJECTED");

    const extraField = await putFull(
      server,
      JSON.stringify({ content: VALID_PROFILES_JSON, overwrite: true })
    );
    expect(extraField.status).toBe(400); // strict envelope: unknown field rejected

    const nonString = await putFull(server, JSON.stringify({ content: 42 }));
    expect(nonString.status).toBe(400);

    const emptyContent = await putFull(server, JSON.stringify({ content: "" }));
    expect(emptyContent.status).toBe(400);

    const withQuery = await putFull(
      server,
      JSON.stringify({ content: VALID_PROFILES_JSON }),
      {},
      "/api/v1/profiles/full?force=1"
    );
    expect(withQuery.status).toBe(400);

    expect(readFileSync(sourceFile, "utf8")).toBe(originalBytes);
  });

  it("⑦ a hand-broken file is still a view (200 + parseError); a deleted file is 409", async () => {
    // Hand-break the file behind the server's back (as a bad editor save
    // would): the view must serve the raw bytes + the parse reason, never a
    // silent empty config.
    writeFileSync(sourceFile, "{ hand-broken", "utf8");
    const broken = await getFull(server);
    expect(broken.status).toBe(200);
    const brokenBody = JSON.parse(broken.body) as {
      rawText: string;
      parseError: string | null;
      profiles: unknown;
    };
    expect(brokenBody.rawText).toBe("{ hand-broken");
    expect(brokenBody.parseError).not.toBeNull();
    expect(brokenBody.profiles).toBeNull();

    // Repair through the endpoint itself: PUT accepts the corrected text.
    const repair = await putFull(server, JSON.stringify({ content: VALID_PROFILES_JSON }));
    expect(repair.status).toBe(200);
    expect(readFileSync(sourceFile, "utf8")).toBe(VALID_PROFILES_JSON);

    // A source deleted after start: nothing to view, nothing to write to.
    expect(dirEntries()).toEqual(["profiles.json"]);
    rmSync(sourceFile);
    const gone = await getFull(server);
    expect(gone.status).toBe(409);
    expect(gone.body).toContain("PROFILE_SOURCE_ABSENT");
    const putGone = await putFull(server, JSON.stringify({ content: VALID_PROFILES_JSON }));
    expect(putGone.status).toBe(409);
  });
});

describe("loadProfilesOrchestration carries the source path (M9-03)", () => {
  it("exposes the --profiles file as profilesSourcePath for the /full endpoints", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-localapi-pfull-load-"));
    try {
      const file = join(dir, "profiles.json");
      writeFileSync(file, VALID_PROFILES_JSON, "utf8");
      const options = loadProfilesOrchestration(join(dir, "o.db"), file);
      expect(options.profilesSourcePath).toBe(file);
      expect(options.profiles).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
