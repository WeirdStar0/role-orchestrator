/**
 * M10-02 M3 (run-driver) — the formal pump: the FIFO drive chain, the
 * round loop, run-level status aggregation, activeCancels and graceful
 * shutdown. Carried over VERBATIM from the former local-api orchestrator.ts
 * (M9-01/M9-02 drive model; production parity is the step-1 hard
 * constraint):
 *
 *  - M10-04 CONCURRENCY OPEN (strategy ①'s separate decision): dispatchJoin
 *    is now "parallel" — ONE round's quota-allowed dispatches (the scheduler's
 *    own four-layer constraint: global/project/profile/credential) run
 *    CONCURRENTLY via the shared pump primitive's Promise.all join; a
 *    workflow's two READY sibling nodes are truly in flight together. Runs
 *    still FIFO on the ONE drive chain (one run's drive at a time — the
 *    global queue poll stays safe for exactly this reason), and the approval
 *    checkpoint continues to park WITHOUT holding a dispatch slot (the
 *    queue-entry settlement precedes the park in the node driver);
 *  - run CREATION serializes on its own fast chain (M9-02): POST answers
 *    202 as soon as creation settles and the drive keeps its FIFO place;
 *  - error isolation is catch-per-run (strategy ②): a failing run logs a
 *    note and NEVER takes the serve process down; the durable record
 *    (nodes/executions/events) carries the evidence. Convergence semantics
 *    are all-terminal: a FAILED node leaves the run RUNNING on purpose (the
 *    frozen status vocabulary has no failed value); since M10-04 the
 *    outcome column (migration 018) says what RUNNING cannot — failed /
 *    blocked park / NULL while in flight;
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
import { getTaskRun, setTaskRunOutcome, setTaskRunStatus, type TaskRunOutcome } from "@role-orchestrator/store";
import {
  enqueueReadyNodes,
  pollQueue,
  type DispatchedOutcome,
  type QuotaRejectedOutcome
} from "@role-orchestrator/scheduler";
import { listRunNodes, propagateNodeStates } from "@role-orchestrator/dag";
import { getApproval } from "@role-orchestrator/approval";
import { runPumpRounds } from "./pump-primitives.js";
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
import { runClaimedDispatch, launchExecution, settleMultiNodeTerminal } from "./node-driver.js";
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

  // ---- the drive chain: runs FIFO (one run's drive at a time); since M10-04
  // the pump WITHIN a run dispatches its quota-allowed nodes in parallel ----
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
    isClosed: () => closed,
    // M10-03: the multi-node run books (created with each workflow run) and
    // the optional node-output commit port (multi-node agent nodes only —
    // the production composition root passes none).
    multiNodeRuns: new Map(),
    outputCommitter: ports.outputCommitter ?? null
  };

  /** FIFO enqueue on the ONE drive chain (runs drive one-at-a-time; the
   * M10-04 parallelism lives WITHIN a run's pump rounds, not across runs). */
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

  /**
   * Drive one run until it settles, blocks on approval, or has nothing due.
   * The round loop is the SHARED pump primitive (M10-02 step 2) with the
   * PRODUCTION strategy configuration: dispatchJoin "parallel" (the M10-04
   * concurrency open — one round's quota-allowed dispatches run concurrently
   * through the primitive's Promise.all join; runs themselves still FIFO on
   * the drive chain), errorIsolation "catch-per-run" (ONE fault ends THIS
   * run's drive with the same log the drive chain used to record; the serve
   * process carries on), convergence "all-terminal" (the frozen
   * vocabulary's own terminal states, emptiness-guarded). The approval
   * continuation sweep, the status aggregation and the PRE-propagate
   * convergence check ride in onRoundBegin — exactly the former in-loop
   * order; propagateNodeStates never mints SUCCEEDED/FAILED, so the
   * primitive's built-in post-propagate check cannot change which rounds
   * run.
   */
  async function driveRun(runId: string): Promise<void> {
    if (closed) return;
    const run = getTaskRun(db, runId);
    if (run === null) return;
    if (run.status === "PLANNED") {
      setTaskRunStatus(db, { id: runId, status: "RUNNING" });
    }
    await runPumpRounds<DispatchedOutcome, QuotaRejectedOutcome>({
      listNodeStates: () => listRunNodes(db, runId).map((node) => node.state),
      propagate: () => propagateNodeStates(db, { runId, now: clock.nowIso() }),
      enqueueReady: () => enqueueReadyNodes(db, { runId, now: clock.nowIso() }),
      poll: () =>
        pollQueue(db, {
          now: clock.nowIso(),
          leaseMs: POLL_LEASE_MS,
          retryWindowMs: POLL_RETRY_WINDOW_MS,
          starvationMs: POLL_STARVATION_MS,
          limit: POLL_LIMIT,
          concurrency: PUMP_CONCURRENCY
        }),
      onRoundBegin: async () => {
        if (closed) return "stop";
        // A checkpoint whose approval the operator APPROVED through the
        // guarded endpoint continues first — the only approval-consuming path.
        // M10-03: multi-node continuations settle through the SAME kind-aware
        // settlement the dispatch path applies (injected so the approval
        // module keeps no runtime edge into the node mechanics).
        await continueApprovedCheckpoints(
          context,
          runId,
          (input) => launchExecution(context, input),
          (continuation) => {
            const committer = context.outputCommitter;
            return settleMultiNodeTerminal(context, {
              runId: continuation.runId,
              nodeId: continuation.nodeId,
              executionId: continuation.executionId,
              kind: continuation.kind,
              result: continuation.result,
              branch: continuation.branch,
              baselineSha: continuation.baselineSha,
              attempt: continuation.attempt,
              commitOutput:
                continuation.kind === "agent" && committer !== null
                  ? () =>
                      committer.commitNodeOutput({
                        runId: continuation.runId,
                        nodeId: continuation.nodeId,
                        executionId: continuation.executionId,
                        attempt: continuation.attempt,
                        worktreePath: continuation.worktreePath,
                        baselineSha: continuation.baselineSha
                      })
                  : null
            });
          }
        );
        if (closed) return "stop";
        // Aggregation first: a run that just settled must carry its durable
        // READY_FOR_DELIVERY status even when this round ends the drive.
        await settleRunStatus(runId);
        if (runNodesAllTerminal(runId)) return "stop";
        return undefined;
      },
      isStopped: () => closed,
      // Nothing dispatchable: quota/gate/blocked outcomes are recorded on
      // their queue rows by the scheduler — nothing is lost or auto-retried.
      onNoneDispatchable: () => "stop",
      onDispatched: (outcome) => runClaimedDispatch(context, runId, outcome),
      onRoundBound: () => {
        log.log(`[orchestrator] run "${runId}" hit the pump round bound; leaving durable state for inspection`);
      },
      onIsolatedError: (error) => {
        // A failing run must never take the serve process down; the durable
        // record (nodes/executions/events) carries the evidence.
        const message = error instanceof Error ? error.message : String(error);
        log.log(`[orchestrator] drive failed: ${message}`);
      }
    }, {
      convergence: "all-terminal",
      dispatchJoin: "parallel",
      errorIsolation: "catch-per-run",
      maxRounds: MAX_PUMP_ROUNDS
    });
  }

  function runNodesAllTerminal(runId: string): boolean {
    const states = listRunNodes(db, runId).map((node) => node.state);
    return states.length > 0 && states.every((state) => state === "SUCCEEDED" || state === "FAILED");
  }

  /**
   * Run-status aggregation: only the frozen vocabulary's own transitions —
   * now paired with the M10-04 OUTCOME column (migration 018, the external
   * evaluation's status+outcome model) so a failed or blocked run stops
   * presenting as a fake 执行中:
   *
   *  - every node SUCCEEDED -> READY_FOR_DELIVERY (from RUNNING only, as
   *    before) with outcome NULL (the delivery flow owns 'success');
   *  - any node WAITING_APPROVAL -> run stays RUNNING, outcome 'blocked'
   *    (the live blocker dominates the presentation);
   *  - any node FAILED        -> run stays RUNNING, outcome 'failed' (the
   *    frozen vocabulary has no failed value; the durable evidence lives on
   *    the node rows and executions, and the outcome column now says so);
   *  - otherwise (nodes still in flight / PENDING, or parked in
   *    INTERRUPTED / RECOVERY_REQUIRED / BLOCKED) -> outcome NULL.
   *
   * Every write is idempotent (same-value writes are skipped), so the pump's
   * repeated rounds never churn the row. Cancellation ('cancelled', paired
   * with the CANCELLED status) has no producer on this driver — no run-cancel
   * surface exists in v1; the pairing is pinned at the store write surface
   * (setTaskRunOutcome + the store suite).
   */
  function settleRunStatus(runId: string): void {
    const nodes = listRunNodes(db, runId);
    if (nodes.length === 0) return;
    const run = getTaskRun(db, runId);
    if (run === null) return;
    if (nodes.every((node) => node.state === "SUCCEEDED")) {
      if (run.status === "RUNNING") {
        setTaskRunStatus(db, { id: runId, status: "READY_FOR_DELIVERY" });
      }
      applyRunOutcome(runId, run.outcome, null);
      return;
    }
    if (nodes.some((node) => node.state === "WAITING_APPROVAL")) {
      applyRunOutcome(runId, run.outcome, "blocked");
      return;
    }
    if (nodes.some((node) => node.state === "FAILED")) {
      applyRunOutcome(runId, run.outcome, "failed");
      return;
    }
    applyRunOutcome(runId, run.outcome, null);
  }

  /** Idempotent outcome write: skip when the row already carries the value. */
  function applyRunOutcome(
    runId: string,
    current: TaskRunOutcome | null,
    next: TaskRunOutcome | null
  ): void {
    if (current !== next) {
      setTaskRunOutcome(db, { id: runId, outcome: next });
    }
  }
}
