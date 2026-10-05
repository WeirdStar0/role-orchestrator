/**
 * M10-02 — the frozen pump constants. Production parity is the step-1 hard
 * constraint: these values ARE the M5-05/M6-05 pump values and the M9-01
 * production choices; changing one is changing product behavior (a new
 * commit + acceptance, never a silent edit). This suite pins them.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_SECONDS,
  EXECUTE_NODE_ID,
  GRAPH_DEFINITION_REVISION,
  MAX_PUMP_ROUNDS,
  POLL_LEASE_MS,
  POLL_LIMIT,
  POLL_RETRY_WINDOW_MS,
  POLL_STARVATION_MS,
  PUMP_CONCURRENCY,
  SHUTDOWN_GRACE_MS
} from "../src/constants.js";

describe("frozen pump constants (M1)", () => {
  it("queue/poll knobs are the M5-05/M6-05 pump values", () => {
    expect(POLL_LEASE_MS).toBe(600_000);
    expect(POLL_RETRY_WINDOW_MS).toBe(50);
    expect(POLL_STARVATION_MS).toBe(600_000);
    expect(POLL_LIMIT).toBe(8);
    expect(PUMP_CONCURRENCY).toEqual({ globalMax: 4, projectMax: 4, unverifiedCredentialGroupMax: 1 });
  });

  it("the M9-01 graph shape and approval/shutdown bounds are unchanged", () => {
    expect(EXECUTE_NODE_ID).toBe("execute");
    expect(GRAPH_DEFINITION_REVISION).toBe("1");
    expect(APPROVAL_TTL_SECONDS).toBe(2_592_000); // 30 days, as the M6-05 driver
    expect(MAX_PUMP_ROUNDS).toBe(32);
    expect(SHUTDOWN_GRACE_MS).toBe(15_000);
  });
});
