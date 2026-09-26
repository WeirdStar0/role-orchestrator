/**
 * Shared helpers for local-api tests: a migrated database, a seeded
 * project/run/execution (store-level) for the request matrix, a full
 * fake-cli dogfood seeding (engine-level, the BUILT fake-cli dist bins) for
 * the end-to-end test, and a small raw-HTTP client that lets tests forge
 * Host/Origin/token/CSRF headers arbitrarily (fetch would normalize them).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { RoleId } from "@role-orchestrator/contracts";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import {
  RUNTIME_PROFILE_MIGRATIONS,
  appliedMigrationRecords,
  applyRuntimeProfileMigrations,
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding,
  verifyMigrations
} from "@role-orchestrator/runtime-profile";
import {
  GRAPH_EDIT_MIGRATIONS,
  applyGraphEditMigrations,
  recordInitialGraphRevision,
  createRunGraph
} from "@role-orchestrator/dag";
import {
  applyControlledExpansionMigrations,
  CONTROLLED_EXPANSION_MIGRATIONS
} from "@role-orchestrator/expand";
import {
  appendEvent,
  createProject,
  createTaskRun,
  createActiveAttempt,
  openDatabase,
  setAttemptPhase
} from "@role-orchestrator/store";
import { GitRunner } from "@role-orchestrator/worktree";

export const T0 = "2026-09-22T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** The BUILT fake-cli dist bin (dogfood path; never a real claude/codex). */
export function fakeBinPath(dialect: "claude" | "codex"): string {
  const bin = path.resolve(testDir, "..", "..", "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new Error(`fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`);
  }
  return bin;
}

export function makeWorkDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ro-localapi-cwd-${label}-`));
}

/** A migrated file-backed store (same recipe as the store package tests). */
export function createTestDb(label: string): { db: DatabaseSync; dbPath: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), `ro-localapi-db-${label}-`));
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyRuntimeProfileMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 2 || records[1]?.version !== 2) {
    db.close();
    throw new Error("test helper: migrations were not applied synchronously");
  }
  verifyMigrations(db, { migrations: RUNTIME_PROFILE_MIGRATIONS });
  return { db, dbPath, close: () => db.close() };
}

export interface MatrixSeed {
  readonly runId: string;
  readonly executionId: string;
}

/**
 * Minimal store-level seed for the request matrix: project, run, one
 * execution in RUNNING — enough for 200-vs-404 assertions without the
 * profile snapshot machinery.
 */
export function seedMatrixData(db: DatabaseSync, overrides: Partial<MatrixSeed> = {}): MatrixSeed {
  const runId = overrides.runId ?? "run-1";
  const executionId = overrides.executionId ?? "exec-1";
  createProject(db, {
    id: "proj-1",
    repoRoot: "h:/repos/proj-1",
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createTaskRun(db, {
    id: runId,
    projectId: "proj-1",
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-config-1",
    baseSha: "base-sha-1",
    now: T0
  });
  createActiveAttempt(db, {
    id: executionId,
    runId,
    nodeId: "node-1",
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: `dt-${executionId}`,
    phase: "RUNNING",
    now: T0
  });
  return { runId, executionId };
}

/** Append hostile (A36-style) events directly through the store. */
export function seedHostileEvents(db: DatabaseSync, executionId: string): void {
  const cases: ReadonlyArray<{ readonly seq: number; readonly payload: Record<string, unknown> }> = [
    { seq: 1, payload: { summary: "step one ok" } },
    {
      seq: 2,
      payload: {
        summary: "call failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.fake.sig",
        html: "<script>alert('stored-xss')</script>",
        img: "<img src=x onerror=alert(2)>"
      }
    },
    { seq: 3, payload: { summary: "config api-key=sk-proj-abcdef1234567890 leaked" } },
    { seq: 4, payload: { summary: "terminal escape \u001b[31mRED\u001b[0m reset" } },
    { seq: 5, payload: { summary: "plain value token=short stays" } }
  ];
  for (const item of cases) {
    const result = appendEvent(db, {
      id: `evt-matrix-${String(item.seq)}`,
      executionId,
      seq: item.seq,
      type: "diagnostic",
      payload: item.payload as never,
      occurredAt: iso(item.seq)
    });
    if (result !== "stored") throw new Error(`seedHostileEvents: event seq ${String(item.seq)} not stored`);
  }
}

export interface DogfoodSeed {
  readonly runId: string;
  readonly executionId: string;
}

/**
 * Full engine-level seeding (the dogfood path): project + profile pointing
 * at the BUILT fake-cli dist bin + frozen run snapshot + role bindings.
 * Mirrors the engine package's own test fixture.
 */
export async function seedFakeCliRun(
  db: DatabaseSync,
  overrides: { runId?: string; dialect?: "claude" | "codex" } = {}
): Promise<{ runId: string; dialect: "claude" | "codex" }> {
  const dialect = overrides.dialect ?? "claude";
  const runId = overrides.runId ?? "run-1";
  createProject(db, {
    id: "proj-1",
    repoRoot: "h:/repos/proj-1",
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  createProfile(db, {
    id: "profile-fake",
    runtime: dialect,
    executable: fakeBinPath(dialect),
    executionTarget: "windows-native",
    configDir: makeConfigDir(),
    credentialGroup: "personal",
    maxConcurrency: 1,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, {
    profileId: "profile-fake",
    model: null,
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: T0
  });
  initializeProjectRoleBindings(db, { projectId: "proj-1", now: T0 });
  for (const roleId of ROLE_IDS as readonly RoleId[]) {
    setRoleBinding(db, {
      projectId: "proj-1",
      roleId,
      profileId: "profile-fake",
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
  createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId: "proj-1",
    taskId: "task-1",
    graphRevision: 0,
    baseSha: "base-sha-1",
    now: T0
  });
  return { runId, dialect };
}

function makeConfigDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ro-localapi-cfg-")), "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// M5-01: the graph-edit test fixture — migrations 001+002+003+015 (the
// GRAPH_EDIT_MIGRATIONS chain), a seeded profile/binding project and an
// EDIT-ENABLED run: createTaskRunWithProfileSnapshot -> createRunGraph ->
// recordInitialGraphRevision (the composition-root sequence the production
// wiring performs at run creation).
// ---------------------------------------------------------------------------

/** A migrated file-backed store with the graph-edit chain applied. */
export function createGraphEditTestDb(label: string): { db: DatabaseSync; dbPath: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), `ro-localapi-graph-${label}-`));
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyGraphEditMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== 4 ||
    records[0]?.version !== 1 ||
    records[1]?.version !== 2 ||
    records[2]?.version !== 3 ||
    records[3]?.version !== 15
  ) {
    db.close();
    throw new Error("test helper: graph-edit migrations were not applied synchronously");
  }
  verifyMigrations(db, { migrations: GRAPH_EDIT_MIGRATIONS });
  return { db, dbPath, close: () => db.close() };
}

export interface EditableRunSeed {
  readonly runId: string;
  readonly projectId: string;
  readonly profileId: string;
  /** Topologically a -> b -> c. */
  readonly nodeIds: readonly string[];
}

export interface SeedEditableRunOptions {
  readonly runId?: string;
  /** When false the baseline is NOT recorded — the run refuses edits. */
  readonly recordBaseline?: boolean;
  /** Project repoRoot override (the M5-03 diff view reads git from here). */
  readonly repoRoot?: string;
  /**
   * Reuse an existing project+profile instead of creating new ones
   * (projects.repo_root is UNIQUE — several runs of one git fixture must
   * share the project row).
   */
  readonly existingProject?: { readonly projectId: string; readonly profileId: string };
}

/**
 * Seed an edit-enabled run with frozen profile snapshots for all four roles:
 * a (coordinator) -> b (developer) -> c (reviewer). `a` lands READY (entry
 * node), `b`/`c` stay PENDING. Mirrors what the composition root must do at
 * run creation to enable UI editing.
 */
export async function seedEditableRun(
  db: DatabaseSync,
  options: SeedEditableRunOptions = {}
): Promise<EditableRunSeed> {
  const runId = options.runId ?? "run-graph-1";
  const nodeIds = ["a", "b", "c"];
  // Ids derive from the run id so repeated seeds in ONE database never
  // collide on projects'/profiles' unique constraints.
  const projectId = options.existingProject?.projectId ?? `proj-${runId}`;
  const profileId = options.existingProject?.profileId ?? `profile-${runId}`;
  if (options.existingProject === undefined) {
    createProject(db, {
      id: projectId,
      repoRoot: options.repoRoot ?? `h:/repos/${projectId}`,
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: T0
    });
    createProfile(db, {
      id: profileId,
      runtime: "claude",
      executable: "claude.cmd",
      executionTarget: "windows-native",
      configDir: makeConfigDir(),
      credentialGroup: "personal",
      maxConcurrency: 1,
      timeoutSeconds: 600,
      now: T0
    });
    await createProfileRevision(db, {
      profileId,
      model: null,
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
    initializeProjectRoleBindings(db, { projectId, now: T0 });
    for (const roleId of ROLE_IDS as readonly RoleId[]) {
      setRoleBinding(db, {
        projectId,
        roleId,
        profileId,
        canCreateSubtasks: roleId === "coordinator",
        now: T0
      });
    }
  }
  createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId,
    taskId: `task-${runId}`,
    graphRevision: 0,
    // 40-hex: the M5-03 checkpoint path digests the run baseSha into the
    // action descriptor (CommitShaSchema), so the seed base is a real SHA.
    baseSha: fakeSha40(`${runId}-base`),
    now: T0
  });
  const workflow = {
    id: "wf-graph-1",
    name: "workflow-graph-1",
    nodes: [
      {
        id: "a",
        role: "coordinator",
        title: "title-a",
        objective: "objective-a",
        dependencies: [],
        capabilityTags: ["planning"],
        acceptanceCriteria: ["criteria-a"]
      },
      {
        id: "b",
        role: "developer",
        title: "title-b",
        objective: "objective-b",
        dependencies: ["a"],
        capabilityTags: ["backend"],
        acceptanceCriteria: ["criteria-b"]
      },
      {
        id: "c",
        role: "reviewer",
        title: "title-c",
        objective: "objective-c",
        dependencies: ["b"],
        capabilityTags: ["testing"],
        acceptanceCriteria: ["criteria-c"]
      }
    ]
  };
  createRunGraph(db, { runId, workflow, now: T0 });
  if (options.recordBaseline !== false) {
    recordInitialGraphRevision(db, { runId, workflow, now: T0 });
  }
  return { runId, projectId, profileId, nodeIds };
}

// ---------------------------------------------------------------------------
// M5-03: the approval/diff/context test fixtures — the FULL migration chain
// (CONTROLLED_EXPANSION_MIGRATIONS = 001..013 + 015 + 016 + 017) so one
// database carries approvals + checkpoints + integration records + review
// records + context bundles + the dag revision machinery, plus a REAL git
// fixture repo under the SYSTEM temp directory (the only place git commands
// are allowed to run).
// ---------------------------------------------------------------------------

/** A migrated file-backed store with the full M5 chain applied. */
export function createM5TestDb(label: string): { db: DatabaseSync; dbPath: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), `ro-localapi-m5-${label}-`));
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  void applyControlledExpansionMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== CONTROLLED_EXPANSION_MIGRATIONS.length ||
    records[records.length - 1]?.version !== 17
  ) {
    db.close();
    throw new Error("test helper: M5 migrations were not applied synchronously");
  }
  return { db, dbPath, close: () => db.close() };
}

/** A deterministic 40-hex stand-in SHA for rows that are never git-read. */
export function fakeSha40(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 40);
}

export interface TerminalExecutionSeed {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId: string;
}

/**
 * Create a TERMINAL (FAILED) attempt row — the checkpoint's precondition
 * (A19: the CLI has ENDED; a checkpoint is never a faked mid-run pause).
 */
export function seedTerminalExecution(
  db: DatabaseSync,
  input: TerminalExecutionSeed
): string {
  createActiveAttempt(db, {
    id: input.executionId,
    runId: input.runId,
    nodeId: input.nodeId,
    definitionRevision: "1",
    attempt: 1,
    dispatchToken: `dt-${input.executionId}`,
    phase: "PREPARING",
    now: T0
  });
  setAttemptPhase(db, { id: input.executionId, phase: "STARTING", wherePhaseIn: ["PREPARING"], now: T0 });
  setAttemptPhase(db, { id: input.executionId, phase: "RUNNING", wherePhaseIn: ["STARTING"], now: T0 });
  setAttemptPhase(db, { id: input.executionId, phase: "FAILED", wherePhaseIn: ["RUNNING"], now: T0 });
  return input.executionId;
}

export interface GitFixture {
  readonly repoPath: string;
  readonly baseSha: string;
  /** The first candidate commit (adds docs/note.md with hostile HTML content). */
  readonly candidateSha: string;
  /** The second candidate commit (shrinks src.txt; used for the A12 change). */
  readonly candidateSha2: string;
  /** A 40-hex SHA that exists NOWHERE in the fixture (diff-unavailable case). */
  readonly missingSha: string;
  close(): void;
}

/**
 * A real git fixture repository under the SYSTEM temp directory (the only
 * place test git commands may run): base -> candidate -> candidate2, with
 * hostile HTML content in the candidate diff for the escaping assertions.
 */
export async function createGitFixture(label: string): Promise<GitFixture> {
  const { rmSync } = await import("node:fs");
  const git = new GitRunner();
  await git.assertAvailable();
  const repoPath = mkdtempSync(join(tmpdir(), `ro-localapi-gitfix-${label}-`));
  await git.run(repoPath, ["init"]);
  await git.run(repoPath, ["config", "user.email", "fixture@example.invalid"]);
  await git.run(repoPath, ["config", "user.name", "diff-fixture"]);
  writeFileSync(join(repoPath, "src.txt"), "line-v1\n", "utf8");
  await git.run(repoPath, ["add", "."]);
  await git.run(repoPath, ["commit", "-m", "base"]);
  const baseSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  writeFileSync(join(repoPath, "src.txt"), "line-v2\n", "utf8");
  const docsDir = join(repoPath, "docs");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "note.md"), "<script>alert('diff-xss')</script>\n", "utf8");
  await git.run(repoPath, ["add", "."]);
  await git.run(repoPath, ["commit", "-m", "candidate-1"]);
  const candidateSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  writeFileSync(join(repoPath, "src.txt"), "v3\n", "utf8");
  await git.run(repoPath, ["add", "."]);
  await git.run(repoPath, ["commit", "-m", "candidate-2"]);
  const candidateSha2 = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    repoPath,
    baseSha,
    candidateSha,
    candidateSha2,
    missingSha: fakeSha40(`${label}-missing`),
    close: () => rmSync(repoPath, { recursive: true, force: true })
  };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Raw HTTP request with FULL header control: tests forge Host / Origin /
 * Authorization / x-csrf-token freely (fetch would normalize or refuse).
 */
export function rawRequest(
  port: number,
  options: {
    readonly method?: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string | undefined>>;
    readonly body?: string;
  }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | undefined> = { ...(options.headers ?? {}) };
    if (!("Host" in headers) && !("host" in headers)) {
      headers["host"] = `127.0.0.1:${String(port)}`;
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** A truly Host-less HTTP/1.1 request over a raw socket (A30 negative). */
export function rawSocketRequest(port: number, requestText: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("connect", () => {
      socket.write(requestText);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const statusLine = /^HTTP\/1\.1 (\d{3})/.exec(body);
      resolve({
        status: statusLine === null ? 0 : Number(statusLine[1]),
        headers: {},
        body
      });
    });
    socket.on("error", reject);
  });
}
