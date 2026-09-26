/**
 * Claimed-attempt composition (M2-06): the scheduler's dispatch claim already
 * created the attempt row (phase STARTING); the engine launches it with
 * `claimedAttempt: true` instead of inserting its own PREPARING row (which
 * the A23 slot constraint makes impossible). Verifies the happy path and the
 * fail-closed mismatches: missing row, wrong phase, wrong dispatch token,
 * wrong slot identity — none of which may spawn a process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  createActiveAttempt,
  getExecution,
  listExecutionsForRun,
  setAttemptPhase
} from "@role-orchestrator/store";
import { ClaimedAttemptInvalidError } from "../src/errors.js";
import { createSeededDb, launchFake, seedFakeRun, T0, type SeedState } from "./helpers.js";

describe("startExecution with a pre-claimed attempt (scheduler dispatch composition)", () => {
  let db: DatabaseSync;
  let seed: SeedState;
  let close: () => void;
  let workDir: string;

  beforeEach(async () => {
    const seededDb = createSeededDb("claimed");
    db = seededDb.db;
    close = seededDb.close;
    seed = await seedFakeRun(db, { runId: "run-claimed" });
    workDir = mkdtempSync(join(tmpdir(), "ro-engine-claimed-"));
  });

  afterEach(() => {
    close();
  });

  function claimAttempt(input: {
    readonly executionId: string;
    readonly dispatchToken: string;
    readonly nodeId?: string;
  }): void {
    createActiveAttempt(db, {
      id: input.executionId,
      runId: seed.runId,
      nodeId: input.nodeId ?? "node-1",
      definitionRevision: "rev-1",
      attempt: 1,
      dispatchToken: input.dispatchToken,
      phase: "STARTING",
      now: T0
    });
  }

  it("launches the claimed attempt and reaches SUCCEEDED without a second row", async () => {
    const executionId = "exec-claimed-1";
    const dispatchToken = "dt-claimed-1";
    claimAttempt({ executionId, dispatchToken });

    const run = launchFake(db, seed, {
      executionId,
      dispatchToken,
      cwd: workDir,
      scenario: "success",
      claimedAttempt: true
    });
    const result = await run.result;
    expect(result.finalPhase).toBe("SUCCEEDED");

    const row = getExecution(db, executionId);
    expect(row?.phase).toBe("SUCCEEDED");
    expect(row?.dispatchToken).toBe(dispatchToken);
    // Exactly ONE execution row exists for the run — the claim's, not a
    // second engine-created one (A23: one active attempt per slot).
    expect(listExecutionsForRun(db, seed.runId).map((entry) => entry.id)).toEqual([executionId]);
  });

  it("refuses to launch when no claimed row exists", async () => {
    const run = launchFake(db, seed, {
      executionId: "exec-unclaimed",
      dispatchToken: "dt-unclaimed",
      cwd: workDir,
      claimedAttempt: true
    });
    await expect(run.result).rejects.toBeInstanceOf(ClaimedAttemptInvalidError);
  });

  it("refuses to launch when the claimed row is not in STARTING", async () => {
    const executionId = "exec-claimed-phase";
    claimAttempt({ executionId, dispatchToken: "dt-phase" });
    // Simulate a claim that already moved past STARTING (double-launch).
    setAttemptPhase(db, { id: executionId, phase: "RUNNING", now: T0 });

    const run = launchFake(db, seed, { executionId, dispatchToken: "dt-phase", cwd: workDir, claimedAttempt: true });
    await expect(run.result).rejects.toBeInstanceOf(ClaimedAttemptInvalidError);
  });

  it("refuses to launch when the dispatch token does not match the claim", async () => {
    const executionId = "exec-claimed-token";
    claimAttempt({ executionId, dispatchToken: "dt-real" });

    const run = launchFake(db, seed, { executionId, dispatchToken: "dt-forged", cwd: workDir, claimedAttempt: true });
    await expect(run.result).rejects.toBeInstanceOf(ClaimedAttemptInvalidError);
  });

  it("refuses to launch when the claimed slot identity differs", async () => {
    const executionId = "exec-claimed-slot";
    claimAttempt({ executionId, dispatchToken: "dt-slot", nodeId: "other-node" });

    const run = launchFake(db, seed, { executionId, dispatchToken: "dt-slot", cwd: workDir, claimedAttempt: true });
    await expect(run.result).rejects.toBeInstanceOf(ClaimedAttemptInvalidError);
  });
});
