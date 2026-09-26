/**
 * Recovery-boundary vitest suites (M4-05): A10 regression, A22 no-auto-rerun,
 * the approval boundaries, the A21 cap under the real scheduler, and the
 * full-chain recovery. The same case functions run inside the matrix driver.
 */
import { test } from "vitest";
import {
  runApprovalConsumeRollbackAtomic,
  runApprovalConsumedEvidencePreserved,
  runChainResumeAfterRecovery,
  runGitMergeConflictPaused,
  runRetryCapThreeAttempts,
  runSideEffectUnknownNoAutoRerun
} from "../src/cases/recovery-boundary.js";

const TIMEOUT = 300_000;

test("FM-GIT-01: a same-line merge conflict pauses, preserves both branches, blocks the node (A10)", { timeout: TIMEOUT }, async () => {
  await runGitMergeConflictPaused();
});

test("FM-A22-01: committed side effects with unknown outcome land RECOVERY_REQUIRED and nothing re-runs", { timeout: TIMEOUT }, async () => {
  await runSideEffectUnknownNoAutoRerun();
});

test("FM-APR-01: the consumed approval's evidence survives reconcile and operator resolution", { timeout: TIMEOUT }, async () => {
  await runApprovalConsumedEvidencePreserved();
});

test("FM-APR-02: a crashed consumption rolls the whole continuation back; replay stays single-shot", { timeout: TIMEOUT }, async () => {
  await runApprovalConsumeRollbackAtomic();
});

test("FM-RETRY-01: three total attempts exhaust the A21 cap; the run is held; the profile never moves", { timeout: TIMEOUT }, async () => {
  await runRetryCapThreeAttempts();
});

test("FM-CHAIN-01: the full chain recovers from a mid-chain failure and finishes with the correct result", { timeout: TIMEOUT }, async () => {
  await runChainResumeAfterRecovery();
});
