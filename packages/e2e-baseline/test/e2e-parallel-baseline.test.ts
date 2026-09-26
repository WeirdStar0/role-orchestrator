/**
 * M2-06 end-to-end baseline: the full example workflow
 * plan -> (frontend || backend) -> integrate -> review -> followup ->
 * integrate-followup, driven through the REAL chain (dag -> scheduler ->
 * engine/fake-cli -> worktree -> integration -> review).
 *
 * Asserted here: every node reaches SUCCEEDED through a real subprocess
 * execution; the parallel sibling pair is claimed in the SAME dispatch round
 * and the unverified-credential lock (A33, contract literal 1) serializes the
 * actual process runs; the reviewed candidate content contains BOTH sibling
 * outputs; and the whole run is traceable from the store (nodes, executions,
 * ordered events with intact checksums, outbox, integration records, review
 * record).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getIntegrationRecord,
  listIntegrationRecords
} from "@role-orchestrator/integration";
import { listRunNodes } from "@role-orchestrator/dag";
import { listReviewRecords } from "@role-orchestrator/review";
import {
  listPendingOutboxMessages,
  listEventsForExecution,
  listExecutionsForRun,
  verifyEventChecksums
} from "@role-orchestrator/store";
import { listQueueEntries } from "@role-orchestrator/scheduler";
import {
  BACKEND_FILE_CONTENT,
  BACKEND_FILE_REL,
  FRONTEND_FILE_CONTENT,
  FRONTEND_FILE_REL,
  BACKEND_NODE,
  FRONTEND_NODE
} from "../src/index.js";
import { required, runFullBaseline, type BaselineHarness } from "./helpers.js";

/**
 * The driver executes through the engine launcher, which is implemented for
 * the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError). These end-to-end cells are therefore
 * win32-gated; on other platforms the decision/scan units they compose stay
 * covered by the per-package unit suites.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[e2e-baseline] non-Windows platform — launcher-driven e2e cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


let harness: BaselineHarness | undefined;

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  harness = await runFullBaseline("parallel");
});

afterAll(() => {
  if (!LAUNCHER_APPLIES) return;
  harness?.cleanup();
});

/** Non-null access once beforeAll has run (keeps strict TS honest). */
function h(): BaselineHarness {
  if (harness === undefined) throw new Error("baseline harness not initialised");
  return harness;
}

describe.skipIf(!LAUNCHER_APPLIES)("M2-06 端到端基准：全链路并行开发", () => {
  it("七个节点全部经真实链路走到 SUCCEEDED", () => {
    const nodes = listRunNodes(h().world.db, h().runId);
    // listRunNodes orders by (created_at, node_id); all rows share ONE
    // creation transaction timestamp, so compare the id SET.
    expect([...nodes.map((node) => node.nodeId)].sort()).toEqual(
      ["plan", "frontend", "backend", "integrate", "review", "followup", "integrate-followup"].sort()
    );
    expect(nodes).toHaveLength(7);
    expect(nodes.every((node) => node.state === "SUCCEEDED")).toBe(true);

    const executions = listExecutionsForRun(h().world.db, h().runId);
    expect(executions).toHaveLength(7);
    expect(executions.every((row) => row.phase === "SUCCEEDED")).toBe(true);
    expect(new Set(executions.map((row) => row.nodeId)).size).toBe(7);

    for (const entry of h().result.trace) {
      expect(entry.finalPhase).toBe("SUCCEEDED");
      expect(entry.reasons).toEqual([]);
    }

    const queue = listQueueEntries(h().world.db);
    expect(queue).toHaveLength(7);
    expect(queue.every((entry) => entry.state === "COMPLETED")).toBe(true);
  });

  it("并行兄弟在同一轮被认领，凭据锁（A33 契约字面量 1）把同组真实执行串行化", () => {
    const frontend = required(
      h().result.trace.find((entry) => entry.nodeId === FRONTEND_NODE.id),
      "frontend trace"
    );
    const backend = required(
      h().result.trace.find((entry) => entry.nodeId === BACKEND_NODE.id),
      "backend trace"
    );
    // Deterministic claim order: the sha-derived queue ids put frontend
    // first, so frontend is claimed in round 2; backend hits the credential
    // lock in the SAME round and is claimed in round 3 after the release.
    expect(frontend.round).toBe(2);
    expect(backend.round).toBe(3);

    // Same round: frontend claimed, backend quota-rejected BY THE CREDENTIAL
    // dimension (same profile -> same credential group; isolation unverified,
    // so the group cap is the contract literal 1).
    const rejections = h().result.quotaRejections;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.nodeId).toBe(BACKEND_NODE.id);
    expect(rejections[0]?.round).toBe(2);
    expect(rejections[0]?.blockedBy.dimension).toBe("credential");
    expect(rejections[0]?.blockedBy.resourceKey).toBe("credential:creds-codex");
    expect(rejections[0]?.lastReason).toBe("quota-full:credential:creds-codex");

    // The two real subprocess runs did NOT overlap: the lock held.
    const [first, second] = [frontend, backend].sort(
      (a, b) => a.wallStartMs - b.wallStartMs
    );
    expect(second).toBeDefined();
    expect(first).toBeDefined();
    expect(required(second, "later sibling").wallStartMs).toBeGreaterThanOrEqual(
      required(first, "earlier sibling").wallEndMs
    );
  });

  it("审查通过的候选内容同时包含两个并行分支的输出", async () => {
    const candidateSha = required(h().result.candidates["integrate"], "candidate C1");
    expect(candidateSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await h().fileAt(candidateSha, FRONTEND_FILE_REL)).toBe(FRONTEND_FILE_CONTENT);
    expect(await h().fileAt(candidateSha, BACKEND_FILE_REL)).toBe(BACKEND_FILE_CONTENT);

    const review = required(
      h().result.trace.find((entry) => entry.nodeId === "review"),
      "review trace"
    );
    const reviewDetail = required(review.review, "review detail");
    expect(reviewDetail.verdict).toBe("pass");
    expect(reviewDetail.validationExitCode).toBe(0);
    expect(reviewDetail.candidateSha).toBe(candidateSha);
  });

  it("全过程可追溯：节点、执行、事件、outbox、集成与审查记录全部可查", async () => {
    const db = h().world.db;
    const runId = h().runId;

    // Events: every execution has an ordered protocol stream plus its
    // lifecycle outcome; checksums verify over the WHOLE store.
    for (const entry of h().result.trace) {
      const events = listEventsForExecution(db, entry.executionId);
      expect(events.length).toBeGreaterThanOrEqual(5);
      const seqs = events.map((event) => event.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(events.some((event) => event.type === "lifecycle_outcome")).toBe(true);
      expect(events.some((event) => event.type === "result_reported")).toBe(true);
    }
    expect(verifyEventChecksums(db)).toEqual([]);

    // Outbox: one scheduler.dispatch per claim + one attempt-finished per
    // execution (the claimed composition skips the engine's own dispatch
    // message; the claim's is the durable one).
    const outbox = listPendingOutboxMessages(db);
    expect(outbox.filter((message) => message.type === "scheduler.dispatch")).toHaveLength(7);
    expect(outbox.filter((message) => message.type === "execution.attempt-finished")).toHaveLength(7);

    // Integration: two completed single-writer assemblies.
    const records = listIntegrationRecords(db, runId);
    expect(records.map((record) => record.nodeId).sort()).toEqual(["integrate", "integrate-followup"]);
    expect(records.every((record) => record.state === "COMPLETED")).toBe(true);
    for (const record of records) {
      const fetched = required(
        getIntegrationRecord(db, { runId, nodeId: record.nodeId }),
        `integration record ${record.nodeId}`
      );
      expect(fetched.candidateSha).toBe(record.candidateSha);
      expect(h().result.candidates[record.nodeId]).toBe(record.candidateSha);
    }

    // Review: one completed, candidateSha-bound record.
    const reviews = listReviewRecords(db, runId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.state).toBe("COMPLETED");
    expect(reviews[0]?.nodeId).toBe("review");
    expect(reviews[0]?.candidateSha).toBe(h().result.candidates["integrate"]);
  });
});
