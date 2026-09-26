/**
 * Shared test plumbing for the M3-01 context suite.
 *
 * Everything here is pure SQLite + in-memory assembly: no git, no CLI, no
 * network. All scratch state lives under the SYSTEM temp directory — never
 * inside the H:\role-orchestrator workspace, which stays a non-git area.
 * Teardown walks the tree with whitelisted primitives (M0-05: fs.rm is
 * broken on Node 25/win32 for non-ASCII paths).
 */
import { mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appliedMigrationRecords, createProject, createTaskRun, openDatabase } from "@role-orchestrator/store";
import { initializeProjectRoleBindings, createProfile, createProfileRevision, setRoleBinding } from "@role-orchestrator/runtime-profile";
import { createIntegrationRecord } from "@role-orchestrator/integration";
import { applyContextMigrations } from "../src/index.js";

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


/** Deterministic 40-hex commit SHA stand-ins (no git involved). */
export function sha40(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 40);
}

export const PROJECT_A = "proj-a";
export const PROJECT_B = "proj-b";

export interface ProjectFixture {
  readonly projectId: string;
  readonly profileId: string;
  readonly runId: string;
  /** The consumer node (developer role) with frozen dependency snapshot ["dep-x"]. */
  readonly nodeId: string;
  /** The dependency node inside the same run. */
  readonly depNodeId: string;
}

export interface World {
  readonly db: DatabaseSync;
  readonly scratchDir: string;
  readonly projectA: ProjectFixture;
  readonly projectB: ProjectFixture;
  close(): void;
}

interface CreateProjectOptions {
  readonly projectId: string;
  /** When true, the run also gets an integration record pinning dep-x's SHA. */
  readonly withIntegration?: boolean;
}

/**
 * Full migrated world (migrations 001..007) with two INDEPENDENT projects,
 * each owning one run with the node graph:
 *
 *   dep-x (developer)  <- frozen snapshot ->  impl-b (developer, deps ["dep-x"])
 *
 * Both projects bind role `developer` to their OWN profile revision 1 —
 * so a bundle assembled under project B can never be explained by project
 * A's rows, which is what the isolation and A16 tests assert.
 */
export function createWorld(): World {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "ro-context-"));
  const db = openDatabase(path.join(scratchDir, "store.db"));
  void applyContextMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 7 || records[6]?.version !== 7) {
    db.close();
    throw new Error("test helper: migrations 001..007 were not applied");
  }

  const makeProject = (options: CreateProjectOptions): ProjectFixture => {
    const projectId = options.projectId;
    const profileId = `profile-${projectId}`;
    const runId = `run-${projectId}`;
    const nodeId = "impl-b";
    const depNodeId = "dep-x";

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
    createTaskRun(db, {
      id: runId,
      projectId,
      taskId: `task-${projectId}`,
      graphRevision: 0,
      configSnapshotHash: "snap-hash",
      baseSha: sha40(projectId),
      now: T0
    });

    const insertNode = db.prepare(
      "INSERT INTO task_nodes(run_id, node_id, definition_revision, role_id, dependencies, state, created_at, updated_at) " +
        "VALUES (?, ?, '1', 'developer', ?, 'READY', ?, ?)"
    );
    insertNode.run(runId, depNodeId, "[]", T0, T0);
    insertNode.run(runId, nodeId, '["dep-x"]', T0, T0);

    if (options.withIntegration === true) {
      createIntegrationRecord(db, {
        id: `integ-${runId}-${nodeId}`,
        manifest: {
          schemaVersion: 1,
          integrationId: `integ-${projectId}`,
          runId,
          nodeId,
          repoPath: path.join(scratchDir, projectId, "repo"),
          integrationBranch: `task/${runId}`,
          integrationWorktreePath: path.join(scratchDir, projectId, "integration"),
          baseSha: sha40(projectId),
          parents: [
            {
              nodeId: depNodeId,
              branch: `exec/${runId}/${depNodeId}/1`,
              headSha: sha40(`${projectId}-dep-output`)
            }
          ],
          candidateSha: sha40(`${projectId}-candidate`),
          createdAt: T0
        },
        now: T0
      });
    }

    return { projectId, profileId, runId, nodeId, depNodeId };
  };

  const projectA = makeProject({ projectId: PROJECT_A, withIntegration: true });
  const projectB = makeProject({ projectId: PROJECT_B, withIntegration: true });

  return {
    db,
    scratchDir,
    projectA,
    projectB,
    close: () => db.close()
  };
}

/** The canonical node definition matching the frozen task_nodes row of a fixture. */
export function nodeDefinition(fixture: ProjectFixture): {
  readonly id: string;
  readonly role: "developer";
  readonly title: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly capabilityTags: readonly ["backend"];
  readonly acceptanceCriteria: readonly string[];
} {
  return {
    id: fixture.nodeId,
    role: "developer",
    title: "实现依赖方的功能",
    objective: "在依赖产物之上实现 impl-b 的目标。",
    dependencies: [fixture.depNodeId],
    capabilityTags: ["backend"],
    acceptanceCriteria: ["全部测试通过", "不引入回归"]
  };
}

export const ROLE_RESPONSIBILITY = "developer 在授权工作树内实现与测试，不自行扩大范围。";

/** The accepted dependency output SHA the fixture's integration record pins. */
export function depOutputSha(fixture: ProjectFixture): string {
  return sha40(`${fixture.projectId}-dep-output`);
}

/**
 * Extend a fixture's integration record with one more accepted parent
 * output. Tests that grow a node's frozen dependency snapshot must keep the
 * integration record consistent with it — exactly what the assembler
 * cross-checks.
 */
export function addIntegrationParent(
  world: World,
  fixture: ProjectFixture,
  parentNodeId: string,
  headSha: string
): void {
  const row = world.db
    .prepare("SELECT manifest FROM integration_records WHERE run_id = ? AND node_id = ?")
    .get(fixture.runId, fixture.nodeId) as { manifest: string } | undefined;
  if (row === undefined) {
    return;
  }
  const manifest = JSON.parse(row.manifest) as {
    parents: { readonly nodeId: string; readonly branch: string; readonly headSha: string }[];
  };
  manifest.parents.push({
    nodeId: parentNodeId,
    branch: `exec/${fixture.runId}/${parentNodeId}/1`,
    headSha
  });
  world.db
    .prepare("UPDATE integration_records SET manifest = ? WHERE run_id = ? AND node_id = ?")
    .run(JSON.stringify(manifest), fixture.runId, fixture.nodeId);
}

/** Small, deterministic rule/dependency contents (ASCII, known byte sizes). */
export function ruleContent(label: string): string {
  return `project rule ${label}: all changes require tests and never bypass the gate.`;
}

export function depContent(label: string): string {
  return `dependency output ${label}: exported function implemented with unit tests.`;
}

/**
 * Recursive removal with whitelisted primitives (same discipline as the
 * review/integration helpers). Teardown never masks the real result and
 * never uses fs.rm (M0-05).
 */
export function removeTreeRobust(dir: string): void {
  let entries: string[] = [];
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
