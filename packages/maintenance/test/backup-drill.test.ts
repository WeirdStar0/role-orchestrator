import { describe, expect, it } from "vitest";
import { DAEMON_CHAIN_MAX_VERSION, runUpgradeRecoveryDrill } from "../src/index.js";
import { makeScratchDir, removeTreeRobust } from "./helpers.js";

/**
 * A41 end to end — the executable runbook. One drill proves BOTH recovery
 * branches on the REAL daemon chain with REAL business data:
 * - A41 前半: a database with full business data survives a failed upgrade;
 *   the restored database is fully readable (migrations verified, data
 *   byte-count identical, outbox/approval rows intact).
 * - A41 后半: the failed-upgrade recovery path is a RUNBOOK with executable
 *   steps (module README documents the same steps in prose).
 */
describe("upgrade-failure recovery drill (A41)", () => {
  it("fails a bad 019, stays readable at 001..018, and recovers by retry with fixed code (branch A)", async () => {
    const workDir = makeScratchDir("drill-a");
    try {
      const report = await runUpgradeRecoveryDrill({ workDir });
      expect(report.daemonChainVersions).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18
      ]);
      // Real business data was seeded through real package APIs.
      expect(report.seeded).toEqual({
        projects: 1,
        runs: 1,
        executions: 1,
        events: 2,
        memories: 1,
        outboxMessages: 1,
        approvals: 1
      });
      expect(report.scenarioA.failureKind).toBe("application-failed");
      expect(report.scenarioA.badMigrationVersion).toBe(DAEMON_CHAIN_MAX_VERSION + 1);
      // The failure rolled back cleanly: chain intact, nothing recorded for 018.
      expect(report.scenarioA.verifyVersionsAfterFailure).toEqual(report.daemonChainVersions);
      // The FIXED 018 then applies under the SAME version number — this is
      // precisely why a rolled-back failure is NOT a "bad migration replay".
      expect(report.scenarioA.fixedVersionApplied).toEqual([DAEMON_CHAIN_MAX_VERSION + 1]);
      expect(report.scenarioA.verifyVersionsAfterFix).toEqual([
        ...report.daemonChainVersions,
        DAEMON_CHAIN_MAX_VERSION + 1
      ]);
      // The drill recorded the human-readable steps for the audit log.
      expect(report.steps.length).toBeGreaterThanOrEqual(4);
    } finally {
      removeTreeRobust(workDir);
    }
  }, 60_000);

  it("restores from the pre-upgrade backup when the post-failure state is damaged (branch B)", async () => {
    const workDir = makeScratchDir("drill-b");
    try {
      const report = await runUpgradeRecoveryDrill({ workDir });
      const b = report.scenarioB;
      // The pre-upgrade backup existed BEFORE the migration ran and passes
      // inspection.
      expect(b.backupInspectionBytes).toBeGreaterThan(0);
      // The damage is detectable: verifyMigrations refuses with the typed kind.
      expect(b.verifyErrorAfterDamage).toBe("checksum-mismatch");
      // The restore verified every migration record in the backup against the
      // shipped chain BEFORE copying bytes.
      expect(b.restoredVerifiedMigrationCount).toBe(DAEMON_CHAIN_MAX_VERSION);
      expect(b.restoredBytes).toBeGreaterThan(0);
      // After restore: full chain verified, ALL seeded business data back.
      expect(b.verifyVersionsAfterRestore).toEqual(report.daemonChainVersions);
      expect(b.seededDataIntact).toBe(true);
      // And the corrected 018 applies afterwards.
      expect(b.fixedVersionApplied).toEqual([DAEMON_CHAIN_MAX_VERSION + 1]);
      expect(b.verifyVersionsAfterFix).toEqual([
        ...report.daemonChainVersions,
        DAEMON_CHAIN_MAX_VERSION + 1
      ]);
      // The steps narrate the runbook: backup -> damage -> quiesce -> restore
      // -> verify -> fixed retry.
      const actions = report.steps.map((step) => step.action).join(" | ");
      expect(actions).toContain("close EVERY connection");
      expect(actions).toContain("restore");
    } finally {
      removeTreeRobust(workDir);
    }
  }, 60_000);
});
