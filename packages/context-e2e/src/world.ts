/**
 * The cross-CLI world (M3-04): a store migrated through the FULL M3 chain
 * (001..010 via `MEMORY_SEARCH_MIGRATIONS`), two projects (A = the run's
 * project, B = a foreign project for the A15 isolation regression), two
 * profiles whose executables are the BUILT fake-cli dist bins (dogfood — the
 * engine never touches a real claude/codex and no credential material is
 * ever read or created), the four role bindings for project A (A01: exactly
 * one profile per role) and the run with its frozen profile snapshots (A34).
 *
 * Reuses the e2e-baseline world primitives (fixture repo, fake bin paths,
 * sequence clock) instead of redefining them — M2-06 is the precedent this
 * package verifies against.
 *
 * Everything lives in one mkdtemp scratch directory: repo, worktrees root,
 * store file and synthetic profile config dirs — removal of the scratch tree
 * is the entire cleanup.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ROLE_IDS, type RoleId } from "@role-orchestrator/contracts";
import {
  appliedMigrationRecords,
  createProject,
  openDatabase,
  verifyMigrations
} from "@role-orchestrator/store";
import { MEMORY_SEARCH_MIGRATIONS, applyMemorySearchMigrations } from "@role-orchestrator/memory-search";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import {
  BASELINE_T0,
  createFixtureRepo,
  fakeBinPath,
  type FixtureRepo
} from "@role-orchestrator/e2e-baseline";
import { ContextE2eUsageError } from "./errors.js";

export const CTX_E2E_PROJECT_A = "proj-ctx-e2e-a";
export const CTX_E2E_PROJECT_B = "proj-ctx-e2e-b";
export const CTX_E2E_CLAUDE_PROFILE_ID = "profile-ctxe2e-claude";
export const CTX_E2E_CODEX_PROFILE_ID = "profile-ctxe2e-codex";

/** Role -> profile binding of the cross-CLI world (both dialects cooperate). */
export const CTX_E2E_ROLE_BINDINGS: Readonly<Record<RoleId, string>> = Object.freeze({
  coordinator: CTX_E2E_CLAUDE_PROFILE_ID,
  developer: CTX_E2E_CODEX_PROFILE_ID,
  architect: CTX_E2E_CLAUDE_PROFILE_ID,
  reviewer: CTX_E2E_CODEX_PROFILE_ID
} as Record<RoleId, string>);

/**
 * A synthetic, non-credential config dir with the two declared baseline
 * files (same shape the runtime-profile/scheduler tests use). No real CLI
 * configuration is ever read, and nothing here contains credentials.
 */
function makeSyntheticConfigDir(scratchDir: string, label: string): string {
  const dir = join(scratchDir, "config", label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"permissions":{"allow":[]},"synthetic":true}\n', "utf8");
  writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
  return dir;
}

export interface CrossCliWorldOptions {
  /** Create the foreign project B (for the A15/A16 regression tests). */
  readonly withProjectB?: boolean;
}

export interface CrossCliWorld {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly fixture: FixtureRepo;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly scratchDir: string;
  readonly projectAId: string;
  /** Present only when the world was created `withProjectB`. */
  readonly projectBId: string | null;
  readonly baseSha: string;
  readonly claudeBin: string;
  readonly codexBin: string;
  close(): void;
}

export async function createCrossCliWorld(
  label: string,
  options: CrossCliWorldOptions = {}
): Promise<CrossCliWorld> {
  const fixture = await createFixtureRepo(label);
  const dbPath = join(fixture.scratchDir, "orchestrator.db");
  const db = openDatabase(dbPath);
  void applyMemorySearchMigrations(db, { now: BASELINE_T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 10 || records[9]?.version !== 10) {
    db.close();
    throw new ContextE2eUsageError("cross-cli world: migrations 001..010 were not applied");
  }
  verifyMigrations(db, { migrations: MEMORY_SEARCH_MIGRATIONS });

  const claudeBin = fakeBinPath("claude");
  const codexBin = fakeBinPath("codex");

  const createProjectRow = (projectId: string, repoRoot: string): void => {
    createProject(db, {
      id: projectId,
      repoRoot,
      executionTarget: "windows-native",
      trustStatus: "requires-user-confirmation",
      now: BASELINE_T0
    });
  };
  createProjectRow(CTX_E2E_PROJECT_A, fixture.repoPath);
  if (options.withProjectB === true) {
    // `projects.repo_root` is UNIQUE (canonical repo root invariant): a
    // foreign project models a DIFFERENT repository, so it gets its own
    // (plain, never-executed) directory inside the same scratch tree.
    const repoRootB = join(fixture.scratchDir, "repo-b");
    mkdirSync(repoRootB, { recursive: true });
    createProjectRow(CTX_E2E_PROJECT_B, repoRootB);
  }

  const profiles: readonly { id: string; runtime: "claude" | "codex"; bin: string }[] = [
    { id: CTX_E2E_CLAUDE_PROFILE_ID, runtime: "claude", bin: claudeBin },
    { id: CTX_E2E_CODEX_PROFILE_ID, runtime: "codex", bin: codexBin }
  ];
  for (const profile of profiles) {
    createProfile(db, {
      id: profile.id,
      runtime: profile.runtime,
      executable: profile.bin,
      executionTarget: "windows-native",
      configDir: makeSyntheticConfigDir(fixture.scratchDir, profile.runtime),
      // Distinct groups per runtime (same shape as the e2e baseline world):
      // the two dialect nodes never contend on the A33 credential lock.
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

  initializeProjectRoleBindings(db, { projectId: CTX_E2E_PROJECT_A, now: BASELINE_T0 });
  for (const roleId of ROLE_IDS) {
    setRoleBinding(db, {
      projectId: CTX_E2E_PROJECT_A,
      roleId,
      profileId: CTX_E2E_ROLE_BINDINGS[roleId],
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
    scratchDir: fixture.scratchDir,
    projectAId: CTX_E2E_PROJECT_A,
    projectBId: options.withProjectB === true ? CTX_E2E_PROJECT_B : null,
    baseSha: fixture.baseSha,
    claudeBin,
    codexBin,
    close: (): void => {
      db.close();
    }
  };
}

export interface CreatedCrossCliRun {
  readonly runId: string;
  readonly configSnapshotHash: string;
}

/** Create the run + frozen role snapshots over the fixture's base commit. */
export function createCrossCliRun(world: CrossCliWorld, runId: string): CreatedCrossCliRun {
  const created = createTaskRunWithProfileSnapshot(world.db, {
    runId,
    projectId: world.projectAId,
    taskId: "task-ctx-e2e",
    graphRevision: 0,
    baseSha: world.baseSha,
    now: BASELINE_T0
  });
  return { runId, configSnapshotHash: created.configSnapshotHash };
}
