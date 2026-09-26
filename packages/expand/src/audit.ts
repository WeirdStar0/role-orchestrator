/**
 * M5-02 — the expansion request audit (docs/ACCEPTANCE.md A04: "disabled
 * 子任务权限发起扩图 → 拒绝并记录原因").
 *
 * `expansion_request_audit` is an APPEND-ONLY trail of every expansion
 * request that went through the controlled entry (`requestControlledExpansion`),
 * recording WHO requested (`requester_role`), FOR WHICH trigger (review node +
 * candidateSha), against WHICH graph revision, and WHAT happened:
 * - `granted` — the permission gate passed and the M4-03 protocol minted (or
 *   idempotently replayed) the fix/re-review pair; the row is what the UI's
 *   Proposal display reads the requester ("谁请求") from;
 * - `denied-permission` — the A04 refusal. The row is written in its OWN
 *   transaction BEFORE the typed `ExpansionPermissionDeniedError` is thrown,
 *   so the reason survives the rejection (a refusal that erased its own
 *   evidence would not be an audit).
 *
 * A04 requires the durable reason, and the UI must be able to show the
 * requester of an executed expansion; both live here. The expansion row
 * itself (`review_expansions`) stays the authoritative record of WHAT was
 * minted — this table only answers who/why/when.
 *
 * Migration 017 composes on top of the 013 expansion schema; the combined
 * M5-02 chain lives in `CONTROLLED_EXPANSION_MIGRATIONS` (controlled.ts).
 */
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import { CommitShaSchema } from "@role-orchestrator/integration";
import { withTransaction, TimestampSchema } from "@role-orchestrator/store";
import type { MigrationDefinition } from "@role-orchestrator/store";

export const EXPANSION_AUDIT_OUTCOMES = ["granted", "denied-permission"] as const;
export type ExpansionAuditOutcome = (typeof EXPANSION_AUDIT_OUTCOMES)[number];

/**
 * Machine-readable denial reasons. `binding-missing` — the run's project has
 * no role_bindings row for the requester (fail-closed: an unresolvable role
 * has no permission); `can-create-subtasks-disabled` — the row exists but the
 * A01 binding table says this role may not create subtasks.
 */
export const EXPANSION_DENIAL_REASONS = [
  "binding-missing",
  "can-create-subtasks-disabled"
] as const;
export type ExpansionDenialReason = (typeof EXPANSION_DENIAL_REASONS)[number];

const EXPANSION_AUDIT_SQL = `
CREATE TABLE expansion_request_audit (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  requester_role TEXT NOT NULL CHECK (requester_role IN ('coordinator', 'architect', 'developer', 'reviewer')),
  review_node_id TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  expected_graph_revision INTEGER NOT NULL CHECK (expected_graph_revision >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('granted', 'denied-permission')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL
) STRICT;

-- The audit of one run is read in insertion order (the per-run sequence is
-- embedded in the id); the index keeps the run page cheap.
CREATE INDEX ix_expansion_request_audit_run
  ON expansion_request_audit(run_id, created_at, id);
`.trim();

export const EXPANSION_REQUEST_AUDIT_MIGRATION: MigrationDefinition = {
  version: 17,
  name: "017-expansion-request-audit",
  upSql: EXPANSION_AUDIT_SQL
};

export interface ExpansionRequestAuditRow {
  readonly id: string;
  readonly runId: string;
  readonly requesterRole: RoleId;
  readonly reviewNodeId: string;
  readonly candidateSha: string;
  readonly expectedGraphRevision: number;
  readonly outcome: ExpansionAuditOutcome;
  /** Human-readable reason (<=2000 chars): why granted, or why denied. */
  readonly reason: string;
  readonly createdAt: string;
}

interface RawRowShape {
  [key: string]: unknown;
}

const RecordAuditInputSchema = z.strictObject({
  runId: IdSchema,
  requesterRoleId: RoleIdSchema,
  reviewNodeId: IdSchema,
  candidateSha: CommitShaSchema,
  expectedGraphRevision: z.number().int().min(0),
  outcome: z.enum(EXPANSION_AUDIT_OUTCOMES),
  reason: z.string().min(1).max(2000),
  now: TimestampSchema
});

export type RecordExpansionRequestAuditInput = z.input<typeof RecordAuditInputSchema>;

/** Zero-padded per-run audit sequence embedded in the id (memory-search pattern). */
function nextAuditSeq(db: DatabaseSync, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM expansion_request_audit WHERE run_id = ?")
    .get(runId) as { readonly n: unknown };
  const count = Number(row.n);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`expansion audit sequence lookup for run "${runId}" returned "${String(row.n)}"`);
  }
  return count + 1;
}

function mapAuditRow(row: RawRowShape): ExpansionRequestAuditRow {
  const outcome = z.enum(EXPANSION_AUDIT_OUTCOMES).parse(row["outcome"]);
  const role = RoleIdSchema.safeParse(row["requester_role"]);
  if (!role.success) {
    // Only reachable if the CHECK constraint was removed by direct tampering.
    throw new Error(`expansion audit row carries impossible role "${String(row["requester_role"])}"`);
  }
  return {
    id: z.string().min(1).parse(row["id"]),
    runId: IdSchema.parse(row["run_id"]),
    requesterRole: role.data,
    reviewNodeId: IdSchema.parse(row["review_node_id"]),
    candidateSha: CommitShaSchema.parse(row["candidate_sha"]),
    expectedGraphRevision: z.number().int().min(0).parse(row["expected_graph_revision"]),
    outcome,
    reason: z.string().min(1).max(2000).parse(row["reason"]),
    createdAt: z.string().min(1).parse(row["created_at"])
  };
}

/**
 * Append ONE audit row in its own transaction. Used for BOTH outcomes; the
 * denied-permission write deliberately happens before the typed error is
 * thrown so the recorded reason survives the rejection (A04).
 */
export function recordExpansionRequestAudit(
  db: DatabaseSync,
  input: RecordExpansionRequestAuditInput
): ExpansionRequestAuditRow {
  const value = RecordAuditInputSchema.parse(input);
  return withTransaction(db, () => {
    const id = `${value.runId}#xaudit${String(nextAuditSeq(db, value.runId)).padStart(4, "0")}`;
    db.prepare(
      "INSERT INTO expansion_request_audit(id, run_id, requester_role, review_node_id, candidate_sha, " +
        "expected_graph_revision, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      value.runId,
      value.requesterRoleId,
      value.reviewNodeId,
      value.candidateSha,
      value.expectedGraphRevision,
      value.outcome,
      value.reason,
      value.now
    );
    const row = db.prepare("SELECT * FROM expansion_request_audit WHERE id = ?").get(id) as
      | RawRowShape
      | undefined;
    if (row === undefined) {
      throw new Error(`expansion audit row "${id}" vanished immediately after insert`);
    }
    return mapAuditRow(row);
  });
}

/** The run's audit trail, oldest first. */
export function listRunExpansionRequestAudit(
  db: DatabaseSync,
  runId: string
): readonly ExpansionRequestAuditRow[] {
  const parsedRunId = IdSchema.parse(runId);
  const rows = db
    .prepare(
      "SELECT * FROM expansion_request_audit WHERE run_id = ? ORDER BY created_at ASC, id ASC"
    )
    .all(parsedRunId) as RawRowShape[];
  return rows.map(mapAuditRow);
}
