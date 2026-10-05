/**
 * M10-03 — the multi-node orchestration end-to-end over the PRODUCTION
 * entry (POST /api/v1/runs with the optional strict `workflow` field),
 * HERMETIC: the only CLI ever spawned is the repository's own BUILT fake-cli
 * dist bin (dogfood discipline — a real claude/codex is never invoked).
 *
 * The cells walk the chain the milestone accepts on:
 *  ① STRICT INPUT: the workflow field's per-field shape/bounds are the HTTP
 *     schema's (unknown fields — including any profileId/model carrier at
 *     ANY nesting — bad kind, bad role, >64 nodes: plain 400
 *     INPUT_REJECTED); the cross-field legality is the domain's (duplicate
 *     ids, unknown dependency, self dependency, cycle, integration without
 *     parents, review dependency count/role: typed 400 WORKFLOW_*); nothing
 *     is created by any refusal. The v0.2.1 path stays intact: a body
 *     WITHOUT workflow creates the single-node execute graph and drives it
 *     exactly as the M10-01 contract suite pins (one execution, bare
 *     objective prompt).
 *  ② FOUR-NODE PASS CHAIN: plan -> impl -> integrate -> review (review PASS):
 *     the run settles READY_FOR_DELIVERY with every node SUCCEEDED; the
 *     dependency baseline is REAL (impl's committed output is an ancestor of
 *     the integration candidate the review verdict binds to; impl's commit
 *     sits directly on the run base); the review session's candidate IS the
 *     integration candidateSha (A12); the multi-node prompts carry the role
 *     context (role header + objective + the dependency's accepted output
 *     SHA) while the single-node prompt stays the bare objective; the CLI
 *     dispatches are SERIAL (no overlap, topological order).
 *  ③ REVIEW FAIL -> CONTROLLED EXPANSION -> FIX -> RE-REVIEW PASS: the
 *     round-1 review FAILS content-grounded (the candidate misses the repair
 *     file), the node still SUCCEEDS (the verdict is data), the driver
 *     itself requests the controlled expansion (A04 coordinator requester /
 *     A38 driver-read revision lock / A20 generation budget intact), the
 *     minted integrate-fix-2 (agent) commits the repair and the minted
 *     integrate-review-2 (review) PASSES bound to the NEW candidateSha (A12:
 *     the old fail verdict answers only for the old candidate).
 *  ④ APPROVAL PARK/CONTINUE IN A MULTI-NODE GRAPH: plan -> impl(proposal
 *     profile) -> review: the proposing execution parks impl at
 *     WAITING_APPROVAL; the DOWNSTREAM review is never dispatched; the
 *     guarded decision endpoint approves; the pump performs the ONE
 *     digest-bound continuation (attempt 2) which — proposal profile —
 *     re-parks (the shipped M9-01 semantics, now with a blocked downstream);
 *     the proposed side effect never happens (A19).
 *
 * The node-output commit is the TEST composition root's OutputCommitter
 * stand-in (the controlled Git-Service commit step: fixed identity, explicit
 * paths only); production passes no committer and never commits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getReviewVerdict } from "@role-orchestrator/review";
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

const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn("[local-api] non-Windows platform — multi-node launcher cells are skipped");
}

const T0_TIMEOUT_MS = 90_000;
const CELL_TIMEOUT_MS = 120_000;

let db: ReturnType<typeof createM5TestDb>["db"];
let closeDb: () => void;
let passFixture: GitFixture;
let reworkFixture: GitFixture;
let approvalFixture: GitFixture;
let server: LocalApiServer;
let worktreesRoot: string;

const SUCCESS_PROFILE_ID = "profile-mn-claude";
const CODEX_PROFILE_ID = "profile-mn-codex";
const REVIEW_PASS_PROFILE_ID = "profile-mn-review-pass";
const REVIEW_REWORK_PROFILE_ID = "profile-mn-review-rework";
const PROPOSAL_PROFILE_ID = "profile-mn-proposal";

const IMPL_FILE_REL = "src/feature/app.txt";
const IMPL_FILE_CONTENT = "multi-node feature: impl output\n";
const FIX_FILE_REL = "src/feature/fix.txt";
const FIX_FILE_CONTENT = "multi-node feature: approved repair output\n";
const proposedWritePath = join(tmpdir(), "role-orchestrator-m10-proposal", "never-written.txt");

/** The committed node outputs the test committer produced, nodeId -> sha. */
const committedOutputs = new Map<string, string>();

/** The declared output files per agent node id (the commit stand-in's manifest). */
function nodeFilesFor(nodeId: string): Readonly<Record<string, string>> | null {
  if (nodeId === "impl") return { [IMPL_FILE_REL]: IMPL_FILE_CONTENT };
  if (nodeId === "integrate-fix-2") return { [FIX_FILE_REL]: FIX_FILE_CONTENT };
  return null;
}

const COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "role-orchestrator-m10-multi-node",
  GIT_AUTHOR_EMAIL: "multi-node@role-orchestrator.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "role-orchestrator-m10-multi-node",
  GIT_COMMITTER_EMAIL: "multi-node@role-orchestrator.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
};

/**
 * The controlled Git-Service commit stand-in: write exactly the declared
 * files, stage EXACTLY those explicit paths, commit with fixed identity and
 * return the new HEAD. Nodes without a declared file set commit nothing
 * (their accepted output is the doctrine's inputSha fallback).
 */
async function commitNodeOutput(
  git: string,
  input: {
    readonly nodeId: string;
    readonly worktreePath: string;
  }
): Promise<string | null> {
  const files = nodeFilesFor(input.nodeId);
  if (files === null) return null;
  const relativePaths = Object.keys(files);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(input.worktreePath, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  const run = (args: readonly string[]): void => {
    execFileSync(git, args, { cwd: input.worktreePath, env: { ...process.env, ...COMMIT_ENV }, stdio: "pipe" });
  };
  run(["add", ...relativePaths]);
  run(["commit", "-m", `multi-node output commit: ${input.nodeId}`]);
  const head = execFileSync(git, ["rev-parse", "HEAD"], { cwd: input.worktreePath, encoding: "utf8" });
  const sha = head.trim();
  committedOutputs.set(input.nodeId, sha);
  return sha;
}

interface RunSummary {
  readonly runId: string;
  readonly projectId: string;
  readonly status: string;
  readonly statusEndpoint: string;
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
  readonly projectId?: string;
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
  body: unknown
): Promise<{ status: number; body: string }> {
  const response = await rawRequest(server_.port, {
    method: "POST",
    path: "/api/v1/runs",
    headers: authed(server_, { "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  return { status: response.status, body: response.body };
}

async function putRoleBindings(
  server_: LocalApiServer,
  projectId: string,
  developerProfileId: string,
  reviewerProfileId: string
): Promise<void> {
  const response = await rawRequest(server_.port, {
    method: "PUT",
    path: `/api/v1/projects/${projectId}/role-bindings`,
    headers: authed(server_, { "content-type": "application/json" }),
    body: JSON.stringify({
      bindings: [
        { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
        { roleId: "architect", profileId: CODEX_PROFILE_ID },
        { roleId: "developer", profileId: developerProfileId },
        { roleId: "reviewer", profileId: reviewerProfileId }
      ]
    })
  });
  expect(response.status).toBe(200);
}

/** Find-or-register the fixture's project (the honest 422 probe), bind roles once. */
async function registerProject(
  server_: LocalApiServer,
  fixture: GitFixture,
  developerProfileId: string,
  reviewerProfileId: string,
  probeLabel: string
): Promise<string> {
  const probe = await createRun(server_, {
    objective: `M10-03 项目登记探针 ${probeLabel}`,
    projectDir: fixture.repoPath
  });
  if (probe.status === 202) {
    // Already registered and bound by an earlier cell.
    const view = JSON.parse(probe.body) as RunSummary;
    return view.projectId;
  }
  expect(probe.status).toBe(422);
  const { projectId } = JSON.parse(probe.body) as ErrorBody;
  expect(projectId).toBeTruthy();
  await putRoleBindings(server_, projectId as string, developerProfileId, reviewerProfileId);
  return projectId as string;
}

async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs = 60_000,
  dump?: () => Promise<string>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) {
      const details = dump === undefined ? "" : `\n--- state dump ---\n${await dump()}`;
      throw new Error(`timed out waiting for ${what}${details}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface NodeRow {
  readonly node_id: string;
  readonly role_id: string;
  readonly state: string;
  readonly updated_at: string;
}

function nodeRows(database: typeof db, runId: string): readonly NodeRow[] {
  return database
    .prepare("SELECT node_id, role_id, state, updated_at FROM task_nodes WHERE run_id = ? ORDER BY node_id ASC")
    .all(runId) as unknown as readonly NodeRow[];
}

interface ExecutionRow {
  readonly id: string;
  readonly node_id: string;
  readonly attempt: number;
  readonly phase: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function executionRows(database: typeof db, runId: string): readonly ExecutionRow[] {
  return database
    .prepare(
      "SELECT id, node_id, attempt, phase, created_at, updated_at FROM executions WHERE run_id = ? ORDER BY created_at ASC, id ASC"
    )
    .all(runId) as unknown as readonly ExecutionRow[];
}

async function runStatus(server_: LocalApiServer, runId: string): Promise<string> {
  const response = await rawRequest(server_.port, {
    path: `/api/v1/runs/${runId}`,
    headers: authed(server_)
  });
  expect(response.status).toBe(200);
  return (JSON.parse(response.body) as { run: { status: string } }).run.status;
}

/** The role-context prompt the engine staged into the node's worktree. */
function stagedPrompt(runId: string, nodeId: string, attempt: number): string {
  const dir = join(worktreesRoot, runId, nodeId, String(attempt));
  const name = readdirSync(dir).find((entry) => entry.startsWith("stdin-") && entry.endsWith(".prompt.txt"));
  if (name === undefined) throw new Error(`no staged prompt file under ${dir}`);
  return readFileSync(join(dir, name), "utf8");
}

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  const handle = createM5TestDb("mn");
  db = handle.db;
  closeDb = handle.close;
  passFixture = await createGitFixture("mn-pass");
  reworkFixture = await createGitFixture("mn-rework");
  approvalFixture = await createGitFixture("mn-approval");
  worktreesRoot = mkdtempSync(join(tmpdir(), "ro-localapi-mn-wt-"));
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
          credentialGroup: "mn-claude",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "success"]
        },
        {
          id: CODEX_PROFILE_ID,
          runtime: "codex",
          executable: fakeBinPath("codex"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-codex",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "success"]
        },
        {
          id: REVIEW_PASS_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-review-pass",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "review", "--review-exists", IMPL_FILE_REL]
        },
        {
          id: REVIEW_REWORK_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-review-rework",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "review", "--review-exists", FIX_FILE_REL]
        },
        {
          id: PROPOSAL_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-proposal",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "action-proposal", "--propose-write", proposedWritePath]
        }
      ],
      ports: {
        outputCommitter: {
          commitNodeOutput: async (input) =>
            commitNodeOutput("git", { nodeId: input.nodeId, worktreePath: input.worktreePath })
        }
      }
    }
  });
}, T0_TIMEOUT_MS);

afterAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  await server?.close();
  closeDb?.();
  passFixture?.close();
  reworkFixture?.close();
  approvalFixture?.close();
});

/** One declared node of the four-node graph (structurally the run body's shape). */
interface DeclaredNode {
  readonly id: string;
  readonly role: string;
  readonly kind: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
}

/** The four-node graph both functional cells drive (per-cell objective). */
function fourNodeGraph(): { readonly workflow: { readonly nodes: readonly DeclaredNode[] } } {
  return {
    workflow: {
      nodes: [
        {
          id: "plan",
          role: "coordinator",
          kind: "agent",
          objective: "拆解多节点任务并产出计划",
          dependencies: []
        },
        {
          id: "impl",
          role: "developer",
          kind: "agent",
          objective: "在独立 worktree 产出功能输出文件",
          dependencies: ["plan"]
        },
        {
          id: "integrate",
          role: "architect",
          kind: "integration",
          objective: "集成候选输出为 candidateSha",
          dependencies: ["impl"]
        },
        {
          id: "review",
          role: "reviewer",
          kind: "review",
          objective: "对固定候选执行审查并给出 verdict",
          dependencies: ["integrate"]
        }
      ]
    }
  };
}

describe.skipIf(!LAUNCHER_APPLIES)("M10-03 multi-node POST /api/v1/runs orchestration", () => {
  it("① refuses malformed workflow declarations at the schema and the domain gates, creating nothing; the v0.2.1 single-node path stays intact", async () => {
    const listBefore = (
      JSON.parse(
        (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
      ) as { runs: ReadonlyArray<{ id: string }> }
    ).runs.length;

    // ---- schema-layer refusals (any projectDir; plain 400 INPUT_REJECTED) --
    const schemaCells: ReadonlyArray<{ readonly name: string; readonly body: Record<string, unknown> }> = [
      {
        name: "unknown node field profileId (A02 at any nesting)",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "a", role: "developer", kind: "agent", objective: "x", dependencies: [], profileId: SUCCESS_PROFILE_ID }
            ]
          }
        }
      },
      {
        name: "unknown node field model (A02)",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [{ id: "a", role: "developer", kind: "agent", objective: "x", dependencies: [], model: "gpt" }]
          }
        }
      },
      {
        name: "unknown workflow field template",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: { nodes: [{ id: "a", role: "developer", kind: "agent", objective: "x", dependencies: [] }], template: "all-roles" }
        }
      },
      {
        name: "unknown node kind",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: { nodes: [{ id: "a", role: "developer", kind: "merge", objective: "x", dependencies: [] }] }
        }
      },
      {
        name: "unknown node role (A03)",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: { nodes: [{ id: "a", role: "tester", kind: "agent", objective: "x", dependencies: [] }] }
        }
      },
      {
        name: "65 nodes (over the 64 budget)",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: Array.from({ length: 65 }, (_, index) => ({
              id: `n${String(index)}`,
              role: "developer",
              kind: "agent",
              objective: "x",
              dependencies: []
            }))
          }
        }
      },
      {
        name: "empty node list",
        body: { objective: "x", projectDir: passFixture.repoPath, workflow: { nodes: [] } }
      }
    ];
    for (const cell of schemaCells) {
      const response = await createRun(server, cell.body);
      expect(response.status, cell.name).toBe(400);
      expect((JSON.parse(response.body) as ErrorBody).error.code, cell.name).toBe("INPUT_REJECTED");
    }

    // ---- domain-layer refusals (a BOUND project; typed 400 WORKFLOW_*) ----
    await registerProject(server, passFixture, SUCCESS_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "domain-gates");
    const domainCells: ReadonlyArray<{ readonly name: string; readonly code: string; readonly body: unknown }> = [
      {
        name: "duplicate node ids",
        code: "WORKFLOW_DUPLICATE_NODE_ID",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "a", role: "developer", kind: "agent", objective: "x", dependencies: [] },
              { id: "a", role: "reviewer", kind: "agent", objective: "y", dependencies: [] }
            ]
          }
        }
      },
      {
        name: "unknown dependency",
        code: "WORKFLOW_UNKNOWN_DEPENDENCY",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [{ id: "a", role: "developer", kind: "agent", objective: "x", dependencies: ["ghost"] }]
          }
        }
      },
      {
        name: "self dependency",
        code: "WORKFLOW_SELF_DEPENDENCY",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [{ id: "a", role: "developer", kind: "agent", objective: "x", dependencies: ["a"] }]
          }
        }
      },
      {
        name: "dependency cycle",
        code: "WORKFLOW_GRAPH_INVALID",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "a", role: "developer", kind: "agent", objective: "x", dependencies: ["b"] },
              { id: "b", role: "reviewer", kind: "agent", objective: "y", dependencies: ["a"] }
            ]
          }
        }
      },
      {
        name: "integration node without parents",
        code: "WORKFLOW_INTEGRATION_WITHOUT_PARENTS",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [{ id: "integ", role: "architect", kind: "integration", objective: "x", dependencies: [] }]
          }
        }
      },
      {
        name: "review node with two dependencies",
        code: "WORKFLOW_REVIEW_DEPENDENCY_COUNT",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "a", role: "developer", kind: "agent", objective: "x", dependencies: [] },
              { id: "b", role: "developer", kind: "agent", objective: "y", dependencies: [] },
              { id: "rev", role: "reviewer", kind: "review", objective: "z", dependencies: ["a", "b"] }
            ]
          }
        }
      },
      {
        name: "review node off the reviewer role",
        code: "WORKFLOW_REVIEW_ROLE",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "a", role: "developer", kind: "agent", objective: "x", dependencies: [] },
              { id: "rev", role: "developer", kind: "review", objective: "z", dependencies: ["a"] }
            ]
          }
        }
      }
    ];
    for (const cell of domainCells) {
      const response = await createRun(server, cell.body);
      expect(response.status, cell.name).toBe(400);
      expect((JSON.parse(response.body) as ErrorBody).error.code, cell.name).toBe(cell.code);
    }

    // Every refusal created NOTHING.
    const listAfter = (
      JSON.parse(
        (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
      ) as { runs: ReadonlyArray<{ id: string }> }
    ).runs.length;
    expect(listAfter).toBe(listBefore);

    // ---- v0.2.1 parity: a body WITHOUT workflow drives the single node ----
    const created = await createRun(server, { objective: "M10-03 单节点回归", projectDir: passFixture.repoPath });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;
    await waitFor(`single-node run READY_FOR_DELIVERY (${runId})`, async () => {
      const status = await runStatus(server, runId);
      return status === "READY_FOR_DELIVERY" || status === "FAILED";
    });
    expect(await runStatus(server, runId)).toBe("READY_FOR_DELIVERY");
    const nodes = nodeRows(db, runId);
    expect(nodes.map((node) => node.node_id)).toEqual(["execute"]);
    expect(nodes[0]?.state).toBe("SUCCEEDED");
    const executions = executionRows(db, runId);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.phase).toBe("SUCCEEDED");
    // The single-node prompt stays the bare objective (v0.2.1 parity).
    expect(stagedPrompt(runId, "execute", 1)).toBe("M10-03 单节点回归");
  }, CELL_TIMEOUT_MS);

  it("② drives the four-node plan→impl→integrate→review chain to READY_FOR_DELIVERY with real baselines, role-context prompts, an A12 pass verdict and serial dispatch", async () => {
    await registerProject(server, passFixture, SUCCESS_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "pass-chain");
    const created = await createRun(server, {
      objective: "M10-03 四节点全绿链",
      projectDir: passFixture.repoPath,
      ...fourNodeGraph()
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      `four-node run READY_FOR_DELIVERY (${runId})`,
      async () => {
        const status = await runStatus(server, runId);
        return status === "READY_FOR_DELIVERY" || status === "FAILED";
      },
      90_000,
      async () =>
        JSON.stringify({
          nodes: nodeRows(db, runId),
          executions: executionRows(db, runId)
        })
    );
    expect(await runStatus(server, runId)).toBe("READY_FOR_DELIVERY");

    // Every node terminal-SUCCEEDED, the integration node having run NO CLI.
    const nodes = nodeRows(db, runId);
    expect(nodes.map((node) => [node.node_id, node.state])).toEqual(
      expect.arrayContaining([
        ["impl", "SUCCEEDED"],
        ["integrate", "SUCCEEDED"],
        ["plan", "SUCCEEDED"],
        ["review", "SUCCEEDED"]
      ])
    );
    const executions = executionRows(db, runId);
    expect(executions.map((execution) => execution.node_id).sort()).toEqual([
      "impl",
      "integrate",
      "plan",
      "review"
    ]);
    expect(executions.every((execution) => execution.phase === "SUCCEEDED")).toBe(true);

    // ---- REAL dependency baseline ------------------------------------------
    // The run's frozen base is the USER repo's HEAD at creation (candidate-2
    // of the fixture), not the fixture's first commit.
    const runBase = (
      db.prepare("SELECT base_sha FROM task_runs WHERE id = ?").get(runId) as {
        base_sha: string;
      }
    ).base_sha;
    const implOutput = committedOutputs.get("impl");
    expect(implOutput).toBeTruthy();
    const integration = db
      .prepare("SELECT candidate_sha, state FROM integration_records WHERE run_id = ? AND node_id = 'integrate'")
      .get(runId) as { candidate_sha: string; state: string } | undefined;
    expect(integration?.state).toBe("COMPLETED");
    const candidateSha = integration?.candidate_sha ?? "";
    expect(candidateSha).toMatch(/^[0-9a-f]{40}$/);
    // impl's commit sits DIRECTLY on the run base (its worktree base).
    const implParent = execFileSync("git", ["rev-parse", `${implOutput}^`], {
      cwd: passFixture.repoPath,
      encoding: "utf8"
    }).trim();
    expect(implParent).toBe(runBase);
    // The candidate CONTAINS impl's output (ancestor check) — B's world really
    // builds on A's accepted output, not on the run base.
    execFileSync("git", ["merge-base", "--is-ancestor", implOutput as string, candidateSha], {
      cwd: passFixture.repoPath
    });
    expect(candidateSha).not.toBe(runBase);

    // ---- A12: the pass verdict is bound to the INTEGRATION candidate -------
    const verdict = getReviewVerdict(db, { runId, nodeId: "review", candidateSha });
    expect(verdict.kind).toBe("valid");
    expect((verdict as { verdict: string }).verdict).toBe("pass");
    // ...and answers with NO VALID verdict for any other candidate (A12:
    // the recorded pass never travels across candidates).
    const wrongCandidate = getReviewVerdict(db, { runId, nodeId: "review", candidateSha: runBase });
    expect(wrongCandidate.kind === "valid").toBe(false);

    // ---- role-context prompts (multi-node) vs the bare objective ----------
    const planPrompt = stagedPrompt(runId, "plan", 1);
    expect(planPrompt).toContain("[role: coordinator]");
    expect(planPrompt).toContain("任务目标：拆解多节点任务并产出计划");
    expect(planPrompt).toContain("依赖产物：无（基于 run 基线提交）。");
    const implPrompt = stagedPrompt(runId, "impl", 1);
    expect(implPrompt).toContain("[role: developer]");
    // plan committed nothing -> its accepted output is the run base (inputSha).
    expect(implPrompt).toContain(`- 节点 plan：accepted 输出 ${runBase}`);
    const reviewPrompt = stagedPrompt(runId, "review", 1);
    expect(reviewPrompt).toContain("[role: reviewer]");
    expect(reviewPrompt).toContain(`- 节点 integrate：accepted 输出 ${candidateSha}`);

    // ---- SERIAL dispatch: no overlap, topological order --------------------
    const ordered = executionRows(db, runId);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      expect(
        (previous?.updated_at ?? "") <= (current?.created_at ?? ""),
        `execution ${String(index)} must start only after its predecessor settled`
      ).toBe(true);
    }
    expect(ordered.map((execution) => execution.node_id)).toEqual(["plan", "impl", "integrate", "review"]);

    // The whole drive left the event log checksum-clean.
    const { verifyEventChecksums } = await import("@role-orchestrator/store");
    expect(verifyEventChecksums(db)).toEqual([]);
  }, CELL_TIMEOUT_MS);

  it("③ review FAIL grounds the controlled expansion; the minted fix commits and the re-review PASSES on the new candidate (A04/A38/A20/A12)", async () => {
    await registerProject(server, reworkFixture, SUCCESS_PROFILE_ID, REVIEW_REWORK_PROFILE_ID, "rework-chain");
    const created = await createRun(server, {
      objective: "M10-03 审查失败返工链",
      projectDir: reworkFixture.repoPath,
      ...fourNodeGraph()
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      `rework chain READY_FOR_DELIVERY (${runId})`,
      async () => {
        const status = await runStatus(server, runId);
        return status === "READY_FOR_DELIVERY" || status === "FAILED";
      },
      120_000,
      async () =>
        JSON.stringify({
          nodes: nodeRows(db, runId),
          executions: executionRows(db, runId)
        })
    );
    expect(await runStatus(server, runId)).toBe("READY_FOR_DELIVERY");

    // The FULL graph incl. the minted pair, every node SUCCEEDED.
    const nodes = nodeRows(db, runId).map((node) => [node.node_id, node.state]);
    expect(nodes).toEqual(
      expect.arrayContaining([
        ["impl", "SUCCEEDED"],
        ["integrate", "SUCCEEDED"],
        ["integrate-fix-2", "SUCCEEDED"],
        ["integrate-review-2", "SUCCEEDED"],
        ["plan", "SUCCEEDED"],
        ["review", "SUCCEEDED"]
      ])
    );

    // The expansion row: grounded on the round-1 review fail, generation 2.
    const expansion = db
      .prepare(
        "SELECT trigger_review_node_id, trigger_candidate_sha, fix_node_id, review_node_id AS minted_review, new_generation FROM review_expansions WHERE run_id = ?"
      )
      .get(runId) as
      | { trigger_review_node_id: string; trigger_candidate_sha: string; fix_node_id: string; minted_review: string; new_generation: number }
      | undefined;
    expect(expansion?.trigger_review_node_id).toBe("review");
    expect(expansion?.fix_node_id).toBe("integrate-fix-2");
    expect(expansion?.minted_review).toBe("integrate-review-2");
    expect(Number(expansion?.new_generation)).toBe(2);

    // A12: the round-1 FAIL answers ONLY for the round-1 candidate; the
    // re-review PASS answers ONLY for the fix candidate.
    const round1Candidate = expansion?.trigger_candidate_sha ?? "";
    const round1Verdict = getReviewVerdict(db, { runId, nodeId: "review", candidateSha: round1Candidate });
    expect(round1Verdict.kind).toBe("valid");
    expect((round1Verdict as { verdict: string }).verdict).toBe("fail");
    const fixOutput = committedOutputs.get("integrate-fix-2");
    expect(fixOutput).toBeTruthy();
    const reReviewVerdict = getReviewVerdict(db, {
      runId,
      nodeId: "integrate-review-2",
      candidateSha: fixOutput as string
    });
    expect(reReviewVerdict.kind).toBe("valid");
    expect((reReviewVerdict as { verdict: string }).verdict).toBe("pass");
    // The two candidates genuinely differ (the fix committed NEW content).
    expect(fixOutput).not.toBe(round1Candidate);
    // The fix candidate actually CONTAINS the repair file the reviewer demanded.
    const fixTree = execFileSync("git", ["show", `${fixOutput}:${FIX_FILE_REL}`], {
      cwd: reworkFixture.repoPath,
      encoding: "utf8"
    });
    expect(fixTree).toBe(FIX_FILE_CONTENT);

    // The run's event log stayed checksum-clean through the expansion.
    const { verifyEventChecksums } = await import("@role-orchestrator/store");
    expect(verifyEventChecksums(db)).toEqual([]);
  }, 150_000);

  it("④ an approval proposal parks the multi-node graph; the guarded decision continues exactly one digest-bound attempt; the downstream review never runs", async () => {
    expect(existsSync(proposedWritePath)).toBe(false);
    await registerProject(server, approvalFixture, PROPOSAL_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "approval-chain");
    const created = await createRun(server, {
      objective: "M10-03 审批暂停续行链",
      projectDir: approvalFixture.repoPath,
      workflow: {
        nodes: [
          { id: "plan", role: "coordinator", kind: "agent", objective: "产出计划", dependencies: [] },
          { id: "impl", role: "developer", kind: "agent", objective: "实现（会提案）", dependencies: ["plan"] },
          { id: "review", role: "reviewer", kind: "review", objective: "审查实现候选", dependencies: ["impl"] }
        ]
      }
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    // The proposal execution parks impl at WAITING_APPROVAL; the review node
    // is never dispatched (it stays PENDING while its dependency is parked).
    await waitFor(
      "impl parked WAITING_APPROVAL",
      async () => {
        const nodes = nodeRows(db, runId);
        const impl = nodes.find((node) => node.node_id === "impl");
        return impl?.state === "WAITING_APPROVAL";
      },
      60_000,
      async () => JSON.stringify(nodeRows(db, runId))
    );
    expect(nodeRows(db, runId).find((node) => node.node_id === "review")?.state).toBe("PENDING");
    expect(executionRows(db, runId).filter((execution) => execution.node_id === "review")).toHaveLength(0);

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
        approval: { approvals: ReadonlyArray<{ approvalId: string; status: string }> };
      }
    ).approval.approvals[0];
    expect(card?.status).toBe("PENDING");

    // The decision goes ONLY through the guarded endpoint.
    const decision = await rawRequest(server.port, {
      method: "POST",
      path: `/api/v1/approvals/${card?.approvalId}/decision`,
      headers: authed(server, { "content-type": "application/json" }),
      body: JSON.stringify({ decision: "approve", decidedBy: "m10-multi-node-test" })
    });
    expect(decision.status).toBe(200);
    expect(JSON.parse(decision.body) as { status: string }).toMatchObject({ status: "APPROVED" });

    // The pump performs the ONE digest-bound continuation (attempt 2); the
    // re-proposing profile parks the node AGAIN — and the review still never
    // ran (the shipped M9-01 continuation semantics, now mid-graph).
    await waitFor("continuation attempt 2 recorded", async () => {
      const attempts = executionRows(db, runId).filter((execution) => execution.node_id === "impl");
      return attempts.some((execution) => execution.attempt === 2);
    }, 60_000);
    await waitFor("re-parked after the continuation", async () => {
      const view = await rawRequest(server.port, {
        path: `/api/v1/runs/${runId}/approvals`,
        headers: authed(server)
      });
      const approvals = (
        JSON.parse(view.body) as {
          approval: { approvals: ReadonlyArray<{ status: string; consumedByExecutionId: string | null }> };
        }
      ).approval.approvals;
      return approvals.some((approval) => approval.status === "CONSUMED") &&
        approvals.some((approval) => approval.status === "PENDING");
    }, 60_000);
    expect(nodeRows(db, runId).find((node) => node.node_id === "impl")?.state).toBe("WAITING_APPROVAL");
    expect(nodeRows(db, runId).find((node) => node.node_id === "review")?.state).toBe("PENDING");
    expect(executionRows(db, runId).filter((execution) => execution.node_id === "review")).toHaveLength(0);
    // A19 through the continuation: still nothing written.
    expect(existsSync(proposedWritePath)).toBe(false);
  }, 150_000);
});
