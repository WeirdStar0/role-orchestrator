/**
 * Migration 014: the standalone chain applies 001+002+003+014 in order,
 * verifies against its checksums, composes after a fuller chain, and the
 * schema_migrations bookkeeping rejects re-application and history gaps
 * loudly.
 */
import { describe, expect, it } from "vitest";
import { MigrationError, verifyMigrations, appliedMigrationRecords, openDatabase } from "@role-orchestrator/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUDGET_MIGRATIONS,
  BUDGET_SCHEMA_MIGRATION,
  applyBudgetMigrations,
  budgetTablesPresent,
  tableExists
} from "../src/index.js";
import { T0 } from "./helpers.js";

describe("migration 014 chain", () => {
  it("applies 001..003+014 and verifies its checksums", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ro-budget-mig-")), "test.db");
    const db = openDatabase(dbPath);
    try {
      const applied = await applyBudgetMigrations(db, { now: T0 });
      expect(applied.appliedVersions).toEqual([1, 2, 3, 14]);
      expect(verifyMigrations(db, { migrations: BUDGET_MIGRATIONS })).toEqual({
        ok: true,
        checked: 4,
        versions: [1, 2, 3, 14]
      });
      // All four budget tables exist (created in ONE transaction).
      for (const table of ["node_retry_state", "run_budgets", "execution_usage", "budget_run_holds"]) {
        expect(tableExists(db, table)).toBe(true);
      }
      expect(budgetTablesPresent(db)).toBe(true);

      // Re-application is a no-op, and the migration record is unique.
      const again = await applyBudgetMigrations(db, { now: T0 });
      expect(again.appliedVersions).toEqual([]);
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([1, 2, 3, 14]);
    } finally {
      db.close();
    }
  });

  it("composes cleanly after a fuller chain (version 14 stays the last entry)", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ro-budget-mig-compose-")), "test.db");
    const db = openDatabase(dbPath);
    try {
      // A scheduler-shaped chain (001..004) followed by the budget migration:
      // exactly the composition scheduler consumers use.
      const composed = [
        ...BUDGET_MIGRATIONS.filter((migration) => migration.version !== 14),
        {
          version: 4,
          name: "004-scheduler-stand-in",
          upSql: "CREATE TABLE scheduler_queue (id TEXT PRIMARY KEY);"
        },
        BUDGET_SCHEMA_MIGRATION
      ];
      const applied = await applyBudgetMigrations(db, { now: T0, migrations: composed });
      expect(applied.appliedVersions).toEqual([1, 2, 3, 4, 14]);
      expect(verifyMigrations(db, { migrations: composed })).toMatchObject({ ok: true });
      expect(budgetTablesPresent(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("fails loudly on a history gap instead of filling one in", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "ro-budget-mig-gap-")), "test.db");
    const db = openDatabase(dbPath);
    try {
      // A database that jumped straight to 014 (versions [1, 14]) cannot be
      // completed by the full chain afterwards: 002/003 are below the
      // highest applied version 14 without records — the store's gap check
      // refuses rather than producing a partially-migrated database.
      await applyBudgetMigrations(db, {
        now: T0,
        migrations: [BUDGET_MIGRATIONS[0]!, BUDGET_SCHEMA_MIGRATION]
      });
      expect(appliedMigrationRecords(db).map((record) => record.version)).toEqual([1, 14]);
      await expect(applyBudgetMigrations(db, { now: T0, migrations: BUDGET_MIGRATIONS })).rejects.toThrow(
        MigrationError
      );
    } finally {
      db.close();
    }
  });
});
