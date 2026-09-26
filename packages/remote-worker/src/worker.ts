/**
 * The SIMULATED remote worker (M7-03). One in-process object standing in for
 * a worker process on another machine. It holds no secrets (only reference
 * names), it keeps running when the transport dies (the zombie), it emits
 * with at-least-once retry semantics (buffered while sealed, re-emitted on
 * heal), and its cancellation is an honest tree receipt — unterminable
 * process refs are REPORTED, never silently claimed killed (A26).
 *
 * This object is the whole "remote side". There is no process, container or
 * network behind it; the process tree is a list of refs (see protocol.ts).
 * Time is a logical clock injected at construction — no wall-clock timers.
 */
import { ForeignExecutionError, WorkerAlreadyAssignedError } from "./errors.js";
import type { InMemoryWorkerTransport } from "./transport.js";
import type {
  AssignCommand,
  CancelCommand,
  ProcessRef,
  ProcessTreeReceipt,
  WorkerCommand,
  WorkerEvent
} from "./protocol.js";

export type WorkerState = "idle" | "assigned" | "running" | "cancel-partial" | "terminal" | "crashed";

interface Assignment {
  readonly executionId: string;
  readonly runId: string;
  readonly resourceKey: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly secretRefs: readonly string[];
}

export interface WorkerDebugState {
  readonly state: WorkerState;
  readonly executionId: string | null;
  readonly fencingToken: number | null;
  readonly secretRefNames: readonly string[];
  readonly processTree: readonly ProcessRef[];
  readonly unterminableRefs: readonly ProcessRef[];
  readonly bufferedEvents: number;
}

const SPAWNED_TREE: readonly ProcessRef[] = ["proc-root", "proc-child-1", "proc-grandchild-1"];

export interface SimulatedRemoteWorkerOptions {
  readonly transport: InMemoryWorkerTransport;
  /** Logical clock: stamped onto every emitted event (deterministic tests). */
  readonly clock: () => string;
}

export class SimulatedRemoteWorker {
  private state: WorkerState = "idle";
  private assignment: Assignment | null = null;
  private lastAssignCommandId: string | null = null;
  private seqCounter = 0;
  private eventCounter = 0;
  private processTree: ProcessRef[] = [];
  private unterminable = new Set<ProcessRef>();
  private retryOutbox: WorkerEvent[] = [];
  private terminalEventId: string | null = null;
  private readonly transport: InMemoryWorkerTransport;
  private readonly clock: () => string;

  constructor(options: SimulatedRemoteWorkerOptions) {
    this.transport = options.transport;
    this.clock = options.clock;
  }

  // ---- simulation controls (the fault-injection surface) -------------------

  /** Mark part of the (simulated) process tree as NOT terminable (A26 honest-report path). */
  injectUnterminable(refs: readonly ProcessRef[]): void {
    for (const ref of refs) this.unterminable.add(ref);
  }

  /**
   * The worker stops responding WITHOUT the cable being cut (silent loss):
   * state crashes, buffered unsent events die with the memory.
   */
  crash(): void {
    if (this.state === "crashed") return;
    this.state = "crashed";
    this.retryOutbox = [];
  }

  /**
   * The worker keeps running past every boundary — the zombie. There is
   * deliberately NO internal expiry enforcement: a real worker cannot be
   * trusted to stop itself when its lease dies, which is exactly why the
   * control plane fences write-backs instead of asking nicely.
   */
  keepRunning(): void {
    /* the absence of a stop API is the modeled behavior */
  }

  // ---- wire plumbing ---------------------------------------------------------

  private emitOrBuffer(event: WorkerEvent): void {
    const delivered = this.transport.emit(event);
    if (!delivered.delivered) {
      this.retryOutbox.push(event);
    }
  }

  /** The worker's retry policy: re-emit everything the sealed cable swallowed (at-least-once). */
  retryBufferedEvents(): number {
    const buffered = [...this.retryOutbox];
    this.retryOutbox = [];
    for (const event of buffered) {
      this.emitOrBuffer(event);
    }
    return buffered.length;
  }

  /** The wire hands delivered commands to the worker (called by the session pump / tests). */
  receiveCommand(command: WorkerCommand): void {
    if (command.kind === "assign") {
      this.handleAssign(command);
      return;
    }
    this.handleCancel(command);
  }

  // ---- command handlers --------------------------------------------------------

  private handleAssign(command: AssignCommand): void {
    // Command-level idempotency: the same assign commandId re-acks, it never
    // re-initializes state.
    if (this.lastAssignCommandId === command.commandId && this.assignment !== null) {
      this.emitOrBuffer(this.ackEvent(command));
      return;
    }
    if (this.assignment !== null) {
      throw new WorkerAlreadyAssignedError(this.assignment.executionId, command.executionId);
    }
    this.lastAssignCommandId = command.commandId;
    this.assignment = {
      executionId: command.executionId,
      runId: command.runId,
      resourceKey: command.resourceKey,
      fencingToken: command.fencingToken,
      leaseExpiresAt: command.leaseExpiresAt,
      secretRefs: [...command.secretRefs]
    };
    this.state = "assigned";
    this.emitOrBuffer(this.ackEvent(command));
  }

  private ackEvent(command: AssignCommand): WorkerEvent {
    return this.buildEvent("ack-assign", { ackedCommandId: command.commandId });
  }

  private handleCancel(command: CancelCommand): void {
    if (this.assignment === null || this.assignment.executionId !== command.executionId) {
      throw new ForeignExecutionError(this.assignment?.executionId ?? "(idle)", command.executionId);
    }
    if (this.state === "terminal" && this.terminalEventId !== null) {
      // The race: the work finished before the cancel arrived. The worker
      // reports the terminal event id; it does NOT fake a kill receipt.
      this.emitOrBuffer(
        this.buildEvent("cancel-after-terminal", {
          ackedCommandId: command.commandId,
          terminalEventId: this.terminalEventId
        })
      );
      return;
    }
    const receipt = this.terminateProcessTree();
    if (receipt.unresolved.length === 0) {
      this.state = "terminal";
      const confirmed = this.buildEvent("cancel-confirmed", {
        ackedCommandId: command.commandId,
        receipt
      });
      this.terminalEventId = confirmed.eventId;
      this.emitOrBuffer(confirmed);
      return;
    }
    // Honest partial failure: some refs could not be terminated. The worker
    // does not claim success, and it keeps running (cancel-partial).
    this.state = "cancel-partial";
    const unconfirmed = this.buildEvent("cancel-unconfirmed", {
      ackedCommandId: command.commandId,
      receipt,
      note: "injected-unterminable-processes"
    });
    this.terminalEventId = unconfirmed.eventId;
    this.emitOrBuffer(unconfirmed);
  }

  private terminateProcessTree(): ProcessTreeReceipt {
    const terminated: ProcessRef[] = [];
    const unresolved: ProcessRef[] = [];
    for (const ref of this.processTree) {
      if (this.unterminable.has(ref)) unresolved.push(ref);
      else terminated.push(ref);
    }
    return { terminated, unresolved };
  }

  // ---- work lifecycle (driven by tests standing in for the remote runtime) -----

  /** The worker begins the assigned work: the simulated process tree appears. */
  beginWork(): void {
    if (this.state !== "assigned" || this.assignment === null) {
      throw new Error(`beginWork requires state "assigned" (is "${this.state}")`);
    }
    this.processTree = [...SPAWNED_TREE];
    this.state = "running";
  }

  emitProgress(note: string): void {
    this.assertEmitting();
    this.emitOrBuffer(this.buildEvent("progress", { note }));
  }

  emitHeartbeat(): void {
    this.assertEmitting();
    this.emitOrBuffer(this.buildEvent("heartbeat", {}));
  }

  /** The work ends by itself: a result event (success REQUIRES its digest, schema-enforced). */
  complete(result: "success" | "error", resultDigest: string | null, exitCode: number | null): void {
    this.assertEmitting();
    if (this.state !== "running" && this.state !== "cancel-partial") {
      throw new Error(`complete requires a running worker (is "${this.state}")`);
    }
    const event = this.buildEvent("result", { result, resultDigest, exitCode });
    this.state = "terminal";
    this.terminalEventId = event.eventId;
    this.emitOrBuffer(event);
  }

  private assertEmitting(): void {
    if (this.state === "crashed") {
      throw new Error("crashed worker emits nothing");
    }
    if (this.assignment === null) {
      throw new Error("worker emits only while assigned");
    }
  }

  // ---- helpers -------------------------------------------------------------------

  private buildEvent(type: WorkerEvent["type"], fields: Record<string, unknown>): WorkerEvent {
    if (this.assignment === null) {
      throw new Error("worker emits only while assigned");
    }
    this.seqCounter += 1;
    this.eventCounter += 1;
    return {
      eventId: `${this.assignment.executionId}-evt-${String(this.eventCounter)}`,
      executionId: this.assignment.executionId,
      seq: this.seqCounter,
      fencingToken: this.assignment.fencingToken,
      occurredAt: this.clock(),
      type,
      ...fields
    } as WorkerEvent;
  }

  /** Serializable worker state; carries reference NAMES only (A42-tested). */
  debugState(): WorkerDebugState {
    return {
      state: this.state,
      executionId: this.assignment?.executionId ?? null,
      fencingToken: this.assignment?.fencingToken ?? null,
      secretRefNames: this.assignment ? [...this.assignment.secretRefs] : [],
      processTree: [...this.processTree],
      unterminableRefs: [...this.unterminable],
      bufferedEvents: this.retryOutbox.length
    };
  }

  get bufferedEventCount(): number {
    return this.retryOutbox.length;
  }
}
