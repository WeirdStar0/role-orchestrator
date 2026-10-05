/**
 * M10-02 M10 (rework-driver) — the OPTIONAL rework phase for multi-node
 * graphs, extracted from the dogfood driver's expansion segment and
 * de-dogfooded (M10-02 step 3). A review FAIL verdict (M8) grounds a
 * CONTROLLED expansion: the requester (a role with canCreateSubtasks, A04)
 * mints the fix/re-review node pair at a NEW graph revision.
 *
 * GUARD (A38, task-3): the optimistic lock is taken HERE, at the call
 * instant — the driver reads the run's CURRENT graphRevision and hands it to
 * the expansion service as expectedGraphRevision. A composition root cannot
 * supply (or stale-supply) the revision: the lock cannot be bypassed, and
 * the expansion service re-validates against the stored revision.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { getTaskRun } from "@role-orchestrator/store";
import { requestControlledExpansion, type ControlledExpansionOutcome } from "@role-orchestrator/expand";

export interface ReworkRequestInput {
  readonly runId: string;
  /** The review node whose FAIL grounds the expansion. */
  readonly reviewNodeId: string;
  /** The failed candidate (A12-bound). */
  readonly candidateSha: string;
  /** Must carry canCreateSubtasks (A04; a denial is durably audited). */
  readonly requesterRoleId: RoleId;
  readonly now: string;
}

/**
 * Request the controlled rework expansion. The A38 expectedGraphRevision is
 * the run's graphRevision read at this instant — the composition root never
 * passes one.
 */
export function requestReworkExpansion(
  db: DatabaseSync,
  input: ReworkRequestInput
): ControlledExpansionOutcome {
  const run = getTaskRun(db, input.runId);
  if (run === null) {
    // The expansion service's own unknown-run refusal, surfaced from here
    // with the same shape a direct call would produce.
    return requestControlledExpansion(db, {
      runId: input.runId,
      reviewNodeId: input.reviewNodeId,
      candidateSha: input.candidateSha,
      requesterRoleId: input.requesterRoleId,
      // The stored row is absent: pass a revision the service must refuse.
      expectedGraphRevision: -1,
      now: input.now
    });
  }
  return requestControlledExpansion(db, {
    runId: input.runId,
    reviewNodeId: input.reviewNodeId,
    candidateSha: input.candidateSha,
    requesterRoleId: input.requesterRoleId,
    expectedGraphRevision: run.graphRevision,
    now: input.now
  });
}
