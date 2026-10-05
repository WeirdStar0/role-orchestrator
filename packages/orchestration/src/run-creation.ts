/**
 * M10-02 M2 (run-creation) — the DOMAIN half of run creation and of role
 * binding configuration, carried over VERBATIM from the former local-api
 * orchestrator.ts (M9-01/M9-02/M10-01 semantics; production parity is the
 * step-1 hard constraint). Only the carriers changed: typed refusals are
 * this package's OrchestrationRejectionError (the HTTP layer maps them to
 * wire envelopes), and time is the injected Clock.
 *
 * The M10-01 semantics live here and must never regress:
 *  - requireCompleteRoleBindings is a PURE READ over the four binding rows
 *    (422 ROLE_BINDINGS_INCOMPLETE naming the missing roles) — task creation
 *    NEVER writes role bindings;
 *  - setProjectRoleBindings is the ONLY binding write surface: fail-closed
 *    gates BEFORE any write (project exists, every profileId among the loaded
 *    profiles, every definition materialized through the seven-field drift
 *    gate), then one transaction for initialize+write (all-or-nothing);
 *  - the run is created over the project's EXISTING bindings and freezes
 *    them (createTaskRunWithProfileSnapshot + createRunGraph +
 *    recordInitialGraphRevision: frozen snapshots + validated graph + the
 *    revision baseline that makes the run scheduling-eligible).
 */
import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { RoleId } from "@role-orchestrator/contracts";
import { IdSchema, ROLE_IDS } from "@role-orchestrator/contracts";
import {
  createProject,
  getProjectByRepoRoot,
  getTaskRun,
  withTransaction
} from "@role-orchestrator/store";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  getLatestProfileRevision,
  getProfile,
  initializeProjectRoleBindings,
  listRoleBindings,
  requireProject,
  setRoleBinding,
  ExecutionTargetMismatchError,
  UnknownProfileError,
  UnknownProfileRevisionError,
  UnknownProjectError
} from "@role-orchestrator/runtime-profile";
import { createRunGraph, recordInitialGraphRevision } from "@role-orchestrator/dag";
import { derivedId } from "@role-orchestrator/scheduler";
import type { ProfileDefinition, RunCreateInput, CreatedRunView, ProjectRoleBindingsView } from "./driver-contract.js";
import type { DriverContext } from "./context.js";
import { OrchestrationRejectionError } from "./errors.js";
import { EXECUTE_NODE_ID, GRAPH_DEFINITION_REVISION } from "./constants.js";

const PLATFORM_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";

/**
 * Fail-closed run creation over a REAL user directory (the former
 * createRunChecked; the drive enqueue stays with the M3 pump so creation
 * order and FIFO placement are unchanged). Answers the 202-accept view; the
 * durable row still reads PLANNED here.
 */
export async function createRunChecked(
  context: DriverContext,
  request: RunCreateInput
): Promise<CreatedRunView> {
  const { db, clock } = context;
  if (!isAbsolute(request.projectDir)) {
    throw new OrchestrationRejectionError(
      400,
      "PROJECT_DIR_NOT_ABSOLUTE",
      `projectDir must be an absolute path, got "${request.projectDir}"`
    );
  }
  const repoRoot = resolve(request.projectDir);
  let projectDirStat: { isDirectory: boolean };
  try {
    projectDirStat = { isDirectory: statSync(repoRoot).isDirectory() };
  } catch (error) {
    throw new OrchestrationRejectionError(
      400,
      "PROJECT_DIR_MISSING",
      `projectDir "${request.projectDir}" does not exist or is not accessible (fail-closed; nothing was created)`,
      { cause: error }
    );
  }
  if (!projectDirStat.isDirectory) {
    throw new OrchestrationRejectionError(
      400,
      "PROJECT_DIR_NOT_DIRECTORY",
      `projectDir "${request.projectDir}" is not a directory (fail-closed; nothing was created)`
    );
  }
  // Worktree isolation (A11) needs a real git baseline; refuse early.
  let baseSha: string;
  try {
    baseSha = (await context.git.run(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  } catch (error) {
    throw new OrchestrationRejectionError(
      400,
      "PROJECT_DIR_NOT_GIT_REPOSITORY",
      `projectDir "${request.projectDir}" is not a git repository with a resolvable HEAD ` +
        "(worktree isolation needs a real baseline; fail-closed, nothing was created)",
      { cause: error }
    );
  }

  const project = await ensureProject(context, repoRoot);
  // M10-01: creation is READ-ONLY over the project's role bindings — the
  // A01 completeness check only, never a write (the v0.2.0 side effect of
  // binding the caller-selected profile to all four roles is gone).
  requireCompleteRoleBindings(db, project.id);

  const objective = request.objective;
  const runId = freshRunId(db);
  const now = clock.nowIso();
  createTaskRunWithProfileSnapshot(db, {
    runId,
    projectId: project.id,
    taskId: `task-${runId}`,
    graphRevision: 0,
    baseSha,
    now
  });
  const workflow = {
    id: `wf-${runId}`,
    name: "M9-01 任务工作台运行",
    nodes: [
      {
        id: EXECUTE_NODE_ID,
        role: "developer" as const,
        title: "执行任务",
        objective,
        dependencies: [] as string[],
        capabilityTags: [] as string[],
        acceptanceCriteria: [objective]
      }
    ]
  };
  createRunGraph(db, { runId, workflow, definitionRevision: GRAPH_DEFINITION_REVISION, now });
  recordInitialGraphRevision(db, { runId, workflow, now });

  return {
    runId,
    projectId: project.id,
    // M9-02: the accept state. The durable row reads PLANNED here; the pump
    // moves it to RUNNING when the drive chain picks the run up — poll
    // statusEndpoint for the frozen vocabulary's transitions.
    status: "queued",
    statusEndpoint: `/api/v1/runs/${runId}`
  };
}

/** Find-or-create the project row for a repo root (repo_root is UNIQUE). */
async function ensureProject(context: DriverContext, repoRoot: string): Promise<{ readonly id: string }> {
  const existing = getProjectByRepoRoot(context.db, repoRoot);
  if (existing !== null) return { id: existing.id };
  const created = createProject(context.db, {
    id: derivedId("proj", repoRoot),
    repoRoot,
    executionTarget: PLATFORM_TARGET,
    trustStatus: "requires-user-confirmation",
    now: context.clock.nowIso()
  });
  return { id: created.id };
}

/**
 * M10-01: the run-creation side of A01, as a PURE READ. All four roles
 * must already be bound (a binding row with a non-null profile); anything
 * less refuses with a typed 422 that names the missing roles and points at
 * the configuration endpoint. Task creation NEVER writes role bindings —
 * the v0.2.0 ensureRoleBindings (which stamped the caller-selected
 * profileId onto every role, overwriting a project's differentiated
 * configuration) is gone; configuration lives in setProjectRoleBindings
 * (below), the ONLY binding write surface.
 */
export function requireCompleteRoleBindings(db: DriverContext["db"], projectId: string): void {
  const bindings = listRoleBindings(db, projectId);
  const missing = ROLE_IDS.filter((roleId) => {
    const binding = bindings.find((candidate) => candidate.roleId === roleId);
    return binding === undefined || binding.profileId === null;
  });
  if (missing.length > 0) {
    throw new OrchestrationRejectionError(
      422,
      "ROLE_BINDINGS_INCOMPLETE",
      `project "${projectId}" has no profile bound for: ${missing.join(", ")}. ` +
        "Task creation is read-only over role bindings (M10-01): configure the four role " +
        "bindings first via PUT /api/v1/projects/" +
        `${projectId}/role-bindings with body ` +
        '{bindings:[{roleId,profileId},...]} (exactly the four built-in roles, profiles ' +
        "this server loaded), then create the task",
      { details: { projectId, missingRoles: missing } }
    );
  }
}

/** `run-` + lowercase base36 timestamp + 6 random base36 chars (IdSchema-safe). */
function freshRunId(db: DriverContext["db"]): string {
  for (;;) {
    const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    if (IdSchema.safeParse(runId).success && getTaskRun(db, runId) === null) return runId;
  }
}

/**
 * M10-01: configure a project's four role bindings (the former
 * setProjectRoleBindings). Fail closed BEFORE any write:
 *   1. the project must exist (the endpoint never invents one — project
 *      rows are created by run creation from a real projectDir);
 *   2. every profileId must be among THIS process's loaded profiles —
 *      binding a profile this process cannot execute would freeze a run
 *      snapshot the pump cannot honor;
 *   3. every profile DEFINITION is materialized (find-or-create with the
 *      seven-field drift gate) and has a revision to pin.
 * Then one transaction initializes the four default rows (idempotent) and
 * writes every binding — a mid-list refusal leaves nothing half-configured.
 */
export async function setProjectRoleBindings(
  context: DriverContext,
  projectId: string,
  bindings: ReadonlyArray<{ readonly roleId: RoleId; readonly profileId: string }>
): Promise<ProjectRoleBindingsView> {
  const { db, clock, profilesById } = context;
  try {
    requireProject(db, projectId);
  } catch (error) {
    if (error instanceof UnknownProjectError) {
      throw new OrchestrationRejectionError(
        404,
        "PROJECT_NOT_FOUND",
        `project "${projectId}" does not exist; project rows are created by the first ` +
          "POST /api/v1/runs over a real projectDir — create a run for the directory first, " +
          "then configure its role bindings",
        { cause: error, details: { projectId } }
      );
    }
    throw error;
  }
  const materialized: { readonly definition: ProfileDefinition }[] = [];
  for (const entry of bindings) {
    const definition = profilesById.get(entry.profileId);
    if (definition === undefined) {
      throw new OrchestrationRejectionError(
        422,
        "UNKNOWN_PROFILE",
        `profileId "${entry.profileId}" (role "${entry.roleId}") is not among the profiles this ` +
          `server loaded (${[...profilesById.keys()].sort().join(", ") || "none"}); ` +
          "role bindings may only point at profiles this process loaded — add it to the " +
          "profiles config and restart serve",
        { details: { roleId: entry.roleId, profileId: entry.profileId } }
      );
    }
    materialized.push({ definition });
  }
  // Materializing a definition can itself cross the A29 gate (createProfile
  // runs the path-form check at registration — the earliest possible
  // point), so the mismatch mapping covers this loop too: a refusal here
  // is the same typed 422. Nothing has been written at this stage.
  let materializingProfileId = "";
  try {
    for (const { definition } of materialized) {
      materializingProfileId = definition.id;
      await ensureProfileRow(context, definition);
      await ensureProfileRevision(context, definition);
    }
  } catch (error) {
    if (error instanceof ExecutionTargetMismatchError) {
      throw new OrchestrationRejectionError(
        422,
        "EXECUTION_TARGET_MISMATCH",
        `cannot bind profile "${materializingProfileId}": ${error.message}`,
        { cause: error, details: { profileId: materializingProfileId } }
      );
    }
    throw error;
  }

  // All-or-nothing: initialize the four default rows (idempotent) and
  // write every binding inside ONE transaction — a mid-list refusal
  // (unknown revision, executionTarget mismatch A29) must not leave a
  // half-configured project behind.
  const now = clock.nowIso();
  withTransaction(db, () => {
    initializeProjectRoleBindings(db, { projectId, now });
    for (const entry of bindings) {
      try {
        setRoleBinding(db, {
          projectId,
          roleId: entry.roleId,
          profileId: entry.profileId,
          // The M9 convention, kept: the coordinator may create subtasks
          // (A04); the other three fixed roles may not.
          canCreateSubtasks: entry.roleId === "coordinator",
          now
        });
      } catch (error) {
        // Map the runtime-profile typed refusals to the driver's typed 4xx
        // carriers (the DOMAIN decides status+code; the HTTP layer only
        // forwards). Everything else rethrows.
        if (error instanceof ExecutionTargetMismatchError) {
          throw new OrchestrationRejectionError(
            422,
            "EXECUTION_TARGET_MISMATCH",
            `cannot bind profile "${entry.profileId}" to role "${entry.roleId}" of project ` +
              `"${projectId}": ${error.message}`,
            { cause: error, details: { roleId: entry.roleId, profileId: entry.profileId } }
          );
        }
        if (error instanceof UnknownProfileError) {
          throw new OrchestrationRejectionError(
            422,
            "UNKNOWN_PROFILE",
            `cannot bind role "${entry.roleId}" of project "${projectId}": ${error.message}`,
            { cause: error, details: { roleId: entry.roleId, profileId: entry.profileId } }
          );
        }
        if (error instanceof UnknownProfileRevisionError) {
          throw new OrchestrationRejectionError(
            422,
            "UNKNOWN_PROFILE_REVISION",
            `cannot bind role "${entry.roleId}" of project "${projectId}": ${error.message}`,
            { cause: error, details: { roleId: entry.roleId, profileId: entry.profileId } }
          );
        }
        throw error;
      }
    }
  });
  return {
    projectId,
    bindings: listRoleBindings(db, projectId).map((row) => ({
      roleId: row.roleId,
      profileId: row.profileId ?? "",
      profileRevision: row.profileRevision ?? 0
    }))
  };
}

/**
 * Find-or-create the durable profile row from the loaded definition.
 * Idempotent across restarts with the same file; a same-id DIFFERENT
 * definition is a 409 (drift is a human decision, never an upsert).
 */
export async function ensureProfileRow(context: DriverContext, definition: ProfileDefinition): Promise<void> {
  const { db, clock } = context;
  const now = clock.nowIso();
  const existing = getProfile(db, definition.id);
  if (existing === null) {
    createProfile(db, {
      id: definition.id,
      runtime: definition.runtime,
      executable: definition.executable,
      executionTarget: definition.executionTarget,
      configDir: definition.configDir,
      credentialGroup: definition.credentialGroup,
      maxConcurrency: definition.maxConcurrency,
      timeoutSeconds: definition.timeoutSeconds,
      now
    });
    await ensureProfileRevision(context, definition);
    return;
  }
  const drift = (
    [
      ["runtime", existing.runtime, definition.runtime],
      ["executable", existing.executable, definition.executable],
      ["executionTarget", existing.executionTarget, definition.executionTarget],
      ["configDir", existing.configDir, definition.configDir],
      ["credentialGroup", existing.credentialGroup, definition.credentialGroup],
      ["maxConcurrency", existing.maxConcurrency, definition.maxConcurrency],
      ["timeoutSeconds", existing.timeoutSeconds, definition.timeoutSeconds]
    ] as const
  ).find(([, stored, wanted]) => stored !== wanted);
  if (drift !== undefined) {
    throw new OrchestrationRejectionError(
      409,
      "PROFILE_DEFINITION_CONFLICT",
      `profile "${definition.id}" already exists with a different ${drift[0]} ` +
        `(stored ${JSON.stringify(drift[1])} != requested ${JSON.stringify(drift[2])}); ` +
        "changing a profile definition is a deliberate human act, not an upsert"
    );
  }
  await ensureProfileRevision(context, definition);
}

/**
 * Create the profile's first revision when it has none. The external
 * config manifest convention for product profiles: the standard
 * `settings.json`/`mcp.json` names, restricted to the files that actually
 * exist in the configured configDir (a missing file is not an error; the
 * revision hashes exactly what is declared and drift checks track that).
 */
export async function ensureProfileRevision(context: DriverContext, definition: ProfileDefinition): Promise<void> {
  const { db, clock } = context;
  if (getLatestProfileRevision(db, definition.id) !== null) return;
  const externalConfigFiles = ["settings.json", "mcp.json"].filter((file) =>
    existsSync(join(definition.configDir, file))
  );
  await createProfileRevision(db, {
    profileId: definition.id,
    model: definition.model,
    externalConfigFiles,
    now: clock.nowIso()
  });
}
