/**
 * Shared test plumbing for the M3-02 memory suite.
 *
 * Everything here is pure SQLite: no git, no CLI, no network. All scratch
 * state lives under the SYSTEM temp directory — never inside the
 * H:\role-orchestrator workspace, which stays a non-git area. Teardown walks
 * the tree with whitelisted primitives (M0-05: fs.rm is broken on
 * Node 25/win32 for non-ASCII paths).
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appliedMigrationRecords, createProject, openDatabase } from "@role-orchestrator/store";
import {
  createProfile,
  createProfileRevision,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import {
  applyMemoryMigrations,
  proposeMemory,
  verifyMemory,
  type MemoryActor,
  type MemoryRecord
} from "../src/index.js";

/** Fixed clock base so DB timestamps are deterministic. */
export const T0 = "2026-09-23T00:00:00.000Z";

/**
 * Fixture execution target follows the RUNNING platform: A29 binds fixture
 * path forms to the target's own world, so a windows-native fixture cannot be
 * seeded from POSIX temp dirs. Domain assertions are platform-independent;
 * cross-world rejection tests build their own explicit fixtures.
 */
export const FIXTURE_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";

export const T1 = "2026-09-23T01:00:00.000Z";
export const T2 = "2026-09-23T02:00:00.000Z";

export const PROJECT_A = "proj-a";
export const PROJECT_B = "proj-b";

export type TestRole = "coordinator" | "architect" | "developer" | "reviewer";

export function roleActor(roleId: TestRole, executionId?: string): MemoryActor {
  return executionId === undefined ? { kind: "role", roleId } : { kind: "role", roleId, executionId };
}

/** The human operator identity used for promotion tests. */
export const USER_ALICE: MemoryActor = { kind: "user", displayName: "maintainer-alice" };

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
  close(): void;
}

/**
 * Full migrated world (migrations 001..008) with two INDEPENDENT projects,
 * each with one profile and a developer role binding — enough for the A16
 * security observations (bindings/profiles) and for project-scoped memory.
 */
export function createMemoryWorld(): World {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "ro-memory-"));
  const dbPath = path.join(scratchDir, "store.db");
  const db = openDatabase(dbPath);
  void applyMemoryMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 8 || records[7]?.version !== 8) {
    db.close();
    throw new Error("test helper: migrations 001..008 were not applied");
  }

  const makeProject = (projectId: string): { readonly projectId: string } => {
    const profileId = `profile-${projectId}`;
    createProject(db, {
      id: projectId,
      repoRoot: path.join(scratchDir, projectId, "repo"),
      executionTarget: FIXTURE_TARGET,
      trustStatus: "untrusted",
      now: T0
    });
    createProfile(db, {
      id: profileId,
      runtime: "codex",
      executable: "fake-codex",
      executionTarget: FIXTURE_TARGET,
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
    close: () => db.close()
  };
}

// ---------------------------------------------------------------------------
// Small lifecycle composers so tests read as intent, not plumbing.
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

export function proposeRule(
  world: World,
  projectId: string,
  overrides: {
    readonly id?: string;
    readonly content?: string;
    readonly proposer?: TestRole;
  } = {}
): MemoryRecord {
  return proposeMemory(world.db, {
    id: overrides.id ?? nextId("rule", projectId),
    projectId,
    type: "project_rule",
    content: overrides.content ?? "project rule: all changes require tests and never bypass the gate.",
    evidenceRefs: ["artifact-rules"],
    actor: roleActor(overrides.proposer ?? "coordinator"),
    now: T0
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

/** propose (coordinator) + verify (reviewer): a verified project rule at version 2. */
export function verifiedRule(
  world: World,
  projectId: string,
  overrides: { readonly id?: string; readonly content?: string } = {}
): MemoryRecord {
  const proposed = proposeRule(world, projectId, overrides);
  return verifyMemory(world.db, {
    projectId,
    memoryId: proposed.id,
    expectedVersion: proposed.version,
    actor: roleActor("reviewer"),
    now: T1
  });
}

/** propose + verify: a verified fact at version 2 (proposer developer, verifier reviewer). */
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

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Recursive removal with whitelisted primitives (same discipline as the
 * context/review/integration helpers). Teardown never masks the real result
 * and never uses fs.rm (M0-05).
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
