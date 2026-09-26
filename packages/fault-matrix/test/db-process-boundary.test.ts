/**
 * Per-boundary vitest suites call the SAME case functions the matrix driver
 * runs, so a failure localizes to one boundary while the driver test
 * (`matrix-driven.test.ts`) proves the whole matrix passes in one drive.
 *
 * Platform gating is declared honestly: the real-process identity cases
 * (FM-PROC-03/04) are windows-native by design (A29: no cross-namespace pid
 * interpretation) and report `test.skip` elsewhere.
 */
import { test } from "vitest";
import {
  runDbApprovalOpenCrash,
  runDbExecutionInsertCrash,
  runDbIntegrationCompletionCrash,
  runDbIntegrationManifestCrash,
  runDbIntegrationPauseCrash
} from "../src/cases/db-boundary.js";
import {
  runProcLaunchWindowCrash,
  runProcPidReuseHolderSurvives,
  runProcSpawnFailure,
  runProcTreeKillGrandchild
} from "../src/cases/process-boundary.js";

const TIMEOUT = 240_000;

test("FM-DB-01: attempt-row INSERT crash rolls back and the chain continues", { timeout: TIMEOUT }, async () => {
  await runDbExecutionInsertCrash();
});

test("FM-DB-02: crash before the integration completion UPDATE reconciles without duplicate commits", { timeout: TIMEOUT }, async () => {
  await runDbIntegrationCompletionCrash();
});

test("FM-DB-03: crash before the manifest write is safe-to-retry with the same candidateSha", { timeout: TIMEOUT }, async () => {
  await runDbIntegrationManifestCrash();
});

test("FM-DB-04: crash before the PAUSED_CONFLICT write leaves a manual conflict scene", { timeout: TIMEOUT }, async () => {
  await runDbIntegrationPauseCrash();
});

test("FM-DB-05: crash inside the checkpoint open rolls the approval back atomically", { timeout: TIMEOUT }, async () => {
  await runDbApprovalOpenCrash();
});

test("FM-PROC-01: launch-window crash is RECOVERY_REQUIRED, blocked, and continues after resolution", { timeout: TIMEOUT }, async () => {
  await runProcLaunchWindowCrash();
});

test("FM-PROC-02: spawn failure is determinate, evidenced, and bounded by the A21 cap", { timeout: TIMEOUT }, async () => {
  await runProcSpawnFailure();
});

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest(
  "FM-PROC-03: the kill budget terminates the whole grandchild tree (A26)",
  { timeout: TIMEOUT },
  async () => {
    await runProcTreeKillGrandchild();
  }
);

windowsTest(
  "FM-PROC-04: a reused pid interrupts the attempt and spares the holder (A27)",
  { timeout: TIMEOUT },
  async () => {
    await runProcPidReuseHolderSurvives();
  }
);
