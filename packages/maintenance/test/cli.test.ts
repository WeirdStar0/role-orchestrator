import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "@role-orchestrator/store";
import { runMaintenanceCli } from "../src/cli.js";
import {
  T0,
  createDaemonDb,
  createFixtureWorld,
  createFinishedExecutionWorktree,
  removeTreeRobust,
  seedBusinessData,
  type FixtureRepo
} from "./helpers.js";

/**
 * The runbook CLI: same operations an operator runs from a shell. Exit codes
 * are part of the contract (0 ok, 1 error, 2 usage).
 */

const cleanup: string[] = [];
const worlds: FixtureRepo[] = [];

afterAll(() => {
  for (const dir of cleanup) removeTreeRobust(dir);
  for (const world of worlds) removeTreeRobust(world.scratchDir);
});

describe("maintenance CLI", () => {
  it("upgrade-drill runs the A41 drill and exits 0 with a parseable report", async () => {
    const workDir = mkdtempSync(path.join(os.tmpdir(), "ro-maint-cli-drill-"));
    cleanup.push(workDir);
    const result = await runMaintenanceCli(["upgrade-drill", "--work-dir", workDir]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output) as {
      daemonChainVersions: number[];
      scenarioA: { fixedVersionApplied: number[] };
      scenarioB: { seededDataIntact: boolean; restoredVerifiedMigrationCount: number };
      steps: unknown[];
    };
    expect(report.daemonChainVersions).toHaveLength(18);
    expect(report.scenarioA.fixedVersionApplied).toEqual([19]);
    expect(report.scenarioB.seededDataIntact).toBe(true);
    expect(report.scenarioB.restoredVerifiedMigrationCount).toBe(18);
    expect(report.steps.length).toBeGreaterThan(3);
  }, 90_000);

  it("cleanup-plan then cleanup-execute round-trips through the plan file with the confirm gate", async () => {
    const world = await createFixtureWorld("cli-roundtrip");
    worlds.push(world);
    const store = createDaemonDb("cli-roundtrip-db");
    const planFile = path.join(store.scratchDir, "plan.json");
    try {
      await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-clean",
        nodeId: "node-1",
        attempt: 1
      });
      seedBusinessData(store.db, "run-rows"); // pending outbox row msg-run-rows
      const dbPath = store.dbPath;
      store.close();

      const planResult = await runMaintenanceCli([
        "cleanup-plan",
        "--db", dbPath,
        "--repo", world.repoPath,
        "--worktrees-root", world.worktreesRoot,
        "--temp-root", world.tempRoot,
        "--now", T0
      ]);
      expect(planResult.exitCode).toBe(0);
      const plan = JSON.parse(planResult.output) as {
        planId: string;
        items: { id: string; kind: string; target: string; safety: string }[];
      };
      writeFileSync(planFile, planResult.output, "utf8");

      // Execute WITHOUT confirmations: the pending outbox row survives.
      const denied = await runMaintenanceCli([
        "cleanup-execute",
        "--plan-file", planFile,
        "--now", T0
      ]);
      expect(denied.exitCode).toBe(0); // refusals are receipt rows, not errors
      const deniedReceipt = JSON.parse(denied.output) as {
        planId: string;
        totals: { refused: number };
        records: { target: string; outcome: string; reasonCode: string | null }[];
      };
      expect(deniedReceipt.planId).toBe(plan.planId);
      expect(deniedReceipt.totals.refused).toBeGreaterThan(0);
      const pendingDenied = deniedReceipt.records.find((r) => r.target === "msg-run-rows");
      expect(pendingDenied?.reasonCode).toBe("requires-explicit-confirmation");

      // Execute WITH the pending row confirmed: it goes.
      const pendingItem = plan.items.find(
        (item) => item.kind === "outbox-row" && item.target === "msg-run-rows"
      );
      expect(pendingItem).toBeDefined();
      const allowed = await runMaintenanceCli([
        "cleanup-execute",
        "--plan-file", planFile,
        "--confirm", pendingItem?.id ?? "",
        "--now", T0
      ]);
      expect(allowed.exitCode).toBe(0);
      const allowedReceipt = JSON.parse(allowed.output) as {
        records: { target: string; outcome: string }[];
      };
      const pendingAllowed = allowedReceipt.records.find((r) => r.target === "msg-run-rows");
      expect(pendingAllowed?.outcome).toBe("deleted");

      const db = openDatabase(dbPath);
      try {
        expect(
          Number(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id='msg-run-rows'").get()?.n)
        ).toBe(0);
      } finally {
        db.close();
      }
      expect(existsSync(planFile)).toBe(true);
    } finally {
      removeTreeRobust(store.scratchDir);
    }
  }, 90_000);

  it("maps failures to exit code 1 and usage errors to exit code 2", async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), "ro-maint-cli-err-"));
    cleanup.push(scratch);
    // A database without the daemon schema fails the plan with exit 1.
    const rawDbPath = path.join(scratch, "empty.db");
    const raw = openDatabase(rawDbPath);
    raw.close();
    const fail = await runMaintenanceCli(["cleanup-plan", "--db", rawDbPath, "--now", T0]);
    expect(fail.exitCode).toBe(1);
    expect(JSON.parse(fail.output)).toMatchObject({ error: "DatabaseSchemaError" });

    const usage = await runMaintenanceCli(["definitely-not-a-command"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.output).toContain("usage");
  }, 60_000);
});
