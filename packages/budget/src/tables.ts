import type { DatabaseSync } from "node:sqlite";

/**
 * Presence checks for the budget-domain tables (migration 014).
 *
 * The scheduler composes budget enforcement INTO its dispatch transaction,
 * but a database migrated by an older chain (e.g. the scheduler-only
 * 001..004 list) legitimately has no budget tables. Enforcement is
 * presence-tolerant BY DESIGN: absent tables mean "this database's schema
 * predates budget governance" — the universal A21 attempt cap still applies
 * (it needs only `executions`), and the budget-domain checks engage the
 * moment migration 014 is applied. A PARTIALLY migrated database (one budget
 * table without the others) cannot happen: migration 014 creates all four
 * tables in one transaction.
 */
export const BUDGET_TABLES = [
  "node_retry_state",
  "run_budgets",
  "execution_usage",
  "budget_run_holds"
] as const;

export function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name);
  return row?.present === 1;
}

/** True when migration 014 has been applied (any budget table implies all). */
export function budgetTablesPresent(db: DatabaseSync): boolean {
  return tableExists(db, "run_budgets");
}
