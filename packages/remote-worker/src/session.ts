/**
 * The orchestrator-side remote execution session (M7-03 control plane).
 *
 * One session owns ONE execution against a remote worker slot. Its duties:
 *
 * - hold the lease through the real store-backed authority (claim at start,
 *   hand back on a DELIVERED terminal outcome — never on an unknown one);
 * - validate EVERY state-bearing inbound event against the authority's
 *   fencing check before applying it (zombie write-backs are refused by
 *   data, not by trust);
 * - deduplicate events by their idempotency key (eventId) regardless of the
 *   first copy's fate — at-least-once delivery must be absorbed in one place;
 * - reach EXACTLY ONE terminal outcome, and make the A22 unknown path land
 *   on RECOVERY_REQUIRED with `autoRerun: false` — this package offers no
 *   API that could re-run anything: the lease stays claimed, the store keeps
 *   the slot blocked, and only the explicit reconcile (`reconcileExpired`)
 *   can free it for a NEW, human-driven attempt.
 *
 * The event-processing order is the contract (each step has a pinned test):
 *   1. strict re-parse        — protocol violations fail loud;
 *   2. idempotency dedup      — duplicates counted, never re-applied;
 *   3. execution match        — foreign events throw (a wiring bug);
 *   4. post-terminal          — late events counted, never re-applied;
 *   5. fencing validation     — stale/expired/no-lease write-backs counted
 *                               and recorded as evidence, never applied;
 *   6. apply                  — terminal outcomes settle once.
 */
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  CancelUndeliverableError,
  FencingRejectedError,
  ForeignExecutionError,
  SessionNotTerminalUnknownError,
  TransportSealedError
} from "./errors.js";
import type { WorkerLeaseAuthority } from "./lease.js";
import type { ProcessRef, WorkerCommand, WorkerEvent } from "./protocol.js";
import { WorkerEventSchema } from "./protocol.js";
import type { GrantedPosture } from "./posture.js";
import type { TransportAuthScheme } from "./auth.js";
import type { InMemoryWorkerTransport } from "./transport.js";

export type SessionOutcome =
  | {
      readonly kind: "result-delivered";
      readonly result: "success" | "error";
      readonly resultDigest: string | null;
      readonly exitCode: number | null;
      readonly eventId: string;
    }
  | { readonly kind: "cancelled-confirmed"; readonly terminated: readonly ProcessRef[]; readonly eventId: string }
  | {
      readonly kind: "cancel-unconfirmed";
      readonly terminated: readonly ProcessRef[];
      readonly unresolved: readonly ProcessRef[];
      readonly eventId: string;
    }
  | {
      /** A22: side effects may exist, outcome unknown. Node lands on RECOVERY_REQUIRED. */
      readonly kind: "unknown-recovery-required";
      readonly reasons: readonly string[];
      readonly nodeState: "RECOVERY_REQUIRED";
      readonly autoRerun: false;
    };

export interface SessionCounters {
  readonly eventsApplied: number;
  readonly duplicatesIgnored: number;
  readonly postTerminalIgnored: number;
  readonly rejectedByFencing: number;
  readonly acksObserved: number;
  readonly heartbeatsObserved: number;
  readonly progressApplied: number;
  readonly cancelAfterTerminalObserved: number;
}

export interface SessionStartInput {
  readonly leaseId: string;
  readonly runId: string;
  readonly workDigest: string;
  readonly worktreeBundleRef: string;
  readonly secretRefs: readonly string[];
  /** Granted posture — the type is `local-trusted`-only, a hardened grant cannot even be passed. */
  readonly posture: GrantedPosture;
  readonly authScheme: TransportAuthScheme;
  /** Lease TTL end — the scheduler owns expiry policy; the session only carries it. */
  readonly expiresAt: string;
  readonly now: string;
}

const StartInputSchema = z
  .strictObject({
    leaseId: IdSchema,
    runId: IdSchema,
    workDigest: z.string().regex(/^[0-9a-f]{64}$/),
    worktreeBundleRef: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    secretRefs: z.array(z.string().regex(/^ref:[a-z][a-z0-9._-]{2,120}$/)).max(8),
    posture: z.enum(["local-trusted"]),
    authScheme: z.enum(["loopback-token", "mtls", "lease-token"]),
    expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
  .refine((value) => value.expiresAt > value.now, {
    message: "expiresAt must be after now",
    path: ["expiresAt"]
  });

export interface RemoteExecutionSessionOptions {
  readonly authority: WorkerLeaseAuthority;
  readonly transport: InMemoryWorkerTransport;
  readonly executionId: string;
  readonly resourceKey: string;
}

export class RemoteExecutionSession {
  private outcomeValue: SessionOutcome | null = null;
  private readonly seenEventIds = new Set<string>();
  private readonly evidence: string[] = [];
  private readonly countersInternal = {
    eventsApplied: 0,
    duplicatesIgnored: 0,
    postTerminalIgnored: 0,
    rejectedByFencing: 0,
    acksObserved: 0,
    heartbeatsObserved: 0,
    progressApplied: 0,
    cancelAfterTerminalObserved: 0
  };
  private leaseIdValue: string | null = null;
  private leaseExpiresAtValue: string | null = null;
  private startedValue = false;
  private cancelCounter = 0;

  constructor(private readonly options: RemoteExecutionSessionOptions) {}

  // ---- lifecycle -------------------------------------------------------------

  /**
   * Claim the slot and put the assign command on the wire. A refusal from
   * the authority (`held` / `needs-reconcile`) is RETURNED — the caller
   * (scheduler) decides; this package never retries a claim on its own.
   * If the very first send fails because the cable is sealed, the claim is
   * released again determinately (nothing was ever dispatched) and the
   * error propagates.
   */
  start(input: SessionStartInput): { claimed: true } | { claimed: false; reason: "held" | "needs-reconcile" } {
    const value = StartInputSchema.parse(input);
    const claim = this.options.authority.claim({
      leaseId: value.leaseId,
      executionId: this.options.executionId,
      resourceKey: this.options.resourceKey,
      expiresAt: value.expiresAt,
      now: value.now
    });
    if (!claim.granted) {
      return { claimed: false, reason: claim.reason };
    }
    this.leaseIdValue = value.leaseId;
    this.leaseExpiresAtValue = claim.lease.expiresAt;
    this.startedValue = true;
    try {
      this.options.transport.send({
        kind: "assign",
        commandId: `${this.options.executionId}-assign-1`,
        executionId: this.options.executionId,
        runId: value.runId,
        workDigest: value.workDigest,
        resourceKey: this.options.resourceKey,
        fencingToken: claim.lease.fencingToken,
        leaseExpiresAt: claim.lease.expiresAt,
        worktreeBundleRef: value.worktreeBundleRef,
        secretRefs: [...value.secretRefs],
        posture: value.posture,
        authScheme: value.authScheme
      });
    } catch (error) {
      if (error instanceof TransportSealedError) {
        // Determinate: a sealed send delivered nothing, so this is a launch
        // failure, not an unknown outcome — hand the slot back.
        this.options.authority.release(value.leaseId, value.now);
        this.leaseIdValue = null;
        this.leaseExpiresAtValue = null;
        this.startedValue = false;
        this.evidence.push(`start-sealed-send-released-lease@${value.now}`);
      }
      throw error;
    }
    return { claimed: true };
  }

  /**
   * Send a cancel. Delivered → the worker will answer on the wire.
   * Sealed cable → `CancelUndeliverableError`: the caller must treat the
   * worker as UNTERMINATED-AND-UNKNOWN, never as dead by assumption (A26).
   */
  cancel(reason: "user" | "policy" | "budget" | "timeout", now: string): { sent: boolean } {
    if (this.outcomeValue !== null) {
      return { sent: false };
    }
    this.cancelCounter += 1;
    try {
      this.options.transport.send({
        kind: "cancel",
        commandId: `${this.options.executionId}-cancel-${String(this.cancelCounter)}`,
        executionId: this.options.executionId,
        reason
      });
    } catch (error) {
      if (error instanceof TransportSealedError) {
        this.evidence.push(`cancel-undeliverable@${now}`);
        throw new CancelUndeliverableError(this.options.executionId);
      }
      throw error;
    }
    this.evidence.push(`cancel-sent@${now}`);
    return { sent: true };
  }

  /**
   * The explicit A22 landing. Callable only while NO terminal outcome exists
   * (repeat observations of the unknown state are idempotent no-ops). Does
   * NOT release the lease: the slot stays blocked against new attempts until
   * the explicit reconcile runs — nothing auto re-runs.
   */
  observeUnknownOutcome(reasons: readonly string[], now: string): SessionOutcome {
    if (this.outcomeValue === null) {
      this.outcomeValue = {
        kind: "unknown-recovery-required",
        reasons: [...reasons],
        nodeState: "RECOVERY_REQUIRED",
        autoRerun: false
      };
      this.evidence.push(`unknown-outcome-observed@${now} reasons=${reasons.join("|")}`);
      return this.outcomeValue;
    }
    if (this.outcomeValue.kind === "unknown-recovery-required") {
      this.evidence.push(`unknown-outcome-reobserved@${now}`);
      return this.outcomeValue;
    }
    throw new SessionNotTerminalUnknownError(this.options.executionId, this.outcomeValue.kind);
  }

  /**
   * Advance the simulated world: hand queued commands to the worker, then
   * process everything the wire delivered back (the `now` argument is the
   * logical clock instant of this pump).
   */
  pump(now: string, worker: { receiveCommand(command: WorkerCommand): void }): void {
    for (const command of this.options.transport.deliverCommandsToWorker()) {
      worker.receiveCommand(command);
    }
    this.drainInbound(now);
  }

  /** Process the wire's inbound events (validation order = the class contract). */
  drainInbound(now: string): void {
    // Routing by executionId happens HERE: the shared bus leaves other
    // executions' events queued for their own sessions.
    for (const event of this.options.transport.drainInbound(this.options.executionId)) {
      this.ingest(event, now);
    }
  }

  /**
   * The pipeline entry for one event (public so tests and future tooling can
   * inject hand-rolled events directly). Validation order = the contract:
   * parse → dedup → foreign guard → post-terminal → fencing → apply.
   */
  ingest(raw: WorkerEvent, now: string): void {
    this.processEvent(raw, now);
  }

  // ---- event pipeline (the contract order) -------------------------------------

  private processEvent(raw: WorkerEvent, now: string): void {
    // 1. strict re-parse — a hand-rolled or drifted event fails loud.
    const event = WorkerEventSchema.parse(raw);

    // 2. idempotency dedup — the key is eventId, regardless of the first
    //    copy's fate (applied, fencing-rejected, or post-terminal).
    if (this.seenEventIds.has(event.eventId)) {
      this.countersInternal.duplicatesIgnored += 1;
      this.evidence.push(`duplicate-ignored:${event.eventId}@${now}`);
      return;
    }
    this.seenEventIds.add(event.eventId);

    // 3. execution match — a foreign event is a wiring bug, not a handling case.
    if (event.executionId !== this.options.executionId) {
      throw new ForeignExecutionError(this.options.executionId, event.executionId);
    }

    // 4. post-terminal — exactly one terminal outcome per session; late
    //    events (zombie retries, cancel races) are counted, not applied.
    if (this.outcomeValue !== null) {
      this.countersInternal.postTerminalIgnored += 1;
      this.evidence.push(`post-terminal-ignored:${event.eventId}@${now}`);
      return;
    }

    // 5. fencing validation — every state-bearing write-back proves it still
    //    owns the slot. Refusals are evidence, never application.
    try {
      this.options.authority.validateWriteBack({
        resourceKey: this.options.resourceKey,
        fencingToken: event.fencingToken,
        now
      });
    } catch (error) {
      if (error instanceof FencingRejectedError) {
        this.countersInternal.rejectedByFencing += 1;
        this.evidence.push(`fencing-rejected:${event.eventId}:${error.reason}@${now}`);
        return;
      }
      throw error;
    }

    // 6. apply.
    switch (event.type) {
      case "ack-assign":
        this.countersInternal.acksObserved += 1;
        break;
      case "heartbeat":
        this.countersInternal.heartbeatsObserved += 1;
        break;
      case "progress":
        this.countersInternal.progressApplied += 1;
        break;
      case "cancel-after-terminal":
        this.countersInternal.cancelAfterTerminalObserved += 1;
        break;
      case "result":
        this.outcomeValue = {
          kind: "result-delivered",
          result: event.result,
          resultDigest: event.resultDigest,
          exitCode: event.exitCode,
          eventId: event.eventId
        };
        this.handBackLease(now, event.eventId);
        break;
      case "cancel-confirmed":
        this.outcomeValue = {
          kind: "cancelled-confirmed",
          terminated: [...event.receipt.terminated],
          eventId: event.eventId
        };
        this.handBackLease(now, event.eventId);
        break;
      case "cancel-unconfirmed":
        this.outcomeValue = {
          kind: "cancel-unconfirmed",
          terminated: [...event.receipt.terminated],
          unresolved: [...event.receipt.unresolved],
          eventId: event.eventId
        };
        this.handBackLease(now, event.eventId);
        break;
    }
    this.countersInternal.eventsApplied += 1;
  }

  private handBackLease(now: string, eventId: string): void {
    if (this.leaseIdValue === null) return;
    this.options.authority.release(this.leaseIdValue, now);
    this.evidence.push(`lease-released-on-terminal:${eventId}@${now}`);
    this.leaseIdValue = null;
  }

  // ---- observation -----------------------------------------------------------

  get outcome(): SessionOutcome | null {
    return this.outcomeValue;
  }

  get counters(): SessionCounters {
    return { ...this.countersInternal };
  }

  get evidenceLog(): readonly string[] {
    return [...this.evidence];
  }

  get liveLeaseExpiresAt(): string | null {
    return this.leaseExpiresAtValue;
  }

  get started(): boolean {
    return this.startedValue;
  }
}
