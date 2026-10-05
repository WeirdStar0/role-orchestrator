/**
 * M10-04 — migration 018 (task_runs.outcome) on the CONTROLLED chain: an old
 * 017-era database (everything the pre-M10-04 chain had applied, with real
 * rows) upgrades in place — the column appears, existing runs read NULL, the
 * chain verifies, and a re-application is the framework's no-op.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appliedMigrationRecords,
  applyMigrations,
  createProject,
  createTaskRun,
  getTaskRun,
  openDatabase,
  verifyMigrations
} from "@role-orchestrator/store";
import { CONTROLLED_EXPANSION_MIGRATIONS } from "../src/controlled.js";

const T0 = "2026-09-22T00:00:00.000Z";

describe("controlled chain upgrade to 018 (task_runs.outcome)", () => {
  it("upgrades a 017-era database in place and keeps every existing run NULL", async () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ro-expand-018-")), "upgrade.db"));
    try {
      // The OLD chain: everything before 018 (001..013 + 015 + 016 + 017).
      const oldChain = CONTROLLED_EXPANSION_MIGRATIONS.slice(0, -1);
      await applyMigrations(db, { now: T0, migrations: oldChain });
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17
      ]);

      // Real rows written through the real APIs BEFORE the upgrade.
      createProject(db, {
        id: "proj-018",
        repoRoot: mkdtempSync(join(tmpdir(), "ro-expand-018-repo-")),
        executionTarget: "windows-native",
        trustStatus: "requires-user-confirmation",
        now: T0
      });
      createTaskRun(db, {
        id: "run-pre018",
        projectId: "proj-018",
        taskId: "task-pre018",
        graphRevision: 0,
        configSnapshotHash: "h",
        baseSha: "s",
        now: T0
      });

      // The upgrade: 018 applies in place over the recorded chain.
      const result = await applyMigrations(db, {
        now: T0,
        migrations: CONTROLLED_EXPANSION_MIGRATIONS
      });
      expect(result.appliedVersions).toEqual([18]);
      expect(verifyMigrations(db, { migrations: CONTROLLED_EXPANSION_MIGRATIONS })).toEqual({
        ok: true,
        checked: 17,
        versions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18]
      });

      // NULL = in progress, for the row that predates the column.
      const run = getTaskRun(db, "run-pre018");
      expect(run?.status).toBe("PLANNED");
      expect(run?.outcome).toBeNull();

      // Idempotent replay: nothing re-applies.
      const replay = await applyMigrations(db, {
        now: T0,
        migrations: CONTROLLED_EXPANSION_MIGRATIONS
      });
      expect(replay.appliedVersions).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps the composed list ascending and gap-free at 18 entries", () => {
    expect(CONTROLLED_EXPANSION_MIGRATIONS.map((def) => def.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18
    ]);
  });
});
