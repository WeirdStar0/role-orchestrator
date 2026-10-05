/**
 * M10-02 M3 (run-driver) — the formal pump: the serial dispatch chain, the
 * round loop, run-level status aggregation, activeCancels and graceful
 * shutdown. Carried over VERBATIM from the former local-api orchestrator.ts
 * (M9-01/M9-02 drive model; production parity is the step-1 hard
 * constraint):
 *
 *  - ONE serial promise chain drives runs (dispatchJoin = serial for v1;
 *    opening concurrency is the separate M10-04 decision — the chain simply
 *    never exercises more than one scheduler slot, whose own quota machinery
 *    stays exactly as shipped);
 *  - run CREATION serializes on its own fast chain (M9-02): POST answers
 *    202 as soon as creation settles and the drive keeps its FIFO place;
 *  - error isolation is catch-per-run (strategy ②): a failing run logs a
 *    note and NEVER takes the serve process down; the durable record
 *    (nodes/executions/events) carries the evidence. Convergence semantics
 *    are all-terminal: a FAILED node leaves the run RUNNING on purpose (the
 *    status vocabulary has no failed value; the evidence lives on the rows
 *    the API already serves);
 *  - this pump only drives runs it created (plus, on an explicit
 *    operator-approved checkpoint, that one continuation — M9);
 *  - graceful close cancels every in-flight execution through the engine's
 *    process-tree kill BEFORE the store closes; a hard kill leaves the
 *    durable A24 evidence for the existing reconcile semantics (nothing
 *    auto re-runs, A22).
 */
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { GitRunner } from "@role-orchestrator/worktree";
import { getTaskRun, setTaskRunStatus } from "@role-orchestrator/store";
import { enqueueReadyNodes, pollQueue } from "@role-orchestrator/scheduler";
import { listRunNodes, propagateNodeStates } from "@role-orchestrator/dag";
import { getApproval } from "@role-orchestrator/approval";
import type {
  CreatedRunView,
  ProfileDefinition,
  ProfileSummaryView,
  ProjectRoleBindingsView,
  RunCreateInput,
  RunDriver,
  RunDriverConfig,
  RunDriverPorts
} from "./driver-contract.js";
import type { RoleId } from "@role-orchestrator/contracts";
import type { DriverContext } from "./context.js";
import { systemClock, createStdoutLogSink } from "./ports.js";
import {
  MAX_PUMP_ROUNDS,
  POLL_LEASE_MS,
  POLL_LIMIT,
  POLL_RETRY_WINDOW_MS,
  PUMP_CONCURRENCY,
  POLL_STARVATION_MS,
  SHUTDOWN_GRACE_MS
} from "./constants.js";
import { createRunChecked, setProjectRoleBindings } from "./run-creation.js";
import { runClaimedDispatch, launchExecution } from "./node-driver.js";
import { continueApprovedCheckpoints } from "./approval-driver.js";

/**
 * Construct the formal run driver over an open store. Fails closed at
 * construction: the worktrees root is created explicitly (a clear failure if
 * the OS refuses — never a silent fallback path).
 */
export function createRunDriver(
  db: DatabaseSync,
  config: RunDriverConfig,
  ports: RunDriverPorts = {}
): RunDriver {
  const clock = ports.clock ?? systemClock;
  const log = ports.log ?? createStdoutLogSink();
  const git = new GitRunner();
  // The worktrees root is server-owned scratch: created once, explicitly,
  // with a clear failure if the OS refuses (never a silent fallback path).
  mkdirSync(config.worktreesRoot, { recursive: true });
  const profilesById = new Map<string, ProfileDefinition>(
    config.profiles.map((profile) => [profile.id, profile])
  );

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
  // soon as creation settles (202 Accepted semantics).
  let creationChain: Promise<void> = Promise.resolve();

  const context: DriverContext = {
    db,
    git,
    worktreesRoot: config.worktreesRoot,
    profilesById,
    clock,
    log,
    activeCancels,
    isClosed: () => closed
  };

  /** Serial dispatchJoin: FIFO enqueue on the ONE drive chain (v1 policy). */
  const enqueueDrive = (work: () => Promise<void>): void => {
    chain = chain
      .then(work)
      .catch((error: unknown) => {
        // A failing run must never take the serve process down; the durable
        // record (nodes/executions/events) carries the evidence.
        const message = error instanceof Error ? error.message : String(error);
        log.log(`[orchestrator] drive failed: ${message}`);
      });
  };

  return {
    profilesSourcePath: config.profilesSourcePath ?? null,

    async createRun(request: RunCreateInput): Promise<CreatedRunView> {
      // Creation serializes on the CREATION chain (fast); the drive it
      // enqueues lands on the drive chain in creation order (FIFO), and the
      // response no longer waits behind an in-flight node execution.
      return await new Promise<CreatedRunView>((resolveCreated, rejectCreated) => {
        creationChain = creationChain
          .then(async () => {
            try {
              const view = await createRunChecked(context, request);
              // The drive is enqueued BEFORE the accept resolves (the exact
              // former order: enqueue inside createRunChecked, then return).
              enqueueDrive(() => driveRun(view.runId));
              resolveCreated(view);
            } catch (error) {
              rejectCreated(error);
            }
          })
          .catch((error: unknown) => {
            // Mirrors the drive-chain discipline: a fault here (outside the
            // typed creation errors, already routed to rejectCreated) must
            // never kill the creation chain.
            const message = error instanceof Error ? error.message : String(error);
            log.log(`[orchestrator] creation failed: ${message}`);
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

    setProjectRoleBindings(
      projectId: string,
      bindings: ReadonlyArray<{ readonly roleId: RoleId; readonly profileId: string }>
    ): Promise<ProjectRoleBindingsView> {
      return setProjectRoleBindings(context, projectId, bindings);
    },

    onApprovalDecided(approvalId: string): void {
      if (closed) return;
      enqueueDrive(async () => {
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
      await continueApprovedCheckpoints(context, runId, (input) => launchExecution(context, input));
      if (closed) return;
      // Aggregation first: a run that just settled must carry its durable
      // READY_FOR_DELIVERY status even when this round ends the drive.
      await settleRunStatus(runId);
      if (runNodesAllTerminal(runId)) return;

      propagateNodeStates(db, { runId, now: clock.nowIso() });
      enqueueReadyNodes(db, { runId, now: clock.nowIso() });
      const poll = pollQueue(db, {
        now: clock.nowIso(),
        leaseMs: POLL_LEASE_MS,
        retryWindowMs: POLL_RETRY_WINDOW_MS,
        starvationMs: POLL_STARVATION_MS,
        limit: POLL_LIMIT,
        concurrency: PUMP_CONCURRENCY
      });
      if (poll.dispatched.length === 0) {
        // Nothing dispatchable: quota/gate/blocked outcomes are recorded on
        // their queue rows by the scheduler — nothing is lost or auto-retried.
        return;
      }
      for (const outcome of poll.dispatched) {
        if (closed) return;
        await runClaimedDispatch(context, runId, outcome);
      }
    }
    log.log(`[orchestrator] run "${runId}" hit the pump round bound; leaving durable state for inspection`);
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
}
