/**
 * M9-01 "点火" — the run-level orchestration carrier for the local API.
 *
 * `POST /api/v1/runs` creates a task run over a REAL user directory and the
 * serve process drives it through the SAME product chain the M6-05 dogfood
 * driver walks (the composition-root sequence, imported — never copied):
 *
 *   建图   createTaskRunWithProfileSnapshot -> createRunGraph ->
 *          recordInitialGraphRevision (frozen snapshots + validated graph +
 *          the revision baseline that makes the run scheduling-eligible)
 *   调度   propagateNodeStates -> enqueueReadyNodes -> pollQueue (real quotas
 *          + capability gate + fencing)
 *   执行   createWorktree (A11 isolation over the USER repo) ->
 *          engine.startExecution (claimed-attempt composition, argv ARRAY,
 *          tree-kill budget) -> queue/quota/node bookkeeping
 *   审批   the persisted event stream is mined with checkpoint's
 *          extractActionProposals; a proposal opens a REAL approval
 *          checkpoint (A17) — the decision goes ONLY through the existing
 *          guarded POST /api/v1/approvals/:id/decision, and only an APPROVED
 *          checkpoint is continued (continueAfterApproval -> the one bounded
 *          continuation execution). Nothing here approves, bypasses or
 *          batch-grants.
 *   结果   events land in the store through the engine's redacting
 *          persistence, so the REST/WS surfaces see them unchanged.
 *
 * Drive model (M9-01 decision, documented in the batch report): the serve
 * process drives runs IN-PROCESS through ONE serial promise chain — a
 * single-user local machine never has two node executions in flight at once;
 * runs created while the chain is busy are driven FIFO after the current
 * work settles. M9-02 splits run CREATION onto its own fast chain: creation
 * is ms-scale bookkeeping (one git rev-parse + synchronous store writes) and
 * must not queue behind a long-running drive, so POST /api/v1/runs answers
 * 202 {runId, status: "queued"} as soon as creation settles and the drive is
 * enqueued — the pump picks the run up asynchronously (async enqueue, safe
 * by construction: driveRun re-reads all state from the store). The
 * scheduler's own quota machinery stays exactly as shipped
 * (globalMax/projectMax/unverifiedCredentialGroupMax are passed unchanged);
 * the serial chain simply never exercises more than one concurrent slot.
 * Graceful close cancels every in-flight execution through the engine's
 * process-tree kill BEFORE the store closes; a hard kill leaves the durable
 * A24 evidence for the existing reconcile semantics (nothing auto re-runs,
 * A22) — this pump only drives runs it created (plus, on an explicit
 * operator-approved checkpoint, that one continuation).
 *
 * A02 stance: the request's `profileId` is a PROJECT ROLE BINDING-level
 * selection — exactly the surface no-override.ts declares ALLOWED
 * (setRoleBinding/createProfile). The graph carries no profile/model field
 * anywhere, the internal run-creation path still runs
 * `assertNoProfileModelOverride`, and the API body schema is strict so a
 * `model` carrier is a plain 400.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, ProfileConfig, RoleId } from "@role-orchestrator/contracts";
import { IdSchema, ProfileConfigSchema, ProfilesFileSchema, RoleIdSchema, ROLE_IDS } from "@role-orchestrator/contracts";
import {
  listEventsForExecution,
  listAttemptsForSlot,
  createProject,
  getProjectByRepoRoot,
  getTaskRun,
  setTaskRunStatus
} from "@role-orchestrator/store";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  getLatestProfileRevision,
  getProfile,
  initializeProjectRoleBindings,
  listRoleBindings,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import {
  createRunGraph,
  getLatestGraphRevision,
  listRunNodes,
  propagateNodeStates,
  recordInitialGraphRevision,
  transitionNodeState
} from "@role-orchestrator/dag";
import {
  derivedId,
  enqueueReadyNodes,
  getQueueEntry,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants
} from "@role-orchestrator/scheduler";
import { startExecution, type ExecutionRunResult } from "@role-orchestrator/engine";
import { GitRunner, createWorktree } from "@role-orchestrator/worktree";
import {
  continueAfterApproval,
  extractActionProposals,
  listCheckpointsForRun,
  openApprovalCheckpoint,
  type ProtocolEventView
} from "@role-orchestrator/checkpoint";
import { getApproval } from "@role-orchestrator/approval";
import { redactText } from "@role-orchestrator/cli-events";
import { GraphEditRejectionError } from "./errors.js";

/** One profile definition the composition root loaded BEFORE serving. */
export type ProfileDefinition = ProfileConfig & {
  /**
   * Non-model invocation arguments appended to EVERY execution of this
   * profile after the dialect protocol args (engine bounds: max 64 elements
   * of 1..4096 chars; `-m`/`--model` are refused — a model flag here would
   * be a hidden override of the frozen profile, and the engine rejects one
   * independently). The profiles FILE schema (frozen contracts
   * ProfilesFileSchema) has no such field and file-loaded definitions keep
   * the default `[]`; in-process composition roots (tests, embedders) may
   * set it — e.g. the fake-cli `--scenario` selection.
   */
  readonly invocationArgs?: readonly string[];
};

const InvocationArgsSchema = z.array(z.string().min(1).max(4096)).max(64);

export interface OrchestrationOptions {
  /** Profiles POST /api/v1/runs may select from (validated at startup). */
  readonly profiles: readonly ProfileDefinition[];
  /**
   * M9-03: the on-disk profiles FILE this configuration was loaded from, when
   * there is one (serve --profiles passes it through loadProfilesOrchestration).
   * It is the ONLY path GET/PUT /api/v1/profiles/full read and atomically
   * write back. In-process composition roots (tests, embedders) that pass
   * profile definitions directly have no source file; for them the endpoints
   * answer 409 PROFILE_SOURCE_ABSENT — there is no writable source, and
   * inventing one (e.g. under the db directory) would silently create a
   * second, divergent fact source.
   */
  readonly profilesSourcePath?: string | undefined;
  /**
   * Root directory for this server's execution worktrees. Created once,
   * explicitly, when the orchestrator is constructed (it is server-owned
   * scratch space — unlike a user-supplied db path, never a silent mkdir of
   * a typo'd input).
   */
  readonly worktreesRoot: string;
}

/** Validate the orchestration options fail-closed at composition time. */
export function parseOrchestrationOptions(options: OrchestrationOptions): OrchestrationOptions {
  const seen = new Set<string>();
  for (const profile of options.profiles) {
    // The FROZEN contracts shape validates every profile (the same per-entry
    // parse a profiles file goes through); the composition-root extension
    // field is split off first (the frozen schema is strict) and validated
    // separately with the engine's own bounds.
    const { invocationArgs, ...frozenFields } = profile;
    ProfileConfigSchema.parse(frozenFields);
    if (invocationArgs !== undefined) {
      InvocationArgsSchema.parse(invocationArgs);
    }
    if (seen.has(profile.id)) {
      throw new GraphEditRejectionError(
        400,
        "PROFILE_DEFINITION_INVALID",
        `profile "${profile.id}" is defined more than once in the orchestration configuration`
      );
    }
    seen.add(profile.id);
  }
  return options;
}

/** Strict POST /api/v1/runs body. Unknown fields are rejected by zod. */
export const RunCreateBodySchema = z.strictObject({
  /** The task objective; becomes the node objective and the child's stdin prompt. */
  objective: z
    .string()
    .min(1)
    .max(10000)
    .refine((value) => value.trim().length > 0, { message: "objective must not be empty/whitespace" }),
  /** One of the profiles the process loaded at startup (binding-level selection). */
  profileId: IdSchema,
  /** Absolute path to an EXISTING directory that is a git repository. */
  projectDir: z.string().min(1).max(2048)
});

export type RunCreateBody = z.infer<typeof RunCreateBodySchema>;

export interface CreatedRunView {
  readonly runId: string;
  readonly projectId: string;
  /**
   * M9-02: the ACCEPT state of the creation, always the literal "queued" —
   * the HTTP 202 is sent as soon as the creation bookkeeping settled and the
   * run's drive is enqueued on the drive chain; the pump picks it up
   * asynchronously. The durable task_runs row status (PLANNED at creation,
   * then the frozen vocabulary's transitions) is read from statusEndpoint
   * (GET /api/v1/runs/:id), never invented here.
   */
  readonly status: "queued";
  /** Where the client polls for progress (the run detail endpoint). */
  readonly statusEndpoint: string;
}

/**
 * M9-02 GET /api/v1/profiles entry — the new-task form's dropdown data:
 * selection-relevant fields only. The executable/configDir filesystem paths
 * and the credential group are deliberately NOT served (the selection needs
 * id + runtime + execution target + model, nothing more).
 */
export interface ProfileSummaryView {
  readonly id: string;
  readonly runtime: string;
  readonly executionTarget: string;
  readonly model: string | null;
  readonly timeoutSeconds: number;
}

const PLATFORM_TARGET =
  process.platform === "win32"
    ? "windows-native"
    : process.platform === "darwin"
      ? "macos-native"
      : "linux-native";

/** The single fixed node of an M9-01 run graph (the user's objective). */
const EXECUTE_NODE_ID = "execute";
const GRAPH_DEFINITION_REVISION = "1";
/** Queue/poll knobs — the M5-05/M6-05 pump values, unchanged. */
const POLL_LEASE_MS = 600_000;
const POLL_RETRY_WINDOW_MS = 50;
const POLL_STARVATION_MS = 600_000;
const POLL_LIMIT = 8;
const CONCURRENCY = { globalMax: 4, projectMax: 4, unverifiedCredentialGroupMax: 1 };
/** Approval checkpoints opened for proposals: 30 days, as the M6-05 driver. */
const APPROVAL_TTL_SECONDS = 2_592_000;
/** Fail-safe bounds for the serial pump (never expected to be reached). */
const MAX_PUMP_ROUNDS = 32;
const SHUTDOWN_GRACE_MS = 15_000;

function nowIso(): string {
  return new Date().toISOString();
}

function logPumpNote(message: string): void {
  process.stdout.write(`${redactText(message).text}\n`);
}

function storedEventViews(db: DatabaseSync, executionId: string): readonly ProtocolEventView[] {
  return listEventsForExecution(db, executionId).map((row) => ({
    type: row.type,
    sourceType: null,
    seq: row.seq,
    payload: JSON.parse(row.payload) as Record<string, JsonValue>
  }));
}

export interface Orchestrator {
  /** Create one run and enqueue its drive. Fails closed with typed 4xx carriers. */
  createRun(request: RunCreateBody): Promise<CreatedRunView>;
  /** M9-02: the loaded profiles behind GET /api/v1/profiles (id-sorted). */
  listProfiles(): readonly ProfileSummaryView[];
  /**
   * M9-03: the on-disk profiles source file (serve --profiles), or null when
   * this process has none — the profiles/full endpoints refuse with 409
   * PROFILE_SOURCE_ABSENT instead of guessing a path.
   */
  readonly profilesSourcePath: string | null;
  /** After POST /api/v1/approvals/:id/decision: continue an APPROVED checkpoint. */
  onApprovalDecided(approvalId: string): void;
  /** Cancel in-flight executions and stop the chain (before the store closes). */
  shutdown(): Promise<void>;
}

export function createOrchestrator(db: DatabaseSync, options: OrchestrationOptions): Orchestrator {
  const parsedOptions = parseOrchestrationOptions(options);
  const profilesById = new Map<string, ProfileDefinition>(
    parsedOptions.profiles.map((profile) => [profile.id, profile])
  );
  const git = new GitRunner();
  // The worktrees root is server-owned scratch: created once, explicitly,
  // with a clear failure if the OS refuses (never a silent fallback path).
  mkdirSync(parsedOptions.worktreesRoot, { recursive: true });

  // ---- the serial drive chain: one node execution in flight, runs FIFO ----
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  const activeCancels = new Map<string, (reason: string) => Promise<boolean>>();

  // M9-02: run CREATION gets its own chain, separate from the drive chain
  // above. Creation is ms-scale (one git rev-parse spawn + synchronous store
  // writes); the M9-01 layout queued it on the DRIVE chain, so a POST
  // /api/v1/runs blocked until the in-flight node execution settled — tens of
  // minutes for a real CLI. Now creations serialize among themselves (the
  // find-or-create bookkeeping stays race-free) while the drive they enqueue
  // keeps its FIFO place on the drive chain; the HTTP response returns as
  // soon as creation settles (202 Accepted semantics, server.ts).
  let creationChain: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): void => {
    chain = chain
      .then(work)
      .catch((error: unknown) => {
        // A failing run must never take the serve process down; the durable
        // record (nodes/executions/events) carries the evidence.
        const message = error instanceof Error ? error.message : String(error);
        logPumpNote(`[orchestrator] drive failed: ${message}`);
      });
  };

  return {
    profilesSourcePath: parsedOptions.profilesSourcePath ?? null,

    async createRun(request: RunCreateBody): Promise<CreatedRunView> {
      // Creation serializes on the CREATION chain (fast); the drive it
      // enqueues lands on the drive chain in creation order (FIFO), and the
      // response no longer waits behind an in-flight node execution.
      return await new Promise<CreatedRunView>((resolveCreated, rejectCreated) => {
        creationChain = creationChain
          .then(async () => {
            try {
              resolveCreated(await createRunChecked(request));
            } catch (error) {
              rejectCreated(error);
            }
          })
          .catch((error: unknown) => {
            // Mirrors the drive-chain discipline: a fault here (outside the
            // typed creation errors, already routed to rejectCreated) must
            // never kill the creation chain.
            const message = error instanceof Error ? error.message : String(error);
            logPumpNote(`[orchestrator] creation failed: ${message}`);
          });
      });
    },

    listProfiles(): readonly ProfileSummaryView[] {
      return [...profilesById.values()]
        .map((profile) => ({
          id: profile.id,
          runtime: profile.runtime,
          executionTarget: profile.executionTarget,
          model: profile.model,
          timeoutSeconds: profile.timeoutSeconds
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },

    onApprovalDecided(approvalId: string): void {
      if (closed) return;
      enqueue(async () => {
        const approval = getApproval(db, approvalId);
        const runId = approval?.requestedBy.runId ?? null;
        if (runId === null) return;
        // Only a human decision recorded through the guarded endpoint gets
        // here; the sweep below consumes exactly the APPROVED checkpoints.
        await driveRun(runId);
      });
    },

    async shutdown(): Promise<void> {
      closed = true;
      // Kill every in-flight CLI process tree through the engine's own
      // cancellation (the CANCELLED path records durable evidence).
      await Promise.allSettled([...activeCancels.values()].map((cancel) => cancel("server shutdown")));
      // Let the in-flight chains settle their bookkeeping (DB writes) before
      // the caller closes the store; bounded so a wedged child cannot hang
      // serve. Both chains: the drive chain AND the M9-02 creation chain.
      await Promise.race([
        Promise.allSettled([chain.catch(() => undefined), creationChain.catch(() => undefined)]),
        new Promise<void>((resolveGrace) => setTimeout(resolveGrace, SHUTDOWN_GRACE_MS))
      ]);
    }
  };

  // ---------------------------------------------------------------------
  // run creation (fail-closed, typed 4xx carriers)
  // ---------------------------------------------------------------------

  async function createRunChecked(request: RunCreateBody): Promise<CreatedRunView> {
    const definition = profilesById.get(request.profileId);
    if (definition === undefined) {
      throw new GraphEditRejectionError(
        400,
        "UNKNOWN_PROFILE",
        `profileId "${request.profileId}" is not among the profiles this server loaded ` +
          `(${[...profilesById.keys()].sort().join(", ") || "none"}); ` +
          "profile selection resolves through loaded profiles bound to project roles (A01/A02)"
      );
    }

    if (!isAbsolute(request.projectDir)) {
      throw new GraphEditRejectionError(
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
      throw new GraphEditRejectionError(
        400,
        "PROJECT_DIR_MISSING",
        `projectDir "${request.projectDir}" does not exist or is not accessible (fail-closed; nothing was created)`,
        { cause: error }
      );
    }
    if (!projectDirStat.isDirectory) {
      throw new GraphEditRejectionError(
        400,
        "PROJECT_DIR_NOT_DIRECTORY",
        `projectDir "${request.projectDir}" is not a directory (fail-closed; nothing was created)`
      );
    }
    // Worktree isolation (A11) needs a real git baseline; refuse early.
    let baseSha: string;
    try {
      baseSha = (await git.run(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    } catch (error) {
      throw new GraphEditRejectionError(
        400,
        "PROJECT_DIR_NOT_GIT_REPOSITORY",
        `projectDir "${request.projectDir}" is not a git repository with a resolvable HEAD ` +
          "(worktree isolation needs a real baseline; fail-closed, nothing was created)",
        { cause: error }
      );
    }

    const project = await ensureProject(repoRoot);
    await ensureProfileRow(definition);
    await ensureRoleBindings(project.id, definition.id);

    const objective = request.objective;
    const runId = freshRunId();
    const now = nowIso();
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

    enqueue(() => driveRun(runId));
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
  async function ensureProject(repoRoot: string): Promise<{ readonly id: string }> {
    const existing = getProjectByRepoRoot(db, repoRoot);
    if (existing !== null) return { id: existing.id };
    const created = createProject(db, {
      id: derivedId("proj", repoRoot),
      repoRoot,
      executionTarget: PLATFORM_TARGET,
      trustStatus: "requires-user-confirmation",
      now: nowIso()
    });
    return { id: created.id };
  }

  /**
   * Find-or-create the durable profile row from the loaded definition.
   * Idempotent across restarts with the same file; a same-id DIFFERENT
   * definition is a 409 (drift is a human decision, never an upsert).
   */
  async function ensureProfileRow(definition: ProfileDefinition): Promise<void> {
    const now = nowIso();
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
      await ensureProfileRevision(definition);
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
      throw new GraphEditRejectionError(
        409,
        "PROFILE_DEFINITION_CONFLICT",
        `profile "${definition.id}" already exists with a different ${drift[0]} ` +
          `(stored ${JSON.stringify(drift[1])} != requested ${JSON.stringify(drift[2])}); ` +
          "changing a profile definition is a deliberate human act, not an upsert"
      );
    }
    await ensureProfileRevision(definition);
  }

  /**
   * Create the profile's first revision when it has none. The external
   * config manifest convention for product profiles: the standard
   * `settings.json`/`mcp.json` names, restricted to the files that actually
   * exist in the configured configDir (a missing file is not an error; the
   * revision hashes exactly what is declared and drift checks track that).
   */
  async function ensureProfileRevision(definition: ProfileDefinition): Promise<void> {
    if (getLatestProfileRevision(db, definition.id) !== null) return;
    const externalConfigFiles = ["settings.json", "mcp.json"].filter((file) =>
      existsSync(join(definition.configDir, file))
    );
    await createProfileRevision(db, {
      profileId: definition.id,
      model: definition.model,
      externalConfigFiles,
      now: nowIso()
    });
  }

  /**
   * All four roles resolve at run creation (A01), so run creation binds the
   * requested profile to every role that is not already bound to it — the
   * Project RoleBinding surface where profile selection is ALLOWED (A02).
   * Frozen run snapshots (A34) are unaffected by later rebinds.
   */
  async function ensureRoleBindings(projectId: string, profileId: string): Promise<void> {
    initializeProjectRoleBindings(db, { projectId, now: nowIso() });
    const bindings = listRoleBindings(db, projectId);
    for (const roleId of ROLE_IDS) {
      const binding = bindings.find((candidate) => candidate.roleId === roleId);
      if (binding?.profileId === profileId) continue;
      setRoleBinding(db, {
        projectId,
        roleId,
        profileId,
        canCreateSubtasks: roleId === "coordinator",
        now: nowIso()
      });
    }
  }

  /** `run-` + lowercase base36 timestamp + 6 random base36 chars (IdSchema-safe). */
  function freshRunId(): string {
    for (;;) {
      const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
      if (IdSchema.safeParse(runId).success && getTaskRun(db, runId) === null) return runId;
    }
  }

  // ---------------------------------------------------------------------
  // the pump
  // ---------------------------------------------------------------------

  /** Drive one run until it settles, blocks on approval, or has nothing due. */
  async function driveRun(runId: string): Promise<void> {
    if (closed) return;
    const run = getTaskRun(db, runId);
    if (run === null) return;
    if (run.status === "PLANNED") {
      setTaskRunStatus(db, { id: runId, status: "RUNNING" });
    }
    for (let round = 0; round < MAX_PUMP_ROUNDS; round += 1) {
      if (closed) return;
      // A checkpoint whose approval the operator APPROVED through the guarded
      // endpoint continues first — the only approval-consuming path.
      await continueApprovedCheckpoints(runId);
      if (closed) return;
      // Aggregation first: a run that just settled must carry its durable
      // READY_FOR_DELIVERY status even when this round ends the drive.
      await settleRunStatus(runId);
      if (runNodesAllTerminal(runId)) return;

      propagateNodeStates(db, { runId, now: nowIso() });
      enqueueReadyNodes(db, { runId, now: nowIso() });
      const poll = pollQueue(db, {
        now: nowIso(),
        leaseMs: POLL_LEASE_MS,
        retryWindowMs: POLL_RETRY_WINDOW_MS,
        starvationMs: POLL_STARVATION_MS,
        limit: POLL_LIMIT,
        concurrency: CONCURRENCY
      });
      if (poll.dispatched.length === 0) {
        // Nothing dispatchable: quota/gate/blocked outcomes are recorded on
        // their queue rows by the scheduler — nothing is lost or auto-retried.
        return;
      }
      for (const outcome of poll.dispatched) {
        if (closed) return;
        await runClaimedDispatch(runId, outcome.executionId, outcome.entryId, outcome.dispatchToken);
      }
    }
    logPumpNote(`[orchestrator] run "${runId}" hit the pump round bound; leaving durable state for inspection`);
  }

  function runNodesAllTerminal(runId: string): boolean {
    const states = listRunNodes(db, runId).map((node) => node.state);
    return states.length > 0 && states.every((state) => state === "SUCCEEDED" || state === "FAILED");
  }

  /** Run-status aggregation: only the frozen vocabulary's own transitions. */
  function settleRunStatus(runId: string): void {
    const nodes = listRunNodes(db, runId);
    if (nodes.length === 0) return;
    if (nodes.every((node) => node.state === "SUCCEEDED")) {
      const run = getTaskRun(db, runId);
      if (run !== null && run.status === "RUNNING") {
        setTaskRunStatus(db, { id: runId, status: "READY_FOR_DELIVERY" });
      }
    }
    // A failed node leaves the run RUNNING on purpose: the status vocabulary
    // has no failed value, and the durable evidence lives on the node rows
    // and executions the API already serves.
  }

  async function runClaimedDispatch(
    runId: string,
    executionId: string,
    entryId: string,
    dispatchToken: string
  ): Promise<void> {
    const run = getTaskRun(db, runId);
    const entry = getQueueEntry(db, entryId);
    if (run === null || entry === null) return;
    const node = listRunNodes(db, runId).find((candidate) => candidate.nodeId === entry.nodeId);
    if (node === undefined) return;
    const attempt = listAttemptsForSlot(db, { runId, nodeId: entry.nodeId }).length;
    const worktree = await createWorktree(git, {
      repoPath: repoRootOf(run.projectId),
      worktreesRoot: parsedOptions.worktreesRoot,
      runId,
      nodeId: entry.nodeId,
      attempt,
      baseSha: run.baseSha
    });

    const result = await launchExecution({
      executionId,
      runId,
      roleId: node.roleId,
      nodeId: entry.nodeId,
      definitionRevision: node.definitionRevision,
      attempt,
      dispatchToken,
      cwd: worktree.worktreePath,
      profileId: entry.profileId,
      objective: objectiveOfRun(runId)
    });

    // The claim's bookkeeping, exactly as the M6-05 driver performs it.
    markQueueEntryCompleted(db, { entryId, now: nowIso() });
    releaseExecutionQuotaGrants(db, { executionId, now: nowIso() });

    // A proposal surfaces BEFORE any terminal node transition: the checkpoint
    // moves the node to WAITING_APPROVAL and the run parks there (A19: an
    // unapproved side effect does not happen; the decision is the operator's).
    const parked = await openCheckpointsForProposals(executionId, worktree.worktreePath);
    if (parked) return;
    if (result.finalPhase === "SUCCEEDED") {
      transitionNodeState(db, {
        runId,
        nodeId: entry.nodeId,
        to: "SUCCEEDED",
        whereStateIn: ["RUNNING"],
        now: nowIso()
      });
    } else {
      transitionNodeState(db, {
        runId,
        nodeId: entry.nodeId,
        to: "FAILED",
        whereStateIn: ["RUNNING"],
        now: nowIso()
      });
    }
  }

  /** engine.startExecution behind the cancel registry + typed failure mapping. */
  async function launchExecution(input: {
    readonly executionId: string;
    readonly runId: string;
    readonly roleId: RoleId;
    readonly nodeId: string;
    readonly definitionRevision: string;
    readonly attempt: number;
    readonly dispatchToken: string;
    readonly cwd: string;
    readonly profileId: string;
    readonly objective: string | null;
  }): Promise<ExecutionRunResult> {
    const definition = profilesById.get(input.profileId);
    const timeoutSeconds = definition?.timeoutSeconds ?? 600;
    const invocationArgs = definition?.invocationArgs ?? [];
    const execution = startExecution(db, {
      executionId: input.executionId,
      runId: input.runId,
      roleId: input.roleId,
      nodeId: input.nodeId,
      definitionRevision: input.definitionRevision,
      attempt: input.attempt,
      dispatchToken: input.dispatchToken,
      cwd: input.cwd,
      prompt: input.objective ?? `run ${input.runId} node ${input.nodeId}`,
      invocationArgs,
      timeoutSeconds,
      now: nowIso(),
      claimedAttempt: true
    });
    activeCancels.set(input.executionId, (reason: string) => execution.cancel(reason));
    try {
      return await execution.result;
    } finally {
      activeCancels.delete(input.executionId);
    }
  }

  /**
   * Mine the persisted (already redacted) event stream for structured action
   * proposals and open one real checkpoint per proposal. Returns true when at
   * least one checkpoint is now WAITING (the node left RUNNING).
   */
  async function openCheckpointsForProposals(executionId: string, cwd: string): Promise<boolean> {
    const extraction = extractActionProposals(storedEventViews(db, executionId));
    let parked = false;
    for (const { proposal } of extraction.proposals) {
      const opened = openApprovalCheckpoint(db, {
        executionId,
        proposal,
        cwd,
        grantedPermissions: ["repo.read"],
        ttlSeconds: APPROVAL_TTL_SECONDS,
        now: nowIso()
      });
      parked = parked || opened.nodeState === "WAITING_APPROVAL";
    }
    return parked;
  }

  /**
   * Consume exactly the checkpoints whose approval a human APPROVED through
   * the guarded decision endpoint: continueAfterApproval mints the ONE
   * digest-bound continuation execution (A17), which this pump launches with
   * the engine's claimed-attempt composition — the same dispatch pipeline
   * every scheduler claim uses.
   */
  async function continueApprovedCheckpoints(runId: string): Promise<void> {
    for (const checkpoint of listCheckpointsForRun(db, runId)) {
      if (closed) return;
      if (checkpoint.status !== "WAITING") continue;
      const approval = getApproval(db, checkpoint.approvalId);
      if (approval === null || approval.status !== "APPROVED") continue;
      const run = getTaskRun(db, runId);
      if (run === null) return;
      const continuationExecutionId = derivedId(
        "exec",
        checkpoint.id,
        "cont",
        String(checkpoint.attempt)
      );
      const plan = continueAfterApproval(db, {
        checkpointId: checkpoint.id,
        newExecutionId: continuationExecutionId,
        now: nowIso()
      });
      transitionNodeState(db, {
        runId,
        nodeId: checkpoint.nodeId,
        to: "READY",
        whereStateIn: ["WAITING_APPROVAL"],
        now: nowIso()
      });
      transitionNodeState(db, {
        runId,
        nodeId: checkpoint.nodeId,
        to: "RUNNING",
        whereStateIn: ["READY"],
        now: nowIso()
      });
      const worktree = await createWorktree(git, {
        repoPath: repoRootOf(run.projectId),
        worktreesRoot: parsedOptions.worktreesRoot,
        runId,
        nodeId: checkpoint.nodeId,
        attempt: plan.attempt,
        baseSha: run.baseSha
      });
      const result = await launchExecution({
        executionId: continuationExecutionId,
        runId,
        roleId: RoleIdSchema.parse(checkpoint.roleId),
        nodeId: checkpoint.nodeId,
        definitionRevision: plan.execution.definitionRevision,
        attempt: plan.attempt,
        dispatchToken: plan.execution.dispatchToken,
        cwd: worktree.worktreePath,
        profileId: plan.frozen.snapshot.id,
        objective: objectiveOfRun(runId)
      });
      // The continuation is an engine-owned attempt (no queue entry); only
      // the (no-op) grant-release bookkeeping applies, as in the M6-05 driver.
      releaseExecutionQuotaGrants(db, { executionId: continuationExecutionId, now: nowIso() });
      const parked = await openCheckpointsForProposals(continuationExecutionId, worktree.worktreePath);
      if (parked) continue;
      if (result.finalPhase === "SUCCEEDED") {
        transitionNodeState(db, {
          runId,
          nodeId: checkpoint.nodeId,
          to: "SUCCEEDED",
          whereStateIn: ["RUNNING"],
          now: nowIso()
        });
      } else {
        transitionNodeState(db, {
          runId,
          nodeId: checkpoint.nodeId,
          to: "FAILED",
          whereStateIn: ["RUNNING"],
          now: nowIso()
        });
      }
    }
  }

  /** The run objective comes from the frozen graph revision (durable). */
  function objectiveOfRun(runId: string): string | null {
    const revision = getLatestGraphRevision(db, runId);
    return revision?.workflow.nodes.find((node) => node.id === EXECUTE_NODE_ID)?.objective ?? null;
  }

  /** The project row always exists for a run created here; read its repoRoot. */
  function repoRootOf(projectId: string): string {
    const row = db.prepare("SELECT repo_root FROM projects WHERE id = ?").get(projectId) as
      | { repo_root: string }
      | undefined;
    if (row === undefined) {
      throw new Error(`project "${projectId}" vanished while driving its run`);
    }
    return row.repo_root;
  }
}

/** Helper re-export for composition roots loading profiles from a JSON file. */
export function parseProfilesFile(json: string): readonly ProfileConfig[] {
  return ProfilesFileSchema.parse(JSON.parse(json)).profiles;
}
