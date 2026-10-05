/**
 * M10-02 — the shared internal context the driver modules (M2 run-creation,
 * M3 run-driver, M4 node-driver, M9 approval-driver) receive. It is the
 * construction state of ONE createRunDriver instance: the store handle, the
 * git runner, the server-owned worktrees root, the loaded profile
 * definitions, the injected ports and the mutable liveness/cancellation
 * registries owned by the M3 pump.
 */
import type { DatabaseSync } from "node:sqlite";
import type { GitRunner } from "@role-orchestrator/worktree";
import type { ProfileDefinition } from "./driver-contract.js";
import type { Clock, LogSink } from "./ports.js";

export interface DriverContext {
  readonly db: DatabaseSync;
  readonly git: GitRunner;
  /** Server-owned scratch root; created once by createRunDriver. */
  readonly worktreesRoot: string;
  readonly profilesById: ReadonlyMap<string, ProfileDefinition>;
  readonly clock: Clock;
  readonly log: LogSink;
  /**
   * In-flight execution cancellations (executionId -> engine cancel). The M3
   * pump registers each launch here so shutdown can tree-kill everything
   * through the engine's own cancellation (durable CANCELLED evidence).
   */
  readonly activeCancels: Map<string, (reason: string) => Promise<boolean>>;
  /** Liveness of the driver (flips true in shutdown; the pump stops driving). */
  readonly isClosed: () => boolean;
}
