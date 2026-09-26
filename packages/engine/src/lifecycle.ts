/**
 * Single-execution lifecycle (M1-03), per docs/ORCHESTRATION.md section 3:
 *
 *   PREPARING -> STARTING -> RUNNING -> FINALIZING -> SUCCEEDED
 *   any unfinished phase -> FAILED | INTERRUPTED | CANCELLED
 *
 * Phase-by-phase, all fail-closed:
 * - PREPARING  the attempt row (with the A23 active-attempt constraint) and
 *              its dispatch outbox message commit in one transaction; the
 *              invocation was already resolved from the frozen snapshot.
 * - STARTING   the child is spawned from an argv ARRAY (no shell string) and
 *              the pid identity is recorded IMMEDIATELY, before any stream
 *              byte is consumed — the smallest window A24 allows.
 * - RUNNING    stdout feeds the cli-events pipeline; every drained event
 *              batch is appended to the store inside one transaction; the
 *              session id from the first `started` event is recorded. The
 *              kill budget and the cancellation handle are armed here.
 * - FINALIZING entered after the process exited and the stream ended, BEFORE
 *              the outcome is judged.
 * - terminal   SUCCEEDED only when exit 0 AND no protocol error AND the final
 *              result has no error AND ExecutionResultSchema validates AND
 *              the required evidence exists (A06). Timeout kills the tree and
 *              records FAILED; cancellation records CANCELLED; everything
 *              else records FAILED with the ordered reasons. The terminal
 *              transition, its lifecycle event and its outbox message commit
 *              in ONE transaction.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, RoleId } from "@role-orchestrator/contracts";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import type { OutcomeFailureReason } from "@role-orchestrator/cli-events";
import { EventStreamPipeline, evaluateOutcome } from "@role-orchestrator/cli-events";
import {
  createActiveAttempt,
  enqueueOutboxMessage,
  getExecution,
  isUniqueViolation,
  setAttemptPhase,
  setExecutionPidIdentity,
  setExecutionSessionId,
  withTransaction,
  type ProcessIdentityRecord
} from "@role-orchestrator/store";
import { ClaimedAttemptInvalidError, DispatchTokenReusedError, ExecutionLaunchError } from "./errors.js";
import { evaluateEvidence, type EvidenceEvaluation, type EvidencePolicyMode } from "./evidence.js";
import {
  prepareExecutionInvocation,
  type PreparedExecution
} from "./invocation.js";
import {
  LIFECYCLE_EVENT_SEQ_BASE,
  appendRedactedEvent,
  lifecycleEventId,
  lifecycleOutboxId,
  persistDrainedEvents
} from "./persistence.js";
import { killProcessTree, type TreeKillEvidence } from "./tree-kill.js";

export type EngineOutcomeReason = OutcomeFailureReason | "missing-evidence" | "timeout" | "cancelled";

export const ENGINE_TERMINAL_PHASES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type EngineTerminalPhase = (typeof ENGINE_TERMINAL_PHASES)[number];

export interface StartExecutionInput {
  readonly executionId: string;
  readonly runId: string;
  readonly roleId: RoleId;
  readonly nodeId: string;
  readonly definitionRevision: string;
  readonly attempt: number;
  readonly dispatchToken: string;
  /** Existing directory; the child runs here and the stdin file is written here. */
  readonly cwd: string;
  /** Controlled task input; written to the stdin file and piped to the child. */
  readonly prompt: string;
  /** Non-model invocation arguments (argv elements), e.g. `["--scenario", "success"]`. */
  readonly invocationArgs?: readonly string[] | undefined;
  /** Kill budget in seconds (engine-level; enforced with a real process-tree kill). */
  readonly timeoutSeconds: number;
  /** Evidence policy; defaults to the dialect default (see evidence.ts). */
  readonly evidencePolicy?: EvidencePolicyMode | undefined;
  /** DB timestamp of the attempt row; later stamps use the wall clock. */
  readonly now: string;
  /**
   * M2-06 scheduler composition: the attempt row was ALREADY created by the
   * scheduler's dispatch claim (`pollQueue`, phase STARTING, dispatch outbox
   * emitted). The engine then skips its own PREPARING insert — the claim is
   * the durable execution row, and inserting a second one is impossible by
   * the A23 slot constraint — and instead VERIFIES the claimed row (exists,
   * phase STARTING, same dispatch token and slot identity) before spawning.
   * Default false: without this flag the engine owns the full
   * PREPARING -> STARTING entry exactly as in M1-03.
   */
  readonly claimedAttempt?: boolean | undefined;
}

const StartExecutionInputSchema = z.strictObject({
  executionId: IdSchema,
  runId: IdSchema,
  roleId: RoleIdSchema,
  nodeId: IdSchema,
  definitionRevision: z.string().min(1).max(128),
  attempt: z.number().int().min(1),
  dispatchToken: z.string().min(1).max(128),
  cwd: z.string().min(1).max(2048),
  prompt: z.string().max(1_048_576),
  invocationArgs: z.array(z.string().min(1).max(4096)).max(64).default([]),
  timeoutSeconds: z.number().int().min(1).max(86400),
  evidencePolicy: z.enum(["cited-artifact-ids", "any-artifact-reported"]).optional(),
  now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  claimedAttempt: z.boolean().optional()
});

export interface ExecutionRunResult {
  readonly executionId: string;
  readonly finalPhase: EngineTerminalPhase;
  /** Ordered failure reasons; empty exactly when finalPhase is SUCCEEDED. */
  readonly reasons: readonly EngineOutcomeReason[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly finalResultEventId: string | null;
  readonly evidence: EvidenceEvaluation | null;
  readonly pidIdentity: ProcessIdentityRecord;
  readonly sessionId: string | null;
}

export interface ExecutionRun {
  readonly executionId: string;
  /** Resolves with the terminal result; rejects only on launch/preparation errors. */
  readonly result: Promise<ExecutionRunResult>;
  /**
   * Request cancellation: sets the intent and kills the process tree. Returns
   * false when the process had already exited (the result then reflects its
   * natural outcome) or cancellation was already requested. Idempotent.
   */
  readonly cancel: (reason: string) => Promise<boolean>;
}

interface LifecycleController {
  child: ChildProcessWithoutNullStreams | null;
  exited: boolean;
  timedOut: boolean;
  cancelRequested: string | null;
  killEvidence: TreeKillEvidence | null;
  requestCancel: ((reason: string) => Promise<boolean>) | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isProcessAlive(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function startExecution(db: DatabaseSync, input: StartExecutionInput): ExecutionRun {
  const value = StartExecutionInputSchema.parse(input);
  const controller: LifecycleController = {
    child: null,
    exited: false,
    timedOut: false,
    cancelRequested: null,
    killEvidence: null,
    requestCancel: null
  };
  const result = executeLifecycle(db, value, controller);
  return {
    executionId: value.executionId,
    result,
    cancel: (reason: string) => {
      const parsedReason = z.string().min(1).max(256).parse(reason);
      const request = controller.requestCancel;
      if (request === null) return Promise.resolve(false);
      return request(parsedReason);
    }
  };
}

async function executeLifecycle(
  db: DatabaseSync,
  input: z.output<typeof StartExecutionInputSchema>,
  controller: LifecycleController
): Promise<ExecutionRunResult> {
  // ---- invocation from the FROZEN snapshot (no DB writes; typed failures) --
  const prepared: PreparedExecution = prepareExecutionInvocation(db, {
    executionId: input.executionId,
    runId: input.runId,
    roleId: input.roleId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    cwd: input.cwd,
    prompt: input.prompt,
    invocationArgs: input.invocationArgs,
    timeoutSeconds: input.timeoutSeconds,
    evidencePolicy: input.evidencePolicy
  });

  // ---- PREPARING: attempt row + dispatch outbox in ONE transaction --------
  // Claimed composition (scheduler dispatch): the claim transaction already
  // committed the attempt row (phase STARTING) and its scheduler.dispatch
  // outbox message; the engine verifies instead of inserting.
  if (input.claimedAttempt === true) {
    const claimed = getExecution(db, input.executionId);
    if (claimed === null) {
      throw new ClaimedAttemptInvalidError(input.executionId, "no attempt row exists for this execution id");
    }
    if (claimed.phase !== "STARTING") {
      throw new ClaimedAttemptInvalidError(
        input.executionId,
        `claimed row is in phase "${claimed.phase}", expected "STARTING"`
      );
    }
    if (claimed.dispatchToken !== input.dispatchToken) {
      throw new ClaimedAttemptInvalidError(
        input.executionId,
        `claimed row carries dispatch token "${claimed.dispatchToken}", launch order presented "${input.dispatchToken}"`
      );
    }
    if (claimed.runId !== input.runId || claimed.nodeId !== input.nodeId || claimed.attempt !== input.attempt) {
      throw new ClaimedAttemptInvalidError(
        input.executionId,
        `claimed row slot ${claimed.runId}/${claimed.nodeId}/#${String(claimed.attempt)} does not match the launch order ` +
          `${input.runId}/${input.nodeId}/#${String(input.attempt)}`
      );
    }
  } else {
    try {
      withTransaction(db, () => {
        createActiveAttempt(db, {
          id: input.executionId,
          runId: input.runId,
          nodeId: input.nodeId,
          definitionRevision: input.definitionRevision,
          attempt: input.attempt,
          dispatchToken: input.dispatchToken,
          phase: "PREPARING",
          sessionId: null,
          now: input.now
        });
        enqueueOutboxMessage(db, {
          id: lifecycleOutboxId(input.executionId, input.attempt, "dispatched"),
          aggregateId: input.executionId,
          type: "execution.dispatch-requested",
          payload: {
            executionId: input.executionId,
            runId: input.runId,
            nodeId: input.nodeId,
            attempt: input.attempt,
            dispatchToken: input.dispatchToken,
            manifestHash: prepared.manifestHash
          },
          now: input.now
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, "executions.dispatch_token")) {
        throw new DispatchTokenReusedError(input.dispatchToken, { cause: error });
      }
      throw error;
    }

    // ---- STARTING ----------------------------------------------------------
    setAttemptPhase(db, {
      id: input.executionId,
      phase: "STARTING",
      wherePhaseIn: ["PREPARING"],
      now: nowIso()
    });
  }

  // ---- spawn + IMMEDIATE pid identity (A24: record before consuming) ------
  const child = spawn(prepared.command, [...prepared.argv], {
    cwd: prepared.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  }) as ChildProcessWithoutNullStreams;
  controller.child = child;

  // A spawn that fails SYNCHRONOUSLY (e.g. a direct-form executable that does
  // not exist: ENOENT with no pid) still delivers its 'error' event
  // ASYNCHRONOUSLY. The handler must exist before any early throw below, or
  // the event escapes as an uncaught exception and kills the daemon on a
  // path that is supposed to surface as a typed launch failure.
  const spawnFailure: { error: Error | null } = { error: null };
  child.once("error", (error) => {
    spawnFailure.error = error;
  });

  if (child.pid === undefined) {
    await persistLaunchFailure(db, input, prepared, "spawn returned no pid", controller);
    throw new ExecutionLaunchError(input.executionId, "spawn returned no pid");
  }
  const pidIdentity: ProcessIdentityRecord = {
    pid: child.pid,
    creationTime: nowIso(),
    executionNonce: randomUUID(),
    target: prepared.snapshot.executionTarget
  };
  setExecutionPidIdentity(db, {
    id: input.executionId,
    pidIdentity,
    wherePhaseIn: ["STARTING"],
    now: nowIso()
  });

  // ---- stream wiring + exit/error capture (all before the first await) ----
  const pipeline = new EventStreamPipeline({
    dialect: prepared.dialect,
    executionId: input.executionId
  });
  let recordedSessionId: string | null = null;
  const drainAndPersist = (): void => {
    const drained = pipeline.drainNewEvents();
    if (drained.length === 0) return;
    const batch = persistDrainedEvents(db, prepared.dialect, input.executionId, drained);
    if (recordedSessionId === null && batch.sessionId !== null) {
      setExecutionSessionId(db, {
        id: input.executionId,
        sessionId: batch.sessionId,
        wherePhaseIn: ["STARTING", "RUNNING", "FINALIZING"],
        now: nowIso()
      });
      recordedSessionId = batch.sessionId;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    pipeline.feedStdout(chunk);
    drainAndPersist();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    pipeline.feedStderr(chunk);
  });
  // A child that never reads stdin (the fake CLI) turns the prompt write into
  // an EPIPE on exit — that is a transport detail, never a protocol verdict.
  child.stdin.on("error", () => {});
  child.stdin.end(Buffer.from(input.prompt, "utf8"));

  // Windows ordering (observed): stdout 'end'/'close' can fire BEFORE the
  // process 'exit' event, so the settle listeners MUST be attached now —
  // attaching them after `await exited` misses them and hangs forever.
  const streamsSettled = Promise.all([
    streamSettled(child.stdout),
    streamSettled(child.stderr)
  ]);

  const exited = new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once("exit", () => settle());
    child.once("error", (error) => {
      spawnFailure.error = error;
      settle();
    });
  });

  // ---- RUNNING --------------------------------------------------------------
  setAttemptPhase(db, {
    id: input.executionId,
    phase: "RUNNING",
    wherePhaseIn: ["STARTING"],
    now: nowIso()
  });

  // Kill budget: only arms if the process is still genuinely alive when it
  // fires (exitCode/signalCode are set synchronously by Node on natural exit).
  let killInFlight: Promise<void> | null = null;
  const timer = setTimeout(() => {
    if (controller.exited || !isProcessAlive(child)) return;
    controller.timedOut = true;
    killInFlight = killProcessTree(child.pid as number).then((evidence) => {
      controller.killEvidence = evidence;
    });
  }, input.timeoutSeconds * 1000);
  controller.requestCancel = async (reason: string): Promise<boolean> => {
    if (controller.exited || controller.cancelRequested !== null || !isProcessAlive(child)) {
      return false;
    }
    controller.cancelRequested = reason;
    controller.killEvidence = await killProcessTree(child.pid as number);
    return true;
  };

  await exited;
  controller.exited = true;
  clearTimeout(timer);
  // A kill was initiated (timeout path): the victim's exit fires while the
  // taskkill process itself may still be running, so the evidence assignment
  // races the terminal write — await the in-flight kill before recording, or
  // the outcome event can persist killEvidence: null on a slow host (real
  // race, exposed by the CI runner in the A26 fault-matrix drive).
  if (killInFlight !== null) {
    await killInFlight;
  }

  if (spawnFailure.error !== null) {
    await persistLaunchFailure(db, input, prepared, spawnFailure.error.message, controller);
    throw new ExecutionLaunchError(input.executionId, spawnFailure.error.message, {
      cause: spawnFailure.error
    });
  }

  // Drain the pipes fully so the protocol tail is never lost, then persist
  // the final batch (including process_exited) — while still RUNNING.
  await streamsSettled;
  pipeline.emitProcessExited({ exitCode: child.exitCode, signal: child.signalCode });
  drainAndPersist();

  // ---- FINALIZING: after process exit, before judgment ---------------------
  setAttemptPhase(db, {
    id: input.executionId,
    phase: "FINALIZING",
    wherePhaseIn: ["RUNNING"],
    now: nowIso()
  });

  const stream = pipeline.finalize();
  const verdict = evaluateOutcome(stream, { exitCode: child.exitCode });

  let reasons: EngineOutcomeReason[] = [...verdict.reasons];
  let evidence: EvidenceEvaluation | null = null;
  if (verdict.success) {
    evidence = evaluateEvidence(prepared.evidencePolicy, stream.events);
    if (!evidence.satisfied) {
      reasons = ["missing-evidence"];
    }
  }

  let finalPhase: EngineTerminalPhase;
  let cancelled = false;
  if (controller.timedOut) {
    finalPhase = "FAILED";
    reasons = [...reasons, "timeout"];
  } else if (controller.cancelRequested !== null) {
    finalPhase = "CANCELLED";
    cancelled = true;
    reasons = ["cancelled"];
  } else {
    finalPhase = reasons.length === 0 ? "SUCCEEDED" : "FAILED";
  }

  // ---- terminal write: lifecycle event + phase + outbox, ONE transaction ---
  const outcomePayload: Record<string, JsonValue> = {
    finalPhase,
    reasons: [...reasons],
    exitCode: child.exitCode,
    signal: child.signalCode ?? null,
    timedOut: controller.timedOut,
    cancelled,
    cancelReason: controller.cancelRequested,
    killEvidence: controller.killEvidence === null
      ? null
      : {
          tool: controller.killEvidence.tool,
          args: [...controller.killEvidence.args],
          exitCode: controller.killEvidence.exitCode,
          stderr: controller.killEvidence.stderr
        },
    protocolFailureReasons: [...verdict.reasons],
    finalResultEventId: verdict.finalResultEventId,
    evidence: evidence === null
      ? null
      : { satisfied: evidence.satisfied, citedIds: [...evidence.citedIds], reportedIds: [...evidence.reportedIds], missingIds: [...evidence.missingIds] },
    manifestHash: prepared.manifestHash,
    dialect: prepared.dialect,
    invocationArgs: [...input.invocationArgs],
    stats: {
      eventsEmitted: stream.stats.eventsEmitted,
      linesSeen: stream.stats.linesSeen,
      duplicatesSkipped: stream.stats.duplicatesSkipped,
      protocolErrors: stream.protocolErrors.length
    },
    stderrTruncated: stream.stderrTruncated
  };
  withTransaction(db, () => {
    appendRedactedEvent(db, {
      id: lifecycleEventId(input.executionId, "outcome"),
      executionId: input.executionId,
      seq: LIFECYCLE_EVENT_SEQ_BASE + 1,
      type: "lifecycle_outcome",
      payload: outcomePayload,
      occurredAt: nowIso()
    });
    setAttemptPhase(db, {
      id: input.executionId,
      phase: finalPhase,
      wherePhaseIn: ["FINALIZING"],
      now: nowIso()
    });
    enqueueOutboxMessage(db, {
      id: lifecycleOutboxId(input.executionId, input.attempt, "finished"),
      aggregateId: input.executionId,
      type: "execution.attempt-finished",
      payload: {
        executionId: input.executionId,
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        finalPhase,
        reasons: [...reasons],
        manifestHash: prepared.manifestHash
      },
      now: nowIso()
    });
  });

  return {
    executionId: input.executionId,
    finalPhase,
    reasons,
    exitCode: child.exitCode,
    signal: child.signalCode ?? null,
    timedOut: controller.timedOut,
    cancelled,
    finalResultEventId: verdict.finalResultEventId,
    evidence,
    pidIdentity,
    sessionId: recordedSessionId
  };
}

/** Persist STARTING/RUNNING -> FAILED with a launch-failure lifecycle event. */
async function persistLaunchFailure(
  db: DatabaseSync,
  input: z.output<typeof StartExecutionInputSchema>,
  prepared: PreparedExecution,
  message: string,
  controller: LifecycleController
): Promise<void> {
  withTransaction(db, () => {
    appendRedactedEvent(db, {
      id: lifecycleEventId(input.executionId, "launch-failed"),
      executionId: input.executionId,
      seq: LIFECYCLE_EVENT_SEQ_BASE + 2,
      type: "lifecycle_launch_failed",
      payload: {
        message,
        manifestHash: prepared.manifestHash,
        argv: [...prepared.argv],
        timedOut: controller.timedOut,
        cancelRequested: controller.cancelRequested
      },
      occurredAt: nowIso()
    });
    setAttemptPhase(db, {
      id: input.executionId,
      phase: "FAILED",
      wherePhaseIn: ["STARTING", "RUNNING"],
      now: nowIso()
    });
    enqueueOutboxMessage(db, {
      id: lifecycleOutboxId(input.executionId, input.attempt, "finished"),
      aggregateId: input.executionId,
      type: "execution.attempt-finished",
      payload: {
        executionId: input.executionId,
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        finalPhase: "FAILED",
        reasons: ["launch-failed"],
        manifestHash: prepared.manifestHash
      },
      now: nowIso()
    });
  });
}

/** Resolves when the stream can deliver no more data (end, close or error). */
function streamSettled(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("end", () => resolve());
    stream.once("close", () => resolve());
    stream.once("error", () => resolve());
  });
}
