/**
 * M11-03 "项目登记" — the project REGISTRATION domain behind POST
 * /api/v1/projects, and the shared fail-closed directory gates it validates
 * with.
 *
 * Provenance, stated honestly: before this module the ONLY creator of a
 * project row was run creation's find-or-create (orchestration
 * run-creation.ts `ensureProject` — after the same four gates, BEFORE the
 * binding-completeness check). That ordering made the product wizard's
 * binding step unreachable for a not-yet-registered directory (the bindings
 * lookup answers 404 PROJECT_UNKNOWN, and the binding PUT needs the project
 * row), which is the dependency the M11-02 handover registered ("按目录预登记"
 * candidate, to be settled with M11-03's project registration). This module
 * realizes pre-registration with ZERO new semantics:
 *   - the four directory gates are byte-for-byte the run-creation ones
 *     (same order, same codes, same "nothing was created" refusals): not
 *     absolute → 400 PROJECT_DIR_NOT_ABSOLUTE, missing → 400
 *     PROJECT_DIR_MISSING, not a directory → 400 PROJECT_DIR_NOT_DIRECTORY,
 *     no resolvable git HEAD → 400 PROJECT_DIR_NOT_GIT_REPOSITORY;
 *   - the row itself is created through the SAME store primitive
 *     (`createProject`) with the SAME derived-id scheme
 *     (`derivedId("proj", repoRoot)`), the SAME platform→executionTarget
 *     mapping (setup.ts `executionTargetForPlatform` — win32/darwin/other,
 *     identical to run creation's PLATFORM_TARGET expression) and the SAME
 *     trustStatus ("requires-user-confirmation") `ensureProject` uses;
 *   - idempotent, not upsert: a directory with an existing row answers 200
 *     `existing: true` and touches NOTHING (the store's repo_root UNIQUE +
 *     the run-creation find-or-create stay the single source of truth; a
 *     refusal-or-noop never mutates).
 *
 * What this module is NOT: it never touches role bindings (the ONLY binding
 * write surface stays PUT /api/v1/projects/:id/role-bindings), never creates
 * a run, never reads file CONTENT (existence/type/git-head metadata only —
 * the git invocation is the worktree package's argv-array GitRunner, the
 * same single spawn point the diff view uses) and never invents a path.
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getProjectByRepoRoot, createProject } from "@role-orchestrator/store";
import { derivedId } from "@role-orchestrator/scheduler";
import { GitRunner } from "@role-orchestrator/worktree";
import { executionTargetForPlatform } from "./setup.js";
import { GraphEditRejectionError } from "./errors.js";

/** Injectable inputs (tests override; production defaults mirror run creation). */
export interface ProjectRegistryOptions {
  readonly db: DatabaseSync;
  /** argv-array-only git runner (the worktree package's single spawn point). */
  readonly git?: GitRunner | undefined;
  /** Platform string driving the executionTarget mapping. Default: process.platform. */
  readonly processPlatform?: string | undefined;
  /** Regular-file/dir probe override (tests). Default: statSync. */
  readonly stat?: ((candidate: string) => { isDirectory: boolean }) | undefined;
  /** Clock override (tests). Default: new Date().toISOString(). */
  readonly now?: (() => string) | undefined;
}

export interface ProjectRegistry {
  /** Shared gate check: validate only, read-only, nothing written. */
  validateProjectDir(projectDir: string): Promise<{ readonly repoRoot: string }>;
  /**
   * Validate (fail-closed, zero writes on any refusal) then find-or-create
   * the project row exactly as run creation would. Answers whether the row
   * already existed plus the operator-facing identity (repoRoot + createdAt;
   * internal ids stay out of the response, like GET /api/v1/projects).
   */
  registerProject(projectDir: string): Promise<{
    readonly existing: boolean;
    readonly project: { readonly repoRoot: string; readonly createdAt: string };
  }>;
}

/**
 * The four fail-closed directory gates, in run creation's order. Each refusal
 * names the SAME code the run-creation path answers with, so the UI's
 * humanizer family stays one vocabulary; every refusal happens BEFORE any
 * write (the registration write itself is only reachable after all four).
 */
async function validateProjectDirGates(
  projectDir: string,
  deps: { readonly git: GitRunner; readonly stat: (candidate: string) => { isDirectory: boolean } }
): Promise<{ readonly repoRoot: string }> {
  if (!isAbsolute(projectDir)) {
    throw new GraphEditRejectionError(
      400,
      "PROJECT_DIR_NOT_ABSOLUTE",
      `projectDir must be an absolute path, got "${projectDir}"`
    );
  }
  const repoRoot = resolve(projectDir);
  let dirStat: { isDirectory: boolean };
  try {
    dirStat = deps.stat(repoRoot);
  } catch (error) {
    throw new GraphEditRejectionError(
      400,
      "PROJECT_DIR_MISSING",
      `projectDir "${projectDir}" does not exist or is not accessible (fail-closed; nothing was created)`,
      { cause: error }
    );
  }
  if (!dirStat.isDirectory) {
    throw new GraphEditRejectionError(
      400,
      "PROJECT_DIR_NOT_DIRECTORY",
      `projectDir "${projectDir}" is not a directory (fail-closed; nothing was created)`
    );
  }
  // Worktree isolation (A11) needs a real git baseline; refuse early — the
  // same awaited gate run creation applies before its find-or-create (the
  // rejection is ASYNC: without the await the refusal would escape this
  // function's catch and the gate would silently pass).
  try {
    await deps.git.run(repoRoot, ["rev-parse", "HEAD"]);
  } catch (error) {
    throw new GraphEditRejectionError(
      400,
      "PROJECT_DIR_NOT_GIT_REPOSITORY",
      `projectDir "${projectDir}" is not a git repository with a resolvable HEAD ` +
        "(worktree isolation needs a real baseline; fail-closed, nothing was created)",
      { cause: error }
    );
  }
  return { repoRoot };
}

/** Production wiring: real statSync, real GitRunner, host platform. */
export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  const git = options.git ?? new GitRunner();
  const processPlatform = options.processPlatform ?? process.platform;
  const stat =
    options.stat ??
    ((candidate: string) => {
      return { isDirectory: statSync(candidate).isDirectory() };
    });
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async validateProjectDir(projectDir: string): Promise<{ readonly repoRoot: string }> {
      return validateProjectDirGates(projectDir, { git, stat });
    },
    async registerProject(projectDir: string): Promise<{
      readonly existing: boolean;
      readonly project: { readonly repoRoot: string; readonly createdAt: string };
    }> {
      const { repoRoot } = await validateProjectDirGates(projectDir, { git, stat });
      const existingRow = getProjectByRepoRoot(options.db, repoRoot);
      if (existingRow !== null) {
        // Idempotent, not upsert: the existing row is returned untouched.
        return {
          existing: true,
          project: { repoRoot: existingRow.repoRoot, createdAt: existingRow.createdAt }
        };
      }
      const created = createProject(options.db, {
        // The SAME derived-id scheme run creation's find-or-create uses, so a
        // later first run over this directory finds THIS row (by repo_root
        // unique) and never mints a second project.
        id: derivedId("proj", repoRoot),
        repoRoot,
        executionTarget: executionTargetForPlatform(processPlatform),
        trustStatus: "requires-user-confirmation",
        now: now()
      });
      return {
        existing: false,
        project: { repoRoot: created.repoRoot, createdAt: created.createdAt }
      };
    }
  };
}
