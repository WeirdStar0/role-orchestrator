/**
 * A37 usage records: missing usage is recorded `unavailable` with NULL
 * numerics (never 0 — the storage CHECK makes a 0-fill a constraint
 * violation), the typed read-back exposes NO numbers for an unavailable
 * record, recorded usage keeps price-known/unknown distinct, and a usage
 * row is written exactly once per execution.
 */
import { describe, expect, it } from "vitest";
import {
  BudgetRowIntegrityError,
  UnknownExecutionError,
  UsageAlreadyRecordedError,
  countUndeterminedUsage,
  getExecutionUsage,
  recordExecutionUsage,
  recordUsageUnavailable
} from "../src/index.js";
import { createBudgetDb, createCoreOnlyDb, expectError, seedSlot } from "./helpers.js";

describe("A37 execution usage", () => {
  it("records missing usage as unavailable with NULL numerics — never zeros", () => {
    const { db } = createBudgetDb("usage-unavailable");
    seedSlot(db, { executionId: "exec-1" });
    recordUsageUnavailable(db, { executionId: "exec-1", now: "2026-09-22T00:00:01.000Z" });

    // The typed read-back has NO numeric fields at all.
    expect(getExecutionUsage(db, "exec-1")).toEqual({ status: "unavailable", recordedAt: "2026-09-22T00:00:01.000Z" });

    // At the storage layer the numerics are NULL, not 0 — the invariant the
    // pairing CHECK enforces for every unavailable row.
    const row = db
      .prepare("SELECT input_tokens, output_tokens, usd_cost_micros FROM execution_usage WHERE execution_id = 'exec-1'")
      .get() as { input_tokens: number | null; output_tokens: number | null; usd_cost_micros: number | null };
    expect(row).toEqual({ input_tokens: null, output_tokens: null, usd_cost_micros: null });
    expect(countUndeterminedUsage(db, "run-exec-1")).toBe(1);
  });

  it("records reported usage with known or unknown price, exactly once", () => {
    const { db } = createBudgetDb("usage-recorded");
    seedSlot(db, { executionId: "exec-1" });
    seedSlot(db, { executionId: "exec-2", projectId: "proj-2", runId: "run-2" });

    recordExecutionUsage(db, {
      executionId: "exec-1",
      priceStatus: "known",
      inputTokens: 1200,
      outputTokens: 340,
      usdCostMicros: 15_400,
      now: "2026-09-22T00:00:01.000Z"
    });
    expect(getExecutionUsage(db, "exec-1")).toEqual({
      status: "recorded",
      priceStatus: "known",
      inputTokens: 1200,
      outputTokens: 340,
      usdCostMicros: 15_400,
      recordedAt: "2026-09-22T00:00:01.000Z"
    });

    // missingPrice vocabulary: tokens known, cost NOT invented.
    recordExecutionUsage(db, {
      executionId: "exec-2",
      priceStatus: "unknown",
      inputTokens: 10,
      outputTokens: 5,
      now: "2026-09-22T00:00:02.000Z"
    });
    expect(getExecutionUsage(db, "exec-2")).toEqual({
      status: "recorded",
      priceStatus: "unknown",
      inputTokens: 10,
      outputTokens: 5,
      usdCostMicros: null,
      recordedAt: "2026-09-22T00:00:02.000Z"
    });
    // Unknown price is NOT undetermined usage — the tokens were reported.
    expect(countUndeterminedUsage(db, "run-2")).toBe(0);

    // Exactly once per execution.
    expectError(
      () =>
        recordExecutionUsage(db, {
          executionId: "exec-1",
          priceStatus: "known",
          inputTokens: 1,
          outputTokens: 1,
          usdCostMicros: 1,
          now: "2026-09-22T00:00:03.000Z"
        }),
      UsageAlreadyRecordedError
    );
    expectError(
      () => recordUsageUnavailable(db, { executionId: "exec-1", now: "2026-09-22T00:00:03.000Z" }),
      UsageAlreadyRecordedError
    );
  });

  it("refuses inconsistent price pairings and unknown executions", () => {
    const { db } = createBudgetDb("usage-strict");
    seedSlot(db, { executionId: "exec-1" });
    // "known" price without a number is a schema rejection...
    expect(() =>
      recordExecutionUsage(db, {
        executionId: "exec-1",
        priceStatus: "known",
        inputTokens: 1,
        outputTokens: 1,
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    // ...and so is an "unknown" price that smuggles a number in.
    expect(() =>
      recordExecutionUsage(db, {
        executionId: "exec-1",
        priceStatus: "unknown",
        inputTokens: 1,
        outputTokens: 1,
        usdCostMicros: 42,
        now: "2026-09-22T00:00:01.000Z"
      })
    ).toThrow();
    // Unknown executions are a typed failure — usage is never orphaned.
    expectError(
      () => recordUsageUnavailable(db, { executionId: "exec-ghost", now: "2026-09-22T00:00:01.000Z" }),
      UnknownExecutionError
    );
    expect(getExecutionUsage(db, "exec-1")).toBeNull();
  });

  it("refuses to drop usage reports on a database without migration 014", () => {
    const { db } = createCoreOnlyDb("usage-absent");
    seedSlot(db, { executionId: "exec-1" });
    // A usage report that arrives must never be silently discarded.
    expectError(
      () => recordUsageUnavailable(db, { executionId: "exec-1", now: "2026-09-22T00:00:01.000Z" }),
      BudgetRowIntegrityError
    );
    expectError(
      () =>
        recordExecutionUsage(db, {
          executionId: "exec-1",
          priceStatus: "known",
          inputTokens: 1,
          outputTokens: 1,
          usdCostMicros: 1,
          now: "2026-09-22T00:00:01.000Z"
        }),
      BudgetRowIntegrityError
    );
    expect(getExecutionUsage(db, "exec-1")).toBeNull();
  });
});
