/**
 * Shared case plumbing for the fault matrix (M4-05).
 *
 * Assertions inside cases use `node:assert/strict` so the matrix driver (a
 * plain async module, also buildable to dist) never depends on a test
 * runner. Every case creates its OWN world and cleans it up in `finally` —
 * cases are order-independent and rerunnable.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@role-orchestrator/contracts";
import {
  createActiveAttempt,
  enqueueOutboxMessage,
  listEventsForExecution,
  setAttemptPhase,
  setExecutionPidIdentity,
  type AttemptPhase
} from "@role-orchestrator/store";
import type { ActionProposal } from "@role-orchestrator/checkpoint";
import { extractActionProposals, type ProtocolEventView } from "@role-orchestrator/checkpoint";

/** Run fn, require it to reject/throw with exactly the given error class. */
export async function expectRejection<T extends Error>(
  promise: Promise<unknown>,
  errorClass: new (...args: never[]) => T
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof errorClass) return error;
    assert.fail(`expected ${errorClass.name}, got: ${String(error)}`);
  }
  assert.fail(`expected ${errorClass.name} to be rejected, but the promise resolved`);
}

export function expectThrow<T extends Error>(
  fn: () => unknown,
  errorClass: new (...args: never[]) => T
): T {
  try {
    fn();
  } catch (error) {
    if (error instanceof errorClass) return error;
    assert.fail(`expected ${errorClass.name}, got: ${String(error)}`);
  }
  assert.fail(`expected ${errorClass.name} to be thrown, but the call succeeded`);
}

/** sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const T0_NOW = "2026-09-23T00:00:00.000Z";

export interface AttemptRowOptions {
  readonly executionId: string;
  readonly runId: string;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly phase?: AttemptPhase;
  readonly dispatchToken?: string;
  readonly definitionRevision?: string;
  /** When set, records a pid identity (engine-shaped: wall clock at spawn). */
  readonly pid?: number;
  readonly pidCreationTime?: string;
  /** When true (default), enqueues the dispatch-requested outbox message. */
  readonly withDispatchOutbox?: boolean;
}

/**
 * Create an attempt row exactly the way the engine's PREPARING transaction
 * does (row + dispatch outbox together), then walk the phase to the
 * requested one and optionally stamp the pid identity. This is the durable
 * state a REAL crash at the corresponding boundary leaves behind — the
 * matrix feeds exactly that state to the recovery machinery.
 */
export function makeAttemptRow(db: DatabaseSync, options: AttemptRowOptions): void {
  const runId = options.runId;
  const nodeId = options.nodeId ?? "node-alpha";
  const attempt = options.attempt ?? 1;
  const phase = options.phase ?? "PREPARING";
  createActiveAttempt(db, {
    id: options.executionId,
    runId,
    nodeId,
    definitionRevision: options.definitionRevision ?? "rev-fm-1",
    attempt,
    dispatchToken: options.dispatchToken ?? `dt-${options.executionId}`,
    phase: "PREPARING",
    now: T0_NOW
  });
  if (options.withDispatchOutbox !== false) {
    enqueueOutboxMessage(db, {
      id: `ob-fm-${options.executionId.replace(/[^a-z0-9_-]/g, "-")}`,
      aggregateId: options.executionId,
      type: "execution.dispatch-requested",
      payload: { executionId: options.executionId, runId, nodeId, attempt },
      now: T0_NOW
    });
  }
  if (phase !== "PREPARING") {
    setAttemptPhase(db, { id: options.executionId, phase, wherePhaseIn: ["PREPARING"], now: T0_NOW });
  }
  if (options.pid !== undefined) {
    setExecutionPidIdentity(db, {
      id: options.executionId,
      pidIdentity: {
        pid: options.pid,
        creationTime: options.pidCreationTime ?? new Date().toISOString(),
        executionNonce: randomUUID(),
        target: "windows-native"
      },
      now: T0_NOW
    });
  }
}

function storedEvents(db: DatabaseSync, executionId: string): readonly ProtocolEventView[] {
  return listEventsForExecution(db, executionId).map((row) => ({
    type: row.type,
    sourceType: null,
    seq: row.seq,
    payload: JSON.parse(row.payload) as Record<string, JsonValue>
  }));
}

/**
 * Extract the single action proposal a fake-cli `action-proposal` execution
 * persisted into its event stream (the M4-02 extraction, on stored rows).
 */
export function extractSingleProposal(db: DatabaseSync, executionId: string): ActionProposal {
  const extraction = extractActionProposals(storedEvents(db, executionId));
  assert.equal(
    extraction.unparsable.length,
    0,
    `unexpected unparsable proposals: ${JSON.stringify(extraction.unparsable)}`
  );
  assert.equal(extraction.proposals.length, 1, "expected exactly one action proposal");
  const proposal = extraction.proposals[0]?.proposal;
  assert.ok(proposal !== undefined, "proposal must be present");
  return proposal;
}


