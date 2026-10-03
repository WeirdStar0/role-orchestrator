/**
 * M9-01 "点火" — the POST /api/v1/runs orchestration end-to-end, HERMETIC:
 * the only CLI ever spawned is the repository's own BUILT fake-cli dist bin
 * (dogfood discipline — a real claude/codex is never invoked; the real-CLI
 * smoke is the maintainer's).
 *
 * The cells walk the full chain the milestone accepts on:
 *   ① create (202 Accepted, status "queued" — M9-02 async-drive semantics)
 *     -> drive -> fake-cli success -> run detail + events queryable
 *     (the events land through the engine's redacting persistence, so the
 *     REST/WS surfaces see them unchanged);
 *  ② strict input validation (unknown fields, bounds, projectDir
 *     fail-closed: not absolute / missing / a file / not a git repo) -> 400;
 *  ③ the guard pipeline is unchanged: no token 403, no/wrong CSRF 403, a
 *     server started WITHOUT orchestration answers 503 (honest refusal) and
 *     serves an EMPTY profiles list (M9-02);
 *  ④ the approval path: a proposal execution opens a REAL checkpoint (the
 *     card is served by the existing approvals view), the decision goes ONLY
 *     through POST /api/v1/approvals/:id/decision, and the pump then performs
 *     exactly the one digest-bound continuation (A17/A19 — the proposed side
 *     effect never happens; the re-proposing continuation re-parks);
 *  ⑤ multi-run: the second run is created while the first is queued and both
 *     complete undisturbed (the serial drive chain, FIFO); the list endpoint
 *     serves both, newest first, with objectives; event checksums still verify;
 *  ⑥ M9-02 coupling regression: with a long run OCCUPYING the drive chain,
 *     POST /api/v1/runs still answers 202 immediately (the creation chain is
 *     separate) and the queued run is nevertheless driven FIFO to completion;
 *  ⑦ M9-02 GET /api/v1/profiles: the loaded profiles behind the guard
 *     pipeline, selection-relevant fields only, empty without orchestration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
let server: LocalApiServer;
let bareServer: LocalApiServer; // same db, started WITHOUT orchestration
let worktreesRoot: string;
const proposedWritePath = join(tmpdir(), "role-orchestrator-m9-proposal", "never-written.txt");

const SUCCESS_PROFILE_ID = "profile-orch-claude";
const PROPOSAL_PROFILE_ID = "profile-orch-proposal";
/** M9-02 cell ⑥: the fake-cli "timeout" scenario hangs until the engine's
 * kill budget fires (profile schema floor: 30s). */
const HANG_PROFILE_ID = "profile-orch-hang";

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

function validBody(overrides: Partial<{ objective: string; profileId: string; projectDir: string }> = {}): Record<string, string> {
  return {
    objective: "在 fixture 仓库中产出第一个合成任务结果",
    profileId: SUCCESS_PROFILE_ID,
    projectDir: fixture.repoPath,
    ...overrides
  };
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
          // the A19 heart of group ④.
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
});

describe.skipIf(!LAUNCHER_APPLIES)("M9-01 POST /api/v1/runs orchestration", () => {
  it("① creates a run (202 queued), drives fake-cli to SUCCEEDED, and serves run detail + events", async () => {
    const created = await createRun(server, validBody());
    // M9-02: 202 Accepted — the drive is asynchronous; the body carries the
    // accept state "queued", never a pretend terminal state.
    expect(created.status).toBe(202);
    const view = JSON.parse(created.body) as RunSummary;
    expect(view.runId).toMatch(/^run-[a-z0-9_-]+$/);
    expect(view.status).toBe("queued");
    expect(view.statusEndpoint).toBe(`/api/v1/runs/${view.runId}`);

    // The pump drives asynchronously; the run row settles READY_FOR_DELIVERY.
    await waitFor("run READY_FOR_DELIVERY", async () => {
      const detail = await runDetail(server, view.runId);
      return detail.run.status === "READY_FOR_DELIVERY";
    });
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

  it("② rejects malformed bodies and fail-closed projectDirs with 400 (nothing created)", async () => {
    // Schema layer -> 400 INPUT_REJECTED (strict: unknown fields, bounds).
    const listBefore = (
      JSON.parse(
        (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
      ) as { runs: ReadonlyArray<{ id: string }> }
    ).runs.length;
    const schemaCells: ReadonlyArray<{ readonly name: string; readonly body: Record<string, unknown> }> = [
      { name: "unknown field model", body: { ...validBody(), model: "override-attempt" } },
      { name: "unknown field profileRevision", body: { ...validBody(), profileRevision: 2 } },
      { name: "empty objective", body: validBody({ objective: "" }) },
      { name: "blank objective", body: validBody({ objective: "   " }) },
      { name: "objective over 10000", body: validBody({ objective: "x".repeat(10001) }) }
    ];
    for (const cell of schemaCells) {
      const response = await createRun(server, cell.body);
      expect(response.status, cell.name).toBe(400);
      const parsed = JSON.parse(response.body) as { error: { code: string } };
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
      },
      {
        name: "unknown profileId",
        code: "UNKNOWN_PROFILE",
        body: validBody({ profileId: "profile-nope" })
      }
    ];
    for (const cell of domainCells) {
      const response = await createRun(server, cell.body);
      expect(response.status, cell.name).toBe(400);
      const parsed = JSON.parse(response.body) as { error: { code: string } };
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

  it("③ keeps the guard pipeline intact and refuses honestly without orchestration", async () => {
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
  });

  it("④ opens a REAL approval checkpoint, the guarded decision moves it, the continuation consumes it", async () => {
    const created = await createRun(server, validBody({ profileId: PROPOSAL_PROFILE_ID }));
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

  it("⑤ drives a second run created back-to-back without disturbing the first (serial FIFO)", async () => {
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

  it("⑥ answers 202 immediately while a long run occupies the drive chain, and still drives the queued run", async () => {
    // The hang profile occupies the serial drive chain: the fake-cli
    // "timeout" scenario never finishes until the engine's kill budget
    // (30s) fires. Under the M9-01 layout the next POST would BLOCK for
    // that whole window — this cell is the coupling regression.
    const hang = await createRun(server, validBody({ objective: "长任务(占链)", profileId: HANG_PROFILE_ID }));
    expect(hang.status).toBe(202);
    const hangView = JSON.parse(hang.body) as RunSummary;
    await waitFor("hang execution RUNNING", async () => {
      const detail = await runDetail(server, hangView.runId);
      return detail.run.executions[0]?.phase === "RUNNING";
    });

    // The queued run's creation must NOT wait behind the in-flight drive.
    const startedAt = Date.now();
    const queued = await createRun(server, validBody({ objective: "排队任务(202 即回)" }));
    const elapsedMs = Date.now() - startedAt;
    expect(queued.status).toBe(202);
    const queuedView = JSON.parse(queued.body) as RunSummary;
    expect(queuedView.status).toBe("queued");
    expect(elapsedMs).toBeLessThan(10_000);

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

  it("⑦ serves the loaded profiles behind the guard pipeline (empty without orchestration)", async () => {
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
      [HANG_PROFILE_ID, PROPOSAL_PROFILE_ID, SUCCESS_PROFILE_ID].sort()
    );
    for (const profile of parsed.profiles) {
      expect(profile.runtime).toBe("claude");
      expect(profile.executionTarget).toBe("windows-native");
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
