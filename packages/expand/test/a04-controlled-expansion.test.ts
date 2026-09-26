/**
 * M5-02 expansion tests — the CONTROLLED entry (`requestControlledExpansion`):
 *
 * - A04: an expansion requested by a role with disabled subtask permission
 *   (or an unresolvable role binding) is refused with a typed error AND the
 *   refusal reason is durably recorded in `expansion_request_audit` BEFORE the
 *   throw; nothing is minted, nothing is written to the graph.
 * - A38: a stale `expectedGraphRevision` is refused with the typed dag
 *   conflict (expected + current), and a successful expansion appends an
 *   'expansion' revision row so later UI edits stay coherent (the composed
 *   revision row still contains the minted nodes).
 * - A20: the three-round cap and user hold apply unchanged through the
 *   controlled entry (the M4-03 protocol is delegated to, not reimplemented).
 * - Idempotency: a replayed fail resolves to the SAME pair and mints nothing.
 *
 * Everything runs against a real file-backed store with the full
 * CONTROLLED_EXPANSION_MIGRATIONS chain (001..013 + 015 + 016 + 017) applied.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, appliedMigrationRecords, getTaskRun } from "@role-orchestrator/store";
import {
  GraphRevisionConflictError,
  applyGraphNodeEdit,
  getLatestGraphRevision,
  recordInitialGraphRevision
} from "@role-orchestrator/dag";
import {
  ExpansionPermissionDeniedError,
  ReviewRoundsExhaustedError,
  RunHeldForUserError,
  applyControlledExpansionMigrations,
  composeExpandedWorkflow,
  getRunUserHold,
  listRunExpansions,
  requestControlledExpansion
} from "../src/index.js";
import {
  T0,
  expectError,
  fakeSha,
  iso,
  rawNode,
  rawWorkflow,
  recordVerdict,
  seedExpansionRun
} from "./helpers.js";

let dbHandle: { db: DatabaseSync; dbPath: string; close(): void };

beforeAll(async () => {
  dbHandle = createControlledDb("a04");
});

afterAll(() => {
  dbHandle?.close();
});

const db = (): DatabaseSync => dbHandle.db;

/** Fresh DB with the FULL controlled-expansion chain (16 migrations). */
function createControlledDb(label: string): { db: DatabaseSync; dbPath: string; close(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), `ro-expand-m502-${label}-`));
  const dbPath = path.join(dir, "test.db");
  const database = openDatabase(dbPath);
  void applyControlledExpansionMigrations(database, { now: T0 });
  const records = appliedMigrationRecords(database);
  if (
    records.length !== 16 ||
    records[12]?.version !== 13 ||
    records[13]?.version !== 15 ||
    records[14]?.version !== 16 ||
    records[15]?.version !== 17
  ) {
    database.close();
    throw new Error("test helper: controlled-expansion migrations 001..013+015+016+017 were not applied");
  }
  return { db: database, dbPath, close: () => database.close() };
}

let runCounter = 0;

/** The seeded plan shape of seedExpansionRun: dev_a -> review_0. */
function seededWorkflow(): unknown {
  return rawWorkflow([
    rawNode({ id: "dev_a", role: "developer" }),
    rawNode({ id: "review_0", role: "reviewer", dependencies: ["dev_a"] })
  ]);
}

/** A seeded run (dev_a -> review_0, baseline recorded) with a fresh id. */
async function freshRun(options: { recordBaseline?: boolean } = {}): Promise<string> {
  runCounter += 1;
  const runId = `run-m502-${String(runCounter)}`;
  // Ids derive from the run id so repeated seeds in ONE database never
  // collide on projects'/profiles' unique constraints (repo_root is unique).
  await seedExpansionRun(db(), { runId, projectId: `proj-${runId}`, profileId: `profile-${runId}` });
  if (options.recordBaseline !== false) {
    recordInitialGraphRevision(db(), { runId, workflow: seededWorkflow(), now: T0 });
  }
  return runId;
}

function controlledRequest(input: {
  readonly runId: string;
  readonly reviewNodeId?: string;
  readonly candidateSha?: string;
  readonly requesterRoleId: "coordinator" | "architect" | "developer" | "reviewer";
  readonly expectedGraphRevision?: number;
  readonly repairedNodeId?: string;
}): ReturnType<typeof requestControlledExpansion> {
  return requestControlledExpansion(db(), {
    runId: input.runId,
    reviewNodeId: input.reviewNodeId ?? "review_0",
    candidateSha: input.candidateSha ?? fakeSha("m5-02-fail"),
    requesterRoleId: input.requesterRoleId,
    expectedGraphRevision: input.expectedGraphRevision ?? 0,
    ...(input.repairedNodeId !== undefined ? { repairedNodeId: input.repairedNodeId } : {}),
    now: iso(1_000_000)
  });
}

function nodeCount(runId: string): number {
  return Number(
    (db().prepare("SELECT COUNT(*) AS n FROM task_nodes WHERE run_id = ?").get(runId) as Record<string, unknown>)["n"]
  );
}

function auditRows(runId: string): readonly Record<string, unknown>[] {
  return db()
    .prepare("SELECT * FROM expansion_request_audit WHERE run_id = ? ORDER BY id")
    .all(runId) as Record<string, unknown>[];
}

describe("A04 — an expansion by a role with disabled subtask permission is refused and audited", () => {
  it("refuses a developer request with a typed error and records the reason durably", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      findings: ["the fix is incomplete"],
      now: iso(500_000)
    });

    const error = expectError(
      () => controlledRequest({ runId, requesterRoleId: "developer" }),
      ExpansionPermissionDeniedError
    );
    expect(error.reason).toBe("can-create-subtasks-disabled");
    expect(error.projectId).toBe(`proj-${runId}`);
    expect(error.requesterRoleId).toBe("developer");
    expect(error.message).toContain("A04");

    // The denial is DURABLE: the reason survives the rejection.
    const rows = auditRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: runId,
      requester_role: "developer",
      review_node_id: "review_0",
      candidate_sha: fakeSha("m5-02-fail"),
      expected_graph_revision: 0,
      outcome: "denied-permission"
    });
    expect(String(rows[0]?.["reason"])).toContain("canCreateSubtasks");

    // Nothing was minted, nothing moved.
    expect(listRunExpansions(db(), runId)).toHaveLength(0);
    expect(nodeCount(runId)).toBe(2);
    expect(getTaskRun(db(), runId)?.graphRevision).toBe(0);
  });

  it("refuses fail-closed when the role binding row is missing, with the reason audited", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    db()
      .prepare("DELETE FROM role_bindings WHERE project_id = ? AND role_id = ?")
      .run(`proj-${runId}`, "coordinator");

    const error = expectError(
      () => controlledRequest({ runId, requesterRoleId: "coordinator" }),
      ExpansionPermissionDeniedError
    );
    expect(error.reason).toBe("binding-missing");
    const rows = auditRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied-permission", requester_role: "coordinator" });
    expect(String(rows[0]?.["reason"])).toContain("no role_bindings row");
    expect(listRunExpansions(db(), runId)).toHaveLength(0);
  });

  it("refuses BEFORE the revision gate: a denied request never reaches the protocol", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    // A stale revision AND a disabled role: the A04 denial wins and is audited
    // with the request's expected revision, not the graph's current one.
    const error = expectError(
      () => controlledRequest({ runId, requesterRoleId: "architect", expectedGraphRevision: 7 }),
      ExpansionPermissionDeniedError
    );
    expect(error.reason).toBe("can-create-subtasks-disabled");
    const rows = auditRows(runId);
    expect(rows[0]).toMatchObject({ expected_graph_revision: 7, outcome: "denied-permission" });
  });
});

describe("the controlled happy path — permission gate, delegation, history append", () => {
  it("expands for a permitted role and appends an 'expansion' revision row (A38)", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      findings: ["boundary case broken"],
      now: iso(500_000)
    });

    const outcome = controlledRequest({ runId, requesterRoleId: "coordinator" });
    expect(outcome.created).toBe(true);
    expect(outcome.requesterRoleId).toBe("coordinator");
    expect(outcome.generation).toBe(2);
    expect(outcome.fixNode.nodeId).toBe("dev_a-fix-2");
    expect(outcome.reviewNode.nodeId).toBe("dev_a-review-2");
    expect(outcome.revision).toBe(1);

    // The minted nodes are ordinary task_nodes rows.
    expect(nodeCount(runId)).toBe(4);

    // The definition history is COMPLETE: the composed revision row contains
    // the minted pair with its real objective, so later UI edits rebuild from
    // a workflow that still knows the expansion happened.
    expect(getTaskRun(db(), runId)?.graphRevision).toBe(1);
    const latest = getLatestGraphRevision(db(), runId);
    expect(latest?.source).toBe("expansion");
    expect(latest?.workflow.nodes.map((node) => node.id)).toEqual([
      "dev_a", "review_0", "dev_a-fix-2", "dev_a-review-2"
    ]);
    expect(
      latest?.workflow.nodes.find((node) => node.id === "dev_a-fix-2")?.objective
    ).toContain("Repair the work that review node");

    // Provenance: the granted audit row answers 谁请求.
    const rows = auditRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "granted", requester_role: "coordinator" });
  });

  it("replays an already-expanded fail idempotently without minting or bumping", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    const first = controlledRequest({ runId, requesterRoleId: "coordinator" });
    expect(first.created).toBe(true);

    // The replay comes with the CURRENT revision (a stale replay is refused
    // by the A38 gate first — see the stale tests below).
    const replay = controlledRequest({
      runId,
      requesterRoleId: "coordinator",
      expectedGraphRevision: 1
    });
    expect(replay.created).toBe(false);
    expect(replay.expansionId).toBe(first.expansionId);
    expect(replay.revision).toBe(1);
    expect(nodeCount(runId)).toBe(4);
    expect(listGraphRevisionSources(runId)).toEqual(["initial", "expansion"]);
    // Both requests are audited as granted; nothing else was minted.
    expect(auditRows(runId)).toHaveLength(2);
  });

  it("keeps a later UI edit coherent: the edit's revision row still has the minted nodes", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    controlledRequest({ runId, requesterRoleId: "coordinator" });

    // A UI edit lands on top of the expansion (revision 1 -> 2)...
    applyGraphNodeEdit(db(), {
      runId,
      nodeId: "dev_a",
      expectedGraphRevision: 1,
      patch: { objective: "objective edited after expansion" },
      now: iso(2_000_000)
    });
    // ...and the edited workflow STILL contains the minted pair — no silent
    // drop of expanded nodes from the definition history.
    const latest = getLatestGraphRevision(db(), runId);
    expect(latest?.source).toBe("ui-node-edit");
    expect(latest?.workflow.nodes.map((node) => node.id)).toEqual([
      "dev_a", "review_0", "dev_a-fix-2", "dev_a-review-2"
    ]);
    expect(
      latest?.workflow.nodes.find((node) => node.id === "dev_a")?.objective
    ).toBe("objective edited after expansion");
  });
});

describe("A38 — stale graphRevision refuses the expansion with the current revision", () => {
  it("refuses a stale request with expected+current and writes nothing", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    const error = expectError(
      () => controlledRequest({ runId, requesterRoleId: "coordinator", expectedGraphRevision: 3 }),
      GraphRevisionConflictError
    );
    expect(error.expected).toBe(3);
    expect(error.current).toBe(0);
    expect(listRunExpansions(db(), runId)).toHaveLength(0);
    expect(nodeCount(runId)).toBe(2);
    expect(getTaskRun(db(), runId)?.graphRevision).toBe(0);
    expect(auditRows(runId)).toHaveLength(0);
  });

  it("accepts the retry against the CURRENT revision after a concurrent edit", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    // A concurrent UI edit bumps the revision under the client's feet.
    applyGraphNodeEdit(db(), {
      runId,
      nodeId: "dev_a",
      expectedGraphRevision: 0,
      patch: { objective: "edited elsewhere" },
      now: iso(900_000)
    });
    expectError(
      () => controlledRequest({ runId, requesterRoleId: "coordinator", expectedGraphRevision: 0 }),
      GraphRevisionConflictError
    );
    // Refresh-and-retry: the request against the current revision lands, and
    // the expansion composes on top of the edited workflow losslessly.
    const retry = controlledRequest({ runId, requesterRoleId: "coordinator", expectedGraphRevision: 1 });
    expect(retry.created).toBe(true);
    expect(retry.revision).toBe(2);
    expect(listGraphRevisionSources(runId)).toEqual(["initial", "ui-node-edit", "expansion"]);
    const latest = getLatestGraphRevision(db(), runId);
    expect(latest?.workflow.nodes.find((node) => node.id === "dev_a")?.objective).toBe("edited elsewhere");
    expect(latest?.workflow.nodes.map((node) => node.id)).toEqual([
      "dev_a", "review_0", "dev_a-fix-2", "dev_a-review-2"
    ]);
  });
});

describe("A20 through the controlled entry — rounds cap, hold, no auto-continue", () => {
  it("refuses the fourth round, holds the run for the user, and refuses further expansion", async () => {
    const runId = await freshRun();
    const sha1 = fakeSha("m5-02-round-1");
    const sha2 = fakeSha("m5-02-round-2");
    const sha3 = fakeSha("m5-02-round-3");

    recordVerdict(db(), { runId, nodeId: "review_0", candidateSha: sha1, verdict: "fail", now: iso(500_000) });
    const first = controlledRequest({ runId, requesterRoleId: "coordinator", candidateSha: sha1 });
    expect(first.generation).toBe(2);

    recordVerdict(db(), { runId, nodeId: "dev_a-review-2", candidateSha: sha2, verdict: "fail", now: iso(600_000) });
    const second = controlledRequest({
      runId,
      requesterRoleId: "coordinator",
      reviewNodeId: "dev_a-review-2",
      candidateSha: sha2,
      expectedGraphRevision: 1
    });
    expect(second.generation).toBe(3);

    recordVerdict(db(), {
      runId,
      nodeId: "dev_a-fix-2-review-3",
      candidateSha: sha3,
      verdict: "fail",
      now: iso(700_000)
    });
    expectError(
      () =>
        controlledRequest({
          runId,
          requesterRoleId: "coordinator",
          reviewNodeId: "dev_a-fix-2-review-3",
          candidateSha: sha3,
          expectedGraphRevision: 2
        }),
      ReviewRoundsExhaustedError
    );
    // The A20 pause is durable: the run waits for the user.
    const hold = getRunUserHold(db(), runId);
    expect(hold).not.toBeNull();
    expect(hold?.attemptedGeneration).toBe(4);
    expect(hold?.reason).toBe("review-rounds-exhausted");

    // And nothing auto-continues: a further NON-expanded trigger is refused
    // with the hold error (the current revision is stated, so the request is
    // well-formed and reaches the protocol's hold guard).
    expectError(
      () =>
        controlledRequest({
          runId,
          requesterRoleId: "coordinator",
          reviewNodeId: "dev_a-fix-2-review-3",
          candidateSha: sha3,
          expectedGraphRevision: 2
        }),
      RunHeldForUserError
    );
    // Two grants only — the round-budget refusal is a protocol rejection, not
    // a permission denial, so it produces no denied-permission audit row.
    expect(auditRows(runId)).toHaveLength(2);
  });
});

describe("composeExpandedWorkflow — the history composition", () => {
  it("composes the latest revision row plus every minted pair, deduped", async () => {
    const runId = await freshRun();
    recordVerdict(db(), {
      runId,
      nodeId: "review_0",
      candidateSha: fakeSha("m5-02-fail"),
      verdict: "fail",
      now: iso(500_000)
    });
    controlledRequest({ runId, requesterRoleId: "coordinator" });
    const composed = composeExpandedWorkflow(db(), runId);
    expect(composed.nodes.map((node) => node.id)).toEqual([
      "dev_a", "review_0", "dev_a-fix-2", "dev_a-review-2"
    ]);
  });
});

function listGraphRevisionSources(runId: string): readonly string[] {
  return (db()
    .prepare("SELECT source FROM task_graph_revisions WHERE run_id = ? ORDER BY revision")
    .all(runId) as Record<string, unknown>[]).map((row) => String(row["source"]));
}
