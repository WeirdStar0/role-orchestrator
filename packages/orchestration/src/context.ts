/**
 * M10-02 — the shared internal context the driver modules (M2 run-creation,
 * M3 run-driver, M4 node-driver, M9 approval-driver) receive. It is the
 * construction state of ONE createRunDriver instance: the store handle, the
 * git runner, the server-owned worktrees root, the loaded profile
 * definitions, the injected ports and the mutable liveness/cancellation
 * registries owned by the M3 pump.
 *
 * M10-03 adds the multi-node run books (`multiNodeRuns`): one registry entry
 * per run created WITH a workflow graph, carrying the declared dispatch kind
 * of every node plus the run's accepted-output/candidate bookkeeping. The
 * frozen contracts node schema is strict and carries no kind field, so the
 * declared kinds live HERE (process memory) — runs are only driven by the
 * process that created them, and an unregistered multi-node re-drive refuses
 * fail-closed instead of mis-dispatching (see resolveNodeKind).
 */
import type { DatabaseSync } from "node:sqlite";
import type { GitRunner } from "@role-orchestrator/worktree";
import type { NodeDispatchKind, ProfileDefinition } from "./driver-contract.js";
import type { AcceptedOutput } from "./dependency-resolver.js";
import type { Clock, LogSink, OutputCommitter } from "./ports.js";

/**
 * The per-run multi-node book: dispatch kinds declared at creation (and at
 * rework expansion, for the minted fix/re-review pair), plus the accepted
 * outputs and integration candidates the dependency rule (M5 baselineFor) and
 * the integration phase (M7) read and record.
 */
export interface MultiNodeRunBook {
  readonly kinds: Map<string, NodeDispatchKind>;
  readonly acceptedOutputs: Map<string, AcceptedOutput>;
  /** nodeId -> candidateSha, recorded by the integration settlements (M7). */
  readonly candidates: Map<string, string>;
}

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
  /** M10-03: runId -> multi-node book. Single-node runs have NO entry. */
  readonly multiNodeRuns: Map<string, MultiNodeRunBook>;
  /** M10-03: the optional node-output commit port (multi-node agent nodes only). */
  readonly outputCommitter: OutputCommitter | null;
}
