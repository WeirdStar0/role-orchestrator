/**
 * M10-02 step 2 — the shared round-loop primitive (runPumpRounds) and the
 * convergence predicates. The db-touching settlement sequence is exercised
 * by the three consuming drivers' full-chain suites (e2e-baseline / dogfood
 * / browser-e2e) and the production HTTP contract suite; THIS suite pins the
 * parameterized semantics the strategy names: dispatchJoin serial|parallel,
 * errorIsolation throw-up|catch-per-run, convergence all-succeeded|
 * all-terminal (with their VERBATIM difference — the emptiness guard).
 */
import { describe, expect, it } from "vitest";
import {
  isConvergedStates,
  runPumpRounds,
  type PumpRoundsDeps
} from "../src/pump-primitives.js";

interface FakeOutcome {
  readonly id: string;
}

interface DepsState {
  rounds: (readonly string[])[];
  readonly settled: string[];
  /** fail the Nth onDispatched (1-based execution order) */
  failAt?: number | undefined;
  executions: number;
}

function makeDeps(
  state: DepsState,
  schedule: readonly (readonly string[])[],
  overrides: Partial<PumpRoundsDeps<FakeOutcome, never>> = {}
): PumpRoundsDeps<FakeOutcome, never> {
  return {
    listNodeStates: () => (state.rounds.length >= 1 ? ["SUCCEEDED"] : []),
    propagate: () => undefined,
    enqueueReady: () => undefined,
    poll: () => {
      const round = schedule[state.rounds.length] ?? [];
      state.rounds.push(round);
      return { dispatched: round.map((id) => ({ id })) };
    },
    onDispatched: async (outcome) => {
      state.executions += 1;
      if (state.failAt !== undefined && state.executions >= state.failAt) {
        throw new Error(`boom ${outcome.id}`);
      }
      state.settled.push(outcome.id);
    },
    ...overrides
  };
}

const THROW_UP_PARALLEL = {
  convergence: "all-succeeded",
  dispatchJoin: "parallel",
  errorIsolation: "throw-up"
} as const;

describe("runPumpRounds (shared round-loop primitive)", () => {
  it("converges on the round AFTER the last dispatch (the benchmark pumps' loop shape, rounds 1-based)", async () => {
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    const result = await runPumpRounds(
      makeDeps(state, [["a"]], {
        listNodeStates: () => (state.settled.length > 0 ? ["SUCCEEDED"] : ["PENDING"])
      }),
      THROW_UP_PARALLEL
    );
    // round 1 dispatches; round 2's post-propagate check sees the settled graph
    expect(result).toEqual({ rounds: 2, stopReason: "converged" });
    expect(state.settled).toEqual(["a"]);
  });

  it("dispatchJoin serial drives outcomes one at a time, in poll order", async () => {
    const events: string[] = [];
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    await runPumpRounds(
      makeDeps(state, [["a", "b", "c"]], {
        listNodeStates: () => (state.settled.length >= 3 ? ["SUCCEEDED"] : ["PENDING"]),
        onDispatched: async (outcome) => {
          events.push(`start:${outcome.id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`end:${outcome.id}`);
          state.settled.push(outcome.id);
        }
      }),
      { convergence: "all-succeeded", dispatchJoin: "serial", errorIsolation: "throw-up" }
    );
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("dispatchJoin parallel starts every execution before joining; onRoundStarted sees them running", async () => {
    const events: string[] = [];
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    await runPumpRounds(
      makeDeps(state, [["a", "b"]], {
        listNodeStates: () => (state.settled.length >= 2 ? ["SUCCEEDED"] : ["PENDING"]),
        onDispatched: async (outcome) => {
          events.push(`start:${outcome.id}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push(`end:${outcome.id}`);
          state.settled.push(outcome.id);
        },
        onRoundStarted: async (round, dispatched) => {
          events.push(`round-started:${String(round)}:[${dispatched.map((o) => o.id).join(",")}]`);
        }
      }),
      THROW_UP_PARALLEL
    );
    // both STARTED before the round-started hook, which is awaited BEFORE the join
    expect(events.slice(0, 3)).toEqual(["start:a", "start:b", "round-started:1:[a,b]"]);
    expect(events.slice(3)).toEqual(["end:a", "end:b"]);
  });

  it("errorIsolation throw-up: the first fault fails the pump (parallel starts the round's executions)", async () => {
    const state: DepsState = { rounds: [], settled: [], executions: 0, failAt: 1 };
    await expect(
      runPumpRounds(makeDeps(state, [["a", "b"]], { listNodeStates: () => ["PENDING"] }), THROW_UP_PARALLEL)
    ).rejects.toThrowError(/boom/);
    // the parallel join STARTED both executions before the join rejected
    expect(state.executions).toBe(2);
    expect(state.settled).toEqual([]);
  });

  it("errorIsolation catch-per-run: ONE fault ends THIS run's drive via onIsolatedError (no throw, remaining dispatches never run)", async () => {
    const state: DepsState = { rounds: [], settled: [], executions: 0, failAt: 2 };
    const isolated: string[] = [];
    const result = await runPumpRounds(
      makeDeps(state, [["a", "b", "c"]], {
        listNodeStates: () => ["PENDING"],
        onIsolatedError: (error) => isolated.push(String((error as Error).message))
      }),
      {
        convergence: "all-succeeded",
        dispatchJoin: "serial",
        errorIsolation: "catch-per-run"
      }
    );
    expect(result.stopReason).toBe("isolated-error");
    expect(isolated).toEqual(["boom b"]); // exactly ONE isolated error, at the run boundary
    expect(state.settled).toEqual(["a"]); // 'b' faulted; 'c' never ran
    expect(state.executions).toBe(2);
  });

  it("convergence all-succeeded has NO emptiness guard; all-terminal requires at least one node", () => {
    expect(isConvergedStates("all-succeeded", [])).toBe(true);
    expect(isConvergedStates("all-terminal", [])).toBe(false);
    expect(isConvergedStates("all-succeeded", ["SUCCEEDED", "SUCCEEDED"])).toBe(true);
    expect(isConvergedStates("all-terminal", ["SUCCEEDED", "FAILED"])).toBe(true);
    expect(isConvergedStates("all-terminal", ["SUCCEEDED", "RUNNING"])).toBe(false);
    expect(isConvergedStates("all-succeeded", ["SUCCEEDED", "FAILED"])).toBe(false);
  });

  it("an all-terminal graph with a FAILED node is converged (production aggregation semantics)", async () => {
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    const result = await runPumpRounds(
      makeDeps(state, [["a"]], {
        listNodeStates: () => ["FAILED"]
      }),
      { convergence: "all-terminal", dispatchJoin: "serial", errorIsolation: "catch-per-run" }
    );
    expect(result).toEqual({ rounds: 1, stopReason: "converged" });
    expect(state.executions).toBe(0); // never dispatched: the graph was settled from the start
  });

  it("onNoneDispatchable continue loops again; stop ends the pump", async () => {
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    const result = await runPumpRounds(
      makeDeps(state, [[], ["a"]], {
        listNodeStates: () => (state.settled.length > 0 ? ["SUCCEEDED"] : ["PENDING"]),
        onNoneDispatchable: () => "continue"
      }),
      THROW_UP_PARALLEL
    );
    // round 1 empty->continue, round 2 dispatches, round 3's check converges
    expect(result).toEqual({ rounds: 3, stopReason: "converged" });

    const stopped = await runPumpRounds(
      makeDeps({ rounds: [], settled: [], executions: 0 }, [[]], { listNodeStates: () => ["PENDING"] }),
      THROW_UP_PARALLEL
    );
    expect(stopped).toEqual({ rounds: 1, stopReason: "none-dispatchable" });
  });

  it("quota rejections are forwarded with their round; the round bound fires onRoundBound", async () => {
    const rejections: string[] = [];
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    const result = await runPumpRounds<FakeOutcome, { readonly entryId: string }>(
      {
        ...makeDeps(state, [["a"]], { listNodeStates: () => ["PENDING"] }),
        poll: () => {
          state.rounds.push(["a"]);
          return { dispatched: [{ id: "a" }], quotaRejected: [{ entryId: "q1" }] };
        },
        onQuotaRejected: (rejection, round) => rejections.push(`${rejection.entryId}@${String(round)}`)
      },
      { ...THROW_UP_PARALLEL, maxRounds: 1 }
    );
    expect(result).toEqual({ rounds: 1, stopReason: "round-bound" });
    expect(rejections).toEqual(["q1@1"]);
  });

  it("isStopped stops at the loop top and before each serial dispatch; onRoundBegin can stop the pump", async () => {
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    let stopped = false;
    const result = await runPumpRounds(
      makeDeps(state, [["a", "b", "c"]], {
        listNodeStates: () => ["PENDING"],
        isStopped: () => stopped,
        onDispatched: async (outcome) => {
          if (outcome.id === "a") stopped = true;
          state.settled.push(outcome.id);
        }
      }),
      { convergence: "all-succeeded", dispatchJoin: "serial", errorIsolation: "throw-up" }
    );
    expect(result.stopReason).toBe("stopped");
    expect(state.settled).toEqual(["a"]);

    const beginStop = await runPumpRounds(
      makeDeps({ rounds: [], settled: [], executions: 0 }, [["a"]], {
        onRoundBegin: () => "stop"
      }),
      THROW_UP_PARALLEL
    );
    expect(beginStop).toEqual({ rounds: 1, stopReason: "round-begin-stop" });
  });
});
