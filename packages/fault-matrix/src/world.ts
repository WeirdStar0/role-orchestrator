/**
 * The matrix world (M4-05): a fully migrated store (migration chain 001..014
 * — `EXPAND_MIGRATIONS` composed with `BUDGET_SCHEMA_MIGRATION`, the budget
 * package's documented full-chain composition), a fixture repository created
 * BY THE TESTS via git inside the SYSTEM TEMP directory (never inside
 * H:\role-orchestrator, which stays a non-git working area), two profiles
 * whose executables are the BUILT fake-cli dist bins (dogfood — never a real
 * claude/codex), and the four role bindings (A01: exactly one profile per
 * role).
 *
 * The fixture models the A11 world: one committed baseline AND one
 * UNCOMMITTED user modification that must survive every injected fault —
 * the matrix asserts "未提交代码保留" against it at the end of the cases
 * that touch the user repository.
 *
 * Determinism: the seed commit uses a FIXED author/committer/date identity,
 * so identical content produces identical SHAs across independent worlds.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { ROLE_IDS, type RoleId } from "@role-orchestrator/contracts";
import {
  appliedMigrationRecords,
  applyMigrations,
  createProject,
  openDatabase
} from "@role-orchestrator/store";
import { BUDGET_SCHEMA_MIGRATION } from "@role-orchestrator/budget";
import { EXPAND_MIGRATIONS } from "@role-orchestrator/expand";
import { removeTreeRobust } from "@role-orchestrator/review";
import { GitRunner } from "@role-orchestrator/worktree";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";

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


/** Fixed clock base so DB timestamps are deterministic. */
export const T0 = "2026-09-23T00:00:00.000Z";

export function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/** The fixture commit identity: fixed dates -> cross-repo identical SHAs. */
export const FIXTURE_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "fault-matrix-fixture",
  GIT_AUTHOR_EMAIL: "fault-matrix@role-orchestrator.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "fault-matrix-fixture",
  GIT_COMMITTER_EMAIL: "fault-matrix@role-orchestrator.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

/** Seed files committed on main before any case runs. */
export const SEED_FILES: Readonly<Record<string, string>> = Object.freeze({
  "src/app.ts": "export const app = 'role-orchestrator-fault-matrix';\n",
  "docs/baseline.md": "# fault matrix fixture\n\nseed content\n"
});

/** The user's UNCOMMITTED modification — the 未提交代码 subject. */
export const DIRTY_FILE_REL = "notes/scratch.txt";
export const DIRTY_FILE_CONTENT = "user uncommitted work v1 — must survive every injected fault (A11)\n";

/** …/packages — resolved so BOTH the src and dist layouts agree. */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));

/** Absolute path of the built fake-cli dist bin for one dialect. */
export function fakeBinPath(dialect: "claude" | "codex"): string {
  const bin = join(packagesDir, "fake-cli", "dist", "bin", `fake-${dialect}.js`);
  if (!existsSync(bin)) {
    throw new Error(`fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first.`);
  }
  return bin;
}

export interface MatrixWorld {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly scratchDir: string;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly git: GitRunner;
  readonly baseSha: string;
  readonly projectId: string;
  readonly claudeProfileId: string;
  readonly codexProfileId: string;
  /** The user's uncommitted file content right now (byte-faithful A11 reads). */
  readDirtyFile(): string;
  /** Current HEAD of a branch (lowercase 40-hex or null). */
  branchHead(branch: string): Promise<string | null>;
  /** All commit SHAs of a branch, oldest first. */
  branchCommits(branch: string): Promise<string[]>;
  close(): void;
}

function writeRepoFile(repoPath: string, relativePath: string, content: string): void {
  const absolute = join(repoPath, ...relativePath.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

/**
 * The full matrix world. `applyMigrations` runs the composed chain
 * 001..013 (`EXPAND_MIGRATIONS`) + 014 (`BUDGET_SCHEMA_MIGRATION`) — the
 * migration framework's gap/downgrade checks fail loudly on partial history.
 */
export async function createMatrixWorld(label: string): Promise<MatrixWorld> {
  const scratchDir = mkdtempSync(join(tmpdir(), `ro-fault-matrix-${label}-`));
  const repoPath = join(scratchDir, "repo");
  const worktreesRoot = join(scratchDir, "worktrees");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });

  const git = new GitRunner();
  await git.run(repoPath, ["init", "-b", "main"]);
  await git.run(repoPath, ["config", "core.autocrlf", "false"]);
  await git.run(repoPath, ["config", "user.email", FIXTURE_COMMIT_ENV["GIT_AUTHOR_EMAIL"] as string]);
  await git.run(repoPath, ["config", "user.name", FIXTURE_COMMIT_ENV["GIT_AUTHOR_NAME"] as string]);
  for (const [relativePath, content] of Object.entries(SEED_FILES)) {
    writeRepoFile(repoPath, relativePath, content);
    await git.run(repoPath, ["add", relativePath]);
  }
  await git.run(repoPath, ["commit", "-m", "seed: fault matrix fixture"], { env: { ...FIXTURE_COMMIT_ENV } });
  const baseSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();

  // The user's uncommitted change: written but NEVER staged or committed.
  writeRepoFile(repoPath, DIRTY_FILE_REL, DIRTY_FILE_CONTENT);

  const dbPath = join(scratchDir, "orchestrator.db");
  const db = openDatabase(dbPath);
  await applyMigrations(db, {
    now: T0,
    migrations: [...EXPAND_MIGRATIONS, BUDGET_SCHEMA_MIGRATION]
  });
  const records = appliedMigrationRecords(db);
  if (records.length !== 14 || records[13]?.version !== 14) {
    db.close();
    throw new Error(`matrix world "${label}": migrations 001..014 were not applied`);
  }

  const projectId = "proj-fault-matrix";
  const claudeProfileId = "profile-fm-claude";
  const codexProfileId = "profile-fm-codex";

  createProject(db, {
    id: projectId,
    repoRoot: repoPath,
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });

  const configs: readonly { id: string; runtime: "claude" | "codex"; bin: string }[] = [
    { id: claudeProfileId, runtime: "claude", bin: fakeBinPath("claude") },
    { id: codexProfileId, runtime: "codex", bin: fakeBinPath("codex") }
  ];
  for (const profile of configs) {
    const configDir = join(scratchDir, "config", profile.runtime);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), '{"permissions":{"allow":[]},"synthetic":true}\n', "utf8");
    writeFileSync(join(configDir, "mcp.json"), '{"mcpServers":{},"synthetic":true}\n', "utf8");
    createProfile(db, {
      id: profile.id,
      runtime: profile.runtime,
      executable: profile.bin,
      executionTarget: FIXTURE_TARGET,
      configDir,
      // Distinct groups per runtime so cross-profile claims never block on
      // the A33 credential lock inside the matrix.
      credentialGroup: `creds-fm-${profile.runtime}`,
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: T0
    });
    await createProfileRevision(db, {
      profileId: profile.id,
      model: null,
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
  }

  initializeProjectRoleBindings(db, { projectId, now: T0 });
  const bindingFor: Readonly<Record<RoleId, string>> = Object.freeze({
    coordinator: claudeProfileId,
    architect: claudeProfileId,
    developer: codexProfileId,
    reviewer: codexProfileId
  } as Record<RoleId, string>);
  for (const roleId of ROLE_IDS as readonly RoleId[]) {
    setRoleBinding(db, {
      projectId,
      roleId,
      profileId: bindingFor[roleId],
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }

  return {
    db,
    dbPath,
    scratchDir,
    repoPath,
    worktreesRoot,
    git,
    baseSha,
    projectId,
    claudeProfileId,
    codexProfileId,
    readDirtyFile: (): string =>
      readFileSync(join(repoPath, ...DIRTY_FILE_REL.split("/")), "utf8"),
    branchHead: async (branch: string): Promise<string | null> => {
      const head = await git.tryRun(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return head.exitCode === 0 ? head.stdout.trim() : null;
    },
    branchCommits: async (branch: string): Promise<string[]> => {
      const result = await git.run(repoPath, ["log", "--format=%H", branch]);
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    },
    close: (): void => {
      db.close();
      removeTreeRobust(scratchDir);
    }
  };
}

export interface CreatedRun {
  readonly runId: string;
  readonly configSnapshotHash: string;
}

/** Create a run + frozen role snapshots over the fixture's base commit. */
export function createMatrixRun(world: MatrixWorld, runId: string, taskId: string): CreatedRun {
  const created = createTaskRunWithProfileSnapshot(world.db, {
    runId,
    projectId: world.projectId,
    taskId,
    graphRevision: 0,
    baseSha: world.baseSha,
    now: T0
  });
  return { runId, configSnapshotHash: created.configSnapshotHash };
}

export interface GhostRun {
  readonly runId: string;
  readonly projectId: string;
  /** The executable string the frozen snapshot carries (never exists on disk). */
  readonly executable: string;
  readonly profileId: string;
}

/**
 * A run whose developer profile points at a DIRECT executable that does not
 * exist on disk — the deterministic spawn-ENOEENT subject. Its own project
 * keeps the healthy bindings of the world untouched.
 */
export async function createGhostRun(world: MatrixWorld, runId: string): Promise<GhostRun> {
  const db = world.db;
  const projectId = "proj-fm-ghost";
  const profileId = "profile-fm-ghost";
  const executable = "ghost-fm-direct.exe";

  createProject(db, {
    id: projectId,
    // A DISTINCT repoRoot: projects.repo_root is UNIQUE across projects.
    repoRoot: join(world.scratchDir, "ghost-repo"),
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  const configDir = join(world.scratchDir, "config", "ghost");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "settings.json"), '{"synthetic":true}\n', "utf8");
  createProfile(db, {
    id: profileId,
    runtime: "codex",
    executable,
    executionTarget: FIXTURE_TARGET,
    configDir,
    credentialGroup: "creds-fm-ghost",
    maxConcurrency: 1,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, {
    profileId,
    model: null,
    externalConfigFiles: ["settings.json"],
    now: T0
  });
  initializeProjectRoleBindings(db, { projectId, now: T0 });
  // A01 needs ALL FOUR roles bound before a run can freeze snapshots; the
  // run only ever launches the developer, whose executable is the ghost.
  for (const roleId of ROLE_IDS as readonly RoleId[]) {
    setRoleBinding(db, {
      projectId,
      roleId,
      profileId,
      canCreateSubtasks: roleId === "coordinator",
      now: T0
    });
  }
  createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId,
    taskId: "task-fm-ghost",
    graphRevision: 0,
    baseSha: world.baseSha,
    now: T0
  });
  return { runId, projectId, executable, profileId };
}

/**
 * A directory an engine launch can run in (the stdin prompt file lands here).
 * Lives under the world scratch dir so world cleanup removes it.
 */
export function makeLaunchDir(world: MatrixWorld, label: string): string {
  const dir = join(world.scratchDir, "launch", label);
  mkdirSync(dir, { recursive: true });
  return dir;
}
