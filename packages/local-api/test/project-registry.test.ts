/**
 * M11-03 "项目登记" — POST /api/v1/projects (project-registry.ts) end-to-end
 * over LIVE servers, HERMETIC: the four fail-closed directory gates run
 * against real temp-dir fixtures (a real git repo via the shared helper, a
 * plain dir, a plain file, a missing path), and the row write goes through
 * the real store.
 *
 * Covered here:
 * - the registry domain directly: each gate refuses with run creation's
 *   exact code and leaves ZERO rows; success find-or-creates with the
 *   platform executionTarget; a second registration is idempotent
 *   (`existing: true`, createdAt byte-equal, still ONE row);
 * - the HTTP surface: guard pipeline (no-token 403 / no-CSRF 403 / PUT 405
 *   with the Allow header), strict body semantics (empty / non-JSON /
 *   unknown field → 400 INPUT_REJECTED), query rejection (GET with params
 *   stays 400 — the M11-01 list face unchanged);
 * - the success path: 200 `{registered, existing, project:{repoRoot,
 *   createdAt}}` with NO internal id anywhere in the body, the project
 *   immediately visible in GET /api/v1/projects AND resolvable by the
 *   bindings lookup (four null rows — the wizard's pre-registration face);
 * - the M11-03 product flow over orchestration (win32-gated, fake-cli):
 *   register → PUT the four role bindings (transactional surface, zero new
 *   semantics) → POST /api/v1/runs accepts a single-node run — the wizard's
 *   登记 → 绑定 → 建任务 chain at the API level.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import { createProjectRegistry } from "../src/project-registry.js";
import {
  createGitFixture,
  createM5TestDb,
  createTestDb,
  fakeBinPath,
  makeConfigDir,
  rawRequest,
  type GitFixture
} from "./helpers.js";
import { getProjectByRepoRoot } from "@role-orchestrator/store";
import { listRoleBindings } from "@role-orchestrator/runtime-profile";
import { ROLE_IDS } from "@role-orchestrator/contracts";

/** The store-level row count (the zero-write assertion for every refusal). */
function projectCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
}

function authed(server: LocalApiServer): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    origin: `http://127.0.0.1:${String(server.port)}`,
    "x-csrf-token": server.csrfToken,
    "content-type": "application/json"
  };
}

/**
 * The git-fixture beforeAll hooks run REAL `git init/config/commit` chains;
 * under the full-suite parallel load (turbo runs every suite at once) a
 * spawn chain that takes ~2s alone can exceed vitest's 10s default
 * hookTimeout — the exact failure the first full `pnpm test` hit. Same
 * remedy as runs-orchestration.test.ts's T0_TIMEOUT_MS: an explicit
 * hook timeout, not a globally raised one.
 */
const FIXTURE_HOOK_TIMEOUT_MS = 60_000;

describe("M11-03 project registry (domain gates, real fixtures)", () => {
  let dbHandle: ReturnType<typeof createTestDb>;
  let fixture: GitFixture;

  beforeAll(async () => {
    dbHandle = createTestDb("registry-gates");
    fixture = await createGitFixture("registry");
  }, FIXTURE_HOOK_TIMEOUT_MS);

  afterAll(() => {
    fixture?.close();
    dbHandle?.close();
  });

  it("refuses a relative path (PROJECT_DIR_NOT_ABSOLUTE) and writes nothing", async () => {
    const registry = createProjectRegistry({ db: dbHandle.db });
    await expect(registry.registerProject("relative/path")).rejects.toMatchObject({
      statusCode: 400,
      code: "PROJECT_DIR_NOT_ABSOLUTE"
    });
    expect(projectCount(dbHandle.db)).toBe(0);
  });

  it("refuses a missing directory (PROJECT_DIR_MISSING) and writes nothing", async () => {
    const registry = createProjectRegistry({ db: dbHandle.db });
    await expect(registry.registerProject(join(tmpdir(), "ro-registry-missing-dir-does-not-exist"))).rejects.toMatchObject({
      statusCode: 400,
      code: "PROJECT_DIR_MISSING"
    });
    expect(projectCount(dbHandle.db)).toBe(0);
  });

  it("refuses a plain file (PROJECT_DIR_NOT_DIRECTORY) and writes nothing", async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "ro-registry-file-")), "plain.txt");
    writeFileSync(filePath, "not a directory\n", "utf8");
    const registry = createProjectRegistry({ db: dbHandle.db });
    await expect(registry.registerProject(filePath)).rejects.toMatchObject({
      statusCode: 400,
      code: "PROJECT_DIR_NOT_DIRECTORY"
    });
    expect(projectCount(dbHandle.db)).toBe(0);
  });

  it("refuses a non-git directory (PROJECT_DIR_NOT_GIT_REPOSITORY) and writes nothing", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "ro-registry-nogit-"));
    const registry = createProjectRegistry({ db: dbHandle.db });
    await expect(registry.registerProject(plainDir)).rejects.toMatchObject({
      statusCode: 400,
      code: "PROJECT_DIR_NOT_GIT_REPOSITORY"
    });
    expect(projectCount(dbHandle.db)).toBe(0);
  });

  it("registers a real git directory with the platform executionTarget, then is idempotent", async () => {
    const registry = createProjectRegistry({ db: dbHandle.db });
    const first = await registry.registerProject(fixture.repoPath);
    expect(first.existing).toBe(false);
    expect(first.project.repoRoot).toBe(resolve(fixture.repoPath));
    expect(projectCount(dbHandle.db)).toBe(1);
    // The row run creation's find-or-create would find (repo-root parity).
    const row = getProjectByRepoRoot(dbHandle.db, resolve(fixture.repoPath));
    expect(row).not.toBeNull();
    expect(row?.executionTarget).toBe(
      process.platform === "win32"
        ? "windows-native"
        : process.platform === "darwin"
          ? "macos-native"
          : "linux-native"
    );
    expect(row?.trustStatus).toBe("requires-user-confirmation");

    const second = await registry.registerProject(fixture.repoPath);
    expect(second.existing).toBe(true);
    expect(second.project.createdAt).toBe(first.project.createdAt);
    expect(projectCount(dbHandle.db)).toBe(1);
  });

  it("leaves the binding rows untouched: the lookup sees an UNBOUND project", async () => {
    // Registration mirrors run creation's find-or-create EXACTLY: no binding
    // rows are initialized (initializeProjectRoleBindings stays with the
    // transactional PUT). A freshly registered project therefore looks — to
    // the M10-01 read-only lookup the wizard's binding step consumes — the
    // same as a project that a refused first run created: zero rows = all
    // four roles unbound. Path-independence is the point: whichever way the
    // row came into existence, the binding face reads identically.
    const row = getProjectByRepoRoot(dbHandle.db, resolve(fixture.repoPath));
    expect(row).not.toBeNull();
    expect(listRoleBindings(dbHandle.db, row!.id)).toHaveLength(0);
  });
});

describe("M11-03 POST /api/v1/projects (live server, guards + strict body + success)", () => {
  let dbHandle: ReturnType<typeof createTestDb>;
  let server: LocalApiServer;
  let fixture: GitFixture;

  beforeAll(async () => {
    dbHandle = createTestDb("registry-http");
    fixture = await createGitFixture("registry-http");
    server = await startLocalApiServer({ db: dbHandle.db });
  }, FIXTURE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    fixture?.close();
    dbHandle?.close();
  });

  it("keeps the guard pipeline intact: no token 403, no CSRF 403", async () => {
    const noToken = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: { origin: `http://127.0.0.1:${String(server.port)}` },
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    expect(noToken.status).toBe(403);
    expect(noToken.body).toContain("TOKEN_REQUIRED");

    const noCsrf = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${String(server.port)}`
      },
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toContain("CSRF_REQUIRED");
    expect(projectCount(dbHandle.db)).toBe(0);
  });

  it("answers PUT/DELETE with 405 and the collection's Allow header; GET semantics unchanged", async () => {
    const put = await rawRequest(server.port, {
      method: "PUT",
      path: "/api/v1/projects",
      headers: authed(server),
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    expect(put.status).toBe(405);
    expect(put.headers["allow"]).toBe("GET, HEAD, POST");

    // The M11-01 GET face is byte-identical, including the query rejection.
    const listWithQuery = await rawRequest(server.port, {
      method: "GET",
      path: "/api/v1/projects?extra=1",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(listWithQuery.status).toBe(400);
    const emptyList = await rawRequest(server.port, {
      method: "GET",
      path: "/api/v1/projects",
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(emptyList.status).toBe(200);
    expect((JSON.parse(emptyList.body) as { projects: unknown[] }).projects).toEqual([]);
  });

  it("refuses strict-body violations with 400 INPUT_REJECTED and writes nothing", async () => {
    for (const body of ["", "not json", "{}", JSON.stringify({ projectDir: fixture.repoPath, extra: true }), JSON.stringify([])]) {
      const response = await rawRequest(server.port, {
        method: "POST",
        path: "/api/v1/projects",
        headers: authed(server),
        ...(body === "" ? {} : { body })
      });
      expect(response.status).toBe(400);
      expect(response.body).toContain("INPUT_REJECTED");
    }
    expect(projectCount(dbHandle.db)).toBe(0);
  });

  it("registers through HTTP: 200 with the operator-facing identity, no internal id in the body", async () => {
    const response = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: authed(server),
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      registered: boolean;
      existing: boolean;
      project: { repoRoot: string; createdAt: string };
    };
    expect(body.registered).toBe(true);
    expect(body.existing).toBe(false);
    expect(body.project.repoRoot).toBe(resolve(fixture.repoPath));
    // Internal ids stay out of the registration surface (GET-list discipline).
    expect(JSON.stringify(body)).not.toContain("proj-");
    expect(body.project).not.toHaveProperty("id");

    // Visible in the GET list …
    const list = await rawRequest(server.port, {
      method: "GET",
      path: "/api/v1/projects",
      headers: { authorization: `Bearer ${server.token}` }
    });
    const projects = (JSON.parse(list.body) as { projects: { repoRoot: string }[] }).projects;
    expect(projects.map((project) => project.repoRoot)).toContain(resolve(fixture.repoPath));

    // … and resolvable by the bindings lookup: the project exists with ZERO
    // binding rows (all four roles unbound — the same face a refused first
    // run's find-or-create leaves; the transactional PUT initializes them).
    const bindings = await rawRequest(server.port, {
      method: "GET",
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(fixture.repoPath)}`,
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(bindings.status).toBe(200);
    const bindingsBody = JSON.parse(bindings.body) as {
      projectId: string;
      bindings: { roleId: string; profileId: string | null }[];
    };
    expect(bindingsBody.projectId).not.toBe("");
    expect(bindingsBody.bindings).toEqual([]);
  });

  it("is idempotent over HTTP (existing: true, one row, createdAt unchanged)", async () => {
    const first = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: authed(server),
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    expect(first.status).toBe(200);
    const firstBody = JSON.parse(first.body) as { existing: boolean; project: { createdAt: string } };
    expect(firstBody.existing).toBe(true);

    const second = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: authed(server),
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    const secondBody = JSON.parse(second.body) as { existing: boolean; project: { createdAt: string } };
    expect(secondBody.existing).toBe(true);
    expect(secondBody.project.createdAt).toBe(firstBody.project.createdAt);
    expect(projectCount(dbHandle.db)).toBe(1);
  });

  it("refuses a non-git directory over HTTP and still writes nothing", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "ro-registry-http-nogit-"));
    const response = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: authed(server),
      body: JSON.stringify({ projectDir: plainDir })
    });
    expect(response.status).toBe(400);
    expect(response.body).toContain("PROJECT_DIR_NOT_GIT_REPOSITORY");
    expect(projectCount(dbHandle.db)).toBe(1); // only the fixture's row from the earlier cell
  });
});

/**
 * The M11-03 product flow at the API level (win32-gated: the engine launcher
 * is windows-native-only, same gate as runs-orchestration.test.ts):
 * register → configure the four role bindings → create the first run.
 */
describe.skipIf(process.platform !== "win32")("M11-03 register → bind → first run flow", () => {
  let dbHandle: ReturnType<typeof createM5TestDb>;
  let server: LocalApiServer;
  let fixture: GitFixture;
  let worktreesRoot: string;

  beforeAll(async () => {
    dbHandle = createM5TestDb("registry-flow");
    fixture = await createGitFixture("registry-flow");
    worktreesRoot = mkdtempSync(join(tmpdir(), "ro-localapi-registry-flow-wt-"));
    server = await startLocalApiServer({
      db: dbHandle.db,
      orchestration: {
        worktreesRoot,
        profiles: [
          {
            id: "registry-flow-claude",
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir: makeConfigDir(),
            model: null,
            credentialGroup: "registry-flow-claude",
            maxConcurrency: 1,
            timeoutSeconds: 600,
            extraArgs: [],
            invocationArgs: ["--scenario", "success"]
          }
        ]
      }
    });
  }, FIXTURE_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
    fixture?.close();
    dbHandle?.close();
  });

  it("register → PUT four bindings → POST /runs 202 (the wizard's chain)", async () => {
    // 1. Register (pre-run — the step that previously had no surface).
    const registered = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/projects",
      headers: authed(server),
      body: JSON.stringify({ projectDir: fixture.repoPath })
    });
    expect(registered.status).toBe(200);

    // 2. Resolve the project through the bindings lookup and configure all
    //    four roles in ONE transactional PUT (existing semantics, zero new).
    const bindingsView = await rawRequest(server.port, {
      method: "GET",
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(fixture.repoPath)}`,
      headers: { authorization: `Bearer ${server.token}` }
    });
    expect(bindingsView.status).toBe(200);
    const { projectId } = JSON.parse(bindingsView.body) as { projectId: string };
    const put = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/projects/${projectId}/role-bindings`,
      headers: authed(server),
      body: JSON.stringify({
        bindings: ROLE_IDS.map((roleId) => ({ roleId, profileId: "registry-flow-claude" }))
      })
    });
    expect(put.status).toBe(200);

    // 3. Create the first task — accepted, queued, driven.
    const created = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/runs",
      headers: authed(server),
      body: JSON.stringify({ objective: "registry flow first task", projectDir: fixture.repoPath })
    });
    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { runId: string; status: string };
    expect(createdBody.status).toBe("queued");
    expect(createdBody.runId).toMatch(/^run-/);
  });
});
