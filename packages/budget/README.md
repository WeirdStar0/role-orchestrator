# @role-orchestrator/budget

M4-04 — retry classification and resource/cost budgets
(docs/ACCEPTANCE.md A21/A22/A37, docs/ORCHESTRATION.md sections 5/6).

## What this package owns

1. **Retry classification (`retry.ts`)** — the CLOSED
   failure-reason → retry-policy table, fixed as a strict schema:

   | policy               | reasons                                                                 | semantics                                                    |
   | -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
   | `auto`               | `timeout`, `nonzero-exit`, `missing-final-result`, `launch-failed`, `missing-evidence`, `final-result-error` | automatic retry, counted against the A21 attempt cap         |
   | `once-then-manual`   | `protocol-error`, `business-schema-invalid`                              | exactly ONE automatic retry, then a human decides            |
   | `manual`             | `cancelled`, `approval-denied`, `credential-locked`, `process-interrupted-determinate` | never automatic; the node waits for a user decision          |
   | `recovery`           | `outcome-unknown-recovery-required`, `process-observed-running`          | A22 hard stop: the outcome is unknown, NOTHING auto re-runs  |

   Constants: `MAX_NODE_ATTEMPTS = 3` (A21: the FIRST attempt plus at most
   two retries — three TOTAL attempts per node), `MAX_CONDITIONAL_RETRIES = 1`.
   The engine/cli-events vocabularies are pinned to this table at COMPILE
   time by an exhaustiveness test, so a future engine reason cannot exist
   without a classification decision.

2. **`node_retry_state`** (migration `014`) — the per-node retry mirror.
   Attempt counting is grounded in the `executions` table (one row per
   process attempt, the A23 slot rows); the mirror records the latest
   failure's classification and its conditional-retry consumption.
   Constraint-level backstops: `total_attempts <= 3` and
   `conditional_retries_used <= 1` — a writer that bypassed every typed
   check still cannot persist a fourth attempt.

3. **`run_budgets` + the dispatch gate** — per-run budgets in the
   LimitsPolicy vocabulary (max nodes, max executions) plus a wall-clock
   duration ceiling, enrolled ONCE per run (`ensureRunBudget`; limits are
   frozen at enrollment, re-scoping is refused). The scheduler calls
   `evaluateDispatchBudgetGate` before its claim and
   `recordDispatchConsumption` INSIDE the claim transaction — a full budget
   raises `BudgetExceededSignal` and rolls the whole claim back (the
   `QuotaFullSignal` shape).

4. **`execution_usage` (A37)** — a missing usage report is recorded
   EXPLICITLY as `usage_status='unavailable'` with all numerics NULL. The
   migration's pairing CHECKs make a 0-fill structurally impossible, and the
   typed read-back (`getExecutionUsage`) exposes NO numbers for an
   unavailable record. A35 boundary: usage exists only for DAG-visible
   executions; CLI-internal activity (sub-agents, MCP) is invisible to this
   ledger and is therefore never counted and never guessed as 0 — that
   control point is the capability gate and the scheduler quota.

5. **`budget_run_holds`** — the durable "wait for the user" state. Reasons:
   `attempts-exhausted`, `node-budget-exhausted`,
   `execution-budget-exhausted`, `duration-budget-exhausted`,
   `usage-undetermined`. One row per (run, reason); only
   `resolveBudgetRunHold` — the human's explicit disposition — resolves a
   hold. Enforcement vs. traceability, precisely:
   - `usage-undetermined`: when a run's undeterminable-usage count reaches
     its enrolled threshold, dispatches are REFUSED and the run pauses; the
     hold's resolution (acceptance of unknown cost) is the ONLY exit — the
     usage stays displayed as unavailable, never re-priced to 0.
   - the ceiling holds: their enforcement lives in the frozen caps
     themselves (resolving changes nothing; the path forward is a new
     TaskRun). They do NOT block the run's independent scheduling.
   - `attempts-exhausted`: recorded for traceability; the A21 cap is
     enforced at the dispatch claim regardless.

## Enforcement points (scheduler composition)

`@role-orchestrator/scheduler` composes this package (see its README):

- enqueue of a run blocked by a scheduling hold (expansion hold or
  `usage-undetermined`) → typed `RunHeldError`, nothing written;
- dispatch of such a run's WAITING entries → blocked and recorded;
- the A21 cap re-reads the attempt count inside the claim transaction — a
  fourth attempt is impossible from any path;
- budget consumption is written inside the claim transaction (atomic with
  the attempt row, the quota grants and the outbox message).

The requeue-to-WAITING flow itself (`requeueForRetry`) lives in the
scheduler because the queue is its table; every gate it applies comes from
this package.

## Migrations

Standalone chain (core + profiles + task_nodes + budget):

```ts
import { applyBudgetMigrations } from "@role-orchestrator/budget";
await applyBudgetMigrations(db); // versions 1, 2, 3, 14
```

Full-chain consumers append migration 014 after their own list:

```ts
import { applyMigrations } from "@role-orchestrator/store";
import { BUDGET_SCHEMA_MIGRATION } from "@role-orchestrator/budget";
await applyMigrations(db, { migrations: [...EXPAND_MIGRATIONS, BUDGET_SCHEMA_MIGRATION] });
```

Migration 014 is atomic (one transaction, four tables); presence checks
(`budgetTablesPresent`) keep older scheduler-only databases working, with
the universal A21 attempt cap still enforced there.

## Tests

`pnpm test` in this package covers: the full classification matrix and its
strictness, aggregation worst-wins, eligibility bounds (A21 cap, conditional
budget), the mirror's upsert/cap/tamper behavior, budget enrollment and all
four gate refusals, the A37 unavailable-not-zero invariant at the storage
layer, hold absorption/resolution semantics, and the migration chain
(apply, verify, composition, history-gap refusal).
