/**
 * Shared test plumbing for the M3-03 memory-search suite.
 *
 * Everything here is pure SQLite EXCEPT the git-fixture helper (used by the
 * staleness adapter test), which creates its repo under the SYSTEM temp
 * directory — never inside H:\role-orchestrator, which stays a non-git
 * area. Teardown walks trees with whitelisted primitives (M0-05: fs.rm is
 * broken on Node 25/win32 for non-ASCII paths).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appliedMigrationRecords, createProject, createTaskRun, openDatabase } from "@role-orchestrator/store";
import {
  createProfile,
  createProfileRevision,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { applyMemorySearchMigrations, openMemoryAccess, type MemoryAccess } from "../src/index.js";
import { proposeMemory, verifyMemory, type MemoryActor, type MemoryRecord } from "@role-orchestrator/memory";

/** Fixed clock base so DB timestamps are deterministic. */
export const T0 = "2026-09-23T00:00:00.000Z";
export const T1 = "2026-09-23T01:00:00.000Z";
export const T2 = "2026-09-23T02:00:00.000Z";
export const T3 = "2026-09-23T03:00:00.000Z";
export const T4 = "2026-09-23T04:00:00.000Z";
export const T5 = "2026-09-23T05:00:00.000Z";

export const PROJECT_A = "proj-a";
export const PROJECT_B = "proj-b";

export type TestRole = "coordinator" | "architect" | "developer" | "reviewer";

export function roleActor(roleId: TestRole, executionId?: string): MemoryActor {
  return executionId === undefined ? { kind: "role", roleId } : { kind: "role", roleId, executionId };
}

let counter = 0;
export function nextId(prefix: string, projectId: string): string {
  counter += 1;
  return `${prefix}-${projectId}-${String(counter)}`;
}

export interface World {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly scratchDir: string;
  readonly projectA: { readonly projectId: string };
  readonly projectB: { readonly projectId: string };
  accessA(): MemoryAccess;
  accessB(): MemoryAccess;
  close(): void;
}

/**
 * Fully migrated world (migrations 001..010) with two INDEPENDENT projects,
 * each with one profile and a developer role binding — enough for bundle
 * assembly (resolveRoleBinding), retrieval, and the A15/A16 observations.
 */
export function createSearchWorld(): World {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "ro-memory-search-"));
  const dbPath = path.join(scratchDir, "store.db");
  const db = openDatabase(dbPath);
  void applyMemorySearchMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 10 || records[9]?.version !== 10) {
    db.close();
    throw new Error("test helper: migrations 001..010 were not applied");
  }

  const makeProject = (projectId: string): { readonly projectId: string } => {
    const profileId = `profile-${projectId}`;
    createProject(db, {
      id: projectId,
      repoRoot: path.join(scratchDir, projectId, "repo"),
      executionTarget: "windows-native",
      trustStatus: "untrusted",
      now: T0
    });
    createProfile(db, {
      id: profileId,
      runtime: "codex",
      executable: "fake-codex",
      executionTarget: "windows-native",
      configDir: path.join(scratchDir, projectId, "config"),
      credentialGroup: `cred-${projectId}`,
      maxConcurrency: 1,
      timeoutSeconds: 600,
      now: T0
    });
    void createProfileRevision(db, {
      profileId,
      model: `model-${projectId}`,
      externalConfigFiles: [],
      externalConfigHash: "e".repeat(64),
      now: T0
    });
    initializeProjectRoleBindings(db, { projectId, permissionsRevision: "42", now: T0 });
    setRoleBinding(db, {
      projectId,
      roleId: "developer",
      profileId,
      canCreateSubtasks: false,
      permissionsRevision: "42",
      now: T0
    });
    return { projectId };
  };

  const projectA = makeProject(PROJECT_A);
  const projectB = makeProject(PROJECT_B);

  return {
    db,
    dbPath,
    scratchDir,
    projectA,
    projectB,
    accessA: () => openMemoryAccess(db, { projectId: PROJECT_A }),
    accessB: () => openMemoryAccess(db, { projectId: PROJECT_B }),
    close: () => db.close()
  };
}

// ---------------------------------------------------------------------------
// Memory composers (propose via the M3-02 write paths, read back via access).
// ---------------------------------------------------------------------------

export function proposeFact(
  world: World,
  projectId: string,
  overrides: {
    readonly id?: string;
    readonly content?: string;
    readonly proposer?: TestRole;
    readonly evidenceRefs?: readonly string[];
  } = {}
): MemoryRecord {
  return proposeMemory(world.db, {
    id: overrides.id ?? nextId("fact", projectId),
    projectId,
    type: "fact",
    content: overrides.content ?? "fact: module X exports parseEvent; covered by tests/e2e.",
    evidenceRefs: overrides.evidenceRefs === undefined ? ["artifact-tests"] : [...overrides.evidenceRefs],
    actor: roleActor(overrides.proposer ?? "developer"),
    now: T0
  });
}

export function verifiedFact(
  world: World,
  projectId: string,
  overrides: { readonly id?: string; readonly content?: string } = {}
): MemoryRecord {
  const proposed = proposeFact(world, projectId, overrides);
  return verifyMemory(world.db, {
    projectId,
    memoryId: proposed.id,
    expectedVersion: proposed.version,
    actor: roleActor("reviewer"),
    now: T1
  });
}

export function proposeDiscovery(
  world: World,
  projectId: string,
  overrides: {
    readonly id?: string;
    readonly content?: string;
    readonly proposer?: TestRole;
  } = {}
): MemoryRecord {
  return proposeMemory(world.db, {
    id: overrides.id ?? nextId("disc", projectId),
    projectId,
    type: "discovery",
    content: overrides.content ?? "discovery: build cache lives under .cache; safe to delete.",
    evidenceRefs: [],
    actor: roleActor(overrides.proposer ?? "developer"),
    now: T0
  });
}

// ---------------------------------------------------------------------------
// A minimal run/node fixture so bundle assembly has a store-side target.
// ---------------------------------------------------------------------------

export interface RunFixture {
  readonly runId: string;
  readonly nodeId: string;
  readonly depNodeId: string;
}

export function createRunFixture(world: World, projectId: string): RunFixture {
  const runId = `run-${projectId}`;
  const nodeId = "impl-b";
  const depNodeId = "dep-x";
  createTaskRun(world.db, {
    id: runId,
    projectId,
    taskId: `task-${projectId}`,
    graphRevision: 0,
    configSnapshotHash: "snap-hash",
    baseSha: sha40(projectId),
    now: T0
  });
  const insertNode = world.db.prepare(
    "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
      "VALUES (?, ?, '1', 'developer', ?, 'READY', ?, ?)"
  );
  insertNode.run(runId, depNodeId, "[]", T0, T0);
  insertNode.run(runId, nodeId, `["${depNodeId}"]`, T0, T0);
  return { runId, nodeId, depNodeId };
}

/** Deterministic 40-hex commit SHA stand-ins (no git involved). */
export function sha40(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 40);
}

/**
 * Git fixture repo (ONLY under the system temp dir) for the resolver
 * adapter test: two empty commits, returns both shas. All invocations are
 * `spawnSync(git, <argv ARRAY>)` with explicit cwd — no shell strings.
 */
export function createGitFixtureRepo(
  dir: string
): { readonly shaA: string; readonly shaB: string } {
  const git = (argv: readonly string[]): string => {
    const result = spawnSync("git", [...argv], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true
    });
    if (result.status !== 0) {
      throw new Error(`git ${argv.join(" ")} failed (${String(result.status)}): ${String(result.stderr)}`);
    }
    return typeof result.stdout === "string" ? result.stdout : "";
  };
  git(["init"]);
  git(["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "--allow-empty", "-m", "commit-a"]);
  const shaA = git(["rev-parse", "HEAD"]).trim();
  git(["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "--allow-empty", "-m", "commit-b"]);
  const shaB = git(["rev-parse", "HEAD"]).trim();
  return { shaA, shaB };
}

/**
 * Recursive removal with whitelisted primitives (same discipline as the
 * context/memory helpers). Teardown never masks the real result and never
 * uses fs.rm (M0-05).
 */
export function removeTreeRobust(dir: string): void {
  let entries: readonly string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // already gone
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stats = statSync(entryPath, { throwIfNoEntry: false });
    if (stats?.isDirectory() === true) {
      removeTreeRobust(entryPath);
    } else {
      try {
        unlinkSync(entryPath);
      } catch {
        try {
          chmodSync(entryPath, 0o666);
          unlinkSync(entryPath);
        } catch {
          // best effort
        }
      }
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // best effort
  }
}
