/**
 * M10-02 step 2 — the shared round-loop primitive (runPumpRounds) and the
 * convergence predicates. The db-touching settlement sequence is exercised
 * by the three consuming drivers' full-chain suites (e2e-baseline / dogfood
 * / browser-e2e) and the production HTTP contract suite; THIS suite pins the
 * parameterized semantics the strategy names: dispatchJoin serial|parallel,
 * errorIsolation throw-up|catch-per-run, convergence all-succeeded|
 * all-terminal (with their VERBATIM difference — the emptiness guard).
 * Since V031-01 the suite also pins the parallel+catch-per-run combination
 * itself (previously only the serial form existed): the per-dispatch fault
 * record (onDispatchFault) that closes the Promise.all second-fault swallow,
 * and the timeout-propagation status-quo anchor for in-flight siblings.
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

  it("dispatchJoin parallel + catch-per-run: a thrown fault ends THIS run's drive via onIsolatedError while the in-flight sibling still settles; EVERY per-dispatch fault has a record (the join-swallowed second fault included)", async () => {
    // V031-01 专格 (the M10-04 review R4 gap, PROPOSALS 测试缺口登记 (1)):
    // under the PARALLEL join, Promise.all rejects with the FIRST fault and
    // the catch-per-run boundary (onIsolatedError) sees exactly that one —
    // before onDispatchFault existed, a SECOND fault of the same round left
    // NO record anywhere (the already-rejected join silently swallowed it).
    // This grid pins the closed swallow AND the unchanged isolation: both
    // per-dispatch faults are recorded, the run boundary still reports only
    // the join's first fault, the non-faulting in-flight sibling settles on
    // its own, and the pump RETURNS normally (the caller's drive chain
    // carries on with the next run; the run-level brother-isolation and
    // serve-survival itself is pinned end-to-end by the local-api 格⑥).
    //
    // 判别力 (how this grid goes red on an implementation error):
    //  - drop the per-promise record (bare Promise.all join again):
    //    onDispatchFault never fires -> `faults` stays empty -> red;
    //  - break catch-per-run (the fault escapes the pump):
    //    runPumpRounds rejects -> red;
    //  - stop the fault from ending the drive (e.g. an allSettled join):
    //    the pump keeps polling (round 2 would claim "d") and the stop
    //    reason is round-bound, not isolated-error -> red.
    //  - SIBLING ARM, wording corrected (V031-02 review family C): this grid
    //    RECORDS the current detached-continuation shape (Promise.all
    //    semantics: the pump never cancels dispatched promises). It is NOT a
    //    red path: a future composition-layer cancellation (e.g. v0.4
    //    run-level cancellation aborting a round's siblings) would NOT turn
    //    this grid red — the grid stubs the dispatch layer itself, so the
    //    stub promises cannot be aborted and "c" still settles; that
    //    cancellation semantics must be pinned at the composition/e2e face
    //    (local-api 格⑥ family) when it lands.
    const state: DepsState = { rounds: [], settled: [], executions: 0 };
    const isolated: string[] = [];
    const faults: string[] = [];
    const inFlight: Promise<void>[] = [];
    const result = await runPumpRounds<FakeOutcome, never>({
      listNodeStates: () => ["PENDING"], // never converges: the fault must be what ends the drive
      propagate: () => undefined,
      enqueueReady: () => undefined,
      poll: () => {
        if (state.rounds.length === 0) {
          state.rounds.push(["a", "b", "c"]);
          return { dispatched: [{ id: "a" }, { id: "b" }, { id: "c" }] };
        }
        // A second poll would mean the drive did NOT stop at the fault.
        state.rounds.push(["d"]);
        return { dispatched: [{ id: "d" }] };
      },
      onDispatched: async (outcome) => {
        state.executions += 1;
        const done = (async () => {
          if (outcome.id === "a") {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("boom a"); // the join's FIRST rejection
          }
          if (outcome.id === "b") {
            // rejects AFTER "a": the very rejection the rejected join used
            // to swallow without a record
            await new Promise((resolve) => setTimeout(resolve, 15));
            throw new Error("boom b");
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
          state.settled.push(outcome.id); // "c": still in flight at pump return
        })();
        inFlight.push(done);
        await done;
      },
      onDispatchFault: (error, round) => faults.push(`${(error as Error).message}@${String(round)}`),
      onIsolatedError: (error) => isolated.push(String((error as Error).message))
    }, {
      convergence: "all-terminal",
      dispatchJoin: "parallel",
      errorIsolation: "catch-per-run"
    });
    // the pump RETURNED (no throw escaped): the drive chain carries on;
    // round 2 never polled, "d" never dispatched
    expect(result).toEqual({ rounds: 1, stopReason: "isolated-error" });
    expect(state.rounds).toEqual([["a", "b", "c"]]);
    // the run-boundary isolation is UNCHANGED: exactly the join's first fault
    expect(isolated).toEqual(["boom a"]);
    // Join every STARTED execution (the pump returns at the first fault;
    // in-flight siblings keep running detached — Promise.all semantics,
    // unchanged): no started execution is left unobserved, and each reached
    // its OWN settlement. The second fault's RECORD lands at its own
    // rejection instant — after the pump already returned — which is exactly
    // the V031-01 point: the record exists even though the join is long gone.
    await Promise.allSettled(inFlight);
    expect(faults).toEqual(["boom a@1", "boom b@1"]);
    expect(state.settled).toEqual(["c"]); // the sibling of two faults ran to its own settlement
    expect(state.executions).toBe(3);
  });

  it("dispatchJoin parallel + catch-per-run: an engine-timeout-shaped fault does NOT abort the already-dispatched sibling — it runs on to its own terminal state (STATUS-QUO ANCHOR, not a desired spec)", async () => {
    // V031-01 超时/取消传播钉死格. 现状锚非期望规范: this grid pins the
    // CURRENT propagation semantics — one dispatch's engine timeout (here:
    // a fault landing while the sibling is still mid-flight) ends THIS
    // run's drive, and the round's already-dispatched sibling is NOT
    // cancelled: it continues detached (the Promise.all join's semantics)
    // to its own terminal state, where its durable settlement evidence
    // lands. This is a descriptive anchor so a future change (e.g. v0.4
    // run-level cancellation aborting a round's siblings on a timeout)
    // cannot land silently — it must consciously rewrite this grid. It is
    // NOT a claim that leave-siblings-running is the desired behavior.
    //
    // 判别力 (how this grid goes red):
    //  - let the timeout fault keep the drive alive: the stop reason is
    //    not "isolated-error" -> red.
    //  - SIBLING-ABORT ARM, wording corrected (V031-02 review family C):
    //    this grid RECORDS the current detached-continuation shape — the
    //    timeout-faulted drive leaves "s" running detached to its own
    //    terminal state, which the grid observes via the allSettled wait.
    //    A future composition-layer sibling cancellation (e.g. v0.4
    //    run-level cancellation) would NOT turn this grid red: the stub
    //    "s" promise runs on its own timer and still lands "end:s", so the
    //    event-order assertion cannot see an abort the pump does not
    //    perform; that semantics must be pinned at the composition/e2e face
    //    when it lands. The former "add sibling-abort-on-timeout: 'end:s'
    //    never lands -> red" arm claimed a discriminating power this
    //    unit-level grid does not have.
    const events: string[] = [];
    const isolated: string[] = [];
    const inFlight: Promise<void>[] = [];
    const result = await runPumpRounds<FakeOutcome, never>({
      listNodeStates: () => ["PENDING"],
      propagate: () => undefined,
      enqueueReady: () => undefined,
      poll: () => {
        events.push("poll:[t,s]");
        return { dispatched: [{ id: "t" }, { id: "s" }] };
      },
      onDispatched: async (outcome) => {
        events.push(`start:${outcome.id}`);
        const done = (async () => {
          if (outcome.id === "t") {
            // the engine-timeout shape: the fault lands while "s" is
            // mid-flight (8ms into s's 25ms execution)
            await new Promise((resolve) => setTimeout(resolve, 8));
            throw new Error("timeout t");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          events.push("end:s");
        })();
        inFlight.push(done);
        await done;
      },
      onDispatchFault: (error, round) => events.push(`fault:${(error as Error).message}@${String(round)}`),
      onIsolatedError: (error) => isolated.push(String((error as Error).message))
    }, {
      convergence: "all-terminal",
      dispatchJoin: "parallel",
      errorIsolation: "catch-per-run"
    });
    expect(result).toEqual({ rounds: 1, stopReason: "isolated-error" });
    expect(isolated).toEqual(["timeout t"]);
    // the sibling was still in flight when the timeout fault ended the drive,
    // and its settlement landed strictly AFTER the fault (detached
    // continuation — the join's semantics, unchanged by V031-01)
    await Promise.allSettled(inFlight);
    expect(events).toEqual(["poll:[t,s]", "start:t", "start:s", "fault:timeout t@1", "end:s"]);
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
