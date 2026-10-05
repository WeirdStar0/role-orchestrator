/**
 * M10-02 M1 (driver-contract) — the RunDriver interface, the configuration
 * the composition root passes in, and the view types the driver answers with.
 *
 * The interface is the former local-api `Orchestrator` surface, carried over
 * verbatim (local-api re-exports it as `Orchestrator`; its server.ts call
 * sites are unchanged). The 202-vs-in-process drive-model difference is NOT
 * in the interface (strategy ⑪): how a composition root calls createRun is
 * the composition root's business.
 *
 * Approval red line (unchanged): the RunDriver NEVER approves — the only
 * approval-consuming path is an APPROVED checkpoint recorded through the
 * guarded decision endpoint, surfaced to the driver via onApprovalDecided.
 */
import type { ProfileConfig, RoleId } from "@role-orchestrator/contracts";
import type { Clock, LogSink, OutputCommitter } from "./ports.js";

/**
 * One profile definition the composition root loaded BEFORE serving.
 * (Formerly local-api orchestrator.ts `ProfileDefinition` — moved so the
 * driver can resolve execution settings; local-api re-exports the type.)
 */
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

/**
 * M10-03 — how ONE node of a multi-node workflow dispatches. `agent` runs the
 * bound role's CLI in its own worktree (the v0.2.1 execution shape);
 * `integration` single-writer-merges its parents' accepted outputs into the
 * run's task branch (M7, no CLI execution); `review` runs the reviewer CLI and
 * then settles a fixed-SHA review session over its dependency's accepted
 * output (M8) — a fail verdict grounds the controlled rework expansion (M10).
 * The kind is DISPATCH bookkeeping of the driving process (the frozen
 * contracts node schema is strict and carries no kind field); it lives in the
 * driver's per-run registry, never in the durable node rows.
 */
export type NodeDispatchKind = "agent" | "integration" | "review";

/** One node of a multi-node workflow request (strict; the HTTP schema mirrors this). */
export interface WorkflowNodeSpec {
  readonly id: string;
  readonly role: RoleId;
  readonly kind: NodeDispatchKind;
  /** The node objective; becomes the child's stdin prompt (with role context). */
  readonly objective: string;
  /** Declared node ids; `review` requires exactly one (its reviewed candidate's producer). */
  readonly dependencies: readonly string[];
}

/** Strict run-creation input (the domain half; the HTTP body schema that
 * validates it stays in the serving package and is structurally this). */
export interface RunCreateInput {
  /** The task objective; becomes the node objective and the child's stdin prompt. */
  readonly objective: string;
  /** Absolute path to an EXISTING directory that is a git repository. */
  readonly projectDir: string;
  /**
   * M10-03: the OPTIONAL multi-node declaration. Absent (v0.2.1) -> the
   * single-node "execute" graph is created exactly as before and the run
   * dispatches with the frozen single-node behavior. Present -> the declared
   * graph REPLACES the single node (the top-level objective stays the run's
   * record; node objectives come from the graph) and every node dispatches by
   * its declared kind.
   */
  readonly workflow?: { readonly nodes: readonly WorkflowNodeSpec[] } | undefined;
}

/** One configured binding as the role-bindings endpoint answers it. */
export interface RoleBindingView {
  readonly roleId: RoleId;
  readonly profileId: string;
  /** The profile revision the binding pins (the latest at bind time). */
  readonly profileRevision: number;
}

export interface ProjectRoleBindingsView {
  readonly projectId: string;
  /** Exactly four entries, ROLE_IDS order (coordinator/architect/developer/reviewer). */
  readonly bindings: readonly RoleBindingView[];
}

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

/** Configuration the composition root validated BEFORE constructing the driver. */
export interface RunDriverConfig {
  /**
   * Profiles this driver serves and role bindings may point at (the
   * composition root validates shape/duplicates at startup — the frozen
   * contracts shape plus the ProfileDefinition invocationArgs extension).
   */
  readonly profiles: readonly ProfileDefinition[];
  /**
   * M9-03: the on-disk profiles FILE this configuration was loaded from, when
   * there is one. Purely informational to the driver (surfaced on
   * `profilesSourcePath` for the profiles/full endpoints); in-process
   * composition roots that pass definitions directly have none.
   */
  readonly profilesSourcePath?: string | undefined;
  /**
   * Root directory for this driver's execution worktrees. Created once,
   * explicitly, when the driver is constructed (server-owned scratch space —
   * unlike a user-supplied db path, never a silent mkdir of a typo'd input).
   */
  readonly worktreesRoot: string;
}

/** Injected ports (M12). Omitted ports fall back to the production defaults. */
export interface RunDriverPorts {
  readonly clock?: Clock | undefined;
  readonly log?: LogSink | undefined;
  /**
   * M10-03: the node-output commit step for MULTI-node agent nodes (the
   * controlled Git-Service stand-in). Production passes none — no multi-node
   * agent output is ever committed by this driver, and accepted outputs fall
   * back to the node's inputSha. No validation command or argv can cross the
   * driver surface through ports (M8/M10-02 guard — type-pinned in the
   * driver-surface suite).
   */
  readonly outputCommitter?: OutputCommitter | undefined;
}

/**
 * The formal run-execution surface (M10-02): ONE truth for creating a run,
 * configuring its role bindings, and driving it to a durable terminal state.
 */
export interface RunDriver {
  /** Create one run and enqueue its drive. Fails closed with typed 4xx carriers. */
  createRun(request: RunCreateInput): Promise<CreatedRunView>;
  /**
   * M10-01: configure a project's four role bindings — the ONLY binding
   * write surface (task creation is read-only over them). Fails closed with
   * typed 4xx carriers; a refusal writes nothing (all-or-nothing).
   */
  setProjectRoleBindings(
    projectId: string,
    bindings: ReadonlyArray<{ readonly roleId: RoleId; readonly profileId: string }>
  ): Promise<ProjectRoleBindingsView>;
  /** M9-02: the loaded profiles behind GET /api/v1/profiles (id-sorted). */
  listProfiles(): readonly ProfileSummaryView[];
  /**
   * M9-03: the on-disk profiles source file (serve --profiles), or null when
   * this process has none.
   */
  readonly profilesSourcePath: string | null;
  /** After a guarded approval decision: continue an APPROVED checkpoint. */
  onApprovalDecided(approvalId: string): void;
  /** Cancel in-flight executions and stop the chains (before the store closes). */
  shutdown(): Promise<void>;
}
