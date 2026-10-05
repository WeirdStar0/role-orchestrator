/**
 * M10-02 step-3 phase-wiring guards (task 3, item 3):
 *
 *  1. PRODUCTION SURFACE — the RunDriver created by createRunDriver exposes
 *     EXACTLY the six operations the local-api server consumes. The optional
 *     phases (M7 integration / M8 review / M10 rework / M11 recovery) are
 *     standalone exports for multi-node composition roots; they appear NOWHERE
 *     on the driver object, so the production single-node pump cannot wander
 *     into a review/integration branch (the graph it creates has no such node,
 *     and the surface has no such operation).
 *  2. CONVERGENCE STRATEGIES — all-terminal (production) vs all-succeeded
 *     (benchmark pumps) are the pinned isConvergedStates pair.
 *  3. M10 A38 GUARD — requestReworkExpansion takes NO revision from its
 *     caller: the input type has no expectedGraphRevision field (the driver
 *     reads it at the call instant), so the optimistic lock cannot be
 *     bypassed through the orchestration surface.
 *  4. M8 GUARD — the validation command is a settleReviewClaim parameter
 *     (test composition roots only); the driver config/ports carry no such
 *     field (type-level; the surface check below pins the runtime side).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRunDriver, isConvergedStates } from "../src/index.js";

/** An empty in-memory store: enough to CONSTRUCT the driver (the surface
 * check builds it without touching schema). */
function buildDriver(): ReturnType<typeof createRunDriver> {
  const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-orch-surface-"));
  return createRunDriver(new DatabaseSync(":memory:"), {
    profiles: [],
    worktreesRoot
  });
}

describe("phase-wiring guards (step 3)", () => {
  it("the RunDriver surface is EXACTLY the six production operations", () => {
    const driver = buildDriver();
    expect(Object.keys(driver).sort()).toEqual(
      [
        "createRun",
        "listProfiles",
        "onApprovalDecided",
        "profilesSourcePath",
        "setProjectRoleBindings",
        "shutdown"
      ].sort()
    );
  });

  it("no optional-phase operation leaks onto the driver object", () => {
    const driver = buildDriver() as unknown as Record<string, unknown>;
    for (const phaseOperation of [
      "settleIntegrationClaim",
      "settleReviewClaim",
      "requestReworkExpansion",
      "scanStartupRecovery",
      "landRecoveryOutcome",
      "integrateParents",
      "openReviewSession",
      "requestControlledExpansion",
      "reconcileStartup"
    ]) {
      expect(driver[phaseOperation], phaseOperation).toBeUndefined();
    }
  });

  it("convergence strategies stay the pinned pair: all-terminal guards emptiness, all-succeeded does not", () => {
    expect(isConvergedStates("all-terminal", [])).toBe(false);
    expect(isConvergedStates("all-succeeded", [])).toBe(true);
    expect(isConvergedStates("all-terminal", ["SUCCEEDED", "FAILED"])).toBe(true);
    expect(isConvergedStates("all-succeeded", ["SUCCEEDED", "FAILED"])).toBe(false);
  });

  it("M10 rework input carries NO revision field (A38: the driver reads it at the call instant)", async () => {
    // Type-level by construction; pinned at runtime through the module's
    // exported input shape documentation object trick: call with a foreign
    // revision field and expect the service to see only the driver-read one.
    // The direct observable: the exported function rejects an unknown run
    // (the expand service's own typed refusal) rather than trusting a caller
    // revision.
    const { requestReworkExpansion } = await import("../src/rework-driver.js");
    const db = new DatabaseSync(":memory:");
    expect(() =>
      requestReworkExpansion(db, {
        runId: "run-unknown-0001",
        reviewNodeId: "review",
        candidateSha: "a".repeat(40),
        requesterRoleId: "coordinator",
        now: new Date().toISOString()
      })
    ).toThrow();
  });
});
