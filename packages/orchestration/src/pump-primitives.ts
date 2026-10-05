/**
 * M10-02 step 2 — the SHARED PUMP PRIMITIVES (the "可搬清单" convergence).
 *
 * Three pumps carried near-identical copies of these sequences (the M2-06
 * e2e-baseline driver, the M5-05 browser-e2e pump, the M6-04 dogfood driver
 * and — since step 1 — the production run-driver). This module is the ONE
 * home; the drivers consume these exports so the copies are gone, not
 * re-copied.
 *
 *  1. The claim-settlement sequence ("结算四件套"): markQueueEntryCompleted
 *     -> releaseExecutionQuotaGrants -> transitionNodeState (whereStateIn
 *     ["RUNNING"]). Offered in the three granularities the drivers actually
 *     use: the full sequence (settleClaimedNode), the two-entry bookkeeping
 *     without the transition (settleClaimBookkeeping — the A19 parked path),
 *     and the bare terminal transition (transitionNodeTerminal — the
 *     engine-owned continuation path applies the grant release itself).
 *  2. The round-loop primitive (runPumpRounds) with the strategy parameters
 *     of the M10-02 unification strategy:
 *       - dispatchJoin: "serial" (one dispatch joined at a time) |
 *         "parallel" (the M10-04 production choice AND the benchmark pumps'
 *         Promise.all: one round's quota-allowed dispatches run together);
 *       - errorIsolation: "throw-up" (the benchmark pumps: the first
 *         dispatch fault fails the driver) | "catch-per-run" (production:
 *         ONE fault ends THIS run's drive — isolated at the run boundary,
 *         never per dispatch — and the serve process carries on);
 *       - convergence: "all-succeeded" (benchmark pumps, no emptiness
 *         guard) | "all-terminal" (production: length > 0 and every node
 *         SUCCEEDED/FAILED). propagateNodeStates never mints SUCCEEDED/
 *         FAILED (dag states.ts computeReadinessTransitions: PENDING->READY
 *         and ->BLOCKED only), so the built-in post-propagate convergence
 *         check cannot change which rounds the production driver would have
 *         run — its own pre-propagate check rides in onRoundBegin.
 *     The production composition root is configured parallel + catch-per-run
 *     (since M10-04; runs themselves still FIFO on the drive chain).
 */
import type { DatabaseSync } from "node:sqlite";
import {
  markQueueEntryCompleted,
  releaseExecutionQuotaGrants
} from "@role-orchestrator/scheduler";
import { transitionNodeState } from "@role-orchestrator/dag";
import { MAX_PUMP_ROUNDS } from "./constants.js";

// ---------------------------------------------------------------------------
// the claim-settlement sequence (结算四件套)
// ---------------------------------------------------------------------------

/**
 * The claim's bookkeeping, exactly as the M6-05 driver performs it: complete
 * the queue entry, release the claim's quota grants.
 */
export function settleClaimBookkeeping(
  db: DatabaseSync,
  input: { readonly entryId: string; readonly executionId: string; readonly now: string }
): void {
  markQueueEntryCompleted(db, { entryId: input.entryId, now: input.now });
  releaseExecutionQuotaGrants(db, { executionId: input.executionId, now: input.now });
}

/**
 * The terminal node transition, only from RUNNING (the frozen vocabulary's
 * own transitions) — SUCCEEDED on the engine's success formula, FAILED
 * otherwise.
 */
export function transitionNodeTerminal(
  db: DatabaseSync,
  input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly to: "SUCCEEDED" | "FAILED";
    readonly now: string;
  }
): void {
  transitionNodeState(db, {
    runId: input.runId,
    nodeId: input.nodeId,
    to: input.to,
    whereStateIn: ["RUNNING"],
    now: input.now
  });
}

/**
 * The full settlement sequence for ONE scheduler-claimed dispatch: complete
 * the entry, release the grants, land the node at its terminal state.
 */
export function settleClaimedNode(
  db: DatabaseSync,
  input: {
    readonly entryId: string;
    readonly executionId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly to: "SUCCEEDED" | "FAILED";
    readonly now: string;
  }
): void {
  settleClaimBookkeeping(db, input);
  transitionNodeTerminal(db, input);
}

// ---------------------------------------------------------------------------
// the round-loop primitive
// ---------------------------------------------------------------------------

/** How one round's dispatched outcomes are joined. */
export type DispatchJoin = "serial" | "parallel";

/** Where a dispatch fault stops the pump. */
export type ErrorIsolation = "throw-up" | "catch-per-run";

/** When the pump considers the run's graph settled. */
export type Convergence = "all-succeeded" | "all-terminal";

/**
 * The two convergence predicates, VERBATIM per semantics: the benchmark
 * pumps' all-succeeded has NO emptiness guard (an empty graph converges);
 * the production all-terminal requires at least one node (an empty graph
 * never converges — nothing was ever scheduled).
 */
export function isConvergedStates(convergence: Convergence, states: readonly string[]): boolean {
  if (convergence === "all-succeeded") {
    return states.every((state) => state === "SUCCEEDED");
  }
  return states.length > 0 && states.every((state) => state === "SUCCEEDED" || state === "FAILED");
}

/** Why runPumpRounds stopped. */
export type PumpRoundsStopReason =
  | "converged"
  | "round-bound"
  | "stopped"
  | "none-dispatchable"
  | "round-begin-stop"
  | "isolated-error";

export interface PumpRoundsResult {
  /** Rounds BEGUN (1-based; the value the benchmark pumps report). */
  readonly rounds: number;
  readonly stopReason: PumpRoundsStopReason;
}

/**
 * The per-run round-loop callbacks. Everything that differs between the
 * pumps is injected; the loop skeleton, the join, the isolation and the
 * convergence predicates are shared.
 */
export interface PumpRoundsDeps<Dispatched, QuotaRejection> {
  /** The run's node states, for the convergence predicate. */
  readonly listNodeStates: () => readonly string[];
  /** dag.propagateNodeStates for this run. */
  readonly propagate: () => void;
  /** scheduler.enqueueReadyNodes for this run. */
  readonly enqueueReady: () => void;
  /** scheduler.pollQueue for this run (dispatch claims this round). */
  readonly poll: () => {
    readonly dispatched: readonly Dispatched[];
    readonly quotaRejected?: readonly QuotaRejection[] | undefined;
  };
  /** Drive ONE claimed dispatch to its settlement (round = its 1-based round). */
  readonly onDispatched: (dispatched: Dispatched, round: number) => Promise<void>;
  /** Record one quota-rejected queue row (benchmark pumps' trace). */
  readonly onQuotaRejected?: (rejection: QuotaRejection, round: number) => void;
  /**
   * Runs at the TOP of every round, before propagate. Return "stop" to end
   * the pump (the production driver's approval continuation sweep, status
   * aggregation and pre-propagate convergence check live here).
   */
  readonly onRoundBegin?: () => Promise<"stop" | undefined> | "stop" | undefined;
  /**
   * Nothing was dispatchable this round. Return "continue" to let
   * retry-window entries become due on a later round (benchmark pumps check
   * WAITING entries first and THROW from inside when none wait); the default
   * is "stop" (production: quota/gate outcomes are recorded on their rows).
   */
  readonly onNoneDispatchable?: (round: number) => "continue" | "stop";
  /**
   * Fired AFTER a round's executions STARTED (parallel join: promises
   * running, not yet joined) and awaited before the join — the browser
   * tests' live-canvas window.
   */
  readonly onRoundStarted?:
    | ((round: number, dispatched: readonly Dispatched[]) => Promise<void>)
    | undefined;
  /** The pump hit its round bound (production logs and leaves durable state). */
  readonly onRoundBound?: (round: number) => void;
  /** catch-per-run sink: the ONE fault that ended this run's drive. */
  readonly onIsolatedError?: (error: unknown) => void;
  /** Liveness (production's closed flag): checked at the loop top and before each serial dispatch. */
  readonly isStopped?: () => boolean;
}

export interface PumpRoundsOptions {
  readonly convergence: Convergence;
  readonly dispatchJoin: DispatchJoin;
  readonly errorIsolation: ErrorIsolation;
  /** Fail-safe bound; default MAX_PUMP_ROUNDS (32, the shared pump value). */
  readonly maxRounds?: number;
}

/**
 * The shared round loop. Round structure (the benchmark pumps' shape, which
 * the production driver maps onto via onRoundBegin): [stopped?] -> round
 * bound? -> onRoundBegin -> propagate -> converged? -> enqueue -> poll ->
 * quota records -> none-dispatchable? -> join the dispatched.
 */
export async function runPumpRounds<Dispatched, QuotaRejection = never>(
  deps: PumpRoundsDeps<Dispatched, QuotaRejection>,
  options: PumpRoundsOptions
): Promise<PumpRoundsResult> {
  const maxRounds = options.maxRounds ?? MAX_PUMP_ROUNDS;
  const catchPerRun = options.errorIsolation === "catch-per-run";
  let rounds = 0;
  try {
    for (;;) {
      if (rounds >= maxRounds) {
        if (deps.onRoundBound !== undefined) deps.onRoundBound(rounds);
        return { rounds, stopReason: "round-bound" };
      }
      if (deps.isStopped?.() === true) return { rounds, stopReason: "stopped" };
      rounds += 1;
      if ((await deps.onRoundBegin?.()) === "stop") {
        return { rounds, stopReason: "round-begin-stop" };
      }
      deps.propagate();
      if (isConvergedStates(options.convergence, deps.listNodeStates())) {
        return { rounds, stopReason: "converged" };
      }
      deps.enqueueReady();
      const poll = deps.poll();
      if (poll.quotaRejected !== undefined && deps.onQuotaRejected !== undefined) {
        for (const rejection of poll.quotaRejected) {
          deps.onQuotaRejected(rejection, rounds);
        }
      }
      if (poll.dispatched.length === 0) {
        const none = deps.onNoneDispatchable?.(rounds) ?? "stop";
        if (none === "continue") continue;
        return { rounds, stopReason: "none-dispatchable" };
      }
      if (options.dispatchJoin === "parallel") {
        // The benchmark pumps' window: every execution STARTED (promises
        // running, not yet joined) before onRoundStarted is awaited.
        const running = poll.dispatched.map((dispatched) => deps.onDispatched(dispatched, rounds));
        if (deps.onRoundStarted !== undefined) {
          await deps.onRoundStarted(rounds, poll.dispatched);
        }
        await Promise.all(running);
      } else {
        for (const dispatched of poll.dispatched) {
          if (deps.isStopped?.() === true) return { rounds, stopReason: "stopped" };
          await deps.onDispatched(dispatched, rounds);
        }
      }
    }
  } catch (error) {
    if (catchPerRun) {
      // ONE fault ends THIS run's drive (isolated at the RUN boundary — the
      // former chain-level catch of the production pump); the serve process
      // carries on with the next run.
      if (deps.onIsolatedError !== undefined) deps.onIsolatedError(error);
      return { rounds, stopReason: "isolated-error" };
    }
    throw error;
  }
}
