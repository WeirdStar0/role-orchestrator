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
const ERROR_PROFILE_ID = "profile-mn-error";
const HOLD_PROFILE_ID = "profile-mn-hold";
const HOLD_B_PROFILE_ID = "profile-mn-hold-b";
// V031-01: the SLOW proposal profile — the fake-cli `--delay-ms` knob
// (one wait per stdout frame; action-proposal emits 3 frames) widens the
// approval continuation's in-flight window to seconds so the blocked→null
// reset is observable by POLLING, not by luck. Its sentinel is its OWN
// path: the shared proposedWritePath stays cell ④'s never-written A19
// sentinel.
const PROPOSAL_SLOW_PROFILE_ID = "profile-mn-proposal-slow";
const slowWritePath = join(tmpdir(), "role-orchestrator-m10-proposal-slow", "never-written.txt");

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
        },
        {
          // M10-04 outcome cell: the CLI runs protocol-clean but exits 1 with
          // a machine-readable error — the engine settles it FAILED.
          id: ERROR_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-error",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: ["--scenario", "error-result"]
        },
        {
          // M10-04 parallel cell: the "timeout" scenario holds until the
          // engine's kill budget — the observable in-flight window. The 30 s
          // engine timeout doubles as the backstop if a cancellation ever
          // failed to land (the cell would fail loudly, not hang).
          id: HOLD_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-hold-a",
          maxConcurrency: 2,
          timeoutSeconds: 30,
          extraArgs: [],
          invocationArgs: ["--scenario", "timeout"]
        },
        {
          // The SECOND hold profile: a DIFFERENT credential group, so the two
          // siblings claim in the SAME poll round (the unverified credential
          // layer caps one group at 1 — the four-layer constraint doing its
          // job; two groups side by side exercise the parallel join itself).
          id: HOLD_B_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-hold-b",
          maxConcurrency: 2,
          timeoutSeconds: 30,
          extraArgs: [],
          invocationArgs: ["--scenario", "timeout"]
        },
        {
          // V031-01: the same action-proposal checkpoint shape as
          // PROPOSAL_PROFILE_ID, slowed by the fake-cli delay knob so the
          // continuation's in-flight window (outcome=null) is pollable.
          id: PROPOSAL_SLOW_PROFILE_ID,
          runtime: "claude",
          executable: fakeBinPath("claude"),
          executionTarget: "windows-native",
          configDir: makeConfigDir(),
          model: null,
          credentialGroup: "mn-proposal-slow",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          extraArgs: [],
          invocationArgs: [
            "--scenario",
            "action-proposal",
            "--propose-write",
            slowWritePath,
            "--delay-ms",
            "2000"
          ]
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
        // v1 restriction (M10-03 round-1 review B2): the M7 integration
        // service is a per-run single writer — two integration nodes reuse
        // the same task branch/worktree singletons, so the second candidate
        // accumulates the first integration's output even with no declared
        // edge and the review verdict attribution is polluted.
        name: "two parallel integration nodes (v1: at most one)",
        code: "WORKFLOW_INTEGRATION_NODE_COUNT",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "plan", role: "coordinator", kind: "agent", objective: "x", dependencies: [] },
              { id: "integ-a", role: "architect", kind: "integration", objective: "x", dependencies: ["plan"] },
              { id: "integ-b", role: "architect", kind: "integration", objective: "x", dependencies: ["plan"] }
            ]
          }
        }
      },
      {
        // v1 restriction (M10-03 round-1 review B1): the upstream
        // integration's accepted output is the CANDIDATE sha recorded on the
        // task branch while the branch tip stays at the baseline, so a
        // downstream integration's tip check deterministically raises
        // ParentOutputMovedError.
        name: "chained integration nodes (v1: at most one)",
        code: "WORKFLOW_INTEGRATION_NODE_COUNT",
        body: {
          objective: "x",
          projectDir: passFixture.repoPath,
          workflow: {
            nodes: [
              { id: "impl", role: "developer", kind: "agent", objective: "x", dependencies: [] },
              { id: "integ-a", role: "architect", kind: "integration", objective: "x", dependencies: ["impl"] },
              { id: "integ-b", role: "architect", kind: "integration", objective: "x", dependencies: ["integ-a"] }
            ]
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

    // The count refusal carries the readable v1-restriction reason verbatim
    // (the wire envelope forwards the domain message byte-identical).
    const countRefusal = await createRun(server, {
      objective: "x",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "impl", role: "developer", kind: "agent", objective: "x", dependencies: [] },
          { id: "integ-a", role: "architect", kind: "integration", objective: "x", dependencies: ["impl"] },
          { id: "integ-b", role: "architect", kind: "integration", objective: "x", dependencies: ["impl"] }
        ]
      }
    });
    expect(countRefusal.status).toBe(400);
    expect((JSON.parse(countRefusal.body) as ErrorBody).error.message).toContain(
      "当前版本每任务支持一个集成节点;链式/并行集成将在后续版本支持"
    );

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

    // M10-04: full success carries NO outcome — the delivery flow owns
    // 'success'; NULL at READY_FOR_DELIVERY is the aggregation rule.
    const greenRun = (
      JSON.parse(
        (await rawRequest(server.port, { path: `/api/v1/runs/${runId}`, headers: authed(server) })).body
      ) as { run: { outcome: string | null } }
    ).run;
    expect(greenRun.outcome).toBeNull();

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

    // M10-04: the park surfaces as outcome 'blocked' on the still-RUNNING run
    // (the next pump round's settleRunStatus writes it; the pump parks there).
    await waitFor("run outcome blocked after the park", async () => {
      const parsed = JSON.parse(
        (await rawRequest(server.port, { path: `/api/v1/runs/${runId}`, headers: authed(server) })).body
      ) as { run: { status: string; outcome: string | null } };
      return parsed.run.status === "RUNNING" && parsed.run.outcome === "blocked";
    }, 30_000);

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

  it("⑤ a failed node leaves the run RUNNING and says so through outcome=failed (the UI no longer fakes 执行中)", async () => {
    // passFixture is already registered (earlier cells bound SUCCESS); the
    // find-or-register probe returns 202 without rebinding, so THIS cell
    // rebinds the developer role to the error profile explicitly — the run
    // created below freezes THAT binding.
    const projectId = await registerProject(server, passFixture, ERROR_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "failed-chain");
    await putRoleBindings(server, projectId as string, ERROR_PROFILE_ID, REVIEW_PASS_PROFILE_ID);
    const created = await createRun(server, {
      objective: "M10-04 失败节点聚合",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "plan", role: "coordinator", kind: "agent", objective: "产出计划", dependencies: [] },
          { id: "impl", role: "developer", kind: "agent", objective: "实现（会失败）", dependencies: ["plan"] }
        ]
      }
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      "impl settled FAILED",
      async () => nodeRows(db, runId).find((node) => node.node_id === "impl")?.state === "FAILED",
      60_000,
      async () => JSON.stringify({ nodes: nodeRows(db, runId), executions: executionRows(db, runId) })
    );

    // The frozen vocabulary keeps the run at RUNNING; the OUTCOME column
    // carries the failure (the external evaluation's status+outcome model).
    await waitFor("run outcome failed", async () => {
      const parsed = JSON.parse(
        (await rawRequest(server.port, { path: `/api/v1/runs/${runId}`, headers: authed(server) })).body
      ) as { run: { status: string; outcome: string | null } };
      return parsed.run.status === "RUNNING" && parsed.run.outcome === "failed";
    }, 30_000);

    // The workbench LIST carries the same outcome (the badge's data source).
    const list = JSON.parse(
      (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
    ) as { runs: ReadonlyArray<{ id: string; status: string; outcome: string | null }> };
    const listed = list.runs.find((run) => run.id === runId);
    expect(listed?.status).toBe("RUNNING");
    expect(listed?.outcome).toBe("failed");

    // The failure is durable node-level evidence, unchanged in vocabulary.
    expect(nodeRows(db, runId).find((node) => node.node_id === "plan")?.state).toBe("SUCCEEDED");
    expect(nodeRows(db, runId).find((node) => node.node_id === "impl")?.state).toBe("FAILED");
  }, 120_000);

  it("⑥ failure isolation: a failed run does not disturb a run created after it; the serve process carries on (catch-per-run)", async () => {
    // passFixture's developer binding is still the ERROR profile from ⑤ —
    // run A freezes it and fails exactly like ⑤ did.
    const projectId = await registerProject(server, passFixture, ERROR_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "isolation");
    const createdA = await createRun(server, {
      objective: "M10-04 失败隔离:先行的失败 run",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "plan", role: "coordinator", kind: "agent", objective: "产出计划", dependencies: [] },
          { id: "impl", role: "developer", kind: "agent", objective: "实现（会失败）", dependencies: ["plan"] }
        ]
      }
    });
    expect(createdA.status).toBe(202);
    const { runId: runA } = JSON.parse(createdA.body) as RunSummary;
    await waitFor(
      "run A settled with a FAILED node",
      async () => nodeRows(db, runA).find((node) => node.node_id === "impl")?.state === "FAILED",
      60_000,
      async () => JSON.stringify(nodeRows(db, runA))
    );

    // The REBIND freezes run A on its failing snapshot and binds every run
    // created from here on to the success profile (the M9-02 semantics).
    await putRoleBindings(server, projectId as string, SUCCESS_PROFILE_ID, REVIEW_PASS_PROFILE_ID);
    const createdB = await createRun(server, {
      objective: "M10-04 失败隔离:后行的成功 run",
      projectDir: passFixture.repoPath
    });
    expect(createdB.status).toBe(202);
    const { runId: runB } = JSON.parse(createdB.body) as RunSummary;

    await waitFor(`run B READY_FOR_DELIVERY (${runB})`, async () => {
      const status = await runStatus(server, runB);
      return status === "READY_FOR_DELIVERY" || status === "FAILED";
    }, 60_000);
    expect(await runStatus(server, runB)).toBe("READY_FOR_DELIVERY");

    // A stays honestly failed (outcome column, task 2), B is untouched, and
    // the serve process still answers (a failing run never kills serve).
    const detailA = JSON.parse(
      (await rawRequest(server.port, { path: `/api/v1/runs/${runA}`, headers: authed(server) })).body
    ) as { run: { status: string; outcome: string | null } };
    expect(detailA.run.status).toBe("RUNNING");
    expect(detailA.run.outcome).toBe("failed");
    const list = JSON.parse(
      (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
    ) as { runs: ReadonlyArray<{ id: string }> };
    expect(list.runs.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  // ---- V031-01 聚合与复位三格(登记缺口逐项) -------------------------------
  // Placement discipline: these cells stay BEFORE ⑦ — the shutdown cell must
  // remain this suite's LAST cell (its in-test orchestrator.shutdown() closes
  // the driver; any later cell could not drive runs).

  /** Read one run's status+outcome through the detail endpoint. */
  async function runOutcome(server_: LocalApiServer, runId: string): Promise<{ status: string; outcome: string | null }> {
    const parsed = JSON.parse(
      (await rawRequest(server_.port, { path: `/api/v1/runs/${runId}`, headers: authed(server_) })).body
    ) as { run: { status: string; outcome: string | null } };
    return { status: parsed.run.status, outcome: parsed.run.outcome };
  }

  /** The project's first PENDING actionable approval card, if any. */
  async function pendingCard(server_: LocalApiServer, runId: string): Promise<string | null> {
    const view = await rawRequest(server_.port, {
      path: `/api/v1/runs/${runId}/approvals`,
      headers: authed(server_)
    });
    if (view.status !== 200) return null;
    const parsed = JSON.parse(view.body) as {
      approval: { approvals: ReadonlyArray<{ approvalId: string; status: string; actionable: boolean }> };
    };
    const card = parsed.approval.approvals.find(
      (candidate) => candidate.status === "PENDING" && candidate.actionable
    );
    return card?.approvalId ?? null;
  }

  async function decide(server_: LocalApiServer, approvalId: string, decidedBy: string): Promise<number> {
    const decision = await rawRequest(server_.port, {
      method: "POST",
      path: `/api/v1/approvals/${approvalId}/decision`,
      headers: authed(server_, { "content-type": "application/json" }),
      body: JSON.stringify({ decision: "approve", decidedBy })
    });
    return decision.status;
  }

  it("V031-01 聚合优先级: one node FAILED + one node WAITING_APPROVAL -> the run stays RUNNING with outcome=blocked (the live blocker dominates the presentation)", async () => {
    // The registered aggregation pin: run-driver settleRunStatus checks
    // WAITING_APPROVAL BEFORE FAILED, so a run with BOTH a parked node and a
    // failed node presents as blocked while the human decision is live.
    //
    // 判别力 (how this grid goes red):
    //  - the branch order flips (FAILED checked first, or the two collapse):
    //    the run would read outcome=failed -> every blocked assertion red;
    //  - the outcome stops surfacing on the list endpoint (the badge's data
    //    source) -> the listed assertion red;
    //  - the re-park stops re-aggregating -> the final blocked wait red.
    const projectId = await registerProject(server, passFixture, ERROR_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "agg-priority");
    const rebind = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/projects/${projectId as string}/role-bindings`,
      headers: authed(server, { "content-type": "application/json" }),
      body: JSON.stringify({
        bindings: [
          { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
          { roleId: "architect", profileId: PROPOSAL_PROFILE_ID },
          { roleId: "developer", profileId: ERROR_PROFILE_ID },
          { roleId: "reviewer", profileId: REVIEW_PASS_PROFILE_ID }
        ]
      })
    });
    expect(rebind.status).toBe(200);
    const created = await createRun(server, {
      objective: "V031-01 聚合优先级:失败与阻塞并存",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "boom", role: "developer", kind: "agent", objective: "实现（会失败）", dependencies: [] },
          { id: "brk", role: "architect", kind: "agent", objective: "提议（会停审批）", dependencies: [] }
        ]
      }
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      "boom FAILED while brk WAITING_APPROVAL (one failed, one parked)",
      async () =>
        nodeRows(db, runId).find((node) => node.node_id === "boom")?.state === "FAILED" &&
        nodeRows(db, runId).find((node) => node.node_id === "brk")?.state === "WAITING_APPROVAL",
      60_000,
      async () => JSON.stringify({ nodes: nodeRows(db, runId), executions: executionRows(db, runId) })
    );

    // THE pin: blocked, not failed. Detail endpoint AND the workbench list.
    await waitFor("run outcome blocked (dominating the FAILED sibling)", async () => {
      const detail = await runOutcome(server, runId);
      return detail.status === "RUNNING" && detail.outcome === "blocked";
    }, 30_000);
    const list = JSON.parse(
      (await rawRequest(server.port, { path: "/api/v1/runs", headers: authed(server) })).body
    ) as { runs: ReadonlyArray<{ id: string; status: string; outcome: string | null }> };
    const listed = list.runs.find((run) => run.id === runId);
    expect(listed?.status).toBe("RUNNING");
    expect(listed?.outcome).toBe("blocked");

    // The decision continues brk; the re-proposing profile parks it AGAIN —
    // and the dominance pin survives the round trip (boom's FAILED stays on
    // the run, yet the fresh blocker still presents as blocked).
    const approvalId = await pendingCard(server, runId);
    expect(approvalId).not.toBeNull();
    expect(await decide(server, approvalId as string, "v031-agg-priority")).toBe(200);
    await waitFor(
      "brk continuation attempt 2 recorded",
      async () =>
        executionRows(db, runId).some((execution) => execution.node_id === "brk" && execution.attempt === 2),
      60_000,
      async () => JSON.stringify(executionRows(db, runId))
    );
    await waitFor("outcome blocked again after the re-park", async () => {
      const detail = await runOutcome(server, runId);
      return detail.status === "RUNNING" && detail.outcome === "blocked";
    }, 30_000);
    // A19 through this cell: the proposed side effect never happened.
    expect(existsSync(proposedWritePath)).toBe(false);
  }, 150_000);

  it("V031-01 审批续行窗口现状锚: after the decision the continuation runs in-flight (node RUNNING) while the run outcome STAYS blocked — the blocked→null reset does NOT surface mid-flight (round-begin-synchronous continuation; 现状如实, not a spec)", async () => {
    // The registered expectation was「审批续行后 blocked→null 过渡」. The
    // ACTUAL v1 semantics differ, and this grid pins THEM (as observed when
    // the naive null-wait timed out — the finding is real, not a flake):
    // the approval continuation runs to settlement INSIDE the pump's
    // round-begin (run-driver onRoundBegin awaits continueApprovedCheckpoints,
    // which awaits the whole launch), so settleRunStatus only runs AFTER the
    // continuation settled — the run outcome never reads null mid-flight.
    // With the always-re-proposing checkpoint profile the node re-parks, so
    // the outcome stays blocked end to end. The null fallthrough is thereby
    // only observable as the FRESH-run null (the next grid) and the
    // completion null — never as a mid-flight reset on this path. If a
    // future change makes continuations asynchronous (or one-shot), the
    // outcome WOULD pass through null here and this grid must be consciously
    // rewritten.
    //
    // 判别力 (how this grid goes red):
    //  - the continuation stops launching: the attempt-2 RUNNING wait red;
    //  - the mid-flight aggregation starts writing a DIFFERENT outcome
    //    (null/failed) while the continuation runs: the stays-blocked
    //    assertion red;
    //  - the re-park stops re-aggregating: the final blocked wait red.
    const projectId = await registerProject(server, passFixture, SUCCESS_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "blocked-null");
    const rebind = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/projects/${projectId as string}/role-bindings`,
      headers: authed(server, { "content-type": "application/json" }),
      body: JSON.stringify({
        bindings: [
          { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
          { roleId: "architect", profileId: PROPOSAL_SLOW_PROFILE_ID },
          { roleId: "developer", profileId: SUCCESS_PROFILE_ID },
          { roleId: "reviewer", profileId: REVIEW_PASS_PROFILE_ID }
        ]
      })
    });
    expect(rebind.status).toBe(200);
    const created = await createRun(server, {
      objective: "V031-01 审批续行窗口现状",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "ok", role: "developer", kind: "agent", objective: "实现（会成功）", dependencies: [] },
          { id: "brk", role: "architect", kind: "agent", objective: "提议（会停审批，续行慢）", dependencies: [] }
        ]
      }
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      "brk parked WAITING_APPROVAL while ok SUCCEEDED",
      async () =>
        nodeRows(db, runId).find((node) => node.node_id === "brk")?.state === "WAITING_APPROVAL" &&
        nodeRows(db, runId).find((node) => node.node_id === "ok")?.state === "SUCCEEDED",
      60_000,
      async () => JSON.stringify({ nodes: nodeRows(db, runId), executions: executionRows(db, runId) })
    );
    await waitFor("run outcome blocked after the park", async () => {
      const detail = await runOutcome(server, runId);
      return detail.status === "RUNNING" && detail.outcome === "blocked";
    }, 30_000);

    const approvalId = await pendingCard(server, runId);
    expect(approvalId).not.toBeNull();
    expect(await decide(server, approvalId as string, "v031-blocked-null")).toBe(200);

    // The continuation LAUNCHES and is observable in flight: the node left
    // WAITING_APPROVAL for RUNNING and attempt 2 is a RUNNING execution
    // (the PROPOSAL_SLOW profile's --delay-ms holds that window for seconds,
    // so the poll observes it, not luck).
    await waitFor(
      "brk continuation attempt 2 RUNNING in flight (node left WAITING_APPROVAL)",
      async () => {
        const nodeState = nodeRows(db, runId).find((node) => node.node_id === "brk")?.state;
        return (
          nodeState === "RUNNING" &&
          executionRows(db, runId).some(
            (execution) => execution.node_id === "brk" && execution.attempt === 2 && execution.phase === "RUNNING"
          )
        );
      },
      60_000,
      async () => JSON.stringify({ nodes: nodeRows(db, runId), executions: executionRows(db, runId) })
    );
    // THE 现状锚: outcome stays blocked THROUGH the in-flight continuation —
    // no mid-flight null reset exists on this path.
    const duringFlight = await runOutcome(server, runId);
    expect(duringFlight.status).toBe("RUNNING");
    expect(duringFlight.outcome).toBe("blocked");

    // The slow re-proposal parks the run blocked again (④'s shipped
    // continuation semantics, now mid-observation).
    await waitFor("outcome blocked again after the re-park", async () => {
      const detail = await runOutcome(server, runId);
      return detail.status === "RUNNING" && detail.outcome === "blocked";
    }, 60_000);
    // A19 through the slow path: the proposed write never happened.
    expect(existsSync(slowWritePath)).toBe(false);
  }, 150_000);

  it("V031-01 其余→null: a run with both siblings mid-flight (hold profiles) reads outcome NULL while nothing has settled (direct assertion, 现状如实)", async () => {
    // The registered fallthrough pin, honestly scoped: the outcome column is
    // written only at round-begins (settleRunStatus), and the pump's join
    // awaits the whole round's executions — so an in-flight run carries the
    // fallthrough NULL (the fresh-run value, persisting): no fabricated
    // 执行中-style presentational outcome exists while nodes fly.
    //
    // 判别力 (how this grid goes red):
    //  - the aggregation starts minting a non-null outcome for in-flight
    //    runs: the null assertion red;
    //  - the runs stop driving under these bindings: the RUNNING wait red.
    const projectId = await registerProject(server, passFixture, HOLD_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "inflight-null");
    const rebind = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/projects/${projectId as string}/role-bindings`,
      headers: authed(server, { "content-type": "application/json" }),
      body: JSON.stringify({
        bindings: [
          { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
          { roleId: "architect", profileId: HOLD_PROFILE_ID },
          { roleId: "developer", profileId: HOLD_B_PROFILE_ID },
          { roleId: "reviewer", profileId: REVIEW_PASS_PROFILE_ID }
        ]
      })
    });
    expect(rebind.status).toBe(200);
    const created = await createRun(server, {
      objective: "V031-01 在飞 run 的 outcome=null",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "sib-a", role: "architect", kind: "agent", objective: "兄弟节点 A（持住）", dependencies: [] },
          { id: "sib-b", role: "developer", kind: "agent", objective: "兄弟节点 B（持住）", dependencies: [] }
        ]
      }
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      "both sibling executions RUNNING at the same time",
      async () => {
        const rows = executionRows(db, runId);
        return rows.length === 2 && rows.every((row) => row.phase === "RUNNING");
      },
      60_000,
      async () => JSON.stringify(executionRows(db, runId))
    );
    // THE direct assertion: in-flight -> outcome NULL, run RUNNING.
    const detail = await runOutcome(server, runId);
    expect(detail.status).toBe("RUNNING");
    expect(detail.outcome).toBeNull();

    // Let the engine's 30s kill budget settle BOTH siblings BEFORE this cell
    // ends, so the drive chain is clean for the shutdown cell that follows
    // (the chain is FIFO: an unsettled hold run would delay ⑦'s own drive).
    await waitFor(
      "both hold executions settled by the engine kill budget",
      async () => {
        const rows = executionRows(db, runId);
        return rows.length === 2 && rows.every((row) => row.phase !== "RUNNING");
      },
      90_000,
      async () => JSON.stringify(executionRows(db, runId))
    );
  }, 150_000);

  it("⑦ parallel dispatchJoin: two READY sibling nodes are in flight SIMULTANEOUSLY; shutdown cancels BOTH (full-cancel coverage)", async () => {
    // The siblings sit on two DIFFERENT hold profiles (two credential
    // groups): the unverified credential layer caps ONE group at 1, so a
    // single profile would serialize them by design. With two groups both
    // nodes claim in the SAME poll round and the parallel join runs them
    // together — the observable two-RUNNING overlap.
    const projectId = await registerProject(server, passFixture, HOLD_PROFILE_ID, REVIEW_PASS_PROFILE_ID, "parallel");
    const customBind = await rawRequest(server.port, {
      method: "PUT",
      path: `/api/v1/projects/${projectId as string}/role-bindings`,
      headers: authed(server, { "content-type": "application/json" }),
      body: JSON.stringify({
        bindings: [
          { roleId: "coordinator", profileId: SUCCESS_PROFILE_ID },
          { roleId: "architect", profileId: HOLD_B_PROFILE_ID },
          { roleId: "developer", profileId: HOLD_PROFILE_ID },
          { roleId: "reviewer", profileId: REVIEW_PASS_PROFILE_ID }
        ]
      })
    });
    expect(customBind.status).toBe(200);
    const created = await createRun(server, {
      objective: "M10-04 两 READY 兄弟节点并行在飞",
      projectDir: passFixture.repoPath,
      workflow: {
        nodes: [
          { id: "sib-a", role: "developer", kind: "agent", objective: "兄弟节点 A（持住）", dependencies: [] },
          { id: "sib-b", role: "architect", kind: "agent", objective: "兄弟节点 B（持住）", dependencies: [] }
        ]
      }
    });
    expect(created.status).toBe(202);
    const { runId } = JSON.parse(created.body) as RunSummary;

    await waitFor(
      "two sibling executions RUNNING at the same time",
      async () => {
        const rows = executionRows(db, runId);
        return rows.length === 2 && rows.every((row) => row.phase === "RUNNING");
      },
      60_000,
      async () => JSON.stringify(executionRows(db, runId))
    );
    // Corroborating timestamp-window math — NOT by itself the
    // parallel/serial discriminator (the inequality can hold under a serial
    // join too, e.g. when the first row is updated after the second starts
    // for unrelated reasons): the discriminating power is the waitFor above,
    // which requires BOTH executions phase=RUNNING at the same poll
    // instant. The window containment then says they were in flight
    // together: each execution's window contains the other's start.
    const [a, b] = executionRows(db, runId);
    if (a === undefined || b === undefined) throw new Error("two executions expected");
    expect(a.created_at <= b.updated_at && b.created_at <= a.updated_at).toBe(true);

    // Full-cancel coverage: the driver's shutdown cancels EVERY in-flight
    // execution through activeCancels (allSettled over the map) — both
    // siblings land the durable CANCELLED evidence.
    await server.orchestrator?.shutdown();
    await waitFor(
      "both sibling executions CANCELLED by the shutdown",
      async () => {
        const rows = executionRows(db, runId);
        return rows.length === 2 && rows.every((row) => row.phase === "CANCELLED");
      },
      60_000,
      async () => JSON.stringify(executionRows(db, runId))
    );
  }, 150_000);
});
