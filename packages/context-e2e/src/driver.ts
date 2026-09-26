/**
 * The cross-CLI handoff driver (M3-04) — the dogfood pump that walks ONE run
 * through the REAL chain, using each package's public service surface and
 * nothing else:
 *
 *   dag.createRunGraph            (plan validation + graph, before any spawn)
 *   scheduler.enqueueReadyNodes   (fair READY queue)
 *   scheduler.pollQueue           (atomic dispatch claim: real quota +
 *                                  fencing grants + STARTING attempt)
 *   worktree.createWorktree       (isolated exec worktree from a fixed base)
 *   engine.startExecution         (claimedAttempt composition; the fake-cli
 *                                  dist bins run as real subprocesses)
 *   memory-search access session  (AUTHORIZED retrieval: rules + memories)
 *   context.assembleContextBundleWithMemory + persistContextBundle
 *                                 (the consumer's ONLY input channel from
 *                                  the producer: versioned, hash-anchored
 *                                  bundle fragments)
 *   dag.propagateNodeStates       (PENDING -> READY -> ... -> SUCCEEDED)
 *
 * What the driver itself does is DOGFOOD PLUMBING, not product logic, and is
 * documented as such: the producer-node output commit (e2e-baseline's
 * `commitNodeOutput` stand-in) represents the controlled Git Service commit
 * step that lands in a later milestone, and the poll/execute loop is the
 * minimal honest pump for "every dispatched node reaches SUCCEEDED". All
 * quota, state-machine, context-assembly and authorization semantics come
 * from the packages, never from this file.
 *
 * The cross-CLI handoff is strictly structural: the consumer's context bundle
 * cites the producer's accepted output commit SHA and the artifact reference
 * the producer's OWN final result event declared. No session id, credential
 * or transcript text of the producer ever enters the consumer's inputs — the
 * tests pin that negatively (grep the whole persisted surface).
 */
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { EngineTerminalPhase, ExecutionRunResult } from "@role-orchestrator/engine";
import { startExecution } from "@role-orchestrator/engine";
import {
  createRunGraph,
  listRunNodes,
  propagateNodeStates,
  transitionNodeState
} from "@role-orchestrator/dag";
import {
  getEvent,
  listAttemptsForSlot,
  listEventsForExecution,
  listExecutionsForRun
} from "@role-orchestrator/store";
import {
  enqueueReadyNodes,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants,
  type DispatchedOutcome
} from "@role-orchestrator/scheduler";
import { branchNameFor, createWorktree, type GitRunner } from "@role-orchestrator/worktree";
import { commitNodeOutput, createSequenceClock } from "@role-orchestrator/e2e-baseline";
import {
  assembleContextBundleWithMemory,
  type MemoryAccess
} from "@role-orchestrator/memory-search";
import { persistContextBundle, type ContextBundle } from "@role-orchestrator/context";
import { ContextE2eDriverError, ContextE2eUsageError } from "./errors.js";
import { renderBundlePrompt } from "./bundle-prompt.js";
import {
  CTX_E2E_DEFINITION_REVISION,
  specToNodeDefinition,
  type ContextE2eNodeSpec
} from "./scenario.js";

export interface CrossCliConcurrency {
  readonly globalMax: number;
  readonly projectMax: number;
  readonly unverifiedCredentialGroupMax: 1;
}

export const DEFAULT_CROSS_CLI_CONCURRENCY: CrossCliConcurrency = {
  globalMax: 2,
  projectMax: 2,
  unverifiedCredentialGroupMax: 1
};

export interface CrossCliDriverOptions {
  readonly db: DatabaseSync;
  readonly git: GitRunner;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly runId: string;
  readonly baseSha: string;
  /** RAW workflow input; createRunGraph validates it before anything runs. */
  readonly workflow: unknown;
  readonly specs: readonly ContextE2eNodeSpec[];
  /** The authorized memory session of the run's project (rules + memories). */
  readonly access: MemoryAccess;
  readonly projectId: string;
  /** Memory retrieval query for the consumer's bundle injection. */
  readonly memoryQuery: string;
  readonly definitionRevision?: string;
  readonly concurrency?: CrossCliConcurrency;
  /** Synthetic-clock step (ms); keep well below the scheduler lease window. */
  readonly clockStepMs?: number;
  /** UTF-8 byte budget for the consumer bundle; null = unlimited. */
  readonly budgetBytes?: number | null;
}

export interface CrossCliNodeTrace {
  readonly nodeId: string;
  readonly round: number;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly attempt: number;
  readonly branch: string;
  readonly worktreePath: string;
  /** The node's input baseline (fixed base SHA of its worktree). */
  readonly baselineSha: string;
  /** Producer only: the committed artifact output tip; consumers carry null. */
  readonly outputSha: string | null;
  readonly finalPhase: EngineTerminalPhase;
  readonly reasons: readonly string[];
  /** Consumer only: the persisted bundle id its prompt was rendered from. */
  readonly bundleId: string | null;
  /** Consumer only: the exact prompt text the engine fed via stdin. */
  readonly renderedPrompt: string | null;
  /** Producer only: artifact ids declared by the node's OWN final result event. */
  readonly artifactRefIds: readonly string[];
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

export interface CrossCliHandoffResult {
  readonly runId: string;
  readonly rounds: number;
  readonly trace: readonly CrossCliNodeTrace[];
  /** The consumer's assembled + persisted bundle (null when none assembled). */
  readonly consumerBundle: ContextBundle | null;
}

const MAX_ROUNDS = 16;

interface AcceptedOutput {
  readonly branch: string;
  readonly headSha: string;
  readonly artifactRefIds: readonly string[];
  readonly artifactFiles: Readonly<Record<string, string>>;
}

export async function runCrossCliHandoff(
  options: CrossCliDriverOptions
): Promise<CrossCliHandoffResult> {
  const { db, repoPath, runId, workflow, specs, access, projectId } = options;
  const definitionRevision = options.definitionRevision ?? CTX_E2E_DEFINITION_REVISION;
  const concurrency = options.concurrency ?? DEFAULT_CROSS_CLI_CONCURRENCY;
  const clock = createSequenceClock({ stepMs: options.clockStepMs ?? 1_000 });

  if (access.projectId !== projectId) {
    throw new ContextE2eUsageError(
      `driver memory session is bound to project "${access.projectId}", not the run's project "${projectId}"; ` +
        "the bundle may only be assembled under the session's own authorized scope"
    );
  }

  const specById = new Map<string, ContextE2eNodeSpec>(specs.map((spec) => [spec.id, spec]));
  if (specById.size !== specs.length) {
    throw new ContextE2eUsageError("duplicate node ids in cross-cli scenario specs");
  }

  // ---- dag: the single pre-start gate (A08/A03/A02 before anything runs) ---
  createRunGraph(db, { runId, workflow, definitionRevision, now: clock.tick() });

  const acceptedOutputs = new Map<string, AcceptedOutput>();
  const trace: CrossCliNodeTrace[] = [];
  let consumerBundle: ContextBundle | null = null;

  const allSucceeded = (): boolean =>
    listRunNodes(db, runId).every((node) => node.state === "SUCCEEDED");

  let round = 0;
  while (round < MAX_ROUNDS) {
    round += 1;
    propagateNodeStates(db, { runId, now: clock.tick() });
    if (allSucceeded()) {
      break;
    }
    enqueueReadyNodes(db, { runId, now: clock.tick() });
    const poll = pollQueue(db, {
      now: clock.tick(),
      leaseMs: 600_000,
      retryWindowMs: 50,
      starvationMs: 600_000,
      limit: 4,
      concurrency
    });
    if (poll.dispatched.length === 0) {
      continue; // retry-window entries become due on a later synthetic tick
    }
    for (const outcome of poll.dispatched) {
      const spec = specById.get(outcome.nodeId);
      if (spec === undefined) {
        throw new ContextE2eUsageError(`scheduler dispatched unknown cross-cli node "${outcome.nodeId}"`);
      }
      const accepted = await runDispatchedNode(options, {
        outcome,
        spec,
        tick: clock.tick,
        round,
        definitionRevision,
        acceptedOutputs,
        trace
      });
      if (accepted !== null) acceptedOutputs.set(spec.id, accepted);
    }
  }

  if (!allSucceeded()) {
    throw new ContextE2eDriverError(
      siteSummary(db, { repoPath, runId }),
      `run did not converge after ${String(round)} rounds`
    );
  }

  return { runId, rounds: round, trace, consumerBundle };
}

interface DispatchContext {
  readonly outcome: DispatchedOutcome;
  readonly spec: ContextE2eNodeSpec;
  readonly tick: () => string;
  readonly round: number;
  readonly definitionRevision: string;
  readonly acceptedOutputs: ReadonlyMap<string, AcceptedOutput>;
  readonly trace: CrossCliNodeTrace[];
}

/**
 * Runs one dispatched node through worktree -> (bundle assembly) -> engine.
 * Returns the accepted output for producers, null for consumers.
 */
async function runDispatchedNode(
  options: CrossCliDriverOptions,
  context: DispatchContext
): Promise<AcceptedOutput | null> {
  const { db, git, repoPath, worktreesRoot, runId, baseSha } = options;
  const { outcome, spec, tick, round, definitionRevision, acceptedOutputs, trace } = context;
  const nodeId = spec.id;
  const wallStartMs = performance.now();

  // The claim created attempt N for this slot; N = current row count.
  const attempt = listAttemptsForSlot(db, { runId, nodeId }).length;
  const branch = branchNameFor(runId, nodeId, attempt);

  // Fixed baseline: producers start at the run base; consumers start at the
  // last accepted producer output (the dependency chain, topological order).
  let baselineSha = baseSha;
  for (let index = spec.dependencies.length - 1; index >= 0; index -= 1) {
    const dep = acceptedOutputs.get(spec.dependencies[index] as string);
    if (dep !== undefined) {
      baselineSha = dep.headSha;
      break;
    }
  }

  // ---- worktree isolation from the fixed baseline --------------------------
  const created = await createWorktree(git, {
    repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt,
    baseSha: baselineSha
  });

  // ---- the consumer's ONLY producer input: the context bundle --------------
  let bundle: ContextBundle | null = null;
  let renderedPrompt: string | null = null;
  if (spec.kind === "consumer") {
    const producer = spec.dependencies
      .map((dep) => acceptedOutputs.get(dep))
      .find((dep) => dep !== undefined);
    if (producer === undefined) {
      throw new ContextE2eUsageError(
        `consumer node "${nodeId}" has no accepted producer output to assemble`
      );
    }
    const producerSpec = options.specs.find((candidate) => candidate.id === spec.dependencies[0]);
    const artifactContent =
      producerSpec?.files !== undefined ? Object.values(producerSpec.files)[0] : undefined;
    if (artifactContent === undefined) {
      throw new ContextE2eUsageError(
        `consumer node "${nodeId}": producer "${String(spec.dependencies[0])}" declared no artifact file`
      );
    }
    const artifactRefId = producer.artifactRefIds[0];
    if (artifactRefId === undefined) {
      throw new ContextE2eUsageError(
        `consumer node "${nodeId}": producer "${String(spec.dependencies[0])}" declared no artifact reference`
      );
    }
    bundle = assembleContextBundleWithMemory(db, options.access, {
      projectId: options.projectId,
      bundle: {
        runId,
        nodeId,
        node: specToNodeDefinition(spec),
        roleResponsibility: spec.roleResponsibility,
        // Active rules come ONLY through the authorized session.
        projectRules: options.access.listActiveProjectRules().map((rule) => ({
          ruleId: rule.id,
          revision: rule.version,
          content: rule.content
        })),
        dependencies: [
          {
            sourceNodeId: producerSpec?.id ?? String(spec.dependencies[0]),
            commitSha: producer.headSha,
            artifactId: artifactRefId,
            content: artifactContent
          }
        ],
        ...(options.budgetBytes === undefined || options.budgetBytes === null
          ? {}
          : { budgetBytes: options.budgetBytes })
      },
      memory: { query: options.memoryQuery }
    });
    persistContextBundle(db, bundle, tick());
    renderedPrompt = renderBundlePrompt(bundle);
  }

  // ---- engine: real fake-cli subprocess on the claimed attempt -------------
  const invocationArgs: string[] = ["--scenario", spec.scenario];
  const prompt =
    renderedPrompt ??
    [
      `cross-cli node ${runId}/${nodeId} (${spec.title}); scenario ${spec.scenario}`,
      spec.roleResponsibility
    ].join("\n");
  const run = startExecution(db, {
    executionId: outcome.executionId,
    runId,
    roleId: spec.role,
    nodeId,
    definitionRevision,
    attempt,
    dispatchToken: outcome.dispatchToken,
    cwd: created.worktreePath,
    prompt,
    invocationArgs,
    timeoutSeconds: 120,
    now: tick(),
    claimedAttempt: true
  });
  const result: ExecutionRunResult = await run.result;

  if (result.finalPhase !== "SUCCEEDED") {
    // Fail-closed bookkeeping, then surface the diagnosable site summary.
    markQueueEntryCompleted(db, { entryId: outcome.entryId, now: tick() });
    releaseExecutionQuotaGrants(db, { executionId: outcome.executionId, now: tick() });
    transitionNodeState(db, {
      runId,
      nodeId,
      to: "FAILED",
      whereStateIn: ["RUNNING"],
      now: tick()
    });
    propagateNodeStates(db, { runId, now: tick() });
    throw new ContextE2eDriverError(
      siteSummary(db, { repoPath, runId }),
      `node "${nodeId}" finished ${result.finalPhase} (reasons: ${result.reasons.join(", ")})`
    );
  }

  // ---- producer: commit the declared artifact + read its OWN artifact refs -
  let outputSha: string | null = null;
  let artifactRefIds: readonly string[] = [];
  if (spec.kind === "producer") {
    if (spec.files === undefined) {
      throw new ContextE2eUsageError(`producer node "${nodeId}" declares no artifact files`);
    }
    // Benchmark stand-in for the controlled Git Service commit step (see
    // e2e-baseline/writer-commit): the fake CLI never writes repo files.
    outputSha = await commitNodeOutput(git, {
      worktreePath: created.worktreePath,
      files: spec.files,
      message: `${runId}/${nodeId}: cross-cli producer artifact`
    });
    artifactRefIds = artifactRefIdsFromFinalResult(db, result.finalResultEventId);
    if (artifactRefIds.length === 0) {
      throw new ContextE2eDriverError(
        siteSummary(db, { repoPath, runId }),
        `producer "${nodeId}" final result event declares no artifact reference`
      );
    }
  }

  // ---- bookkeeping: complete the queue entry, free the grants, node done ---
  markQueueEntryCompleted(db, { entryId: outcome.entryId, now: tick() });
  releaseExecutionQuotaGrants(db, { executionId: outcome.executionId, now: tick() });
  transitionNodeState(db, {
    runId,
    nodeId,
    to: "SUCCEEDED",
    whereStateIn: ["RUNNING"],
    now: tick()
  });

  trace.push({
    nodeId,
    round,
    executionId: outcome.executionId,
    dispatchToken: outcome.dispatchToken,
    attempt,
    branch,
    worktreePath: created.worktreePath,
    baselineSha,
    outputSha,
    finalPhase: result.finalPhase,
    reasons: [...result.reasons],
    bundleId: bundle?.manifest.bundleId ?? null,
    renderedPrompt,
    artifactRefIds,
    wallStartMs,
    wallEndMs: performance.now()
  });

  return spec.kind === "producer"
    ? { branch, headSha: outputSha ?? baselineSha, artifactRefIds, artifactFiles: spec.files ?? {} }
    : null;
}

/**
 * The artifact ids the PRODUCER's own final result event declared (the
 * stored, redacted `result_reported` event's businessResult) — the handoff
 * cites what the producer subprocess actually reported, never a hardcoded id.
 */
function artifactRefIdsFromFinalResult(
  db: DatabaseSync,
  finalResultEventId: string | null
): readonly string[] {
  if (finalResultEventId === null) {
    return [];
  }
  const row = getEvent(db, finalResultEventId);
  if (row === null) {
    return [];
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    return [];
  }
  const businessResult = (payload as { businessResult?: unknown }).businessResult;
  if (businessResult === undefined || businessResult === null) {
    return [];
  }
  const refs = (businessResult as { artifactRefs?: unknown }).artifactRefs;
  if (!Array.isArray(refs)) {
    return [];
  }
  const ids: string[] = [];
  for (const ref of refs) {
    const id = (ref as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The diagnosable site summary: store FACTS only. Returned as part of any
 * ContextE2eDriverError so a red run explains itself.
 */
function siteSummary(
  db: DatabaseSync,
  input: { readonly repoPath: string; readonly runId: string }
): string {
  const lines: string[] = ["--- cross-cli handoff site summary ---"];
  lines.push(`run: ${input.runId}  repo: ${input.repoPath}`);
  lines.push(
    `nodes: ${listRunNodes(db, input.runId)
      .map((node) => `${node.nodeId}=${node.state}`)
      .join(", ")}`
  );
  lines.push(
    `executions: ${
      listExecutionsForRun(db, input.runId)
        .map((row) => `${row.id}[${row.nodeId}]#${String(row.attempt)}=${row.phase}`)
        .join(", ") || "(none)"
    }`
  );
  for (const execution of listExecutionsForRun(db, input.runId)) {
    const events = listEventsForExecution(db, execution.id);
    const tail = events.slice(-6).map((event) => `#${String(event.seq)}:${event.type}`);
    lines.push(`last events of ${execution.id}: ${tail.join(", ") || "(none)"}`);
  }
  return lines.join("\n");
}

/** sha256 over UTF-8 bytes — used by tests to compare rendered prompts. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
