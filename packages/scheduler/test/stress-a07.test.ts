import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { getNodeState } from "@role-orchestrator/dag";
import {
  GLOBAL_RESOURCE_KEY,
  countLiveQuotaGrants,
  credentialResourceKey,
  enqueueReadyNodes,
  listQueueEntries,
  listQuotaGrants,
  markQueueEntryCompleted,
  pollQueue,
  profileResourceKey,
  projectResourceKey,
  releaseExecutionQuotaGrants,
  type QuotaGrantRow
} from "../src/index.js";
import {
  T0,
  createMigratedFileDb,
  iso,
  pollInput,
  seedProfile,
  seedProject,
  seedReadyRun,
  seedExecution
} from "./helpers.js";

/**
 * A07 "并行图资源竞争": assert from the GRANT RECORDS that no level ever
 * exceeded its quota, that a saturated profile does not block others, that
 * real worker_threads contention never duplicates a fencing grant, and that
 * a released quota lets the queue recover.
 */

/** Max simultaneous live grants per key, computed by sweep line over grant rows. */
function maxOverlapByKey(grants: readonly QuotaGrantRow[]): Map<string, number> {
  const byKey = new Map<string, number>();
  const grouped = new Map<string, { start: string; end: string }[]>();
  for (const grant of grants) {
    if (grant.releasedAt === null) continue; // churn tests release everything
    const list = grouped.get(grant.resourceKey) ?? [];
    list.push({ start: grant.grantedAt, end: grant.releasedAt });
    grouped.set(grant.resourceKey, list);
  }
  for (const [key, intervals] of grouped) {
    const events: [string, number][] = intervals.flatMap((interval) => [
      [interval.start, 1],
      [interval.end, -1]
    ]);
    // At equal timestamps, releases (-1) are processed before starts (+1).
    events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    let current = 0;
    let max = 0;
    for (const event of events) {
      current += event[1];
      max = Math.max(max, current);
    }
    byKey.set(key, max);
  }
  return byKey;
}

/** Fencing tokens per key must be exactly 1..n (monotonic MAX+1, no gaps, no reuse). */
function tokensByKey(grants: readonly QuotaGrantRow[]): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  for (const grant of grants) {
    const list = byKey.get(grant.resourceKey) ?? [];
    list.push(grant.fencingToken);
    byKey.set(grant.resourceKey, list);
  }
  for (const list of byKey.values()) list.sort((a, b) => a - b);
  return byKey;
}

function expectContiguousTokens(byKey: Map<string, number[]>): void {
  for (const [key, tokens] of byKey) {
    expect(
      tokens.every((token, index) => token === index + 1),
      `fencing tokens for ${key} must be exactly 1..n without gaps or duplicates (got ${JSON.stringify(tokens)})`
    ).toBe(true);
  }
}

describe("A07 stress — multi-project multi-profile quota churn", () => {
  it("never exceeds any level's quota and recovers the queue after releases", async () => {
    const { db } = createMigratedFileDb("churn");
    // 3 projects x (profile maxConcurrency 2, distinct credential groups), each
    // one run with 4 independent READY nodes: 12 competing entries.
    const farms = [
      { profileId: "claude-a", runtime: "claude" as const, group: "group-a" },
      { profileId: "codex-b", runtime: "codex" as const, group: "group-b" },
      { profileId: "claude-c", runtime: "claude" as const, group: "group-c" }
    ];
    let farmIndex = 0;
    for (const farm of farms) {
      farmIndex += 1;
      await seedProfile(db, {
        profileId: farm.profileId,
        runtime: farm.runtime,
        credentialGroup: farm.group,
        maxConcurrency: 2
      });
      const projectId = `proj-${String(farmIndex)}`;
      const runId = `run-${String(farmIndex)}`;
      await seedProject(db, { projectId, profileId: farm.profileId });
      await seedReadyRun(db, {
        projectId,
        runId,
        nodeIds: ["n1", "n2", "n3", "n4"]
      });
      enqueueReadyNodes(db, { runId, now: T0 });
    }

    const maxima = new Map<string, number>([
      [GLOBAL_RESOURCE_KEY, 4],
      ...farms.flatMap((farm, index) => [
        [projectResourceKey(`proj-${String(index + 1)}`), 3] as const,
        [profileResourceKey(farm.profileId), 2] as const,
        [credentialResourceKey(farm.group), 1] as const
      ])
    ]);

    let clock = 1_000;
    let completedEntries = 0;
    const totalEntries = 12;
    let rounds = 0;
    let sampledMaxGlobal = 0;
    const dispatchedNodeIds = new Set<string>();

    while (completedEntries < totalEntries && rounds < 64) {
      rounds += 1;
      clock += 1_000;
      const now = iso(clock);
      // retryWindowMs 0: the synthetic clock is per-round, so rejected
      // entries must stay poll-eligible on every round.
      const result = pollQueue(db, pollInput(now, { limit: 8, retryWindowMs: 0 }));

      // Live invariants from the grant records after every poll.
      for (const [key, max] of maxima) {
        const live = countLiveQuotaGrants(db, { resourceKey: key, now });
        expect(
          live.total <= max,
          `${key} live grants ${String(live.total)} exceeded quota ${String(max)}`
        ).toBe(true);
        sampledMaxGlobal = Math.max(
          sampledMaxGlobal,
          key === GLOBAL_RESOURCE_KEY ? live.total : 0
        );
      }

      for (const outcome of result.dispatched) {
        const slotKey = `${outcome.runId}/${outcome.nodeId}`;
        expect(dispatchedNodeIds.has(slotKey), `node ${slotKey} dispatched twice`).toBe(false);
        dispatchedNodeIds.add(slotKey);
        expect(outcome.fencing).toHaveLength(4); // global + project + profile + credential
        expect(getNodeState(db, { runId: outcome.runId, nodeId: outcome.nodeId })?.state).toBe("RUNNING");
      }

      // Simulate process completion for half of the running dispatches so
      // slots free up across rounds while others keep running.
      let toRelease = Math.max(1, Math.floor(result.dispatched.length / 2));
      for (const outcome of result.dispatched) {
        if (toRelease <= 0) break;
        toRelease -= 1;
        clock += 250;
        expect(releaseExecutionQuotaGrants(db, { executionId: outcome.executionId, now: iso(clock) })).toBe(4);
        markQueueEntryCompleted(db, { entryId: outcome.entryId, now: iso(clock) });
        completedEntries += 1;
      }
      // Older still-DISPATCHED entries from previous rounds finish this round.
      for (const entry of listQueueEntries(db, { state: "DISPATCHED" })) {
        if (completedEntries >= totalEntries) break;
        if (result.dispatched.some((outcome) => outcome.entryId === entry.id)) continue;
        clock += 250;
        expect(releaseExecutionQuotaGrants(db, { executionId: entry.executionId ?? "", now: iso(clock) })).toBe(4);
        markQueueEntryCompleted(db, { entryId: entry.id, now: iso(clock) });
        completedEntries += 1;
      }
    }

    expect(completedEntries).toBe(totalEntries);
    expect(rounds).toBeGreaterThan(1); // the queue genuinely churned through quota windows
    expect(sampledMaxGlobal).toBeGreaterThan(0); // the global budget was actually used

    // From the records alone: at no point did any level exceed its quota.
    const allGrants = listQuotaGrants(db);
    const overlaps = maxOverlapByKey(allGrants);
    for (const [key, max] of maxima) {
      const observed = overlaps.get(key);
      expect(observed, `expected grant activity on ${key}`).toBeDefined();
      expect(observed! <= max, `${key} peak overlap ${String(observed)} exceeded quota ${String(max)}`).toBe(true);
    }
    // Fencing: tokens per key are exactly 1..n — monotonic, gapless, never reused.
    expectContiguousTokens(tokensByKey(allGrants));
    // Every node dispatched exactly once (12 distinct nodes, one attempt each).
    expect(dispatchedNodeIds.size).toBe(totalEntries);
  });
});

describe("A07 stress — worker_threads fencing storm", () => {
  it("24 threads contending on one file DB never duplicate a fencing grant", async () => {
    const { db, dbPath } = createMigratedFileDb("workers");
    const WORKERS = 24;
    // M4-04: the global budget is deliberately 1 (below the worker count),
    // so the shared slot is contended by construction, not by luck.
    const GLOBAL_MAX = 1;

    // One distinct (project, run, execution) slot per worker.
    const executions: string[] = [];
    for (let index = 0; index < WORKERS; index += 1) {
      const seeded = seedExecution(db, {
        projectId: `proj-w${String(index)}`,
        runId: `run-w${String(index)}`,
        executionId: `exec-w${String(index)}`,
        nodeId: "n1"
      });
      executions.push(seeded.executionId);
    }

    // Deterministic contention barrier (see fixtures/quota-worker.mjs): all
    // threads connect first, then race; a phase-1 grant is HELD until every
    // worker's first attempt has been reported, so the N-1 remaining
    // first attempts cannot avoid the quota-full window. The old free-race
    // version was timing-dependent: on a fully loaded machine thread startup
    // could stagger until no worker ever hit a quota-full window, failing
    // the "contention really happened" assertion below. Every wait here is
    // a promise resolved by worker messages and rejected by worker
    // errors/exits, so ANY worker failure fails the test loudly instead of
    // hanging a poll loop.
    const sab = new SharedArrayBuffer(8);
    const flags = new Int32Array(sab);

    const workerUrl = new URL("./fixtures/quota-worker.mjs", import.meta.url);
    type FirstReport = { executionId: string; granted: boolean };
    type DoneReport = { granted: number; quotaFull: number; errors: string[] };
    type WorkerMessage =
      | { type: "ready"; executionId: string }
      | { type: "first"; executionId: string; granted: boolean }
      | { type: "done"; executionId: string; granted: number; quotaFull: number; errors: string[] };

    interface WorkerHandle {
      readonly first: Promise<FirstReport>;
      readonly done: Promise<DoneReport>;
      readonly exited: Promise<void>;
    }

    const readyIds = new Set<string>();
    let releaseReadyGate!: () => void;
    const allReady = new Promise<void>((resolve) => {
      releaseReadyGate = resolve;
    });
    let anyFailureReject!: (error: Error) => void;
    const anyFailure = new Promise<never>((_, reject) => {
      anyFailureReject = reject;
    });

    const threads: WorkerHandle[] = executions.map((executionId, index) => {
      const slots = [
        { dimension: "global", resourceKey: GLOBAL_RESOURCE_KEY, max: GLOBAL_MAX },
        {
          dimension: "credential",
          resourceKey: credentialResourceKey(index % 2 === 0 ? "group-even" : "group-odd"),
          max: 2
        }
      ];
      const worker = new Worker(workerUrl, {
        workerData: { dbPath, executionId, slots, leaseMs: 60_000, holdMsMin: 15, holdMsMax: 45, sab }
      });

      let firstResolve!: (report: FirstReport) => void;
      let firstReject!: (error: Error) => void;
      let doneResolve!: (report: DoneReport) => void;
      let doneReject!: (error: Error) => void;
      let firstSettled = false;
      let doneSettled = false;
      let readySeen = false;
      const first = new Promise<FirstReport>((resolve, reject) => {
        firstResolve = resolve;
        firstReject = reject;
      });
      const done = new Promise<DoneReport>((resolve, reject) => {
        doneResolve = resolve;
        doneReject = reject;
      });
      const exited = new Promise<void>((resolve, reject) => {
        worker.once("error", (error: Error) => {
          firstReject?.(error);
          if (!doneSettled) {
            doneReject?.(error);
            anyFailureReject(error);
          }
          reject(error);
        });
        worker.once("exit", (code) => {
          if (code === 0) {
            resolve();
            if (!doneSettled) {
              const error = new Error(`worker "${executionId}" exited without reporting completion`);
              doneReject?.(error);
              anyFailureReject(error);
            }
            if (!readySeen) {
              const error = new Error(`worker "${executionId}" exited before reporting ready`);
              firstReject?.(error);
              anyFailureReject(error);
            }
          } else {
            const error = new Error(`worker "${executionId}" exited with code ${String(code)}`);
            firstReject?.(error);
            if (!doneSettled) {
              doneReject?.(error);
              anyFailureReject(error);
            }
            reject(error);
          }
        });
      });
      worker.on("message", (message: WorkerMessage) => {
        if (message.type === "ready") {
          readySeen = true;
          readyIds.add(message.executionId);
          if (readyIds.size === WORKERS) releaseReadyGate();
        } else if (message.type === "first") {
          firstSettled = true;
          firstResolve({ executionId: message.executionId, granted: message.granted });
        } else {
          if (!firstSettled) {
            firstReject(
              new Error(
                `worker "${executionId}" finished without a first-attempt report: ${message.errors.join("; ") || "no error recorded"}`
              )
            );
          }
          doneSettled = true;
          if (!readySeen) {
            anyFailureReject(new Error(`worker "${executionId}" reported done before ready`));
          }
          doneResolve({
            granted: message.granted,
            quotaFull: message.quotaFull,
            errors: message.errors
          });
        }
      });
      return { first, done, exited };
    });

    // Ready barrier: every worker must connect BEFORE the race starts. A
    // worker that dies before becoming ready rejects the wait — the
    // protocol has no silent hang.
    await Promise.race([allReady, anyFailure]);

    // Release the start barrier: all 24 workers race from this instant.
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0, WORKERS);

    // Real-time sampling while the storm runs: the global level must never
    // visibly exceed its budget.
    let sampledMaxGlobal = 0;
    const sampler = setInterval(() => {
      try {
        const live = countLiveQuotaGrants(db, {
          resourceKey: GLOBAL_RESOURCE_KEY,
          now: new Date().toISOString()
        });
        sampledMaxGlobal = Math.max(sampledMaxGlobal, live.total);
      } catch {
        // the parent connection may briefly contend; the post-hoc
        // checks below are authoritative
      }
    }, 5);

    // Phase 1 completes when every worker reported its single first attempt.
    const firstReports = await Promise.all(threads.map(({ first }) => first));

    // Deterministic contention proof, BY CONSTRUCTION: at most one worker
    // could hold the single global slot while every other worker made its
    // first (refused) attempt.
    const grantedFirst = firstReports.filter((report) => report.granted);
    expect(grantedFirst.length).toBeLessThanOrEqual(GLOBAL_MAX);
    expect(firstReports.length - grantedFirst.length).toBeGreaterThanOrEqual(WORKERS - GLOBAL_MAX);

    // Only now may the phase-1 grant holder release its slot.
    Atomics.store(flags, 1, 1);
    Atomics.notify(flags, 1, WORKERS);

    // Phase 2: the losers retry through real quota-full rejections until
    // each acquired exactly once.
    const settled = await Promise.all(threads.map(({ done }) => done));
    clearInterval(sampler);
    await Promise.all(threads.map(({ exited }) => exited));

    const totalQuotaFull = settled.reduce((sum, report) => sum + report.quotaFull, 0);
    for (const report of settled) {
      expect(report.errors).toEqual([]);
      expect(report.granted).toBe(1);
    }
    expect(totalQuotaFull).toBeGreaterThanOrEqual(WORKERS - GLOBAL_MAX);
    expect(sampledMaxGlobal).toBeLessThanOrEqual(GLOBAL_MAX);
    expect(settled.some((report) => report.quotaFull > 0)).toBe(true); // contention really happened — deterministically

    // Post-hoc, from the grant records alone. Fencing proof: per key the
    // tokens are exactly 1..n — the MAX+1 derivation ran inside serialized
    // BEGIN IMMEDIATE transactions, so a second thread can never have
    // duplicated a grant (the UNIQUE(resource_key, fencing_token) index
    // would have errored the acquire into report.errors).
    const allGrants = listQuotaGrants(db);
    expect(allGrants).toHaveLength(WORKERS * 2); // global + credential per worker
    const tokens = tokensByKey(allGrants);
    expectContiguousTokens(tokens);
    expect(tokens.get(GLOBAL_RESOURCE_KEY)).toHaveLength(WORKERS);
    expect(tokens.get(credentialResourceKey("group-even"))).toHaveLength(WORKERS / 2);
    expect(tokens.get(credentialResourceKey("group-odd"))).toHaveLength(WORKERS / 2);
    // Every grant was an all-or-nothing acquisition: exactly the two
    // requested dimensions per execution, each execution exactly once.
    for (const executionId of executions) {
      const own = allGrants.filter((grant) => grant.executionId === executionId);
      expect(own.map((grant) => grant.dimension).sort()).toEqual(["credential", "global"]);
    }
    // Everything released: no leaked slots.
    expect(listQuotaGrants(db, { liveOnly: true })).toHaveLength(0);
    // NOTE: a sweep-line over [granted_at, released_at] is deliberately NOT
    // used here — with 24 contending writers, granted_at is the caller's
    // pre-transaction clock reading and an acquire can queue on the write
    // lock past it, so client-side intervals overlap without any quota
    // violation. The in-process churn test above owns the interval-level
    // assertion under a single controlled clock; here the serialization proof
    // is the token sequence plus the live sampling above.
  }, 120_000);

  it("sweeps expired grants through the reconcile step and recovers the queue", async () => {
    const { db } = createMigratedFileDb("expiry-recovery");
    await seedProfile(db, { profileId: "claude-main", credentialGroup: "personal", maxConcurrency: 2 });
    await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
    await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1", "n2"] });
    enqueueReadyNodes(db, { runId: "run-1", now: T0 });

    // Dispatch ONE entry with a tiny lease; its holder then "crashes" (never
    // releases). The other entry is rejected (credential lock) with
    // retryWindowMs 0 so it stays poll-eligible.
    const first = pollQueue(db, pollInput(T0, { leaseMs: 5_000, retryWindowMs: 0 }));
    expect(first.dispatched).toHaveLength(1);
    expect(first.releasedExpiredGrants).toBe(0);
    const firstNode = first.dispatched[0]?.nodeId;
    const otherNode = firstNode === "n1" ? "n2" : "n1";

    // Before the grants expire, the other entry cannot run: the crashed
    // holder still owns the credential slot ("超时只代表需 reconcile" — no
    // auto-steal).
    const early = pollQueue(db, pollInput(iso(3_000), { leaseMs: 5_000, retryWindowMs: 0 }));
    expect(early.dispatched).toHaveLength(0);
    expect(early.releasedExpiredGrants).toBe(0);

    // At iso(6_000) the poll's leading reconcile step frees the four expired
    // grants and the queue immediately recovers with the other entry.
    const recovered = pollQueue(db, pollInput(iso(6_000), { leaseMs: 5_000, retryWindowMs: 0 }));
    expect(recovered.releasedExpiredGrants).toBe(4);
    expect(recovered.dispatched).toHaveLength(1);
    const second = recovered.dispatched[0];
    if (!second) throw new Error("expected the queue to recover after expiry reconcile");
    expect(second.nodeId).toBe(otherNode);
    expect(getNodeState(db, { runId: "run-1", nodeId: second.nodeId })?.state).toBe("RUNNING");
  });
});
