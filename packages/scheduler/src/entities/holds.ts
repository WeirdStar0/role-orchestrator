import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import { listUnresolvedBudgetHolds, budgetTablesPresent } from "@role-orchestrator/budget";

/**
 * Run-hold visibility for the scheduler (M4-04 强制点).
 *
 * Two hold sources gate run scheduling:
 *
 * - `expansion_user_holds` (migration 013, expand package) — the refused
 *   fourth review round of A20. The scheduler reads the durable table
 *   directly: the composed migration chain every scheduler consumer uses
 *   guarantees its presence, and the presence check keeps scheduler-only
 *   databases (001..004) working unchanged.
 * - `budget_run_holds` (migration 014, budget package) — read through
 *   `@role-orchestrator/budget`'s own query, so the hold semantics stay in
 *   the package that owns the table.
 *
 * Only holds that genuinely pause the RUN block scheduling: the expansion
 * hold (the graph integrity itself is in question) and the
 * `usage-undetermined` budget hold (the run's cost is undeterminable, A37).
 * The other budget holds (attempts exhausted, ceiling reached) are recorded
 * for traceability but their enforcement lives in the corresponding cap
 * checks — a node exhausting its attempts must not starve an independent
 * branch of the same run.
 */

export interface RunSchedulingHold {
  readonly source: "expansion" | "budget";
  readonly reason: string;
  readonly holdId: string;
  readonly createdAt: string;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(name);
  return row?.present === 1;
}

/** All unresolved holds of the run that block run scheduling. */
export function listRunSchedulingHolds(db: DatabaseSync, runId: string): readonly RunSchedulingHold[] {
  const parsedRunId = IdSchema.parse(runId);
  const holds: RunSchedulingHold[] = [];

  if (tableExists(db, "expansion_user_holds")) {
    const rows = db
      .prepare(
        "SELECT id, reason, created_at FROM expansion_user_holds " +
          "WHERE run_id = ? AND resolved_at IS NULL ORDER BY created_at ASC, id ASC"
      )
      .all(parsedRunId) as { id: string; reason: string; created_at: string }[];
    for (const row of rows) {
      holds.push({
        source: "expansion",
        reason: row.reason,
        holdId: row.id,
        createdAt: row.created_at
      });
    }
  }

  if (budgetTablesPresent(db)) {
    for (const hold of listUnresolvedBudgetHolds(db, parsedRunId)) {
      if (hold.blocksScheduling) {
        holds.push({
          source: "budget",
          reason: hold.reason,
          holdId: hold.id,
          createdAt: hold.createdAt
        });
      }
    }
  }

  return holds;
}
