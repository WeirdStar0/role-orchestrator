/**
 * The browser-e2e world (M5-05): a migrated store (the FULL M5 chain
 * 001..013 + 015..018 via `CONTROLLED_EXPANSION_MIGRATIONS`), the A11 user
 * fixture repository built by real git inside the SYSTEM temp directory
 * (reused from the e2e-baseline package — never inside H:\role-orchestrator,
 * which stays a non-git area), two profiles whose executables are the BUILT
 * fake-cli dist bins (dogfood — a real claude/codex is never invoked), the
 * four role bindings (A01) and the run-creation helper that freezes profile
 * snapshots AND records the graph-revision baseline (the composition-root
 * sequence that enables UI editing + controlled expansion).
 *
 * Everything lives in the fixture's scratch tree; teardown removes that tree
 * with the review package's whitelisted primitive (`removeTreeRobust`; raw
 * fs.rm is broken on Node 25/win32 for non-ASCII paths, M0-05).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { ROLE_IDS, type RoleId, type WorkflowDefinition } from "@role-orchestrator/contracts";
import {
  appliedMigrationRecords,
  createProject,
  openDatabase,
  verifyMigrations
} from "@role-orchestrator/store";
import { CONTROLLED_EXPANSION_MIGRATIONS, applyControlledExpansionMigrations } from "@role-orchestrator/expand";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { createRunGraph, recordInitialGraphRevision } from "@role-orchestrator/dag";
import { removeTreeRobust } from "@role-orchestrator/review";
import {
  createFixtureRepo,
  type FixtureRepo
} from "@role-orchestrator/e2e-baseline";
import { FakeCliNotBuiltError } from "./errors.js";

/**
 * Fixture execution target follows the RUNNING platform: A29 binds fixture
 * path forms to the target's own world, so a windows-native fixture cannot be
 * seeded from POSIX temp dirs. Domain assertions are platform-independent;
 * launcher-bound cells are additionally win32-gated at the test level.
 */
const FIXTURE_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";


export const WORLD_PROJECT_ID = "proj-browser-e2e";
export const CLAUDE_PROFILE_ID = "profile-e2e-claude";
export const CODEX_PROFILE_ID = "profile-e2e-codex";

/** Role -> profile binding: both bundled dialects cooperate (A01: one each). */
export const WORLD_ROLE_BINDINGS: Readonly<Record<RoleId, string>> = Object.freeze({
  coordinator: CLAUDE_PROFILE_ID,
  developer: CODEX_PROFILE_ID,
  architect: CLAUDE_PROFILE_ID,
  reviewer: CODEX_PROFILE_ID
} as Record<RoleId, string>);

/** …/packages — resolved so BOTH the src (vitest) and dist layouts agree. */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));

/** Absolute path of the built fake-cli dist bin for one dialect (dogfood). */
export function fakeBinPath(dialect: "claude" | "codex"): string {
  const bin = join(packagesDir, "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new FakeCliNotBuiltError(bin);
  }
  return bin;
}

/** Synthetic, non-credential config dir with the two declared files. */
function makeConfigDir(scratchDir: string, label: string): string {
  const dir = join(scratchDir, "config", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"permissions":{"allow":[]},"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface BrowserE2eWorld {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly fixture: FixtureRepo;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly projectId: string;
  readonly baseSha: string;
  readonly claudeBin: string;
  readonly codexBin: string;
  close(): void;
}

/**
 * Create the world: fixture repo + store with the full M5 migration chain +
 * project + fake-cli profiles + four role bindings. `credentialGroup` is per
 * runtime (like the M2-06 baseline): the parallel flow's serialization comes
 * from TWO nodes sharing the developer ROLE binding (hence one profile, one
 * credential group) while the unverified-credential cap is 1 (A33/A07).
 */
export async function createWorld(label: string): Promise<BrowserE2eWorld> {
  const fixture = await createFixtureRepo(label);
  const dbPath = join(fixture.scratchDir, "orchestrator.db");
  const db = openDatabase(dbPath);
  void applyControlledExpansionMigrations(db, { now: WORLD_T0 });
  const records = appliedMigrationRecords(db);
  if (
    records.length !== CONTROLLED_EXPANSION_MIGRATIONS.length ||
    records[records.length - 1]?.version !== 18
  ) {
    db.close();
    throw new Error("browser-e2e world: the controlled-expansion migration chain was not applied");
  }
  verifyMigrations(db, { migrations: CONTROLLED_EXPANSION_MIGRATIONS });

  const claudeBin = fakeBinPath("claude");
  const codexBin = fakeBinPath("codex");

  createProject(db, {
    id: WORLD_PROJECT_ID,
    repoRoot: fixture.repoPath,
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: WORLD_T0
  });

  const profiles: readonly { id: string; runtime: "claude" | "codex"; bin: string }[] = [
    { id: CLAUDE_PROFILE_ID, runtime: "claude", bin: claudeBin },
    { id: CODEX_PROFILE_ID, runtime: "codex", bin: codexBin }
  ];
  for (const profile of profiles) {
    createProfile(db, {
      id: profile.id,
      runtime: profile.runtime,
      executable: profile.bin,
      executionTarget: FIXTURE_TARGET,
      configDir: makeConfigDir(fixture.scratchDir, profile.runtime),
      credentialGroup: `creds-${profile.runtime}`,
      maxConcurrency: 4,
      timeoutSeconds: 600,
      now: WORLD_T0
    });
    await createProfileRevision(db, {
      profileId: profile.id,
      model: null,
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: WORLD_T0
    });
  }

  initializeProjectRoleBindings(db, { projectId: WORLD_PROJECT_ID, now: WORLD_T0 });
  for (const roleId of ROLE_IDS) {
    setRoleBinding(db, {
      projectId: WORLD_PROJECT_ID,
      roleId,
      profileId: WORLD_ROLE_BINDINGS[roleId],
      // coordinator holds canCreateSubtasks (the A04 expansion requester);
      // every other role is denied and its denial is audited.
      canCreateSubtasks: roleId === "coordinator",
      now: WORLD_T0
    });
  }

  return {
    db,
    dbPath,
    fixture,
    repoPath: fixture.repoPath,
    worktreesRoot: fixture.worktreesRoot,
    projectId: WORLD_PROJECT_ID,
    baseSha: fixture.baseSha,
    claudeBin,
    codexBin,
    close: (): void => {
      db.close();
    }
  };
}

/** Fixed clock base so derived ids and DB timestamps stay deterministic. */
export const WORLD_T0 = "2026-09-22T00:00:00.000Z";

/** Remove the whole scratch tree with the whitelisted primitive (M0-05). */
export async function removeScratchTree(scratchDir: string): Promise<void> {
  await removeTreeRobust(scratchDir);
}

export interface CreatedRun {
  readonly runId: string;
  readonly configSnapshotHash: string;
}

/**
 * Create one run over the fixture's base commit: the frozen role snapshots
 * (A34), the validated graph and the definition-history baseline that makes
 * the run UI-editable and expansion-eligible (M5-01/M5-02 composition-root
 * sequence: createTaskRunWithProfileSnapshot -> createRunGraph ->
 * recordInitialGraphRevision).
 */
export function createRunnableRun(
  world: BrowserE2eWorld,
  runId: string,
  workflow: WorkflowDefinition | unknown
): CreatedRun {
  const created = createTaskRunWithProfileSnapshot(world.db, {
    runId,
    projectId: world.projectId,
    taskId: `task-${runId}`,
    graphRevision: 0,
    baseSha: world.baseSha,
    now: WORLD_T0
  });
  createRunGraph(world.db, { runId, workflow, now: WORLD_T0 });
  recordInitialGraphRevision(world.db, {
    runId,
    workflow: workflow as WorkflowDefinition,
    now: WORLD_T0
  });
  return { runId, configSnapshotHash: created.configSnapshotHash };
}
