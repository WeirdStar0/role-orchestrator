/**
 * M9-01 "点火" — the POST /api/v1/runs orchestration end-to-end, HERMETIC:
 * the only CLI ever spawned is the repository's own BUILT fake-cli dist bin
 * (dogfood discipline — a real claude/codex is never invoked; the real-CLI
 * smoke is the maintainer's).
 *
 * The cells walk the full chain the milestone accepts on:
 *  ① M10-01 CORE REGRESSION: creation is READ-ONLY over project role
 *     bindings — the first POST over a fresh project answers 422
 *     ROLE_BINDINGS_INCOMPLETE and writes NOTHING (no binding rows); after
 *     the bindings are configured through the dedicated endpoint with a
 *     DIFFERENTIATED claude/codex mix, a POST (no profileId — the field is
 *     gone) leaves every binding row byte-identical (updated_at included)
 *     and the run freezes exactly the project-bound developer profile;
 *     fake-cli success -> run detail + events queryable;
 *  ② strict input validation (unknown fields — including the REMOVED
 *     profileId — bounds, projectDir fail-closed) -> 400, nothing created;
 *  ③ the M10-01 binding endpoint PUT /api/v1/projects/:id/role-bindings:
 *     valid mix / unknown profileId (422) / missing role (400) / duplicate
 *     role (400) / executionTarget mismatch (typed 422 — the M9-01-era 500
 *     is fixed) / unknown project (404) / guard pipeline (CSRF 403, 405s),
 *     plus the by-projectDir read the workbench page uses;
 *  ④ the guard pipeline is unchanged: no token 403, no/wrong CSRF 403, a
 *     server started WITHOUT orchestration answers 503 (honest refusal) and
 *     serves an EMPTY profiles list (M9-02);
 *  ⑤ the approval path: a proposal execution opens a REAL checkpoint (the
 *     card is served by the existing approvals view), the decision goes ONLY
 *     through POST /api/v1/approvals/:id/decision, and the pump then performs
 *     exactly the one digest-bound continuation (A17/A19 — the proposed side
 *     effect never happens; the re-proposing continuation re-parks);
 *  ⑥ multi-run: the second run is created while the first is queued and both
 *     complete undisturbed (the serial drive chain, FIFO); the list endpoint
 *     serves both, newest first, with objectives; event checksums still verify;
 *  ⑦ M9-02 coupling regression: with a long run OCCUPYING the drive chain,
 *     POST /api/v1/runs still answers 202 immediately (the creation chain is
 *     separate) and the queued run is nevertheless driven FIFO to completion;
 *     the rebind between the two creations (a deliberate act through the
 *     binding endpoint) leaves the in-flight run riding its FROZEN snapshot
 *     (A34) while the queued run freezes the new binding;
 *  ⑧ M9-02 GET /api/v1/profiles: the loaded profiles behind the guard
 *     pipeline, selection-relevant fields only, empty without orchestration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEventChecksums } from "@role-orchestrator/store";
import type { LocalApiServer } from "../src/index.js";
import { startLocalApiServer } from "../src/index.js";
import {
  createGitFixture,
  createM5TestDb,
  fakeBinPath,
  makeConfigDir,
  rawRequest,
  type GitFixture
} from "./helpers.js";

/**
 * The engine launcher is windows-native-only; non-Windows hosts skip the
 * launcher-driven cells (same gate as server-dogfood.test.ts).
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn("[local-api] non-Windows platform — orchestration cells are skipped");
}

const T0_TIMEOUT_MS = 60_000;

let db: ReturnType<typeof createM5TestDb>["db"];
let closeDb: () => void;
let fixture: GitFixture;
/** M10-01: dedicated projects for the no-binding refusal and the endpoint cells. */
let nobindFixture: GitFixture;
let bindingsFixture: GitFixture;
let proposalFixture: GitFixture;
let server: LocalApiServer;
let bareServer: LocalApiServer; // same db, started WITHOUT orchestration
let worktreesRoot: string;
const proposedWritePath = join(tmpdir(), "role-orchestrator-m9-proposal", "never-written.txt");

const SUCCESS_PROFILE_ID = "profile-orch-claude";
const PROPOSAL_PROFILE_ID = "profile-orch-proposal";
/** M9-02 cell ⑦: the fake-cli "timeout" scenario hangs until the engine's
 * kill budget fires (profile schema floor: 30s). */
const HANG_PROFILE_ID = "profile-orch-hang";
/** M10-01: a second RUNTIME (codex, same fake-cli dogfood bin) so the
 * differentiated four-role binding mix is real, not cosmetically different
 * ids. Only the developer role ever executes in these single-node runs. */
const CODEX_PROFILE_ID = "profile-orch-codex";
/** M10-01: a profile whose executionTarget can never match the fixture
 * project's (windows-native) — binding it must be a typed 422 refusal. It is
 * loaded but never bound successfully, hence never executed. */
const WSL_PROFILE_ID = "profile-orch-wsl";

interface RunSummary {
  readonly runId: string;
  readonly projectId: string;
  readonly status: string;
  readonly statusEndpoint: string;
}

interface RunDetailBody {
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly executions: ReadonlyArray<{ readonly id: string; readonly phase: string; readonly attempt: number; readonly pid: number | null }>;
  };
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
  readonly projectId?: string;
  readonly missingRoles?: readonly string[];
  readonly roleId?: string;
  readonly profileId?: string;
}

function authed(server_: LocalApiServer, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${server_.token}`,
    origin: `http://127.0.0.1:${server_.port}`,
    "x-csrf-token": server_.csrfToken,
    ...extra
  };
}

async function createRun(
  server_: LocalApiServer,
  body: unknown,
  overrides: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  const response = await rawRequest(server_.port, {
    method: "POST",
    path: "/api/v1/runs",
    headers: authed(server_, overrides),
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { status: response.status, body: response.body };
}

function validBody(overrides: Partial<{ objective: string; projectDir: string }> = {}): Record<string, string> {
  return {
    objective: "在 fixture 仓库中产出第一个合成任务结果",
    projectDir: fixture.repoPath,
    ...overrides
  };
}

/** M10-01: configure a project's four role bindings through the dedicated endpoint. */
async function putRoleBindings(
  server_: LocalApiServer,
  projectId: string,
  bindings: ReadonlyArray<{ roleId: string; profileId: string }>,
  overrides: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  const response = await rawRequest(server_.port, {
    method: "PUT",
    path: `/api/v1/projects/${projectId}/role-bindings`,
    headers: authed(server_, { "content-type": "application/json", ...overrides }),
    body: JSON.stringify({ bindings })
  });
  return { status: response.status, body: response.body };
}

/** Raw role_bindings rows (every column, role_id order) for byte-identical comparisons. */
function roleBindingRows(database: typeof db, projectId: string): readonly Record<string, unknown>[] {
  return database
    .prepare("SELECT * FROM role_bindings WHERE project_id = ? ORDER BY role_id ASC")
    .all(projectId) as unknown as readonly Record<string, unknown>[];
}

function roleBindingRowCount(database: typeof db, projectId: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS n FROM role_bindings WHERE project_id = ?")
    .get(projectId) as { n: number };
  return Number(row.n);
}

/** The frozen run snapshots (A34): (role, profile, revision), role_id order. */
function frozenSnapshots(
  database: typeof db,
  runId: string
): ReadonlyArray<{ role_id: string; profile_id: string; profile_revision: number }> {
  return database
    .prepare("SELECT role_id, profile_id, profile_revision FROM run_profile_snapshots WHERE run_id = ? ORDER BY role_id ASC")
    .all(runId) as unknown as ReadonlyArray<{ role_id: string; profile_id: string; profile_revision: number }>;
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs = 30_000,
  dump?: () => Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) {
      const details = dump === undefined ? "" : `
--- state dump ---
${await dump()}`;
      throw new Error(`timed out waiting for ${what}${details}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Debug dump of one run's durable state (node rows + executions). */
async function dumpRun(server_: LocalApiServer, runId: string): Promise<string> {
  const detail = await runDetail(server_, runId);
  const graph = await rawRequest(server_.port, {
    path: `/api/v1/runs/${runId}/graph`,
    headers: authed(server_)
  });
  return `${JSON.stringify(detail.run, null, 2)}
graph: ${graph.body.slice(0, 600)}`;
}

async function runDetail(server_: LocalApiServer, runId: string): Promise<RunDetailBody> {
  const response = await rawRequest(server_.port, {
    path: `/api/v1/runs/${runId}`,
    headers: authed(server_)
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as RunDetailBody;
}

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  const handle = createM5TestDb("orch");
  db = handle.db;
  closeDb = handle.close;
  fixture = await createGitFixture("orch");
  nobindFixture = await createGitFixture("orch-nobind");
  bindingsFixture = await createGitFixture("orch-bind");
  proposalFixture = await createGitFixture("orch-proposal");
  worktreesRoot = mkdtempSync(join(tmpdir(), "ro-localapi-orch-wt-"));

  server = await startLocalApiServer({
    db,
    orchestration: {
      worktreesRoot,
      profiles: [
        {
          id: SUCCESS_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "orch-claude",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "success"]
        },
        {
          id: PROPOSAL_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "orch-proposal",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          // The proposal profile PROPOSES an unscoped write on every
          // execution (including continuations) and never performs it —
          // the A19 heart of group ⑤.
          invocationArgs: ["--scenario", "action-proposal", "--propose-write", proposedWritePath]
        },
        {
          id: HANG_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "orch-hang",
          maxConcurrency: 2,
          // The engine's kill budget doubles as the hang breaker: the
          // "timeout" scenario never finishes on its own.
          timeoutSeconds: 30,
          extraArgs: [],
          invocationArgs: ["--scenario", "timeout"]
        },
        {
          id: CODEX_PROFILE_ID,
          runtime: "codex",
          executable: fakeBinPath("codex"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "orch-codex",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "success"]
        },
        {
          id: WSL_PROFILE_ID,
          runtime: "claude",
          // Windows-form paths on purpose: this profile is never executed —
          // binding it to the windows-native project must cross the A29 gate
          // and be REFUSED (a wsl target cannot take win32 drive paths), the
          // typed 422 the M9-01 era answered with a 500.
          executable: fakeBinPath("claude"),
          executionTarget: "wsl",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "orch-wsl",
          maxConcurrency: 1,
          timeoutSeconds: 600,
          extraArgs: []
        }
      ]
    }
  });
  bareServer = await startLocalApiServer({ db });
}, T0_TIMEOUT_MS);

afterAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  await bareServer?.close();
  await server?.close();
  closeDb?.();
  fixture?.close();
  nobindFixture?.close();
  bindingsFixture?.close();
  proposalFixture?.close();
});

describe.skipIf(!LAUNCHER_APPLIES)("M9-01 POST /api/v1/runs orchestration", () => {
  it("① M10-01 core regression: creation is read-only over role bindings — 422 when incomplete, byte-identical bindings and project-bound developer snapshot when configured", async () => {
    // ---- a fresh project: creation REFUSES (422) and writes nothing ------
    const refused = await createRun(server, validBody({ objective: "M10-01:未绑定时诚实拒绝" }));
    expect(refused.status).toBe(422);
    const refusal = JSON.parse(refused.body) as ErrorBody;
    expect(refusal.error.code).toBe("ROLE_BINDINGS_INCOMPLETE");
    expect(refusal.error.message).toContain("role-bindings"); // the guidance names the configuration endpoint
    expect(refusal.projectId).toMatch(/^proj-[a-z0-9_-]+$/);
    expect(refusal.missingRoles).toEqual(["coordinator", "architect", "developer", "reviewer"]);
    // Zero side effect on the binding table: no rows were initialized.
    expect(roleBindingRowCount(db, refusal.projectId as string)).toBe(0);

    // ---- configure the DIFFERENTIATED four-role mix through the endpoint -
    // claude for developer (the role that executes), codex for the rest.
    const configured = await putRoleBindings(server, refusal.projectId as string, [
      { roleId: "coordinator", profileId: CODEX_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(configured.status).toBe(200);
    const configuredView = JSON.parse(configured.body) as {
      projectId: string;
      bindings: ReadonlyArray<{ roleId: string; profileId: string; profileRevision: number }>;
    };
    expect(configuredView.projectId).toBe(refusal.projectId);
    expect(configuredView.bindings).toEqual([
      { roleId: "architect", profileId: CODEX_PROFILE_ID, profileRevision: 1 },
      { roleId: "coordinator", profileId: CODEX_PROFILE_ID, profileRevision: 1 },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID, profileRevision: 1 },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID, profileRevision: 1 }
    ]);

    // ---- POST (no profileId — the field no longer exists) ----------------
    const bindingsBefore = roleBindingRows(db, refusal.projectId as string).map((row) => ({ ...row }));
    const created = await createRun(server, validBody({ objective: "M10-01:绑定差异化后创建" }));
    // M9-02: 202 Accepted — the drive is asynchronous; the body carries the
    // accept state "queued", never a pretend terminal state.
    expect(created.status).toBe(202);
    const view = JSON.parse(created.body) as RunSummary;
    expect(view.runId).toMatch(/^run-[a-z0-9_-]+$/);
    expect(view.status).toBe("queued");
    expect(view.statusEndpoint).toBe(`/api/v1/runs/${view.runId}`);
    expect(view.projectId).toBe(refusal.projectId);

    // THE regression: creating a task left every binding row byte-identical
    // (every column, updated_at included) — no side effect, no overwrite of
    // the differentiated configuration.
    expect(roleBindingRows(db, refusal.projectId as string).map((row) => ({ ...row }))).toEqual(bindingsBefore);

    // The pump drives asynchronously; the run row settles READY_FOR_DELIVERY.
    await waitFor("run READY_FOR_DELIVERY", async () => {
      const detail = await runDetail(server, view.runId);
      return detail.run.status === "READY_FOR_DELIVERY";
    });
    // ...and the drive changed nothing either.
    expect(roleBindingRows(db, refusal.projectId as string).map((row) => ({ ...row }))).toEqual(bindingsBefore);

    // The run froze EXACTLY the project-bound profiles (A34): developer ->
    // the claude profile that executes, the other roles -> the codex mix.
    expect(frozenSnapshots(db, view.runId)).toEqual([
      { role_id: "architect", profile_id: CODEX_PROFILE_ID, profile_revision: 1 },
      { role_id: "coordinator", profile_id: CODEX_PROFILE_ID, profile_revision: 1 },
      { role_id: "developer", profile_id: SUCCESS_PROFILE_ID, profile_revision: 1 },
      { role_id: "reviewer", profile_id: CODEX_PROFILE_ID, profile_revision: 1 }
    ]);

    const detail = await runDetail(server, view.runId);
    expect(detail.run.status).toBe("READY_FOR_DELIVERY");
    expect(detail.run.executions).toHaveLength(1);
    const execution = detail.run.executions[0];
    expect(execution?.phase).toBe("SUCCEEDED");
    expect(execution?.attempt).toBe(1);
    expect(execution?.pid).toBeGreaterThan(0); // the fake-cli child, engine-recorded

    // The node graph is real and terminal.
    const graph = await rawRequest(server.port, {
      path: `/api/v1/runs/${view.runId}/graph`,
      headers: authed(server)
    });
    expect(graph.status).toBe(200);
    expect(graph.body).toContain('"execute"');

    // The events of the REAL execution are queryable (A36-redacted envelopes).
    const events = await rawRequest(server.port, {
      path: `/api/v1/executions/${execution?.id}/events`,
      headers: authed(server)
    });
    expect(events.status).toBe(200);
    const types = (JSON.parse(events.body) as { events: Array<{ type: string }> }).events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("result_reported");
    expect(types).toContain("process_exited");
  }, T0_TIMEOUT_MS);

  it("② rejects malformed bodies and fail-closed projectDirs with 400 (nothing created); the removed profileId field is an unknown field now", async () => {
    // Schema layer -> 400 INPUT_REJECTED (strict: unknown fields, bounds).
    const listBefore = (
      JSON.parse(
        (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
      ) as { runs: ReadonlyArray<{ id: string }> }
    ).runs.length;
    const schemaCells: ReadonlyArray<{ readonly name: string; readonly body: Record<string, unknown> }> = [
      { name: "unknown field model", body: { ...validBody(), model: "override-attempt" } },
      {
        // M10-01 BREAKING: profileId was removed from the body. A client that
        // still sends it gets the plain unknown-field 400 — never a silent
        // ignore, and never the v0.2.0 binding side effect.
        name: "removed field profileId",
        body: { ...validBody(), profileId: SUCCESS_PROFILE_ID }
      },
      { name: "unknown field profileRevision", body: { ...validBody(), profileRevision: 2 } },
      { name: "empty objective", body: validBody({ objective: "" }) },
      { name: "blank objective", body: validBody({ objective: "   " }) },
      { name: "objective over 10000", body: validBody({ objective: "x".repeat(10001) }) }
    ];
    for (const cell of schemaCells) {
      const response = await createRun(server, cell.body);
      expect(response.status, cell.name).toBe(400);
      const parsed = JSON.parse(response.body) as ErrorBody;
      expect(parsed.error.code, cell.name).toBe("INPUT_REJECTED");
    }

    // Typed domain layer -> 400 with the specific fail-closed code.
    const domainCells: ReadonlyArray<{ readonly name: string; readonly code: string; readonly body: Record<string, unknown> }> = [
      {
        name: "relative projectDir",
        code: "PROJECT_DIR_NOT_ABSOLUTE",
        body: validBody({ projectDir: "relative/dir" })
      },
      {
        name: "missing projectDir",
        code: "PROJECT_DIR_MISSING",
        body: validBody({ projectDir: join(tmpdir(), "ro-m9-missing-dir-xyz") })
      },
      {
        name: "projectDir is a file",
        code: "PROJECT_DIR_NOT_DIRECTORY",
        body: validBody({
          projectDir: (() => {
            const file = join(mkdtempSync(join(tmpdir(), "ro-m9-file-")), "plain.txt");
            writeFileSync(file, "not a directory\n", "utf8");
            return file;
          })()
        })
      },
      {
        name: "projectDir is not a git repository",
        code: "PROJECT_DIR_NOT_GIT_REPOSITORY",
        body: validBody({ projectDir: mkdtempSync(join(tmpdir(), "ro-m9-nogit-")) })
      }
    ];
    for (const cell of domainCells) {
      const response = await createRun(server, cell.body);
      expect(response.status, cell.name).toBe(400);
      const parsed = JSON.parse(response.body) as ErrorBody;
      expect(parsed.error.code, cell.name).toBe(cell.code);
    }

    // None of the refusals created a run: the list is unchanged.
    const listAfter = (
      JSON.parse(
        (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
      ) as { runs: ReadonlyArray<{ id: string }> }
    ).runs.length;
    expect(listAfter).toBe(listBefore);
  });

  it("③ configures bindings ONLY through the dedicated endpoint: valid mix, typed refusals, transactional rollback", async () => {
    // A dedicated project (fresh directory -> 422 probe registers it).
    const probe = await createRun(server, validBody({ projectDir: bindingsFixture.repoPath, objective: "M10-01 端点格:项目登记" }));
    expect(probe.status).toBe(422);
    const { projectId } = JSON.parse(probe.body) as ErrorBody;
    expect(projectId).toMatch(/^proj-[a-z0-9_-]+$/);

    // ---- valid configuration (claude/codex mix) -> 200 + durable rows ----
    const valid = await putRoleBindings(server, projectId as string, [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(valid.status).toBe(200);
    expect(roleBindingRowCount(db, projectId as string)).toBe(4);
    const before = roleBindingRows(db, projectId as string).map((row) => ({ ...row }));

    // ---- unknown profileId (not among the LOADED profiles) -> typed 422 --
    const unknownProfile = await putRoleBindings(server, projectId as string, [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: "profile-never-loaded" },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(unknownProfile.status).toBe(422);
    const unknownBody = JSON.parse(unknownProfile.body) as ErrorBody;
    expect(unknownBody.error.code).toBe("UNKNOWN_PROFILE");
    expect(unknownBody.error.message).toContain("profile-never-loaded");
    expect(unknownBody.profileId).toBe("profile-never-loaded");

    // ---- missing role (three entries) -> 400 shape refusal ---------------
    const missingRole = await putRoleBindings(server, projectId as string, [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID }
    ]);
    expect(missingRole.status).toBe(400);
    expect((JSON.parse(missingRole.body) as ErrorBody).error.code).toBe("INPUT_REJECTED");

    // ---- duplicate role -> 400 shape refusal ------------------------------
    const duplicateRole = await putRoleBindings(server, projectId as string, [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "coordinator", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(duplicateRole.status).toBe(400);
    expect((JSON.parse(duplicateRole.body) as ErrorBody).error.code).toBe("INPUT_REJECTED");

    // ---- executionTarget mismatch -> TYPED 422 (the M9-01-era 500 defect
    //      is fixed): the wsl profile can never run this windows project ----
    const mismatch = await putRoleBindings(server, projectId as string, [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: WSL_PROFILE_ID },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(mismatch.status).toBe(422);
    const mismatchBody = JSON.parse(mismatch.body) as ErrorBody;
    expect(mismatchBody.error.code).toBe("EXECUTION_TARGET_MISMATCH");
    expect(mismatchBody.profileId).toBe(WSL_PROFILE_ID);

    // Every refusal above wrote NOTHING: the bindings are byte-identical
    // (transactional all-or-nothing, updated_at included).
    expect(roleBindingRows(db, projectId as string).map((row) => ({ ...row }))).toEqual(before);

    // ---- unknown project id -> typed 404 ----------------------------------
    const unknownProject = await putRoleBindings(server, "proj-does-not-exist", [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: SUCCESS_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
      { roleId: "reviewer", profileId: SUCCESS_PROFILE_ID }
    ]);
    expect(unknownProject.status).toBe(404);
    expect((JSON.parse(unknownProject.body) as ErrorBody).error.code).toBe("PROJECT_NOT_FOUND");

    // ---- the guard pipeline covers the new endpoint like every /api route -
    const noCsrf = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/projects/${projectId}/role-bindings`,
      headers: { authorization: `Bearer ${server.token}`, origin: `http://127.0.0.1:${server.port}`, "content-type": "application/json" },
      body: JSON.stringify({
        bindings: [
          { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
          { roleId: "architect", profileId: SUCCESS_PROFILE_ID },
          { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
          { roleId: "reviewer", profileId: SUCCESS_PROFILE_ID }
        ]
      })
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toContain("CSRF_REQUIRED");

    const byIdWrongMethod = await rawRequest(server.port, {
      path: `/api/v1/projects/${projectId}/role-bindings`,
      headers: authed(server)
    });
    expect(byIdWrongMethod.status).toBe(405);
    expect(String(byIdWrongMethod.headers.allow)).toBe("PUT");

    const byIdPost = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/projects/${projectId}/role-bindings`,
      headers: authed(server, { "content-type": "application/json" }),
      body: "{}"
    });
    expect(byIdPost.status).toBe(405);

    // ---- the by-projectDir READ the workbench page uses -------------------
    const noTokenRead = await rawRequest(server.port, {
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(bindingsFixture.repoPath)}`
    });
    expect(noTokenRead.status).toBe(403);
    expect(noTokenRead.body).toContain("TOKEN_REQUIRED");

    const byDir = await rawRequest(server.port, {
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(bindingsFixture.repoPath)}`,
      headers: authed(server)
    });
    expect(byDir.status).toBe(200);
    const byDirView = JSON.parse(byDir.body) as {
      projectId: string;
      executionTarget: string;
      bindings: ReadonlyArray<{ roleId: string; profileId: string | null; profileRevision: number | null }>;
    };
    expect(byDirView.projectId).toBe(projectId);
    expect(byDirView.executionTarget).toBe("windows-native");
    expect(byDirView.bindings).toHaveLength(4);
    expect(byDirView.bindings.find((binding) => binding.roleId === "developer")?.profileId).toBe(SUCCESS_PROFILE_ID);

    // A project whose bindings were never configured reads back as unbound
    // nulls — the honest state the page guides on.
    const nobindProbe = await createRun(server, validBody({ projectDir: nobindFixture.repoPath, objective: "M10-01 端点格:未绑定读面" }));
    expect(nobindProbe.status).toBe(422);
    const byDirUnbound = await rawRequest(server.port, {
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(nobindFixture.repoPath)}`,
      headers: authed(server)
    });
    expect(byDirUnbound.status).toBe(200);
    const unboundView = JSON.parse(byDirUnbound.body) as { bindings: ReadonlyArray<{ roleId: string; profileId: string | null }> };
    expect(unboundView.bindings).toHaveLength(0); // never initialized: zero rows is the truth

    const byDirUnknown = await rawRequest(server.port, {
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(join(tmpdir(), "ro-never-a-project"))}`,
      headers: authed(server)
    });
    expect(byDirUnknown.status).toBe(404);
    expect((JSON.parse(byDirUnknown.body) as ErrorBody).error.code).toBe("PROJECT_UNKNOWN");

    const byDirRelative = await rawRequest(server.port, {
      path: "/api/v1/projects/role-bindings?projectDir=relative/dir",
      headers: authed(server)
    });
    expect(byDirRelative.status).toBe(400);
    expect((JSON.parse(byDirRelative.body) as ErrorBody).error.code).toBe("PROJECT_DIR_NOT_ABSOLUTE");

    const byDirExtra = await rawRequest(server.port, {
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(bindingsFixture.repoPath)}&x=1`,
      headers: authed(server)
    });
    expect(byDirExtra.status).toBe(400);
  });

  it("④ keeps the guard pipeline intact and refuses honestly without orchestration", async () => {
    const body = JSON.stringify(validBody());

    const noToken = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/runs",
      headers: { origin: `http://127.0.0.1:${server.port}` },
      body
    });
    // Shipped guard behavior, unchanged (guard.ts checkBearerToken: missing
    // and invalid tokens are indistinguishable 403s — probing-resistant).
    expect(noToken.status).toBe(403);
    expect(noToken.body).toContain("TOKEN_REQUIRED");

    const noCsrf = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/runs",
      headers: { authorization: `Bearer ${server.token}`, origin: `http://127.0.0.1:${server.port}` },
      body
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body).toContain("CSRF_REQUIRED");

    const wrongCsrf = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/runs",
      headers: {
        authorization: `Bearer ${server.token}`,
        origin: `http://127.0.0.1:${server.port}`,
        "x-csrf-token": `${server.csrfToken}x`
      },
      body
    });
    expect(wrongCsrf.status).toBe(403);

    // A process started WITHOUT orchestration: the list still works, the
    // create route refuses with an honest typed 503 (never a pretend run).
    const bareList = await rawRequest(bareServer.port, {
      path: "/api/v1/runs",
      headers: authed(bareServer)
    });
    expect(bareList.status).toBe(200);
    const bareCreate = await createRun(bareServer, validBody());
    expect(bareCreate.status).toBe(503);
    expect(bareCreate.body).toContain("ORCHESTRATION_NOT_CONFIGURED");

    // The binding endpoint refuses with the SAME honest 503 (bindings may
    // only point at loaded profiles; nothing can validate them here).
    const bareBindings = await putRoleBindings(bareServer, "proj-whatever", [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: SUCCESS_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
      { roleId: "reviewer", profileId: SUCCESS_PROFILE_ID }
    ]);
    expect(bareBindings.status).toBe(503);
    expect(bareBindings.body).toContain("ORCHESTRATION_NOT_CONFIGURED");
  });

  it("⑤ opens a REAL approval checkpoint, the guarded decision moves it, the continuation consumes it", async () => {
    // The proposal project binds the PROPOSING profile to the developer role.
    const probe = await createRun(server, validBody({ projectDir: proposalFixture.repoPath, objective: "M9-01 审批格:项目登记" }));
    expect(probe.status).toBe(422);
    const { projectId } = JSON.parse(probe.body) as ErrorBody;
    const seeded = await putRoleBindings(server, projectId as string, [
      { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
      { roleId: "architect", profileId: SUCCESS_PROFILE_ID },
      { roleId: "developer", profileId: PROPOSAL_PROFILE_ID },
      { roleId: "reviewer", profileId: SUCCESS_PROFILE_ID }
    ]);
    expect(seeded.status).toBe(200);

    const created = await createRun(server, validBody({ projectDir: proposalFixture.repoPath, objective: "审批链:提案执行" }));
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    // The proposal execution ends FAILED having ONLY proposed (A19).
    await waitFor("proposal execution terminal", async () => {
      const detail = await runDetail(server, runId);
      return detail.run.executions.length > 0 &&
        ["FAILED", "SUCCEEDED", "CANCELLED"].includes(detail.run.executions[0]?.phase ?? "");
    });
    const firstExecution = (await runDetail(server, runId)).run.executions[0];
    expect(firstExecution?.phase).toBe("FAILED");

    // A19: the proposed side effect has NOT happened.
    expect(existsSync(proposedWritePath)).toBe(false);

    // The approval card is served by the EXISTING approvals view.
    await waitFor("approval card visible", async () => {
      const view = await rawRequest(server.port, {
        path: `/api/v1/runs/${runId}/approvals`,
        headers: authed(server)
      });
      if (view.status !== 200) return false;
      const parsed = JSON.parse(view.body) as { approval: { approvals: ReadonlyArray<{ status: string; actionable: boolean }> } };
      return parsed.approval.approvals.length === 1 && parsed.approval.approvals[0]?.actionable === true;
    });
    const cardView = await rawRequest(server.port, {
      path: `/api/v1/runs/${runId}/approvals`,
      headers: authed(server)
    });
    const card = (
      JSON.parse(cardView.body) as {
        approval: { approvals: ReadonlyArray<{ approvalId: string; status: string; action: { argv: readonly string[] } }> };
      }
    ).approval.approvals[0];
    expect(card?.status).toBe("PENDING");
    expect(card?.action.argv).toContain(proposedWritePath); // the complete argv is visible BEFORE the decision

    // The decision goes through the EXISTING guarded endpoint — and nothing
    // else. The endpoint itself never executes the action.
    const decision = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/approvals/${card?.approvalId}/decision`,
      headers: authed(server, { "content-type": "application/json" }),
      body: JSON.stringify({ decision: "approve", decidedBy: "m9-orchestration-test" })
    });
    expect(decision.status).toBe(200);
    expect(JSON.parse(decision.body) as { status: string }).toMatchObject({ status: "APPROVED" });

    // The pump wakes, performs the ONE digest-bound continuation, and the
    // approval is CONSUMED by exactly that continuation execution.
    let continuationId: string | null = null;
    await waitFor("approval consumed by the continuation", async () => {
      const view = await rawRequest(server.port, {
        path: `/api/v1/runs/${runId}/approvals`,
        headers: authed(server)
      });
      const approvals = (JSON.parse(view.body) as {
        approval: { approvals: ReadonlyArray<{ status: string; consumedByExecutionId: string | null }> };
      }).approval.approvals;
      const first = approvals[0];
      if (first === undefined || first.consumedByExecutionId === null) return false;
      continuationId = first.consumedByExecutionId;
      return true;
    }, 45_000);
    expect(continuationId).not.toBeNull();

    // The continuation execution exists on the run (attempt 2) and, being
    // driven by the re-proposing profile, ends FAILED with a NEW parked
    // checkpoint — the side effect STILL has not happened (A19 through the
    // continuation), and nothing ever wrote the proposed path.
    await waitFor("continuation execution terminal", async () => {
      const detail = await runDetail(server, runId);
      const continuation = detail.run.executions.find((execution) => execution.id === continuationId);
      return continuation !== undefined && ["FAILED", "SUCCEEDED", "CANCELLED"].includes(continuation.phase);
    }, 45_000);
    const finalDetail = await runDetail(server, runId);
    expect(finalDetail.run.executions.find((execution) => execution.id === continuationId)?.attempt).toBe(2);
    expect(existsSync(proposedWritePath)).toBe(false);
    // The re-proposal parked the node again: a fresh WAITING card, PENDING.
    const finalApprovals = (
      JSON.parse(
        (await rawRequest(server.port, {
          path: `/api/v1/runs/${runId}/approvals`,
          headers: authed(server)
        })).body
      ) as {
        approval: {
          approvals: ReadonlyArray<{ status: string; consumedByExecutionId: string | null }>;
        };
      }
    ).approval.approvals;
    expect(finalApprovals.some((approval) => approval.status === "CONSUMED")).toBe(true);
    expect(finalApprovals.some((approval) => approval.status === "PENDING")).toBe(true);
  }, 120_000);

  it("⑥ drives a second run created back-to-back without disturbing the first (serial FIFO)", async () => {
    const first = await createRun(server, validBody({ objective: "第一个串行任务" }));
    const second = await createRun(server, validBody({ objective: "第二个串行任务" }));
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstView = JSON.parse(first.body) as RunSummary;
    const secondView = JSON.parse(second.body) as RunSummary;
    expect(firstView.runId).not.toBe(secondView.runId);

    await waitFor("both runs READY_FOR_DELIVERY", async () => {
      const a = await runDetail(server, firstView.runId);
      const b = await runDetail(server, secondView.runId);
      return a.run.status === "READY_FOR_DELIVERY" && b.run.status === "READY_FOR_DELIVERY";
    }, 45_000, async () =>
      `${await dumpRun(server, firstView.runId)}
===
${await dumpRun(server, secondView.runId)}`);

    // Both executions succeeded — neither run corrupted the other.
    const a = await runDetail(server, firstView.runId);
    const b = await runDetail(server, secondView.runId);
    expect(a.run.executions[0]?.phase).toBe("SUCCEEDED");
    expect(b.run.executions[0]?.phase).toBe("SUCCEEDED");

    // The task list serves both, newest first, with the durable objectives.
    const list = await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) });
    expect(list.status).toBe(200);
    const runs = (JSON.parse(list.body) as {
      runs: ReadonlyArray<{ id: string; objective: string | null; status: string }>;
    }).runs;
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs[0]?.id).toBe(secondView.runId);
    expect(runs[1]?.id).toBe(firstView.runId);
    expect(runs.find((run) => run.id === firstView.runId)?.objective).toBe("第一个串行任务");
    expect(runs.find((run) => run.id === secondView.runId)?.objective).toBe("第二个串行任务");
    expect(runs.find((run) => run.id === firstView.runId)?.status).toBe("READY_FOR_DELIVERY");

    // The whole drive left the event log checksum-clean.
    expect(verifyEventChecksums(db)).toEqual([]);
  }, 90_000);

  it("⑦ answers 202 immediately while a long run occupies the drive chain; the mid-flight rebind freezes the OLD run and binds the NEW one", async () => {
    // Resolve the main project (registered by cell ①) through the by-dir read,
    // then bind the developer role to the HANGING profile — a deliberate act
    // through the binding endpoint — and occupy the serial drive chain: the
    // fake-cli "timeout" scenario never finishes until the engine's kill
    // budget (30s) fires. Under the M9-01 layout the next POST would BLOCK
    // for that whole window — this cell is the coupling regression.
    const mainProject = await rawRequest(server.port, {
      path: `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(fixture.repoPath)}`,
      headers: authed(server)
    });
    expect(mainProject.status).toBe(200);
    const { projectId: mainProjectId } = JSON.parse(mainProject.body) as { projectId: string };
    const hangBind = await putRoleBindings(server, mainProjectId, [
      { roleId: "coordinator", profileId: CODEX_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: HANG_PROFILE_ID },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(hangBind.status).toBe(200);

    const hang = await createRun(server, validBody({ objective: "长任务(占链)" }));
    expect(hang.status).toBe(202);
    const hangView = JSON.parse(hang.body) as RunSummary;
    await waitFor("hang execution RUNNING", async () => {
      const detail = await runDetail(server, hangView.runId);
      return detail.run.executions[0]?.phase === "RUNNING";
    });

    // The M10-01 rebind WHILE the hang run is in flight: a deliberate human
    // act through the endpoint. The in-flight run must not notice it (its
    // snapshot is frozen); the NEXT creation freezes the new binding.
    const rebind = await putRoleBindings(server, hangView.projectId, [
      { roleId: "coordinator", profileId: CODEX_PROFILE_ID },
      { roleId: "architect", profileId: CODEX_PROFILE_ID },
      { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
      { roleId: "reviewer", profileId: CODEX_PROFILE_ID }
    ]);
    expect(rebind.status).toBe(200);

    // The queued run's creation must NOT wait behind the in-flight drive.
    const startedAt = Date.now();
    const queued = await createRun(server, validBody({ objective: "排队任务(202 即回)" }));
    const elapsedMs = Date.now() - startedAt;
    expect(queued.status).toBe(202);
    const queuedView = JSON.parse(queued.body) as RunSummary;
    expect(queuedView.status).toBe("queued");
    expect(elapsedMs).toBeLessThan(10_000);

    // A34 from the API side: the in-flight hang run rides the FROZEN hang
    // snapshot; the queued run froze the NEW developer binding.
    expect(frozenSnapshots(db, hangView.runId).find((row) => row.role_id === "developer")?.profile_id).toBe(HANG_PROFILE_ID);
    expect(frozenSnapshots(db, queuedView.runId).find((row) => row.role_id === "developer")?.profile_id).toBe(SUCCESS_PROFILE_ID);

    // At the moment of acceptance the long run was still executing — the
    // response really did not wait for the chain.
    const hangDuring = await runDetail(server, hangView.runId);
    expect(hangDuring.run.executions[0]?.phase).toBe("RUNNING");

    // ...and the queued run IS still executed: once the hang hits the kill
    // budget (FAILED evidence on the execution), the pump proceeds FIFO.
    await waitFor("queued run READY_FOR_DELIVERY", async () => {
      const detail = await runDetail(server, queuedView.runId);
      return detail.run.status === "READY_FOR_DELIVERY";
    }, 90_000);
    const queuedFinal = await runDetail(server, queuedView.runId);
    expect(queuedFinal.run.executions[0]?.phase).toBe("SUCCEEDED");
    const hangFinal = await runDetail(server, hangView.runId);
    expect(hangFinal.run.executions[0]?.phase).toBe("FAILED");
  }, 150_000);

  it("⑧ serves the loaded profiles behind the guard pipeline (empty without orchestration)", async () => {
    const response = await rawRequest(server.port, { path: "/api/v1/profiles", headers: authed(server) });
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as {
      profiles: ReadonlyArray<{
        readonly id: string;
        readonly runtime: string;
        readonly executionTarget: string;
        readonly model: string | null;
        readonly timeoutSeconds: number;
      }>;
    };
    expect([...parsed.profiles.map((profile) => profile.id)].sort()).toEqual(
      [HANG_PROFILE_ID, PROPOSAL_PROFILE_ID, SUCCESS_PROFILE_ID, CODEX_PROFILE_ID, WSL_PROFILE_ID].sort()
    );
    for (const profile of parsed.profiles) {
      expect(["claude", "codex"]).toContain(profile.runtime);
      expect(["windows-native", "wsl"]).toContain(profile.executionTarget);
      expect(profile.model).toBeNull();
      expect(typeof profile.timeoutSeconds).toBe("number");
    }
    // Selection-relevant fields ONLY: the executable/configDir filesystem
    // paths and the credential group never leave the process.
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("executable");
    expect(serialized).not.toContain("configDir");
    expect(serialized).not.toContain("credentialGroup");

    // Same guard pipeline as every /api read.
    const noToken = await rawRequest(server.port, { path: "/api/v1/profiles" });
    expect(noToken.status).toBe(403);
    expect(noToken.body).toContain("TOKEN_REQUIRED");

    const withQuery = await rawRequest(server.port, {
      path: "/api/v1/profiles?x=1",
      headers: authed(server)
    });
    expect(withQuery.status).toBe(400);

    const postRefused = await rawRequest(server.port, {
      method: "POST",
      path: "/api/v1/profiles",
      headers: authed(server, { "content-type": "application/json" }),
      body: "{}"
    });
    expect(postRefused.status).toBe(405);

    // A process started WITHOUT orchestration drives nothing and offers
    // nothing to select: an honest empty list, not an error.
    const bare = await rawRequest(bareServer.port, { path: "/api/v1/profiles", headers: authed(bareServer) });
    expect(bare.status).toBe(200);
    expect((JSON.parse(bare.body) as { profiles: unknown[] }).profiles).toEqual([]);
  });
});

/**
 * M9-04 review handover #62 — the model-only semantics the corrected copy
 * states, pinned as behavior (the review probe's scenario, made permanent):
 * a same-id profile edit that changes ONLY the model
 *   - never meets the drift gate (409) at run creation — `model` is not one
 *     of the seven compared fields;
 *   - never mints a new profile revision (the binding endpoint's
 *     ensureProfileRevision runs once);
 *   - leaves every NEW task riding the FIRST-frozen revision (old model),
 *     both before AND after a restart with the edited file.
 * Fail-safe on purpose: silently executing under the old model beats any
 * silent upsert; changing a model must be a new profile id (or a future
 * governance proposal). Self-contained harness: its own db/git fixture/
 * worktrees/source file, so the shared cells above stay untouched.
 * M10-01: the developer profile comes from the project role bindings
 * (configured through the dedicated endpoint), never from the run body.
 */
describe.skipIf(!LAUNCHER_APPLIES)("M9-04 #62 regression: model-only same-id edit (no conflict, no re-revision)", () => {
  const MODEL_PROFILE_ID = "profile-orch-model";
  const MODEL_V1 = "test-model-m1";
  const MODEL_V2 = "test-model-m2";

  // ONE configDir across every form: configDir is one of the seven drift
  // fields — the composition profile, the file content and the post-restart
  // composition must agree on all seven so ONLY the model differs.
  const sharedConfigDir = makeConfigDir();

  /** Composition-level profile (invocationArgs is the process-injection
   * channel — NOT part of the frozen FILE schema, so fileWith omits it). */
  function definition(model: string | null): Record<string, unknown> {
    return { ...baseFields(model), invocationArgs: ["--scenario", "success"] };
  }

  function baseFields(model: string | null): Record<string, unknown> {
    return {
      id: MODEL_PROFILE_ID,
      runtime: "claude",
      executable: fakeBinPath("claude"),
      executionTarget: "windows-native",
      configDir: sharedConfigDir,
      model,
      credentialGroup: "orch-model",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      extraArgs: []
    };
  }

  function fileWith(model: string): string {
    return JSON.stringify({ schemaVersion: 1, profiles: [baseFields(model)] });
  }

  /** The profile's durable revision rows: [(revision, model)] oldest first. */
  function revisionRows(database: ReturnType<typeof createM5TestDb>["db"]): ReadonlyArray<{ revision: number; model: string | null }> {
    return (
      database
        .prepare("SELECT revision, model FROM profile_revisions WHERE profile_id = ? ORDER BY revision ASC")
        .all(MODEL_PROFILE_ID) as unknown as ReadonlyArray<{ revision: number; model: string | null }>
    ).map((row) => ({ revision: Number(row.revision), model: row.model }));
  }

  /** The frozen profile snapshot a run actually executes under. */
  function frozenSnapshot(
    database: ReturnType<typeof createM5TestDb>["db"],
    runId: string
  ): { profileId: string; revision: number; model: string | null } {
    const row = database
      .prepare("SELECT profile_id, profile_revision, snapshot_json FROM run_profile_snapshots WHERE run_id = ? LIMIT 1")
      .get(runId) as { profile_id: string; profile_revision: number; snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as { requestedModel: string | null };
    return { profileId: row.profile_id, revision: Number(row.profile_revision), model: snapshot.requestedModel };
  }

  it("same-id model edit: write-back and restart both leave run creation conflict-free on revision 1", async () => {
    const handle = createM5TestDb("orch-model");
    const modelFixture = await createGitFixture("orch-model");
    const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-localapi-orch-model-wt-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "ro-localapi-orch-model-src-"));
    const sourceFile = join(sourceDir, "profiles.json");
    writeFileSync(sourceFile, fileWith(MODEL_V1), "utf8");

    const serverV1 = await startLocalApiServer({
      db: handle.db,
      orchestration: {
        worktreesRoot,
        profiles: [definition(MODEL_V1)] as never,
        profilesSourcePath: sourceFile
      }
    });
    let serverV1Open = true;
    try {
      // ---- project registration + role bindings through the endpoint ------
      const probe = await createRun(serverV1, validBody({ projectDir: modelFixture.repoPath, objective: "model-only 回归:项目登记" }));
      expect(probe.status).toBe(422); // no bindings yet — the honest M10-01 refusal
      const { projectId } = JSON.parse(probe.body) as ErrorBody;
      const seeded = await putRoleBindings(serverV1, projectId as string, [
        { roleId: "coordinator", profileId: MODEL_PROFILE_ID },
        { roleId: "architect", profileId: MODEL_PROFILE_ID },
        { roleId: "developer", profileId: MODEL_PROFILE_ID },
        { roleId: "reviewer", profileId: MODEL_PROFILE_ID }
      ]);
      expect(seeded.status).toBe(200);
      expect(revisionRows(handle.db)).toEqual([{ revision: 1, model: MODEL_V1 }]);

      // ---- run 1 under the first-frozen revision (model m1) ----------------
      const first = await createRun(serverV1, validBody({ projectDir: modelFixture.repoPath, objective: "model-only 回归:首建任务" }));
      expect(first.status).toBe(202);
      const firstView = JSON.parse(first.body) as RunSummary;
      await waitFor("run 1 READY_FOR_DELIVERY", async () => {
        const detail = await runDetail(serverV1, firstView.runId);
        return detail.run.status === "READY_FOR_DELIVERY";
      });
      expect(revisionRows(handle.db)).toEqual([{ revision: 1, model: MODEL_V1 }]);

      // ---- the same-id, model-only write-back through the guarded endpoint -
      const put = await rawRequest(serverV1.port, {
        method: "PUT",
        path: "/api/v1/profiles/full",
        headers: authed(serverV1, { "content-type": "application/json" }),
        body: JSON.stringify({ content: fileWith(MODEL_V2) })
      });
      expect(put.status).toBe(200); // validates through the frozen parser — no drift refusal

      // ---- run 2 BEFORE any restart: no 409, still revision 1 / old model --
      const second = await createRun(serverV1, validBody({ projectDir: modelFixture.repoPath, objective: "model-only 回归:写回后建任务" }));
      expect(second.status).toBe(202); // the drift gate does NOT fire on a model-only edit
      expect(second.body).not.toContain("PROFILE_DEFINITION_CONFLICT");
      const secondView = JSON.parse(second.body) as RunSummary;
      await waitFor("run 2 READY_FOR_DELIVERY", async () => {
        const detail = await runDetail(serverV1, secondView.runId);
        return detail.run.status === "READY_FOR_DELIVERY";
      });
      // The edit minted NO new revision, and run 2 rides the FIRST one.
      expect(revisionRows(handle.db)).toEqual([{ revision: 1, model: MODEL_V1 }]);
      expect(frozenSnapshot(handle.db, secondView.runId)).toEqual({
        profileId: MODEL_PROFILE_ID,
        revision: 1,
        model: MODEL_V1
      });

      await serverV1.close();
      serverV1Open = false;

      // ---- restart WITH the edited file: still conflict-free, still rev 1 --
      const serverV2 = await startLocalApiServer({
        db: handle.db,
        orchestration: {
          worktreesRoot,
          profiles: [definition(MODEL_V2)] as never,
          profilesSourcePath: sourceFile
        }
      });
      try {
        const third = await createRun(serverV2, validBody({ projectDir: modelFixture.repoPath, objective: "model-only 回归:重启后建任务" }));
        expect(third.status).toBe(202); // the post-restart half of the #62 copy
        expect(third.body).not.toContain("PROFILE_DEFINITION_CONFLICT");
        const thirdView = JSON.parse(third.body) as RunSummary;
        await waitFor("run 3 READY_FOR_DELIVERY", async () => {
          const detail = await runDetail(serverV2, thirdView.runId);
          return detail.run.status === "READY_FOR_DELIVERY";
        });
        expect(revisionRows(handle.db)).toEqual([{ revision: 1, model: MODEL_V1 }]);
        expect(frozenSnapshot(handle.db, thirdView.runId)).toEqual({
          profileId: MODEL_PROFILE_ID,
          revision: 1,
          model: MODEL_V1
        });
      } finally {
        await serverV2.close();
      }
    } finally {
      if (serverV1Open) await serverV1.close();
      handle.close();
      modelFixture.close();
      rmSync(worktreesRoot, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  }, 150_000);
});

/**
 * V031-01 ③ — the drift gate's POSITIVE case. Until now the 409
 * PROFILE_DEFINITION_CONFLICT family existed only as an error-mapping table
 * entry (orchestration errors.test.ts) and NEGATIVE assertions (the M9-04 #62
 * model-only cells above assert the gate does NOT fire) — no test ever drove
 * an actual seven-field drift through the HTTP surface.
 *
 * The ACTUAL trigger surface is PUT /api/v1/projects/:id/role-bindings
 * (server.ts refusal order #6 → orchestration setProjectRoleBindings →
 * ensureProfileRow's seven-field find at run-creation.ts): the binding
 * endpoint materializes the durable profile row, so a same-id definition
 * whose loaded (post-restart) values differ from the stored row on ANY of
 * runtime/executable/executionTarget/configDir/credentialGroup/maxConcurrency/
 * timeoutSeconds must answer 409 there — drift is a deliberate human act,
 * never an upsert.
 *
 * 判别力 (how this grid goes red):
 *  - the gate removed or narrowed (drift silently upserted): the second
 *    PUT answers 200 and the stored row reads 601 -> both assertions red;
 *  - the gate fires on model-only edits too (over-broad): breaks the M9-04
 *    #62 cells above (same suite, shared contract);
 *  - the refusal loses its typed code/message: the body assertions fail.
 */
describe.skipIf(!LAUNCHER_APPLIES)("V031-01 drift-gate positive: same-id seven-field drift answers 409 PROFILE_DEFINITION_CONFLICT", () => {
  const DRIFT_PROFILE_ID = "profile-orch-drift";
  // ONE configDir across both serves: configDir is itself one of the seven
  // compared fields — only timeoutSeconds may differ between V1 and V2.
  const sharedConfigDir = makeConfigDir();

  function driftDefinition(timeoutSeconds: number): Record<string, unknown> {
    return {
      id: DRIFT_PROFILE_ID,
      runtime: "claude",
      executable: fakeBinPath("claude"),
      executionTarget: "windows-native",
      configDir: sharedConfigDir,
      model: null,
      credentialGroup: "orch-drift",
      maxConcurrency: 2,
      timeoutSeconds,
      extraArgs: [],
      invocationArgs: ["--scenario", "success"]
    };
  }

  function fileWith(timeoutSeconds: number): string {
    // The FILE schema carries the frozen fields (invocationArgs is the
    // process-injection channel and stays out — same discipline as the
    // M9-04 #62 harness above).
    const { invocationArgs: _omitted, ...fileFields } = driftDefinition(timeoutSeconds);
    return JSON.stringify({ schemaVersion: 1, profiles: [fileFields] });
  }

  it("a same-id profile with timeoutSeconds drifted 600->601 is refused 409 at the binding endpoint; the stored row keeps 600 (refusal, not upsert)", async () => {
    const handle = createM5TestDb("orch-drift");
    const driftFixture = await createGitFixture("orch-drift");
    const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-localapi-orch-drift-wt-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "ro-localapi-orch-drift-src-"));
    const sourceFile = join(sourceDir, "profiles.json");
    writeFileSync(sourceFile, fileWith(600), "utf8");

    const serverV1 = await startLocalApiServer({
      db: handle.db,
      orchestration: {
        worktreesRoot,
        profiles: [driftDefinition(600)] as never,
        profilesSourcePath: sourceFile
      }
    });
    let serverV1Open = true;
    try {
      // Register the project and MATERIALIZE the durable profile row at V1
      // (the binding endpoint's ensureProfileRow creates it).
      const probe = await createRun(serverV1, validBody({ projectDir: driftFixture.repoPath, objective: "漂移门正向:项目登记" }));
      expect(probe.status).toBe(422); // the honest M10-01 no-bindings refusal
      const { projectId } = JSON.parse(probe.body) as ErrorBody;
      const seeded = await putRoleBindings(serverV1, projectId as string, [
        { roleId: "coordinator", profileId: DRIFT_PROFILE_ID },
        { roleId: "architect", profileId: DRIFT_PROFILE_ID },
        { roleId: "developer", profileId: DRIFT_PROFILE_ID },
        { roleId: "reviewer", profileId: DRIFT_PROFILE_ID }
      ]);
      expect(seeded.status).toBe(200);

      await serverV1.close();
      serverV1Open = false;

      // Restart against the SAME db with the SAME id but timeoutSeconds
      // drifted 600->601 — every other field (and the file on disk) agreed
      // per the shared configDir discipline above.
      const serverV2 = await startLocalApiServer({
        db: handle.db,
        orchestration: {
          worktreesRoot,
          profiles: [driftDefinition(601)] as never,
          profilesSourcePath: sourceFile
        }
      });
      try {
        const conflict = await putRoleBindings(serverV2, projectId as string, [
          { roleId: "coordinator", profileId: DRIFT_PROFILE_ID },
          { roleId: "architect", profileId: DRIFT_PROFILE_ID },
          { roleId: "developer", profileId: DRIFT_PROFILE_ID },
          { roleId: "reviewer", profileId: DRIFT_PROFILE_ID }
        ]);
        expect(conflict.status).toBe(409);
        expect(conflict.body).toContain("PROFILE_DEFINITION_CONFLICT");
        expect(conflict.body).toContain("timeoutSeconds");
        expect(conflict.body).toContain("601");
        // Drift is a refusal, not an upsert: the durable row still reads 600.
        const stored = handle.db
          .prepare("SELECT timeout_seconds FROM profiles WHERE id = ?")
          .get(DRIFT_PROFILE_ID) as { timeout_seconds: number | bigint };
        expect(Number(stored.timeout_seconds)).toBe(600);
      } finally {
        await serverV2.close();
      }
    } finally {
      if (serverV1Open) await serverV1.close();
      handle.close();
      driftFixture.close();
      rmSync(worktreesRoot, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }
  }, 120_000);
});
