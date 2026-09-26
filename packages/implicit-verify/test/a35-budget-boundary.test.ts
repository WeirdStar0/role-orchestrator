/**
 * A35 proxy-budget boundary — the quota/budget/usage ledgers count ZERO for
 * activity a CLI derives internally (its own sub-agents / MCP calls / hooks).
 *
 * Pinned here with real ledgers on the composed 001..004+014 chain:
 * - quota grants, budget consumption and usage rows exist ONLY for
 *   executions the orchestrator's dispatch claim created (the FK from
 *   `quota_grants`/`execution_usage` to `executions` makes anything else a
 *   hard error, and `executions` rows are claim products);
 * - a well-formed id that is NOT a dispatched execution cannot be granted a
 *   quota slot, cannot record usage (known or unavailable) and holds no rows;
 * - consumption advances exactly with orchestrator dispatches, and a
 *   exhausted budget refuses the next ORCHESTRATOR dispatch — the budget
 *   never moved for anything else because nothing else can move it
 *   (不可计费 → 不可无人值守的逻辑闭环).
 */
import { describe, expect, test } from "vitest";
import {
  ensureRunBudget,
  countUndeterminedUsage,
  getExecutionUsage,
  getRunBudget,
  recordExecutionUsage,
  recordUsageUnavailable,
  UnknownExecutionError
} from "@role-orchestrator/budget";
import {
  acquireQuotaSlots,
  enqueueReadyNodes,
  listExecutionQuotaGrants,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants
} from "@role-orchestrator/scheduler";
import {
  evaluateUnattendedWriteDecision,
  quotaLedgerCensus
} from "../src/index.js";
import {
  createImplicitVerifyDb,
  expectError,
  iso,
  pollInput,
  seedProfile,
  seedProject,
  seedReadyRun
} from "./helpers.js";

/** The id a confused caller might use for a CLI-internal activity. */
const CLI_INTERNAL_ACTIVITY_ID = "cli-internal-subagent-1";

async function seedRunWithNodes(db: Awaited<ReturnType<typeof createImplicitVerifyDb>>["db"], nodeIds: readonly string[]): Promise<string> {
  await seedProfile(db, { profileId: "claude-main", runtime: "claude", credentialGroup: "personal", maxConcurrency: 2 });
  seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
  await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds });
  return "run-1";
}

describe("quota grants tie to orchestrator-dispatched executions only", () => {
  test("two dispatches → exactly their grants; a CLI-internal id cannot be granted", async () => {
    const { db, close } = createImplicitVerifyDb("quota-tie");
    try {
      const runId = await seedRunWithNodes(db, ["n1", "n2"]);
      enqueueReadyNodes(db, { runId, now: iso(1_000), requiredCapability: null });
      // Sequential dispatches: the A33 credential lock caps an unverified
      // group at ONE live execution, so the first claim's grants are
      // released (the normal completion path) before the second dispatch.
      const first = pollQueue(db, pollInput(iso(2_000)));
      expect(first.dispatched).toHaveLength(1);
      expect(first.quotaRejected).toHaveLength(1);
      markQueueEntryCompleted(db, { entryId: first.dispatched[0]?.entryId ?? "", now: iso(2_500) });
      expect(releaseExecutionQuotaGrants(db, { executionId: first.dispatched[0]?.executionId ?? "", now: iso(2_500) })).toBe(4);
      const second = pollQueue(db, pollInput(iso(62_500)));
      expect(second.dispatched).toHaveLength(1);
      const dispatchedIds = [first.dispatched[0]?.executionId, second.dispatched[0]?.executionId]
        .filter((id) => id !== undefined)
        .sort();

      // Every grant row belongs to one of the two claim products, and the
      // executions table contains exactly those two rows. Grant rows persist
      // after release, so the ledger still shows 2 executions x 4 dimensions.
      const census = quotaLedgerCensus(db);
      expect(census.grantRowsTotal).toBe(8); // 2 executions x 4 counted dimensions
      expect(census.grantsByDimension).toEqual({ global: 2, project: 2, profile: 2, credential: 2 });
      expect(census.distinctExecutionIds).toEqual(dispatchedIds);
      const executionRows = db.prepare("SELECT id FROM executions ORDER BY id ASC").all() as { id: string }[];
      expect(executionRows.map((row) => row.id).sort()).toEqual(dispatchedIds);

      // A CLI-internal activity id is schema-valid but references NO
      // execution row: the FK refuses to mint a quota entry for it, and no
      // partial row survives the failed claim.
      const error = expectError(
        () =>
          acquireQuotaSlots(db, {
            executionId: CLI_INTERNAL_ACTIVITY_ID,
            slots: [{ dimension: "global", resourceKey: "global", max: 4 }],
            leaseMs: 3_600_000,
            now: iso(3_500)
          }),
        Error
      );
      expect(error.message).toMatch(/FOREIGN KEY/i);
      expect(listExecutionQuotaGrants(db, CLI_INTERNAL_ACTIVITY_ID)).toHaveLength(0);
      expect(quotaLedgerCensus(db).grantRowsTotal).toBe(8);
    } finally {
      close();
    }
  });
});

describe("budget consumption and usage rows tie to orchestrator dispatches only", () => {
  test("consumption advances per dispatch; CLI-internal activity cannot record anything", async () => {
    const { db, close } = createImplicitVerifyDb("budget-tie");
    try {
      const runId = await seedRunWithNodes(db, ["n1", "n2", "n3"]);
      ensureRunBudget(db, {
        runId,
        limits: { maxNodes: 3, maxExecutions: 2, maxDurationMs: 3_600_000, undeterminedUsageLimit: 3 },
        now: iso(500)
      });
      enqueueReadyNodes(db, { runId, now: iso(1_000), requiredCapability: null });
      // Sequential dispatches (the A33 credential lock allows one live
      // execution per unverified group): n1 dispatches; n2/n3 are
      // quota-rejected with a retry window and stay WAITING. After the
      // normal completion path releases n1's grants, n2 dispatches and the
      // execution budget is then exactly full; n3 is refused by the FROZEN
      // budget — nothing else ever moved the counters, because nothing else
      // can.
      const first = pollQueue(db, pollInput(iso(2_000)));
      expect(first.dispatched).toHaveLength(1);
      expect(first.quotaRejected).toHaveLength(2);
      markQueueEntryCompleted(db, { entryId: first.dispatched[0]?.entryId ?? "", now: iso(2_500) });
      expect(releaseExecutionQuotaGrants(db, { executionId: first.dispatched[0]?.executionId ?? "", now: iso(2_500) })).toBe(4);
      const second = pollQueue(db, pollInput(iso(62_500)));
      expect(second.dispatched).toHaveLength(1);
      expect(second.blocked).toHaveLength(1);
      expect(second.blocked[0]?.kind).toBe("budget");
      expect(second.blocked[0]?.reason).toBe("budget:execution-budget-exhausted");
      const budget = getRunBudget(db, runId);
      expect(budget?.executionsUsed).toBe(2);
      expect(budget?.nodesUsed).toBe(2);

      // Usage recording refuses the CLI-internal id in BOTH directions
      // (known usage and A37-unavailable) — the usage ledger is keyed by
      // dispatched executions, so CLI-internal activity is neither counted
      // nor guessed as 0.
      expectError(
        () =>
          recordExecutionUsage(db, {
            executionId: CLI_INTERNAL_ACTIVITY_ID,
            priceStatus: "known",
            inputTokens: 1_000,
            outputTokens: 500,
            usdCostMicros: 0,
            now: iso(3_000)
          }),
        UnknownExecutionError
      );
      expectError(
        () => recordUsageUnavailable(db, { executionId: CLI_INTERNAL_ACTIVITY_ID, now: iso(3_000) }),
        UnknownExecutionError
      );
      expect(getExecutionUsage(db, CLI_INTERNAL_ACTIVITY_ID)).toBeNull();
      expect(Number(db.prepare("SELECT COUNT(*) AS n FROM execution_usage").get()?.n)).toBe(0);

      // The dispatched executions CAN record usage — recorded for one,
      // A37-unavailable for the other — and the ledger still contains
      // exactly the orchestrator's rows.
      const firstExecution = first.dispatched[0]?.executionId;
      const secondExecution = second.dispatched[0]?.executionId;
      if (firstExecution === undefined || secondExecution === undefined) {
        throw new Error("expected two dispatches");
      }
      recordExecutionUsage(db, {
        executionId: firstExecution,
        priceStatus: "known",
        inputTokens: 1_000,
        outputTokens: 500,
        usdCostMicros: 0,
        now: iso(63_000)
      });
      recordUsageUnavailable(db, { executionId: secondExecution, now: iso(63_100) });
      expect(Number(db.prepare("SELECT COUNT(*) AS n FROM execution_usage").get()?.n)).toBe(2);
      expect(countUndeterminedUsage(db, runId)).toBe(1);
      expect(getExecutionUsage(db, firstExecution)?.status).toBe("recorded");
      expect(getExecutionUsage(db, secondExecution)?.status).toBe("unavailable");
    } finally {
      close();
    }
  });
});

describe("the closure: not billable ⇒ no unattended operation", () => {
  test("unattended stays refused while the ledgers count only dispatched executions", async () => {
    const { db, close } = createImplicitVerifyDb("closure");
    try {
      const runId = await seedRunWithNodes(db, ["n1"]);
      enqueueReadyNodes(db, { runId, now: iso(1_000), requiredCapability: null });
      const result = pollQueue(db, pollInput(iso(2_000)));
      expect(result.dispatched).toHaveLength(1);

      // Limb 1 (control plane): the unattended write mode is refused by the
      // capability gate and the scheduling gate, because the CLI's internal
      // executions (sub-agents/MCP) are invisible and unmanaged.
      expect(evaluateUnattendedWriteDecision("claude").allowed).toBe(false);

      // Limb 2 (ledger): the quota ledger holds exactly the one claim's
      // grants and nothing else — a CLI-internal burst has no entry, no
      // consumption and no release path; it cannot buy back the refused
      // unattended mode or extend the DAG's quota.
      const census = quotaLedgerCensus(db);
      expect(census.grantRowsTotal).toBe(4);
      expect(census.distinctExecutionIds).toEqual([result.dispatched[0]?.executionId]);
      expect(listExecutionQuotaGrants(db, CLI_INTERNAL_ACTIVITY_ID)).toHaveLength(0);
    } finally {
      close();
    }
  });
});
