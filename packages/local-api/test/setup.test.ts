/**
 * M11-02 "首启零配置" — the setup surface end-to-end over LIVE servers,
 * fully HERMETIC: the CLI discovery is driven through an INJECTED
 * environment + regular-file probe (win32 path semantics on every host, no
 * real PATH/USERPROFILE is ever read, no real claude/codex is ever probed
 * or executed), while the profiles file itself is a real temp-dir file so
 * the atomic create/replace disciplines are exercised for real.
 *
 * Covered here:
 * - GET /api/v1/setup/status: guard pipeline (403/405/400), the zod-pinned
 *   output shape, all four profiles fileStates (unwired/absent/configured/
 *   unparseable), the default binding template over the FULL four-state
 *   matrix (both CLIs / claude-only / codex-only / none), and the
 *   loaded-vs-usable restart delta;
 * - POST /api/v1/setup/first-run: the happy create path (file on disk,
 *   frozen-schema valid, safe defaults, distinct credential groups, the
 *   discovered absolute executable), the two single-CLI arms (claude-only /
 *   codex-only — the M11-02 B1 rework's intent mapping, not a fallback), the
 *   typed
 *   refusals (no wiring 409 / already-configured 409 with the original file
 *   byte-untouched / neither-CLI 422 with the miss list / no home 422), the
 *   repair path (a hand-broken file is replaced, not merged), strict body
 *   semantics and the full guard pipeline;
 * - the generated file re-validated through the SAME frozen parser serve
 *   applies at startup.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseProfilesFile } from "../src/orchestrator.js";
import { cliDiscoveryProbes, platformPath, type CliDiscoveryEnv } from "../src/cli-discovery.js";
import { SetupStatusViewSchema } from "../src/setup.js";
import { startLocalApiServer, type LocalApiServer } from "../src/index.js";
import { createTestDb, rawRequest } from "./helpers.js";

// ---------------------------------------------------------------------------
// The injected discovery fixture: win32 path semantics on every host. The
// probe answers true exactly for paths BUILT BY the module under test, so
// the endpoint exercises the real candidate construction end-to-end.
// ---------------------------------------------------------------------------

const WIZARD_ENV: CliDiscoveryEnv = {
  PATH: "C:\\tools\\first;C:\\tools\\second",
  USERPROFILE: "C:\\users\\wizard",
  npm_config_prefix: "C:\\npm-global"
};

const { join: wjoin } = platformPath("win32");

/** Path-located claude.exe (from the first PATH dir, preferred form). */
const CLAUDE_EXE = cliDiscoveryProbes(WIZARD_ENV, "win32", "claude").find(
  (probe) => probe.source === "path" && probe.path === wjoin("C:\\tools\\first", "claude.exe")
)!.path;
/** npm-shim codex.cmd (npm-global-prefix source). */
const CODEX_CMD = cliDiscoveryProbes(WIZARD_ENV, "win32", "codex").find(
  (probe) => probe.source === "npm-global-prefix" && probe.path === wjoin("C:\\npm-global", "codex.cmd")
)!.path;

function probeOf(existing: ReadonlySet<string>): (candidate: string) => boolean {
  return (candidate) => existing.has(candidate);
}

const BOTH_FOUND = new Set([CLAUDE_EXE, CODEX_CMD]);
const CLAUDE_ONLY = new Set([CLAUDE_EXE]);
const CODEX_ONLY = new Set([CODEX_CMD]);
const NONE_FOUND = new Set<string>();

function authed(server: LocalApiServer): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    origin: `http://127.0.0.1:${String(server.port)}`,
    "x-csrf-token": server.csrfToken,
    "content-type": "application/json"
  };
}

interface Wired {
  readonly server: LocalApiServer;
  readonly sourceFile: string;
}

/** A server whose orchestration is wired to a DECLARED but ABSENT profiles file. */
async function startWiredAbsentServer(
  label: string,
  db: DatabaseSync,
  discovery: { env: CliDiscoveryEnv; existing: ReadonlySet<string> }
): Promise<Wired> {
  const dir = mkdtempSync(join(tmpdir(), `ro-localapi-setup-${label}-`));
  const sourceFile = join(dir, "profiles.json"); // never created before start
  const server = await startLocalApiServer({
    db,
    orchestration: { profiles: [], worktreesRoot: join(dir, "worktrees"), profilesSourcePath: sourceFile },
    cliDiscovery: { env: discovery.env, platform: "win32", processPlatform: "win32", isFile: probeOf(discovery.existing) }
  });
  return { server, sourceFile };
}

describe("M11-02 GET /api/v1/setup/status", () => {
  let dbHandle: ReturnType<typeof createTestDb>;
  let both: Wired;
  let claudeOnly: Wired;
  let codexOnly: Wired;
  let none: Wired;
  let unwired: LocalApiServer;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    dbHandle = createTestDb("setup-status");
    both = await startWiredAbsentServer("both", dbHandle.db, { env: WIZARD_ENV, existing: BOTH_FOUND });
    tempDirs.push(both.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    claudeOnly = await startWiredAbsentServer("claude", dbHandle.db, { env: WIZARD_ENV, existing: CLAUDE_ONLY });
    tempDirs.push(claudeOnly.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    codexOnly = await startWiredAbsentServer("codex", dbHandle.db, { env: WIZARD_ENV, existing: CODEX_ONLY });
    tempDirs.push(codexOnly.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    none = await startWiredAbsentServer("none", dbHandle.db, { env: WIZARD_ENV, existing: NONE_FOUND });
    tempDirs.push(none.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    const bareDir = mkdtempSync(join(tmpdir(), "ro-localapi-setup-bare-"));
    tempDirs.push(bareDir);
    unwired = await startLocalApiServer({
      db: dbHandle.db,
      cliDiscovery: { env: WIZARD_ENV, platform: "win32", processPlatform: "win32", isFile: probeOf(BOTH_FOUND) }
    });
  });

  afterAll(async () => {
    await both.server.close();
    await claudeOnly.server.close();
    await codexOnly.server.close();
    await none.server.close();
    await unwired.close();
    dbHandle.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("detects both CLIs with source attribution and the recommended template (zod-pinned shape)", async () => {
    const response = await rawRequest(both.server.port, {
      path: "/api/v1/setup/status",
      headers: { authorization: `Bearer ${both.server.token}` }
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const body = SetupStatusViewSchema.parse(JSON.parse(response.body)); // shape FIXED: drift fails here
    expect(body.clis.claude).toEqual({ found: true, path: CLAUDE_EXE, source: "path" });
    expect(body.clis.codex).toEqual({ found: true, path: CODEX_CMD, source: "npm-global-prefix" });
    expect(body.profiles.sourcePath).toBe(both.sourceFile);
    expect(body.profiles.fileState).toBe("absent");
    expect(body.profiles.usableProfiles).toBe(0);
    expect(body.profiles.parseError).toBeNull();
    expect(body.profiles.loadedProfiles).toBe(0);
    expect(body.defaultBindingTemplate).toEqual([
      { roleId: "coordinator", runtime: "claude" },
      { roleId: "architect", runtime: "claude" },
      { roleId: "developer", runtime: "codex" },
      { roleId: "reviewer", runtime: "claude" }
    ]);
  });

  // The four-state matrix of the default binding template — what each arm
  // asserts and what makes it RED (no arm is tautologically true):
  // - BOTH found → coordinator/architect/reviewer→claude + developer→codex:
  //   red if any runtime drifts or the role order changes (test above).
  // - CLAUDE-ONLY → all four roles "claude" AND, in the SAME payload,
  //   clis.codex.found=false. Red on the pre-review implementation: its
  //   developer branch keyed off claudeFound and answered
  //   DEFAULT_ROLE_RUNTIME_TEMPLATE.developer ("codex") whenever claude was
  //   found, so this arm's developer=claude assertion fails on the old code.
  //   The combined codex.found=false assertion pins the unknown-deny invariant:
  //   the template must never suggest a runtime the same payload reports as
  //   absent (both-missing never reaches the mapper — it returns null above,
  //   and first-run refuses 422 CLIS_NOT_FOUND before any write).
  // - CODEX-ONLY → all four roles "codex": red if the claude-miss fallbacks
  //   drift (the retained arm; the old code already passed it).
  // - NEITHER → null template: red if the null guard is dropped and a
  //   template is fabricated for a machine with no discovered CLI.
  // first-run is template-INDEPENDENT by construction: planDefaultProfiles
  // walks the discovered CLIs directly and never consults the template, so
  // the bug and this fix are status-view-only.
  it("claude-only: all four roles land on claude while the same payload reports codex not found", async () => {
    const response = await rawRequest(claudeOnly.server.port, {
      path: "/api/v1/setup/status",
      headers: { authorization: `Bearer ${claudeOnly.server.token}` }
    });
    const body = SetupStatusViewSchema.parse(JSON.parse(response.body));
    // Combined consistency in ONE payload (unknown-deny): the suggested
    // developer runtime must agree with the detection verdict beside it.
    expect(body.clis.codex).toEqual({ found: false, path: null, source: null });
    expect(body.clis.claude.found).toBe(true);
    expect(body.defaultBindingTemplate).toEqual([
      { roleId: "coordinator", runtime: "claude" },
      { roleId: "architect", runtime: "claude" },
      { roleId: "developer", runtime: "claude" },
      { roleId: "reviewer", runtime: "claude" }
    ]);
  });

  it("codex-only: the single discovered CLI carries all four roles in the template", async () => {
    const response = await rawRequest(codexOnly.server.port, {
      path: "/api/v1/setup/status",
      headers: { authorization: `Bearer ${codexOnly.server.token}` }
    });
    const body = SetupStatusViewSchema.parse(JSON.parse(response.body));
    expect(body.clis.claude).toEqual({ found: false, path: null, source: null });
    expect(body.clis.codex.found).toBe(true);
    expect(body.defaultBindingTemplate).toEqual([
      { roleId: "coordinator", runtime: "codex" },
      { roleId: "architect", runtime: "codex" },
      { roleId: "developer", runtime: "codex" },
      { roleId: "reviewer", runtime: "codex" }
    ]);
  });

  it("no CLI found: honest null verdicts and no template suggested", async () => {
    const response = await rawRequest(none.server.port, {
      path: "/api/v1/setup/status",
      headers: { authorization: `Bearer ${none.server.token}` }
    });
    const body = SetupStatusViewSchema.parse(JSON.parse(response.body));
    expect(body.clis.claude).toEqual({ found: false, path: null, source: null });
    expect(body.clis.codex).toEqual({ found: false, path: null, source: null });
    expect(body.defaultBindingTemplate).toBeNull();
  });

  it("an unwired process says so (no invented source path)", async () => {
    const response = await rawRequest(unwired.port, {
      path: "/api/v1/setup/status",
      headers: { authorization: `Bearer ${unwired.token}` }
    });
    const body = SetupStatusViewSchema.parse(JSON.parse(response.body));
    expect(body.profiles).toEqual({
      sourcePath: null,
      fileState: "unwired",
      usableProfiles: 0,
      parseError: null,
      loadedProfiles: 0
    });
  });

  it("keeps the guard pipeline: no token 403, mutating 405, query strings 400", async () => {
    const anon = await rawRequest(both.server.port, { path: "/api/v1/setup/status" });
    expect(anon.status).toBe(403);
    expect(anon.body).toContain("TOKEN_REQUIRED");

    const post = await rawRequest(both.server.port, {
      method: "POST",
      path: "/api/v1/setup/status",
      headers: authed(both.server),
      body: "{}"
    });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");

    const query = await rawRequest(both.server.port, {
      path: "/api/v1/setup/status?cli=claude",
      headers: { authorization: `Bearer ${both.server.token}` }
    });
    expect(query.status).toBe(400);
  });
});

describe("M11-02 POST /api/v1/setup/first-run", () => {
  let dbHandle: ReturnType<typeof createTestDb>;
  let both: Wired;
  let codexOnly: Wired;
  let none: Wired;
  let homeless: Wired;
  let unwired: LocalApiServer;
  /** A server whose wired file EXISTS and parses at startup (configured, then hand-broken for repair). */
  let configured: Wired;
  const tempDirs: string[] = [];

  const VALID_ONE_PROFILE = (): string =>
    JSON.stringify({
      schemaVersion: 1,
      profiles: [
        {
          id: "preexisting",
          runtime: "codex",
          executable: "C:\\tools\\first\\codex.exe",
          executionTarget: "windows-native",
          configDir: wjoin("C:\\users\\wizard", ".codex"),
          model: null,
          credentialGroup: "preexisting-group",
          maxConcurrency: 1,
          timeoutSeconds: 600,
          extraArgs: []
        }
      ]
    });

  beforeAll(async () => {
    dbHandle = createTestDb("setup-firstrun");
    both = await startWiredAbsentServer("fr-both", dbHandle.db, { env: WIZARD_ENV, existing: BOTH_FOUND });
    tempDirs.push(both.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    codexOnly = await startWiredAbsentServer("fr-codex", dbHandle.db, { env: WIZARD_ENV, existing: CODEX_ONLY });
    tempDirs.push(codexOnly.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    none = await startWiredAbsentServer("fr-none", dbHandle.db, { env: WIZARD_ENV, existing: NONE_FOUND });
    tempDirs.push(none.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    // CLI found, but no home variable at all → the defaults cannot be built.
    homeless = await startWiredAbsentServer("fr-homeless", dbHandle.db, {
      env: { PATH: WIZARD_ENV.PATH },
      existing: new Set([CLAUDE_EXE])
    });
    tempDirs.push(homeless.sourceFile.replace(/[/\\]profiles\.json$/, ""));
    const bareDir = mkdtempSync(join(tmpdir(), "ro-localapi-fr-bare-"));
    tempDirs.push(bareDir);
    unwired = await startLocalApiServer({
      db: dbHandle.db,
      cliDiscovery: { env: WIZARD_ENV, platform: "win32", processPlatform: "win32", isFile: probeOf(BOTH_FOUND) }
    });
    // Configured server: the file exists and parses at startup (loaded 1).
    const cfgDir = mkdtempSync(join(tmpdir(), "ro-localapi-fr-cfg-"));
    tempDirs.push(cfgDir);
    const sourceFile = join(cfgDir, "profiles.json");
    writeFileSync(sourceFile, VALID_ONE_PROFILE(), "utf8");
    const server = await startLocalApiServer({
      db: dbHandle.db,
      orchestration: {
        profiles: (JSON.parse(VALID_ONE_PROFILE()) as { profiles: unknown[] }).profiles as never,
        worktreesRoot: join(cfgDir, "worktrees"),
        profilesSourcePath: sourceFile
      },
      cliDiscovery: { env: WIZARD_ENV, platform: "win32", processPlatform: "win32", isFile: probeOf(BOTH_FOUND) }
    });
    configured = { server, sourceFile };
  });

  afterAll(async () => {
    await both.server.close();
    await codexOnly.server.close();
    await none.server.close();
    await homeless.server.close();
    await unwired.close();
    await configured.server.close();
    dbHandle.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the default profiles file through the atomic create path (both CLIs)", async () => {
    const response = await rawRequest(both.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(both.server),
      body: "{}"
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      schemaVersion: number;
      applied: boolean;
      mode: string;
      sourcePath: string;
      profiles: Array<{ id: string; runtime: string; executable: string; configDir: string; model: unknown; credentialGroup: string; maxConcurrency: number; timeoutSeconds: number; extraArgs: unknown[] }>;
      restartRequired: boolean;
      note: string;
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.applied).toBe(true);
    expect(body.mode).toBe("created");
    expect(body.sourcePath).toBe(both.sourceFile);
    expect(body.restartRequired).toBe(true); // the no-hot-reload constraint, stated
    expect(body.note).toContain("restart");
    expect(body.profiles).toHaveLength(2);
    // Recommended combination: claude-default + codex-default, claude from
    // PATH with source attribution, codex from the npm prefix.
    expect(body.profiles[0]).toMatchObject({
      id: "claude-default",
      runtime: "claude",
      executable: CLAUDE_EXE,
      configDir: wjoin("C:\\users\\wizard", ".claude"),
      model: null,
      credentialGroup: "claude-personal",
      maxConcurrency: 4,
      timeoutSeconds: 1800,
      extraArgs: []
    });
    expect(body.profiles[1]).toMatchObject({
      id: "codex-default",
      runtime: "codex",
      executable: CODEX_CMD,
      credentialGroup: "codex-personal" // distinct per CLI: the quota isolation
    });
    // The file on disk re-validates through the SAME frozen parser serve
    // applies at startup — and no temp file was left behind (M11-03 handover
    // D: the leftover claim is now ASSERTED, not just stated; the filter
    // matches the primitive's temp-name pattern, everything else in the
    // directory belongs to the fixture).
    expect(existsSync(both.sourceFile)).toBe(true);
    expect(readdirSync(dirname(both.sourceFile)).filter((entry) => entry.includes(".m11-02-tmp-"))).toEqual([]);
    const parsed = parseProfilesFile(readFileSync(both.sourceFile, "utf8"));
    expect(parsed.map((profile) => profile.id)).toEqual(["claude-default", "codex-default"]);
    // The no-hot-reload honesty is visible in data: the file is usable, the
    // running process still has zero loaded profiles.
    const status = await rawRequest(both.server.port, {
      path: "/api/v1/setup/status",
      headers: { authorization: `Bearer ${both.server.token}` }
    });
    const statusBody = SetupStatusViewSchema.parse(JSON.parse(status.body));
    expect(statusBody.profiles.fileState).toBe("configured");
    expect(statusBody.profiles.usableProfiles).toBe(2);
    expect(statusBody.profiles.loadedProfiles).toBe(0);
  });

  it("is idempotent by refusal: a second call answers 409 and the file stays byte-identical", async () => {
    const before = readFileSync(both.sourceFile, "utf8");
    const response = await rawRequest(both.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(both.server),
      body: "{}"
    });
    expect(response.status).toBe(409);
    expect(response.body).toContain("PROFILES_ALREADY_CONFIGURED");
    const body = JSON.parse(response.body) as { usableProfiles?: number };
    expect(body.usableProfiles).toBe(2);
    expect(readFileSync(both.sourceFile, "utf8")).toBe(before);
  });

  it("a single discovered CLI produces exactly that CLI's default profile", async () => {
    const response = await rawRequest(codexOnly.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(codexOnly.server),
      body: "{}"
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { profiles: Array<{ id: string; runtime: string }> };
    expect(body.profiles.map((profile) => profile.id)).toEqual(["codex-default"]);
  });

  it("neither CLI found: 422 CLIS_NOT_FOUND listing the misses; nothing written", async () => {
    const response = await rawRequest(none.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(none.server),
      body: "{}"
    });
    expect(response.status).toBe(422);
    expect(response.body).toContain("CLIS_NOT_FOUND");
    const body = JSON.parse(response.body) as { notFound?: string[] };
    expect(body.notFound).toEqual(["claude", "codex"]);
    expect(existsSync(none.sourceFile)).toBe(false);
  });

  it("CLI found but no home variable: 422 HOME_DIRECTORY_UNAVAILABLE; nothing written", async () => {
    const response = await rawRequest(homeless.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(homeless.server),
      body: "{}"
    });
    expect(response.status).toBe(422);
    expect(response.body).toContain("HOME_DIRECTORY_UNAVAILABLE");
    expect(existsSync(homeless.sourceFile)).toBe(false);
  });

  it("no profiles wiring: 409 PROFILE_SOURCE_ABSENT (no path is invented)", async () => {
    const response = await rawRequest(unwired.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(unwired),
      body: "{}"
    });
    expect(response.status).toBe(409);
    expect(response.body).toContain("PROFILE_SOURCE_ABSENT");
    expect(response.body).toContain("--profiles");
  });

  it("an already-usable configuration is never overwritten (409, bytes untouched)", async () => {
    const before = readFileSync(configured.sourceFile, "utf8");
    const response = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(configured.server),
      body: "{}"
    });
    expect(response.status).toBe(409);
    expect(response.body).toContain("PROFILES_ALREADY_CONFIGURED");
    expect(readFileSync(configured.sourceFile, "utf8")).toBe(before);
  });

  it("a file hand-broken AFTER start is repaired with the defaults (mode: replaced)", async () => {
    writeFileSync(configured.sourceFile, "{ hand-broken after start", "utf8");
    const response = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(configured.server),
      body: "{}"
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { mode: string; profiles: unknown[] };
    expect(body.mode).toBe("replaced");
    const parsed = parseProfilesFile(readFileSync(configured.sourceFile, "utf8"));
    expect(parsed.length).toBe(body.profiles.length);
  });

  it("strict body: only {} is accepted (any key — override vocabulary included — is 400)", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["unknown field", JSON.stringify({ force: true })],
      ["model carrier", JSON.stringify({ model: "claude-opus-4" })],
      ["profileId carrier", JSON.stringify({ profileId: "profile-x" })],
      ["non-object", JSON.stringify([1, 2])]
    ];
    for (const [label, body] of cases) {
      const response = await rawRequest(configured.server.port, {
        method: "POST",
        path: "/api/v1/setup/first-run",
        headers: authed(configured.server),
        body
      });
      expect(response.status, label).toBe(400);
      expect(response.body, label).toContain("INPUT_REJECTED");
    }
    const notJson = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(configured.server),
      body: "{not json"
    });
    expect(notJson.status).toBe(400);
    const empty = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: authed(configured.server)
    });
    expect(empty.status).toBe(400);
    const query = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run?force=1",
      headers: authed(configured.server),
      body: "{}"
    });
    expect(query.status).toBe(400);
  });

  it("keeps the guard pipeline: methods, token, origin, CSRF", async () => {
    const get = await rawRequest(configured.server.port, {
      path: "/api/v1/setup/first-run",
      headers: { authorization: `Bearer ${configured.server.token}` }
    });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST");

    const put = await rawRequest(configured.server.port, {
      method: "PUT",
      path: "/api/v1/setup/first-run",
      headers: authed(configured.server),
      body: "{}"
    });
    expect(put.status).toBe(405);

    // Guard order is Host/Origin → token → CSRF: a mutating request needs a
    // valid loopback Origin before the token check is even reached.
    const noToken = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: { origin: `http://127.0.0.1:${String(configured.server.port)}` },
      body: "{}"
    });
    expect(noToken.status).toBe(403);
    expect(noToken.body).toContain("TOKEN_REQUIRED");

    // Mutating without Origin → 403 before CSRF is even consulted.
    const noOrigin = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: { authorization: `Bearer ${configured.server.token}` },
      body: "{}"
    });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body).toContain("ORIGIN_REQUIRED");

    const noCsrf = await rawRequest(configured.server.port, {
      method: "POST",
      path: "/api/v1/setup/first-run",
      headers: {
        authorization: `Bearer ${configured.server.token}`,
        origin: `http://127.0.0.1:${String(configured.server.port)}`
      },
      body: "{}"
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toContain("CSRF_REQUIRED");
  });
});
