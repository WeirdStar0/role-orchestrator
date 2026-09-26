import { describe, expect, it } from "vitest";
import { getNodeState } from "@role-orchestrator/dag";
import { countOutboxMessages, listPendingOutboxMessages, setAttemptPhase } from "@role-orchestrator/store";
import {
  GLOBAL_RESOURCE_KEY,
  InvalidQueueEntryStateError,
  UnknownQueueEntryError,
  UnknownRunError,
  cancelQueueEntry,
  countLiveQuotaGrants,
  enqueueReadyNodes,
  getQueueEntry,
  listQueueEntries,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants
} from "../src/index.js";
import {
  T0,
  createMigratedFileDb,
  expectError,
  iso,
  pollInput,
  seedProfile,
  seedProject,
  seedReadyRun
} from "./helpers.js";

/** Seed one project + profile + run with `n` independent READY developer nodes. */
async function seedSingle(db: Awaited<ReturnType<typeof createMigratedFileDb>>["db"], nodeCount: number): Promise<string> {
  await seedProfile(db, { profileId: "claude-main", runtime: "claude", credentialGroup: "personal", maxConcurrency: 2 });
  await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
  const nodeIds = Array.from({ length: nodeCount }, (_, index) => `n${String(index + 1)}`);
  await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds });
  return "run-1";
}

/**
 * Seed (project, profile, single-node run) triples and enqueue them. Distinct
 * profiles get distinct credential groups, so only the SHARED dimension
 * (global) couples them — the A07 cross-profile independence setup.
 */
async function seedFarms(
  db: Awaited<ReturnType<typeof createMigratedFileDb>>["db"],
  farms: readonly {
    readonly profileId: string;
    readonly runtime: "claude" | "codex";
    readonly group: string;
    readonly priority?: number;
    readonly enqueueAt?: string;
  }[]
): Promise<void> {
  let index = 0;
  for (const farm of farms) {
    index += 1;
    await seedProfile(db, {
      profileId: farm.profileId,
      runtime: farm.runtime,
      credentialGroup: farm.group,
      maxConcurrency: 8
    });
    const projectId = `proj-${String(index)}`;
    const runId = `run-${String(index)}`;
    await seedProject(db, { projectId, profileId: farm.profileId });
    await seedReadyRun(db, { projectId, runId, nodeIds: ["n1"] });
    enqueueReadyNodes(db, {
      runId,
      now: farm.enqueueAt ?? T0,
      priority: farm.priority ?? 100
    });
  }
}

describe("enqueueReadyNodes", () => {
  it("enqueues every READY node once; re-enqueue absorbs duplicates", async () => {
    const { db } = createMigratedFileDb("enqueue");
    const runId = await seedSingle(db, 3);
    const first = enqueueReadyNodes(db, { runId, now: T0 });
    expect(first.enqueued).toHaveLength(3);
    expect(first.alreadyQueued).toBe(0);
    expect(first.enqueued.every((entry) => entry.state === "WAITING")).toBe(true);
    expect(first.enqueued[0]?.profileId).toBe("claude-main");
    expect(first.enqueued[0]?.credentialGroup).toBe("personal");
    expect(first.enqueued[0]?.projectId).toBe("proj-1");

    const second = enqueueReadyNodes(db, { runId, now: iso(1_000) });
    expect(second.enqueued).toHaveLength(0);
    expect(second.alreadyQueued).toBe(3);
    expect(listQueueEntries(db)).toHaveLength(3);
  });

  it("fails for an unknown run and records the required capability on the rows", async () => {
    const { db } = createMigratedFileDb("enqueue-unknown");
    await seedProfile(db, { profileId: "claude-main" });
    await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
    expectError(() => enqueueReadyNodes(db, { runId: "run-x", now: T0 }), UnknownRunError);

    await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1"] });
    enqueueReadyNodes(db, { runId: "run-1", now: T0, requiredCapability: "codex.resume" });
    expect(getQueueEntry(db, listQueueEntries(db)[0]?.id ?? "")?.requiredCapability).toBe("codex.resume");
  });
});

describe("pollQueue — dispatch claim", () => {
  it("dispatches one entry atomically: grants + STARTING execution + RUNNING node + DISPATCHED row + outbox", async () => {
    const { db } = createMigratedFileDb("claim");
    const runId = await seedSingle(db, 1);
    enqueueReadyNodes(db, { runId, now: T0 });

    const result = pollQueue(db, pollInput(iso(1_000)));
    expect(result.dispatched).toHaveLength(1);
    expect(result.quotaRejected).toHaveLength(0);
    expect(result.gateBlocked).toHaveLength(0);

    const first = result.dispatched[0];
    if (!first) throw new Error("expected a dispatch");
    expect(first.fencing.map((fencing) => fencing.resourceKey).sort()).toEqual([
      "credential:personal",
      "global",
      "profile:claude-main",
      "project:proj-1"
    ]);
    expect(getNodeState(db, { runId, nodeId: first.nodeId })?.state).toBe("RUNNING");
    expect(getQueueEntry(db, first.entryId)?.state).toBe("DISPATCHED");
    const outboxPending = listPendingOutboxMessages(db);
    expect(outboxPending).toHaveLength(1);
    expect(outboxPending[0]?.type).toBe("scheduler.dispatch");
    expect(JSON.parse(outboxPending[0]?.payload ?? "{}")).toMatchObject({
      queueEntryId: first.entryId,
      executionId: first.executionId,
      dispatchToken: first.dispatchToken
    });
    expect(countLiveQuotaGrants(db, { resourceKey: GLOBAL_RESOURCE_KEY, now: iso(1_000) }).total).toBe(1);
  });

  it("keeps quota-rejected entries WAITING with a retry window and their nodes READY — nothing lost", async () => {
    const { db } = createMigratedFileDb("retry-window");
    const runId = "run-1";
    await seedProfile(db, { profileId: "claude-main", credentialGroup: "personal", maxConcurrency: 1 });
    await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
    await seedReadyRun(db, { projectId: "proj-1", runId, nodeIds: ["n1", "n2", "n3", "n4"] });
    enqueueReadyNodes(db, { runId, now: T0 });

    // profileMax 1 binds BEFORE the credential dimension (slot order), so the
    // rejections are pure profile-level rejections.
    const result = pollQueue(db, pollInput(iso(1_000), { limit: 8 }));
    expect(result.dispatched).toHaveLength(1);
    expect(result.quotaRejected).toHaveLength(3);
    const rejected = result.quotaRejected[0];
    if (!rejected) throw new Error("expected a rejection");
    expect(rejected.blockedBy.dimension).toBe("profile");
    expect(rejected.blockedBy.resourceKey).toBe("profile:claude-main");
    expect(rejected.attempts).toBe(1);
    expect(rejected.retryNotBefore).toBe(iso(61_000));
    // Node stays READY; queue entry stays WAITING with the recorded reason.
    expect(getNodeState(db, { runId, nodeId: rejected.nodeId })?.state).toBe("READY");
    const entry = getQueueEntry(db, rejected.entryId);
    expect(entry?.state).toBe("WAITING");
    expect(entry?.notBefore).toBe(iso(61_000));
    expect(entry?.lastReason ?? "").toContain("quota-full:profile:claude-main");

    // Before the retry window opens, nothing new dispatches.
    const tooEarly = pollQueue(db, pollInput(iso(2_000)));
    expect(tooEarly.dispatched).toHaveLength(0);

    // Release the slot; after the window opens the queue recovers one entry,
    // and the other two keep waiting on their second attempt.
    const dispatchedFirst = result.dispatched[0];
    if (!dispatchedFirst) throw new Error("expected a dispatch");
    releaseExecutionQuotaGrants(db, { executionId: dispatchedFirst.executionId, now: iso(62_000) });
    const recovered = pollQueue(db, pollInput(iso(62_000)));
    expect(recovered.dispatched).toHaveLength(1);
    const rejectedNodeIds = result.quotaRejected.map((outcome) => outcome.nodeId);
    expect(rejectedNodeIds).toContain(recovered.dispatched[0]?.nodeId);
    expect(getNodeState(db, { runId, nodeId: recovered.dispatched[0]?.nodeId ?? "" })?.state).toBe("RUNNING");
    expect(recovered.quotaRejected).toHaveLength(2);
    for (const stillWaiting of recovered.quotaRejected) {
      expect(stillWaiting.attempts).toBe(2);
      expect(rejectedNodeIds).toContain(stillWaiting.nodeId);
    }
  });

  it("single Profile saturated does NOT block other Profiles (A07/A33 scheduling semantics)", async () => {
    const { db } = createMigratedFileDb("cross-profile");
    // proj-1: profile at maxConcurrency 1; proj-2: a codex profile, different
    // credential group. One READY node each, enqueued together.
    await seedProfile(db, { profileId: "claude-main", runtime: "claude", credentialGroup: "personal", maxConcurrency: 1 });
    await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
    await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1", "n2"] });
    enqueueReadyNodes(db, { runId: "run-1", now: T0 });
    await seedProfile(db, { profileId: "codex-alt", runtime: "codex", credentialGroup: "team", maxConcurrency: 2 });
    await seedProject(db, { projectId: "proj-2", profileId: "codex-alt" });
    await seedReadyRun(db, { projectId: "proj-2", runId: "run-2", nodeIds: ["n1"] });
    enqueueReadyNodes(db, { runId: "run-2", now: T0 });

    const result = pollQueue(db, pollInput(iso(1_000), { limit: 8 }));
    // proj-1 dispatches ONE (its profile is then full at maxConcurrency 1);
    // proj-2 still runs — one saturated profile never blocks another.
    expect(result.dispatched).toHaveLength(2);
    expect(new Set(result.dispatched.map((outcome) => outcome.runId))).toEqual(new Set(["run-1", "run-2"]));
    expect(result.quotaRejected).toHaveLength(1);
    expect(result.quotaRejected[0]?.runId).toBe("run-1");
  });

  it("completes the lifecycle: DISPATCHED -> COMPLETED and grants released", async () => {
    const { db } = createMigratedFileDb("complete");
    const runId = await seedSingle(db, 1);
    enqueueReadyNodes(db, { runId, now: T0 });
    const result = pollQueue(db, pollInput(iso(1_000)));
    const dispatched = result.dispatched[0];
    if (!dispatched) throw new Error("expected a dispatch");
    expect(releaseExecutionQuotaGrants(db, { executionId: dispatched.executionId, now: iso(2_000) })).toBe(4);
    const entry = markQueueEntryCompleted(db, { entryId: dispatched.entryId, now: iso(2_000) });
    expect(entry.state).toBe("COMPLETED");
    expect(countLiveQuotaGrants(db, { resourceKey: GLOBAL_RESOURCE_KEY, now: iso(2_000) }).total).toBe(0);
    expectError(
      () => markQueueEntryCompleted(db, { entryId: dispatched.entryId, now: iso(3_000) }),
      InvalidQueueEntryStateError
    );
    expectError(() => cancelQueueEntry(db, { entryId: dispatched.entryId, now: iso(3_000) }), InvalidQueueEntryStateError);
    expectError(() => markQueueEntryCompleted(db, { entryId: "q-does-not-exist", now: iso(3_000) }), UnknownQueueEntryError);
  });

  it("blocks dispatch on unknown required capabilities (gate wiring) and records the reason", async () => {
    const { db } = createMigratedFileDb("gate");
    const runId = await seedSingle(db, 2);
    enqueueReadyNodes(db, { runId, now: T0, requiredCapability: "totally-unknown.capability" });
    const result = pollQueue(db, pollInput(iso(1_000)));
    expect(result.dispatched).toHaveLength(0);
    expect(result.gateBlocked).toHaveLength(2);
    expect(result.gateBlocked[0]?.capability).toBe("totally-unknown.capability");
    expect(result.gateBlocked[0]?.status).toBe("unverified");
    const entry = getQueueEntry(db, result.gateBlocked[0]?.entryId ?? "");
    expect(entry?.state).toBe("GATE_BLOCKED");
    expect(entry?.lastReason ?? "").toContain("unknown to the capability matrix");
    // Node untouched: gate rejection is a scheduling refusal, not a node failure.
    expect(getNodeState(db, { runId, nodeId: result.gateBlocked[0]?.nodeId ?? "" })?.state).toBe("READY");
    // No grants, no executions, no outbox for blocked entries.
    expect(countLiveQuotaGrants(db, { resourceKey: GLOBAL_RESOURCE_KEY, now: iso(1_000) }).total).toBe(0);
    expect(countOutboxMessages(db, { pendingOnly: true })).toBe(0);
  });

  it("aborts the whole poll when the concurrency policy fails strict validation", async () => {
    const { db } = createMigratedFileDb("bad-policy");
    const runId = await seedSingle(db, 1);
    enqueueReadyNodes(db, { runId, now: T0 });
    expectError(
      () => pollQueue(db, pollInput(iso(1_000), { concurrency: { globalMax: 4, projectMax: 3, extra: 1 } })),
      Error
    );
    expect(listQueueEntries(db, { state: "WAITING" })).toHaveLength(1);
    expect(countLiveQuotaGrants(db, { resourceKey: GLOBAL_RESOURCE_KEY, now: iso(1_000) }).total).toBe(0);
  });
});

describe("pollQueue — fairness", () => {
  it("equal priorities poll in enqueue (wait-time) order", async () => {
    const { db } = createMigratedFileDb("enqueue-order");
    await seedFarms(db, [
      { profileId: "claude-main", runtime: "claude", group: "group-a", enqueueAt: T0 },
      { profileId: "claude-second", runtime: "claude", group: "group-b", enqueueAt: iso(1_000) },
      { profileId: "codex-alt", runtime: "codex", group: "group-c", enqueueAt: iso(2_000) }
    ]);
    const result = pollQueue(db, pollInput(iso(3_000), { limit: 3 }));
    expect(result.dispatched.map((outcome) => outcome.runId)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("priority orders candidates; equal priorities keep enqueue order", async () => {
    const { db } = createMigratedFileDb("priority-explicit");
    await seedProfile(db, { profileId: "claude-main", credentialGroup: "personal", maxConcurrency: 8 });
    await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
    // Three runs in ONE project — but the credential lock serializes them, so
    // verify ORDER via three sequential poll/release rounds instead.
    await seedReadyRun(db, { projectId: "proj-1", runId: "run-low-prio", nodeIds: ["n1"] });
    await seedReadyRun(db, { projectId: "proj-1", runId: "run-high-prio", nodeIds: ["n1"] });
    enqueueReadyNodes(db, { runId: "run-low-prio", now: T0, priority: 50 });
    enqueueReadyNodes(db, { runId: "run-high-prio", now: iso(1_000), priority: 0 });

    // Poll ONE slot: the priority-0 run wins even though it was enqueued later.
    const first = pollQueue(db, pollInput(iso(2_000), { starvationMs: 3_600_000, limit: 1 }));
    expect(first.dispatched.map((outcome) => outcome.runId)).toEqual(["run-high-prio"]);
    releaseExecutionQuotaGrants(db, { executionId: first.dispatched[0]?.executionId ?? "", now: iso(2_500) });
    markQueueEntryCompleted(db, { entryId: first.dispatched[0]?.entryId ?? "", now: iso(2_500) });

    const second = pollQueue(db, pollInput(iso(3_000), { starvationMs: 3_600_000, limit: 1 }));
    expect(second.dispatched.map((outcome) => outcome.runId)).toEqual(["run-low-prio"]);
  });

  it("promotes entries past the starvation bound ahead of newer higher priorities (anti-starvation)", async () => {
    const { db } = createMigratedFileDb("starvation");
    await seedProfile(db, { profileId: "claude-main", credentialGroup: "personal", maxConcurrency: 8 });
    await seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
    await seedProfile(db, { profileId: "codex-alt", runtime: "codex", credentialGroup: "team", maxConcurrency: 8 });
    await seedProject(db, { projectId: "proj-2", profileId: "codex-alt" });
    // run-low: priority 900, enqueued at T0 (project 1).
    await seedReadyRun(db, { projectId: "proj-1", runId: "run-low", nodeIds: ["n1"] });
    enqueueReadyNodes(db, { runId: "run-low", now: T0, priority: 900 });
    // run-high: priority 0, enqueued at T0+1s (project 2, own credential group).
    await seedReadyRun(db, { projectId: "proj-2", runId: "run-high", nodeIds: ["n1"] });
    enqueueReadyNodes(db, { runId: "run-high", now: iso(1_000), priority: 0 });

    // At T0+30s neither entry is aged (starvationMs 60s) -> priority wins.
    const before = pollQueue(db, pollInput(iso(30_000), { starvationMs: 60_000, limit: 1 }));
    expect(before.dispatched.map((outcome) => outcome.runId)).toEqual(["run-high"]);
    releaseExecutionQuotaGrants(db, { executionId: before.dispatched[0]?.executionId ?? "", now: iso(30_500) });
    markQueueEntryCompleted(db, { entryId: before.dispatched[0]?.entryId ?? "", now: iso(30_500) });

    // A fresh priority-0 entry arrives late (T0+100s), still unaged.
    await seedReadyRun(db, { projectId: "proj-2", runId: "run-high-2", nodeIds: ["n1"] });
    enqueueReadyNodes(db, { runId: "run-high-2", now: iso(100_000), priority: 0 });

    // At T0+120s run-low has waited past the bound and jumps the queue.
    const after = pollQueue(db, pollInput(iso(120_000), { starvationMs: 60_000, limit: 1 }));
    expect(after.dispatched.map((outcome) => outcome.runId)).toEqual(["run-low"]);
  });
});

describe("pollQueue — dispatch token uniqueness across attempts (M2-04)", () => {
  it("derives the dispatch token from the attempt, so a retried node never reuses a token", async () => {
    const { db } = createMigratedFileDb("dispatch-token-attempt");
    const runId = await seedSingle(db, 1);
    enqueueReadyNodes(db, { runId, now: T0 });

    const firstPoll = pollQueue(db, pollInput(iso(1_000)));
    const first = firstPoll.dispatched[0];
    if (!first) throw new Error("expected the first dispatch");
    expect(first.executionId).toContain(first.dispatchToken.slice(-12)); // derived siblings

    // Finish attempt 1: terminal phase frees the slot, grants released.
    setAttemptPhase(db, { id: first.executionId, phase: "SUCCEEDED", wherePhaseIn: ["STARTING"], now: iso(2_000) });
    releaseExecutionQuotaGrants(db, { executionId: first.executionId, now: iso(2_000) });
    markQueueEntryCompleted(db, { entryId: first.entryId, now: iso(2_000) });

    // Simulate the retry path: the node becomes READY again and the SAME
    // queue row is re-armed to WAITING (raw SQL — test setup only).
    db.prepare("UPDATE task_nodes SET state = 'READY' WHERE run_id = ? AND node_id = ?")
      .run(runId, first.nodeId);
    db.prepare("UPDATE scheduler_queue SET state = 'WAITING', execution_id = NULL WHERE id = ?")
      .run(first.entryId);

    const secondPoll = pollQueue(db, pollInput(iso(3_000)));
    const second = secondPoll.dispatched[0];
    if (!second) throw new Error("expected the retried dispatch");
    expect(second.entryId).toBe(first.entryId); // same node, same queue entry
    expect(second.executionId).not.toBe(first.executionId); // new attempt row
    expect(second.dispatchToken).not.toBe(first.dispatchToken); // the fix: token is attempt-scoped

    // Constraint-level: dispatch_token is UNIQUE across executions.
    const tokens = db
      .prepare("SELECT dispatch_token FROM executions WHERE run_id = ? AND node_id = ? ORDER BY attempt")
      .all(runId, first.nodeId)
      .map((row) => String((row as Record<string, unknown>).dispatch_token));
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
  });
});
