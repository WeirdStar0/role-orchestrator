import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@role-orchestrator/contracts";
import type { CapabilityStatus } from "@role-orchestrator/capability-gate";
import { transitionNodeState } from "@role-orchestrator/dag";
import {
  MAX_NODE_ATTEMPTS,
  AttemptCapExceededSignal,
  BudgetExceededSignal,
  evaluateDispatchBudgetGate,
  recordBudgetRunHold,
  recordDispatchConsumption
} from "@role-orchestrator/budget";
import { getProfile, readRunRoleProfile, type ProfileRow } from "@role-orchestrator/runtime-profile";
import {
  createActiveAttempt,
  enqueueOutboxMessage,
  getTaskRun,
  listAttemptsForSlot,
  optStr,
  reqInt,
  reqStr,
  TimestampSchema,
  withTransaction,
  type Row
} from "@role-orchestrator/store";
import {
  InvalidQueueEntryStateError,
  RunHeldError,
  SchedulerError,
  UnknownProfileError,
  UnknownQueueEntryError,
  UnknownRunError
} from "../errors.js";
import { derivedId } from "../ids.js";
import { credentialGroupMax, evaluateDispatchGate, parseConcurrencyPolicy } from "../policy.js";
import {
  GLOBAL_RESOURCE_KEY,
  credentialResourceKey,
  profileResourceKey,
  projectResourceKey,
  type QuotaDimension
} from "../keys.js";
import { listRunSchedulingHolds } from "./holds.js";
import {
  QuotaFullSignal,
  releaseExpiredQuotaGrants,
  acquireQuotaSlotsInTransaction,
  type QuotaBlockedBy
} from "./quota-grants.js";

/**
 * The fair READY queue (migration 004) and the M2-02 dispatch claim.
 *
 * Fairness contract (ORCHESTRATION.md section 4: "READY 队列先按优先级再按
 * 等待时间排序，设置 starvation 上限"):
 * - candidates poll in `priority ASC, enqueued_at ASC, id ASC` order —
 *   priority first, wait time second, so same-priority entries cannot
 *   starve each other;
 * - entries waiting strictly longer than `starvationMs` are promoted AHEAD
 *   of the priority order (oldest aged entry first) — the starvation bound.
 *   A saturated profile's backlog therefore cannot hold the queue forever.
 *
 * No-loss / no-duplicate contract: a quota-rejected entry STAYS `WAITING`
 * (its node stays READY in task_nodes), gains `attempts+1` and a
 * `not_before` retry window; rows are keyed `UNIQUE(run_id, node_id)` so
 * re-enqueueing absorbs duplicates. A gate-blocked entry is recorded
 * `GATE_BLOCKED` with the reason — rejected, never silently dropped.
 *
 * Dispatch claim — ONE `withTransaction` per entry, the transaction shape of
 * ORCHESTRATION.md section 4 (检查配额 -> lease -> execution -> dispatch
 * outbox): insert fencing grants -> create the active attempt -> READY ->
 * RUNNING node transition -> queue row DISPATCHED -> dispatch outbox
 * message. A full quota raises `QuotaFullSignal` and rolls the WHOLE claim
 * back; nothing is ever half-claimed.
 *
 * M4-04 additions (A21/A22/A37), all fail-closed and recorded:
 * - a run held for user disposition enqueues nothing (`RunHeldError`) and
 *   its WAITING entries are blocked at dispatch (`run-held`);
 * - an enrolled run budget is checked before the claim and consumed INSIDE
 *   the claim transaction (`BudgetExceededSignal` rolls the claim back);
 * - the A21 attempt cap re-reads the slot's attempt count under the write
 *   lock — a fourth attempt is refused for ANY reason and recorded
 *   `attempt-cap`.
 */

export const QUEUE_ENTRY_STATES = [
  "WAITING",
  "DISPATCHED",
  "COMPLETED",
  "GATE_BLOCKED",
  "CANCELLED"
] as const;
export type QueueEntryState = (typeof QUEUE_ENTRY_STATES)[number];
export const QueueEntryStateSchema = z.enum(QUEUE_ENTRY_STATES);

export interface QueueEntryRow {
  readonly id: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly projectId: string;
  readonly profileId: string;
  readonly credentialGroup: string;
  readonly requiredCapability: string | null;
  readonly priority: number;
  readonly state: QueueEntryState;
  readonly attempts: number;
  readonly notBefore: string;
  readonly executionId: string | null;
  readonly lastReason: string | null;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
}

const EnqueueInputSchema = z.strictObject({
  runId: IdSchema,
  now: TimestampSchema,
  /** Lower value = scheduled earlier. Defaults to 100 (ordinary work). */
  priority: z.number().int().min(0).max(1000).default(100),
  /**
   * Optional capability-matrix cell id this run's nodes additionally require
   * (checked per dispatch by the capability gate). Null = entry-point check
   * only.
   */
  requiredCapability: z.string().min(1).max(120).nullable().default(null)
});

export type EnqueueReadyNodesInput = z.input<typeof EnqueueInputSchema>;

export interface EnqueueReadyNodesResult {
  /** Rows created by THIS call, in task_nodes order. */
  readonly enqueued: readonly QueueEntryRow[];
  /** READY nodes that already had a queue row (absorbed — no duplicates). */
  readonly alreadyQueued: number;
}

/**
 * Enqueue every READY node of a run that has no queue row yet. Project,
 * profile and credential group come from the FROZEN run snapshot (A34 read
 * path: `run_profile_snapshots` via runtime-profile), never from current
 * bindings.
 *
 * M4-04 强制点: a run held for user disposition (an unresolved
 * expansion_user_holds row or a scheduling-blocking budget hold) enqueues
 * NOTHING — the typed `RunHeldError` fires before any row is written.
 */
export function enqueueReadyNodes(db: DatabaseSync, input: EnqueueReadyNodesInput): EnqueueReadyNodesResult {
  const value = EnqueueInputSchema.parse(input);
  const run = getTaskRun(db, value.runId);
  if (run === null) {
    throw new UnknownRunError(value.runId);
  }
  const holds = listRunSchedulingHolds(db, value.runId);
  if (holds.length > 0) {
    throw new RunHeldError(value.runId, holds);
  }
  const readyNodes = db
    .prepare(
      "SELECT node_id, role_id FROM task_nodes WHERE run_id = ? AND state = 'READY' ORDER BY node_id ASC"
    )
    .all(value.runId);
  const enqueued: QueueEntryRow[] = [];
  let alreadyQueued = 0;
  for (const node of readyNodes) {
    const nodeId = reqStr(node, "node_id");
    const roleId = reqStr(node, "role_id");
    const entryId = derivedId("q", value.runId, nodeId);
    const existing = db.prepare("SELECT * FROM scheduler_queue WHERE id = ?").get(entryId);
    if (existing !== undefined) {
      alreadyQueued += 1;
      continue;
    }
    // Frozen snapshot for this run's role -> profile (fails closed when the
    // snapshot is missing: UnknownRunSnapshotError from runtime-profile).
    const resolution = readRunRoleProfile(db, { runId: value.runId, roleId });
    const profileId = resolution.snapshot.id;
    const profile = getProfile(db, profileId);
    if (profile === null) {
      throw new UnknownProfileError(profileId);
    }
    db.prepare(
      "INSERT INTO scheduler_queue(id, run_id, node_id, project_id, profile_id, credential_group, required_capability, " +
        "priority, state, attempts, not_before, execution_id, last_reason, enqueued_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', 0, ?, NULL, NULL, ?, ?)"
    ).run(
      entryId,
      value.runId,
      nodeId,
      run.projectId,
      profile.id,
      profile.credentialGroup,
      value.requiredCapability,
      value.priority,
      value.now,
      value.now,
      value.now
    );
    const row = db.prepare("SELECT * FROM scheduler_queue WHERE id = ?").get(entryId);
    if (row === undefined) {
      throw new UnknownQueueEntryError(entryId);
    }
    enqueued.push(mapQueueRow(row));
  }
  return { enqueued, alreadyQueued };
}

function mapQueueRow(row: Row): QueueEntryRow {
  return {
    id: reqStr(row, "id"),
    runId: reqStr(row, "run_id"),
    nodeId: reqStr(row, "node_id"),
    projectId: reqStr(row, "project_id"),
    profileId: reqStr(row, "profile_id"),
    credentialGroup: reqStr(row, "credential_group"),
    requiredCapability: optStr(row, "required_capability"),
    priority: reqInt(row, "priority"),
    state: QueueEntryStateSchema.parse(reqStr(row, "state")),
    attempts: reqInt(row, "attempts"),
    notBefore: reqStr(row, "not_before"),
    executionId: optStr(row, "execution_id"),
    lastReason: optStr(row, "last_reason"),
    enqueuedAt: reqStr(row, "enqueued_at"),
    updatedAt: reqStr(row, "updated_at")
  };
}

export function getQueueEntry(db: DatabaseSync, entryId: string): QueueEntryRow | null {
  const row = db.prepare("SELECT * FROM scheduler_queue WHERE id = ?").get(IdSchema.parse(entryId));
  return row === undefined ? null : mapQueueRow(row);
}

export function requireQueueEntry(db: DatabaseSync, entryId: string): QueueEntryRow {
  const entry = getQueueEntry(db, entryId);
  if (entry === null) {
    throw new UnknownQueueEntryError(entryId);
  }
  return entry;
}

export function listQueueEntries(
  db: DatabaseSync,
  options: { readonly state?: QueueEntryState } = {}
): readonly QueueEntryRow[] {
  const state = options.state === undefined ? undefined : QueueEntryStateSchema.parse(options.state);
  const rows =
    state === undefined
      ? db.prepare("SELECT * FROM scheduler_queue ORDER BY enqueued_at ASC, id ASC").all()
      : db
          .prepare("SELECT * FROM scheduler_queue WHERE state = ? ORDER BY enqueued_at ASC, id ASC")
          .all(state);
  return rows.map(mapQueueRow);
}

// ---------------------------------------------------------------------------
// Dispatch outcomes
// ---------------------------------------------------------------------------

export interface FencingRecord {
  readonly dimension: QuotaDimension;
  readonly resourceKey: string;
  readonly fencingToken: number;
}

export interface DispatchedOutcome {
  readonly kind: "dispatched";
  readonly entryId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly executionId: string;
  readonly dispatchToken: string;
  /** Fencing tokens per resource key, as granted in the claim transaction. */
  readonly fencing: readonly FencingRecord[];
}

export interface QuotaRejectedOutcome {
  readonly kind: "quota-rejected";
  readonly entryId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attempts: number;
  /** Earliest time the entry becomes poll-eligible again (retry window). */
  readonly retryNotBefore: string;
  readonly blockedBy: QuotaBlockedBy;
}

export interface GateBlockedOutcome {
  readonly kind: "gate-blocked";
  readonly entryId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly capability: string;
  readonly status: CapabilityStatus;
  readonly reason: string;
}

/**
 * M4-04 pre-dispatch refusals that are recorded on the queue row as
 * GATE_BLOCKED with a structured reason (the entry is never silently
 * dropped):
 *
 * - `attempt-cap`  the claim would create an attempt beyond
 *                  MAX_NODE_ATTEMPTS = 3 (A21) — refused INSIDE the claim
 *                  transaction, so even a queue row that reached WAITING by
 *                  mistake can never mint a fourth attempt;
 * - `budget`       the run's enrolled budget (nodes/executions/duration/
 *                  undetermined usage, A37) refused the dispatch; the
 *                  matching budget hold is recorded for the user;
 * - `run-held`     the run is held for user disposition (expansion hold /
 *                  usage-undetermined) — nothing dispatches until a human
 *                  resolves the hold.
 */
export interface DispatchBlockedOutcome {
  readonly kind: "attempt-cap" | "budget" | "run-held";
  readonly entryId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly reason: string;
}

export interface PollQueueResult {
  /** Grants freed by the leading explicit reconcile step. */
  readonly releasedExpiredGrants: number;
  /** Candidates examined (WAITING and due). */
  readonly scanned: number;
  readonly dispatched: readonly DispatchedOutcome[];
  readonly quotaRejected: readonly QuotaRejectedOutcome[];
  readonly gateBlocked: readonly GateBlockedOutcome[];
  /** M4-04 refusals: A21 attempt cap, run budget, or a held run. */
  readonly blocked: readonly DispatchBlockedOutcome[];
}

const PollInputSchema = z.strictObject({
  now: TimestampSchema,
  /** Grant expiry window ("lease"): an unreleased grant counts until this passes AND reconcile runs. */
  leaseMs: z.number().int().min(1).max(86_400_000),
  /** Backoff window applied to quota-rejected entries before they are poll-eligible again. */
  retryWindowMs: z.number().int().min(0).max(3_600_000),
  /** Starvation bound: entries waiting strictly longer than this poll before higher priorities. */
  starvationMs: z.number().int().min(0).max(86_400_000),
  /** Maximum entries dispatched by ONE poll call. */
  limit: z.number().int().min(1).max(100).default(8),
  /**
   * RAW `policies.concurrency` — strict-parsed against the frozen contracts
   * schema (`globalMax`, `projectMax`, `unverifiedCredentialGroupMax: 1`).
   * Unknown fields or out-of-range maxima abort the whole poll BEFORE any
   * state changes.
   */
  concurrency: z.unknown()
});

export type PollQueueInput = z.input<typeof PollInputSchema>;

/** Per-entry quota slots as resolved from policy + profile configuration. */
export interface EntryQuotaSlots {
  readonly slots: readonly {
    readonly dimension: QuotaDimension;
    readonly resourceKey: string;
    readonly max: number;
  }[];
  /** Null when credential isolation is verified (dimension not enforced). */
  readonly credentialMax: number | null;
}

/**
 * Resolve one entry's quota slots: global from `globalMax`, project from
 * `projectMax`, profile from `profiles.max_concurrency`, credentialGroup
 * from `unverifiedCredentialGroupMax` — the last only while the runtime's
 * `credential-isolation` capability is unverified (A33); a verified
 * isolation drops the credential dimension instead of double-counting the
 * profile quota. The three levels are checked SIMULTANEOUSLY by the claim
 * transaction — never collapsed into a single `min()` (ORCHESTRATION.md
 * section 4).
 */
export function resolveEntryQuotaSlots(
  policy: {
    readonly globalMax: number;
    readonly projectMax: number;
    readonly unverifiedCredentialGroupMax: 1;
  },
  profile: Pick<ProfileRow, "id" | "runtime" | "maxConcurrency" | "credentialGroup">,
  projectId: string
): EntryQuotaSlots {
  const slots: { dimension: QuotaDimension; resourceKey: string; max: number }[] = [
    { dimension: "global", resourceKey: GLOBAL_RESOURCE_KEY, max: policy.globalMax },
    { dimension: "project", resourceKey: projectResourceKey(projectId), max: policy.projectMax },
    { dimension: "profile", resourceKey: profileResourceKey(profile.id), max: profile.maxConcurrency }
  ];
  const credentialMax = credentialGroupMax(profile.runtime, policy.unverifiedCredentialGroupMax);
  if (credentialMax !== null) {
    slots.push({
      dimension: "credential",
      resourceKey: credentialResourceKey(profile.credentialGroup),
      max: credentialMax
    });
  }
  return { slots, credentialMax };
}

/**
 * One scheduler tick. See the module contract above for fairness and
 * no-loss/no-duplicate semantics. The policy is parsed BEFORE the leading
 * reconcile step, so an invalid policy changes nothing at all.
 */
export function pollQueue(db: DatabaseSync, input: PollQueueInput): PollQueueResult {
  const value = PollInputSchema.parse(input);
  const policy = parseConcurrencyPolicy(value.concurrency);

  // Explicit reconcile step FIRST (mirrors `releaseExpiredLeases`): expired
  // grants occupy their slots until this frees them; the poll frees them
  // before counting, so a recovered queue actually recovers.
  const releasedExpiredGrants = releaseExpiredQuotaGrants(db, { now: value.now });

  const candidates = db
    .prepare(
      "SELECT * FROM scheduler_queue WHERE state = 'WAITING' AND not_before <= ? " +
        "ORDER BY priority ASC, enqueued_at ASC, id ASC LIMIT 1024"
    )
    .all(value.now);
  const entries = (candidates as Row[]).map(mapQueueRow);

  // Starvation bound: entries older than `starvationMs` jump the priority
  // queue (oldest aged entry first); everyone else keeps the fair order.
  const starvationDeadline = new Date(Date.parse(value.now) - value.starvationMs).toISOString();
  const ordered = [...entries].sort((a, b) => {
    const aAged = a.enqueuedAt < starvationDeadline ? 0 : 1;
    const bAged = b.enqueuedAt < starvationDeadline ? 0 : 1;
    if (aAged !== bAged) return aAged - bAged;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const dispatched: DispatchedOutcome[] = [];
  const quotaRejected: QuotaRejectedOutcome[] = [];
  const gateBlocked: GateBlockedOutcome[] = [];
  const blocked: DispatchBlockedOutcome[] = [];

  for (const entry of ordered) {
    if (dispatched.length >= value.limit) {
      break;
    }
    const profile = getProfile(db, entry.profileId);
    if (profile === null) {
      throw new UnknownProfileError(entry.profileId);
    }

    // 0. Run holds (M4-04 强制点): a held run's WAITING entries are blocked
    //    and recorded — never silently dropped, never dispatched.
    const holds = listRunSchedulingHolds(db, entry.runId);
    if (holds.length > 0) {
      const reason = `run-held:${holds.map((hold) => `${hold.source}:${hold.reason}`).join(",")}`;
      const updated = db
        .prepare(
          "UPDATE scheduler_queue SET state = 'GATE_BLOCKED', last_reason = ?, updated_at = ? " +
            "WHERE id = ? AND state = 'WAITING'"
        )
        .run(reason, value.now, entry.id);
      if (Number(updated.changes) === 1) {
        blocked.push({
          kind: "run-held",
          entryId: entry.id,
          runId: entry.runId,
          nodeId: entry.nodeId,
          reason
        });
      }
      continue;
    }

    // The attempt this dispatch WOULD create; the authoritative re-read
    // happens again inside the claim transaction (under the write lock).
    const nextAttempt = listAttemptsForSlot(db, { runId: entry.runId, nodeId: entry.nodeId }).length + 1;

    // 0b. Run budget gate (M4-04, A37): read-only pre-check; the binding
    //     consumption happens inside the claim transaction below.
    const budgetGate = evaluateDispatchBudgetGate(db, {
      runId: entry.runId,
      attempt: nextAttempt,
      now: value.now
    });
    if (budgetGate.managed && !budgetGate.allowed) {
      if (budgetGate.reason === "usage-undetermined") {
        // A37 pause: the run waits for the user behind the hold, but the
        // entry itself stays WAITING — resolving the hold (the human's
        // acceptance of unknown cost) lets the very next poll dispatch it.
        db.prepare(
          "UPDATE scheduler_queue SET last_reason = ?, updated_at = ? WHERE id = ? AND state = 'WAITING'"
        ).run(`budget:${budgetGate.reason}`, value.now, entry.id);
        recordBudgetRunHold(db, {
          runId: entry.runId,
          reason: budgetGate.reason,
          detail: { entryId: entry.id, nodeId: entry.nodeId, detail: budgetGate.detail },
          now: value.now
        });
        blocked.push({
          kind: "budget",
          entryId: entry.id,
          runId: entry.runId,
          nodeId: entry.nodeId,
          reason: `budget:${budgetGate.reason}`
        });
        continue;
      }
      const reason = `budget:${budgetGate.reason}`;
      const updated = db
        .prepare(
          "UPDATE scheduler_queue SET state = 'GATE_BLOCKED', last_reason = ?, updated_at = ? " +
            "WHERE id = ? AND state = 'WAITING'"
        )
        .run(reason, value.now, entry.id);
      if (Number(updated.changes) === 1) {
        recordBudgetRunHold(db, {
          runId: entry.runId,
          reason: budgetGate.reason,
          detail: { entryId: entry.id, nodeId: entry.nodeId, detail: budgetGate.detail },
          now: value.now
        });
        blocked.push({
          kind: "budget",
          entryId: entry.id,
          runId: entry.runId,
          nodeId: entry.nodeId,
          reason
        });
      }
      continue;
    }

    // 1. Capability gate (fail-closed, BEFORE any quota or state change).
    const gate = evaluateDispatchGate(profile.runtime, entry.requiredCapability);
    if (!gate.allowed) {
      const reason = gate.reason ?? "capability gate rejected the dispatch";
      const updated = db
        .prepare(
          "UPDATE scheduler_queue SET state = 'GATE_BLOCKED', last_reason = ?, updated_at = ? " +
            "WHERE id = ? AND state = 'WAITING'"
        )
        .run(reason, value.now, entry.id);
      if (Number(updated.changes) === 1) {
        gateBlocked.push({
          kind: "gate-blocked",
          entryId: entry.id,
          runId: entry.runId,
          nodeId: entry.nodeId,
          capability: gate.capability,
          status: gate.status,
          reason
        });
      }
      continue;
    }

    // 2..6. The atomic claim (one transaction; QuotaFullSignal and the
    // M4-04 budget/attempt-cap signals roll it all back).
    const { slots } = resolveEntryQuotaSlots(policy, profile, entry.projectId);

    try {
      const outcome = withTransaction(db, () => {
        // M2-04 fix, tightened in M4-04: the dispatch token derives from the
        // ATTEMPT, not just the queue entry, and the attempt count is read
        // UNDER the write lock — so the A21 cap check below is race-free
        // across connections and a retried node can never re-present its
        // predecessor's token.
        const attempt = listAttemptsForSlot(db, { runId: entry.runId, nodeId: entry.nodeId }).length + 1;
        if (attempt > MAX_NODE_ATTEMPTS) {
          throw new AttemptCapExceededSignal(entry.id, attempt - 1);
        }
        const executionId = derivedId("exec", entry.id, String(attempt));
        const dispatchToken = derivedId("dispatch", entry.id, String(attempt));
        const nodeRow = db
          .prepare("SELECT definition_revision FROM task_nodes WHERE run_id = ? AND node_id = ?")
          .get(entry.runId, entry.nodeId);
        if (nodeRow === undefined) {
          throw new UnknownRunError(entry.runId);
        }
        // Budget consumption INSIDE the claim transaction (M4-04): recorded
        // atomically with the claim; a full budget throws
        // BudgetExceededSignal and rolls the whole claim back.
        recordDispatchConsumption(db, {
          runId: entry.runId,
          attempt,
          now: value.now
        });
        // Physical insert order note: the executions row is created BEFORE
        // the grant rows because quota_grants' foreign key to executions is
        // enforced immediately. The quota CHECK (and its QuotaFullSignal
        // rollback) still gates the whole claim — on quota-full the
        // transaction rolls back the execution row too, so the committed
        // state is exactly the ORCHESTRATION.md section-4 claim
        // (检查配额 -> lease -> execution -> outbox) with nothing half-done.
        createActiveAttempt(db, {
          id: executionId,
          runId: entry.runId,
          nodeId: entry.nodeId,
          definitionRevision: reqStr(nodeRow, "definition_revision"),
          attempt,
          dispatchToken,
          phase: "STARTING",
          now: value.now
        });
        const grants = acquireQuotaSlotsInTransaction(db, {
          executionId,
          slots,
          leaseMs: value.leaseMs,
          now: value.now
        });
        // READY -> RUNNING is the scheduler's explicit decision
        // (ORCHESTRATION.md section 3, via dag's guarded transition).
        transitionNodeState(db, {
          runId: entry.runId,
          nodeId: entry.nodeId,
          to: "RUNNING",
          whereStateIn: ["READY"],
          now: value.now
        });
        const marked = db
          .prepare(
            "UPDATE scheduler_queue SET state = 'DISPATCHED', execution_id = ?, last_reason = NULL, updated_at = ? " +
              "WHERE id = ? AND state = 'WAITING'"
          )
          .run(executionId, value.now, entry.id);
        if (Number(marked.changes) !== 1) {
          throw new InvalidQueueEntryStateError(entry.id, ["WAITING"], "not WAITING");
        }
        const fencing: readonly FencingRecord[] = grants.map((grant) => ({
          dimension: grant.dimension,
          resourceKey: grant.resourceKey,
          fencingToken: grant.fencingToken
        }));
        enqueueOutboxMessage(db, {
          id: derivedId("ob", entry.id, executionId),
          aggregateId: executionId,
          type: "scheduler.dispatch",
          payload: {
            queueEntryId: entry.id,
            executionId,
            runId: entry.runId,
            nodeId: entry.nodeId,
            profileId: entry.profileId,
            dispatchToken,
            fencing
          },
          now: value.now
        });
        return {
          kind: "dispatched" as const,
          entryId: entry.id,
          runId: entry.runId,
          nodeId: entry.nodeId,
          executionId,
          dispatchToken,
          fencing
        };
      });
      dispatched.push(outcome);
    } catch (error) {
      if (error instanceof AttemptCapExceededSignal) {
        // A21: the fourth attempt never happens. The entry is recorded
        // GATE_BLOCKED with a structured reason — the run waits for a user
        // decision, it is not retried and not dropped.
        const reason = `attempt-cap:${String(MAX_NODE_ATTEMPTS)}`;
        const updated = db
          .prepare(
            "UPDATE scheduler_queue SET state = 'GATE_BLOCKED', last_reason = ?, updated_at = ? " +
              "WHERE id = ? AND state = 'WAITING'"
          )
          .run(reason, value.now, entry.id);
        if (Number(updated.changes) === 1) {
          blocked.push({
            kind: "attempt-cap",
            entryId: entry.id,
            runId: entry.runId,
            nodeId: entry.nodeId,
            reason
          });
        }
        continue;
      }
      if (error instanceof BudgetExceededSignal) {
        if (error.reason === "usage-undetermined") {
          // A37 pause: the run waits for the user behind the hold, but the
          // entry itself stays WAITING — resolving the hold (the human's
          // acceptance of unknown cost) lets the very next poll dispatch it.
          // A terminal state here would deadlock the run past its only exit.
          db.prepare(
            "UPDATE scheduler_queue SET last_reason = ?, not_before = ?, updated_at = ? " +
              "WHERE id = ? AND state = 'WAITING'"
          )
            .run(`budget:${error.reason}`, value.now, value.now, entry.id);
          recordBudgetRunHold(db, {
            runId: entry.runId,
            reason: error.reason,
            detail: { entryId: entry.id, nodeId: entry.nodeId, detail: error.detail },
            now: value.now
          });
          blocked.push({
            kind: "budget",
            entryId: entry.id,
            runId: entry.runId,
            nodeId: entry.nodeId,
            reason: `budget:${error.reason}`
          });
          continue;
        }
        // A frozen budget ceiling cannot come back within this run: the
        // entry is recorded terminal GATE_BLOCKED (the durable path forward
        // is a new TaskRun, never a limit rewrite).
        const reason = `budget:${error.reason}`;
        const updated = db
          .prepare(
            "UPDATE scheduler_queue SET state = 'GATE_BLOCKED', last_reason = ?, updated_at = ? " +
              "WHERE id = ? AND state = 'WAITING'"
          )
          .run(reason, value.now, entry.id);
        if (Number(updated.changes) === 1) {
          recordBudgetRunHold(db, {
            runId: entry.runId,
            reason: error.reason,
            detail: { entryId: entry.id, nodeId: entry.nodeId, detail: error.detail },
            now: value.now
          });
          blocked.push({
            kind: "budget",
            entryId: entry.id,
            runId: entry.runId,
            nodeId: entry.nodeId,
            reason
          });
        }
        continue;
      }
      if (error instanceof QuotaFullSignal) {
        // The claim rolled back — zero rows persisted. Record the rejection
        // on the queue row (retry window) and move on; other profiles /
        // projects may still have room.
        const retryNotBefore = new Date(Date.parse(value.now) + value.retryWindowMs).toISOString();
        const updated = db
          .prepare(
            "UPDATE scheduler_queue SET attempts = attempts + 1, not_before = ?, last_reason = ?, updated_at = ? " +
              "WHERE id = ? AND state = 'WAITING'"
          )
          .run(retryNotBefore, `quota-full:${error.blockedBy.resourceKey}`, value.now, entry.id);
        if (Number(updated.changes) === 1) {
          quotaRejected.push({
            kind: "quota-rejected",
            entryId: entry.id,
            runId: entry.runId,
            nodeId: entry.nodeId,
            attempts: entry.attempts + 1,
            retryNotBefore,
            blockedBy: error.blockedBy
          });
        }
        continue;
      }
      throw error;
    }
  }

  return {
    releasedExpiredGrants,
    scanned: entries.length,
    dispatched,
    quotaRejected,
    gateBlocked,
    blocked
  };
}

const EntryTransitionInputSchema = z.strictObject({
  entryId: IdSchema,
  now: TimestampSchema
});

/**
 * Mark a DISPATCHED entry COMPLETED (the process finished). Releasing its
 * quota grants is a separate step (`releaseExecutionQuotaGrants`) so a crash
 * between the two is VISIBLE — a completed entry whose grants are still live
 * — and the poll's reconcile step frees them.
 */
export function markQueueEntryCompleted(
  db: DatabaseSync,
  input: { readonly entryId: string; readonly now: string }
): QueueEntryRow {
  const parsed = EntryTransitionInputSchema.parse(input);
  const result = db
    .prepare(
      "UPDATE scheduler_queue SET state = 'COMPLETED', updated_at = ? WHERE id = ? AND state = 'DISPATCHED'"
    )
    .run(parsed.now, parsed.entryId);
  if (Number(result.changes) !== 1) {
    throw entryStateError(db, parsed.entryId, "DISPATCHED");
  }
  return requireQueueEntry(db, parsed.entryId);
}

/** Cancel a WAITING entry explicitly (run cancelled, node blocked, ...). */
export function cancelQueueEntry(
  db: DatabaseSync,
  input: { readonly entryId: string; readonly now: string }
): QueueEntryRow {
  const parsed = EntryTransitionInputSchema.parse(input);
  const result = db
    .prepare(
      "UPDATE scheduler_queue SET state = 'CANCELLED', updated_at = ? WHERE id = ? AND state = 'WAITING'"
    )
    .run(parsed.now, parsed.entryId);
  if (Number(result.changes) !== 1) {
    throw entryStateError(db, parsed.entryId, "WAITING");
  }
  return requireQueueEntry(db, parsed.entryId);
}

function entryStateError(db: DatabaseSync, entryId: string, expected: string): SchedulerError {
  const entry = getQueueEntry(db, entryId);
  if (entry === null) {
    return new UnknownQueueEntryError(entryId);
  }
  return new InvalidQueueEntryStateError(entryId, [expected], entry.state);
}
