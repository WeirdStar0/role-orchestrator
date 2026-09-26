/**
 * The in-memory FAKE transport (M7-03). Both endpoints live in this process;
 * there is no socket, no network call, no real byte ever moves. It exists to
 * carry the protocol messages and to make the failure modes of a real cable
 * INJECTABLE and DETERMINISTIC:
 *
 * - `seal()`   — the cable is cut: orchestrator sends throw immediately (a
 *                cancel cannot be delivered); worker emits are buffered in
 *                the worker's own retry outbox (a zombie keeps trying);
 * - `heal()`   — the cable comes back (a reconnect): buffered worker events
 *                are delivered in their original order, late by real time;
 * - `dropInFlight()` — a mid-stream loss with NO seal: messages in flight
 *                simply vanish (both directions);
 * - `armDuplicateDelivery(eventId)` — the next drain delivers that event
 *                TWICE (duplicate delivery; the session's idempotency key
 *                must absorb it).
 *
 * Simulation disclosure (pinned in tenancy.ts and the README): this is a
 * protocol-level fake. Timing is explicit — tests advance a logical clock;
 * nothing here depends on wall-clock timers.
 */
import { TransportSealedError } from "./errors.js";
import type { WorkerCommand, WorkerEvent } from "./protocol.js";

export type TransportDirection = "orchestrator-to-worker" | "worker-to-orchestrator";

export interface TransportStats {
  readonly commandsDelivered: number;
  readonly commandsDropped: number;
  readonly commandsRefusedSealed: number;
  readonly eventsDelivered: number;
  readonly eventsDropped: number;
  readonly eventsBufferedSealed: number;
  readonly duplicatesInjected: number;
}

export class InMemoryWorkerTransport {
  private commandQueue: WorkerCommand[] = [];
  private eventInbox: WorkerEvent[] = [];
  private sealed = false;
  private duplicateTarget: string | null = null;
  private statsInternal: {
    commandsDelivered: number;
    commandsDropped: number;
    commandsRefusedSealed: number;
    eventsDelivered: number;
    eventsDropped: number;
    eventsBufferedSealed: number;
    duplicatesInjected: number;
  } = {
    commandsDelivered: 0,
    commandsDropped: 0,
    commandsRefusedSealed: 0,
    eventsDelivered: 0,
    eventsDropped: 0,
    eventsBufferedSealed: 0,
    duplicatesInjected: 0
  };

  // ---- orchestrator side -------------------------------------------------

  /** Hand a command to the wire. Throws while sealed (the send fails loudly). */
  send(command: WorkerCommand): void {
    if (this.sealed) {
      this.statsInternal.commandsRefusedSealed += 1;
      throw new TransportSealedError("orchestrator-to-worker");
    }
    this.commandQueue.push(command);
  }

  /**
   * Take the events the wire has delivered for ONE execution (the bus is
   * shared: events belonging to other executions stay queued for their own
   * sessions). Without a filter, everything is handed over.
   */
  drainInbound(executionId?: string): WorkerEvent[] {
    const drained: WorkerEvent[] = [];
    const remaining: WorkerEvent[] = [];
    for (const event of this.eventInbox) {
      if (executionId === undefined || event.executionId === executionId) {
        drained.push(event);
      } else {
        remaining.push(event);
      }
    }
    this.eventInbox = remaining;
    if (this.duplicateTarget !== null) {
      const index = drained.findIndex((event) => event.eventId === this.duplicateTarget);
      const original = index >= 0 ? drained[index] : undefined;
      if (index >= 0 && original !== undefined) {
        drained.splice(index, 0, original);
        this.statsInternal.duplicatesInjected += 1;
      }
      this.duplicateTarget = null;
    }
    return drained;
  }

  // ---- worker side -------------------------------------------------------

  /** Worker emits an event. While sealed the WORKER retries later (zombie behavior). */
  emit(event: WorkerEvent): { delivered: boolean } {
    if (this.sealed) {
      this.statsInternal.eventsBufferedSealed += 1;
      return { delivered: false };
    }
    this.eventInbox.push(event);
    this.statsInternal.eventsDelivered += 1;
    return { delivered: true };
  }

  /** A command becomes reachable by the worker (the wire hands it over). */
  deliverCommandsToWorker(): WorkerCommand[] {
    const handed = [...this.commandQueue];
    this.commandQueue = [];
    this.statsInternal.commandsDelivered += handed.length;
    return handed;
  }

  // ---- fault injection ---------------------------------------------------

  /** Cut the cable. In-flight commands are lost; worker emits buffer for retry. */
  seal(): void {
    this.sealed = true;
    this.statsInternal.commandsDropped += this.commandQueue.length;
    this.statsInternal.eventsDropped += this.eventInbox.length;
    this.commandQueue = [];
    this.eventInbox = [];
  }

  /** Reconnect the cable (buffered worker events flow on the next drain). */
  heal(): void {
    this.sealed = false;
  }

  /** Mid-stream loss WITHOUT seal: in-flight messages vanish silently. */
  dropInFlight(): void {
    this.statsInternal.commandsDropped += this.commandQueue.length;
    this.statsInternal.eventsDropped += this.eventInbox.length;
    this.commandQueue = [];
    this.eventInbox = [];
  }

  /** Arm a one-shot duplicate delivery of the named event on the next drain. */
  armDuplicateDelivery(eventId: string): void {
    this.duplicateTarget = eventId;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  get stats(): TransportStats {
    return { ...this.statsInternal };
  }
}
