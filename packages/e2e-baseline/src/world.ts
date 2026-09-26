/**
 * The baseline world: a migrated store, a project bound to the fixture repo,
 * two profiles whose executables are the BUILT fake-cli dist bins (dogfood —
 * the engine never touches a real claude/codex), the four role bindings
 * (A01: exactly one profile per role) and the run with its frozen profile
 * snapshots (A34).
 *
 * Migrations 001..006 come from @role-orchestrator/review
 * (`REVIEW_MIGRATIONS` = store core + profiles + task_nodes + scheduler +
 * integration + review), the longest chain any M2 package needs.
 *
 * Everything lives in one mkdtemp scratch directory: repo, worktrees root,
 * store file and synthetic profile config dirs — removal of the scratch tree
 * is the entire cleanup.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { ROLE_IDS, type RoleId } from "@role-orchestrator/contracts";
import {
  appliedMigrationRecords,
  createProject,
  openDatabase,
  verifyMigrations
} from "@role-orchestrator/store";
import {
  applyReviewMigrations,
  REVIEW_MIGRATIONS
} from "@role-orchestrator/review";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { BaselineDriverUsageError } from "./errors.js";
import { createFixtureRepo, makeScratchDir, type FixtureRepo } from "./fixture-repo.js";
import { BASELINE_T0 } from "./clock.js";

/**
 * Fixture execution target follows the RUNNING platform: A29 binds fixture
 * path forms to the target's own world, so the absolute fake-cli dist paths
 * seed only under the host's native target. (Suite cells driving the engine
 * launcher are additionally win32-gated at the test level: the production
 * launcher is windows-native-only.)
 */
const FIXTURE_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";


export const BASELINE_PROJECT_ID = "proj-e2e-baseline";
export const CLAUDE_PROFILE_ID = "profile-e2e-claude";
export const CODEX_PROFILE_ID = "profile-e2e-codex";

/** Role -> profile binding of the baseline (both bundled dialects cooperate). */
export const BASELINE_ROLE_BINDINGS: Readonly<Record<RoleId, string>> = Object.freeze({
  coordinator: CLAUDE_PROFILE_ID,
  developer: CODEX_PROFILE_ID,
  architect: CLAUDE_PROFILE_ID,
  reviewer: CODEX_PROFILE_ID
} as Record<RoleId, string>);

/** …/packages — resolved so BOTH the src (vitest) and dist layouts agree:
 * src/world.ts and dist/index.js sit exactly one directory below the package
 * root, so "../../" is the packages/ directory from either. */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));

/** Absolute path of the built fake-cli dist bin for one dialect. */
export function fakeBinPath(dialect: "claude" | "codex"): string {
  const bin = join(packagesDir, "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new BaselineDriverUsageError(
      `fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`
    );
  }
  return bin;
}

/**
 * A synthetic, non-credential config dir with the two declared baseline
 * files (same shape the runtime-profile/scheduler tests use).
 */
function makeConfigDir(scratchDir: string, label: string): string {
  const dir = join(scratchDir, "config", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"permissions":{"allow":[]},"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface BaselineWorld {
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

export async function createBaselineWorld(label: string): Promise<BaselineWorld> {
  const fixture = await createFixtureRepo(label);
  const dbPath = join(fixture.scratchDir, "orchestrator.db");
  const db = openDatabase(dbPath);
  void applyReviewMigrations(db, { now: BASELINE_T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 6 || records[5]?.version !== 6) {
    db.close();
    throw new BaselineDriverUsageError("baseline world: migrations 001..006 were not applied");
  }
  verifyMigrations(db, { migrations: REVIEW_MIGRATIONS });

  const claudeBin = fakeBinPath("claude");
  const codexBin = fakeBinPath("codex");

  createProject(db, {
    id: BASELINE_PROJECT_ID,
    repoRoot: fixture.repoPath,
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: BASELINE_T0
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
      // Distinct groups per runtime: cross-profile claims never block on the
      // A33 credential lock; the SAME-profile lock behavior the parallel pair
      // exercises is per-group (contract literal 1 while isolation is
      // unverified) and stays fully in effect.
      credentialGroup: `creds-${profile.runtime}`,
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: BASELINE_T0
    });
    await createProfileRevision(db, {
      profileId: profile.id,
      model: null,
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: BASELINE_T0
    });
  }

  initializeProjectRoleBindings(db, { projectId: BASELINE_PROJECT_ID, now: BASELINE_T0 });
  for (const roleId of ROLE_IDS) {
    setRoleBinding(db, {
      projectId: BASELINE_PROJECT_ID,
      roleId,
      profileId: BASELINE_ROLE_BINDINGS[roleId],
      canCreateSubtasks: roleId === "coordinator",
      now: BASELINE_T0
    });
  }

  return {
    db,
    dbPath,
    fixture,
    repoPath: fixture.repoPath,
    worktreesRoot: fixture.worktreesRoot,
    projectId: BASELINE_PROJECT_ID,
    baseSha: fixture.baseSha,
    claudeBin,
    codexBin,
    close: (): void => {
      db.close();
    }
  };
}

export interface CreatedRun {
  readonly runId: string;
  readonly configSnapshotHash: string;
}

/** Create the run + frozen role snapshots over the fixture's base commit. */
export function createBaselineRun(
  world: BaselineWorld,
  runId: string
): CreatedRun {
  const created = createTaskRunWithProfileSnapshot(world.db, {
    runId,
    projectId: world.projectId,
    taskId: "task-e2e-baseline",
    graphRevision: 0,
    baseSha: world.baseSha,
    now: BASELINE_T0
  });
  return { runId, configSnapshotHash: created.configSnapshotHash };
}

export { makeScratchDir };
