/**
 * M9-01 "点火" -> M10-02 composition root — the local API's THIN adapter
 * between its HTTP surface and the ONE formal run-execution truth
 * (@role-orchestrator/orchestration).
 *
 * Everything that IS run execution now lives in the orchestration package
 * (same chains, same constants, same semantics, verbatim):
 *
 *   建图   run-creation.createRunChecked: createTaskRunWithProfileSnapshot ->
 *          createRunGraph -> recordInitialGraphRevision (frozen snapshots +
 *          validated graph + the revision baseline that makes the run
 *          scheduling-eligible); M10-01 semantics: creation is READ-ONLY
 *          over the project's role bindings (requireCompleteRoleBindings
 *          pure read; the ONLY binding write surface is setProjectRoleBindings)
 *   调度   run-driver driveRun: propagateNodeStates -> enqueueReadyNodes ->
 *          pollQueue (real quotas + capability gate + fencing) over ONE
 *          serial drive chain (202-accepted creations enqueue FIFO; M9-02
 *          keeps creation on its own fast chain)
 *   执行   node-driver runClaimedDispatch: createWorktree (A11 isolation over
 *          the USER repo) -> engine.startExecution (claimed-attempt
 *          composition, argv ARRAY, tree-kill budget) -> queue/quota/node
 *          bookkeeping
 *   审批   approval-driver: the persisted event stream is mined with
 *          checkpoint's extractActionProposals; a proposal opens a REAL
 *          approval checkpoint (A17) — the decision goes ONLY through the
 *          existing guarded POST /api/v1/approvals/:id/decision, and only an
 *          APPROVED checkpoint is continued (continueAfterApproval -> the
 *          one bounded continuation execution). Nothing approves, bypasses
 *          or batch-grants.
 *   结果   events land in the store through the engine's redacting
 *          persistence, so the REST/WS surfaces see them unchanged.
 *
 * Error-carrier inversion (M10-02, strategy ⑦): the orchestration package
 * refuses with its OWN typed family (OrchestrationRejectionError); server.ts
 * maps it to the wire envelope VERBATIM — status, code, message text and
 * structured details are byte-identical to the former in-package
 * GraphEditRejectionError carriers (the runs-orchestration HTTP contract
 * suite, unchanged, is the regression anchor). The HTTP-facing pieces stay
 * HERE on purpose: the strict POST /api/v1/runs body schema (zod — the
 * orchestration package has zero external dependencies) and the startup
 * validation of the orchestration options (parseOrchestrationOptions).
 *
 * A02 stance (M10-01 revision, unchanged): task creation does NOT select a
 * profile and does NOT write role bindings. The body carries
 * {objective, projectDir} only; the run is created over the project's
 * EXISTING role bindings and freezes them (the M9-01 snapshot chain,
 * unchanged). Profile selection lives in exactly one write surface: PUT
 * /api/v1/projects/:id/role-bindings (configureProjectRoleBindings inside
 * the orchestration package). The graph carries no profile/model field
 * anywhere, the internal run-creation path still runs
 * `assertNoProfileModelOverride` (inside the snapshot chain), and the API
 * body schemas are strict so a `model`/`profileId` carrier is a plain 400.
 */
import { z } from "zod";
import type { ProfileConfig } from "@role-orchestrator/contracts";
import { ProfileConfigSchema, ProfilesFileSchema } from "@role-orchestrator/contracts";
import type { DatabaseSync } from "node:sqlite";
import { GraphEditRejectionError } from "./errors.js";
import {
  createRunDriver,
  OrchestrationRejectionError,
  type ProfileDefinition,
  type RunDriver
} from "@role-orchestrator/orchestration";

export type {
  CreatedRunView,
  ProfileDefinition,
  ProfileSummaryView,
  ProjectRoleBindingsView,
  RoleBindingView
} from "@role-orchestrator/orchestration";
/** The formal run-execution surface, under the name this server has always used. */
export type Orchestrator = RunDriver;
export { OrchestrationRejectionError };

const InvocationArgsSchema = z.array(z.string().min(1).max(4096)).max(64);

export interface OrchestrationOptions {
  /**
   * Profiles this process serves and role bindings may point at (validated at
   * startup). Since M10-01 POST /api/v1/runs no longer selects from them —
   * the executing profile comes from the project role bindings, and only the
   * role-bindings endpoint may bind (loaded profiles only).
   */
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
   * explicitly, when the driver is constructed (it is server-owned
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

/**
 * Strict POST /api/v1/runs body. Unknown fields are rejected by zod.
 * M10-01 BREAKING: `profileId` was removed (v0.2.0 carried it) — a task's
 * executing profile resolves through the PROJECT ROLE BINDINGS, and creation
 * is read-only over them. A body still carrying profileId is therefore a
 * plain 400 INPUT_REJECTED (unknown field), never silently ignored.
 */
export const RunCreateBodySchema = z.strictObject({
  /** The task objective; becomes the node objective and the child's stdin prompt. */
  objective: z
    .string()
    .min(1)
    .max(10000)
    .refine((value) => value.trim().length > 0, { message: "objective must not be empty/whitespace" }),
  /** Absolute path to an EXISTING directory that is a git repository. */
  projectDir: z.string().min(1).max(2048)
});

export type RunCreateBody = z.infer<typeof RunCreateBodySchema>;

/**
 * M10-02: construct the formal run driver for this process — the composition
 * root's whole job. Startup options are validated fail-closed HERE (HTTP
 * composition concern, GraphEditRejectionError carrier); everything else —
 * chains, pump, creation, bindings, approvals, cancellation — is the
 * orchestration package's RunDriver, unchanged in behavior.
 */
export function createOrchestrator(db: DatabaseSync, options: OrchestrationOptions): Orchestrator {
  const parsedOptions = parseOrchestrationOptions(options);
  return createRunDriver(db, {
    profiles: parsedOptions.profiles,
    profilesSourcePath: parsedOptions.profilesSourcePath,
    worktreesRoot: parsedOptions.worktreesRoot
  });
}

/** Helper re-export for composition roots loading profiles from a JSON file. */
export function parseProfilesFile(json: string): readonly ProfileConfig[] {
  return ProfilesFileSchema.parse(JSON.parse(json)).profiles;
}
