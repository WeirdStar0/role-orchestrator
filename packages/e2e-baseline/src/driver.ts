/**
 * The baseline driver (M2-06) — the benchmark pump that walks ONE run through
 * the REAL chain, using each package's public service surface and nothing
 * else:
 *
 *   dag.createRunGraph            (plan validation + graph, before any spawn)
 *   scheduler.enqueueReadyNodes   (fair READY queue)
 *   scheduler.pollQueue           (atomic dispatch claim: real three-level
 *                                  quota + unverified-credential lock, fencing
 *                                  grants, STARTING attempt, dispatch outbox)
 *   integration.integrateParents  (single-writer task-branch merge, inputSha
 *                                  set + candidateSha — for integration nodes)
 *   worktree.createWorktree       (isolated exec worktree from a fixed base)
 *   engine.startExecution         (claimedAttempt composition; the fake-cli
 *                                  dist bin runs as a real subprocess)
 *   review.openReviewSession      (fixed-SHA baseline + disposable workspace)
 *   runValidationCommand          (machine evidence in the workspace)
 *   completeReview                (candidateSha-bound verdict, A12/A13)
 *   dag.propagateNodeStates       (PENDING -> READY -> ...; FAILED -> BLOCKED)
 *
 * What the driver itself does is BENCHMARK PLUMBING, not product logic, and is
 * documented as such: the node-output commit (writer-commit.ts) stands in for
 * the controlled Git Service commit step that lands in a later milestone, and
 * the poll/execute loop is the minimal honest pump for "every dispatched node
 * reaches a terminal phase". All quota, state-machine, integration and review
 * semantics come from the packages, never from this file.
 */
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { EngineTerminalPhase, ExecutionRunResult } from "@role-orchestrator/engine";
import { startExecution } from "@role-orchestrator/engine";
import {
  createRunGraph,
  listRunNodes,
  propagateNodeStates,
  transitionNodeState
} from "@role-orchestrator/dag";
import type { NodeState } from "@role-orchestrator/dag";
import type { ParentCommit } from "@role-orchestrator/integration";
import { integrateParents } from "@role-orchestrator/integration";
import {
  completeReview,
  openReviewSession,
  runValidationCommand
} from "@role-orchestrator/review";
import {
  enqueueReadyNodes,
  listQueueEntries,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants,
  type DispatchedOutcome,
  type QuotaBlockedBy
} from "@role-orchestrator/scheduler";
import {
  listAttemptsForSlot,
  listEventsForExecution,
  listExecutionsForRun,
  verifyEventChecksums
} from "@role-orchestrator/store";
import {
  branchNameFor,
  createWorktree,
  worktreePathFor,
  type GitRunner,
  type RepositorySnapshot
} from "@role-orchestrator/worktree";
import { BaselineDriverError, BaselineDriverUsageError } from "./errors.js";
import { createSequenceClock } from "./clock.js";
import { FIXTURE_SEED_FILES } from "./fixture-repo.js";
import type { BaselineNodeSpec } from "./scenario.js";
import { commitNodeOutput } from "./writer-commit.js";

export interface DriverConcurrency {
  readonly globalMax: number;
  readonly projectMax: number;
  readonly unverifiedCredentialGroupMax: 1;
}

export const DEFAULT_BASELINE_CONCURRENCY: DriverConcurrency = {
  globalMax: 4,
  projectMax: 4,
  unverifiedCredentialGroupMax: 1
};

export interface DriverOptions {
  readonly db: DatabaseSync;
  readonly git: GitRunner;
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly runId: string;
  readonly baseSha: string;
  /** RAW workflow input; createRunGraph validates it before anything runs. */
  readonly workflow: unknown;
  readonly specs: readonly BaselineNodeSpec[];
  readonly definitionRevision?: string;
  readonly concurrency?: DriverConcurrency;
  /** Synthetic-clock step (ms); keep well below the scheduler lease window. */
  readonly clockStepMs?: number;
}

export interface DriverIntegrationTrace {
  readonly kind: "integrated" | "already-integrated";
  readonly candidateSha: string;
  readonly inputShaSet: readonly ParentCommit[];
}

export interface DriverReviewTrace {
  readonly reviewId: string;
  readonly candidateSha: string;
  readonly verdict: "pass" | "fail" | "blocked";
  readonly validationExitCode: number | null;
}

export interface NodeExecutionTrace {
  readonly nodeId: string;
  readonly round: number;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly attempt: number;
  readonly branch: string;
  readonly worktreePath: string;
  /** The node's input baseline (fixed base SHA of its worktree). */
  readonly baselineSha: string;
  /** Writer only: the committed output tip; others carry null. */
  readonly outputSha: string | null;
  readonly finalPhase: EngineTerminalPhase;
  readonly reasons: readonly string[];
  readonly integration: DriverIntegrationTrace | null;
  readonly review: DriverReviewTrace | null;
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

export interface DriverQuotaRejection {
  readonly nodeId: string;
  readonly round: number;
  readonly blockedBy: QuotaBlockedBy;
  readonly attempts: number;
  readonly lastReason: string | null;
}

export interface BaselineRunResult {
  readonly runId: string;
  readonly rounds: number;
  readonly trace: readonly NodeExecutionTrace[];
  readonly quotaRejections: readonly DriverQuotaRejection[];
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly state: NodeState;
        readonly baselineSha: string;
        readonly outputSha: string | null;
        readonly branch: string;
      }
    >
  >;
  /** Integration node id -> recorded candidateSha (inputSha set in trace). */
  readonly candidates: Readonly<Record<string, string>>;
  /** The user-repo snapshot captured by the FIRST worktree creation (A11). */
  readonly firstUserRepoSnapshot: RepositorySnapshot;
  /** Every createWorktree's user-repo status fingerprint, in order (A11). */
  readonly worktreeFingerprints: readonly string[];
}

const MAX_ROUNDS = 32;

export async function runBaseline(options: DriverOptions): Promise<BaselineRunResult> {
  const { db, repoPath, runId, baseSha, workflow, specs } = options;
  const definitionRevision = options.definitionRevision ?? "rev-e2e-1";
  const concurrency = options.concurrency ?? DEFAULT_BASELINE_CONCURRENCY;
  const clock = createSequenceClock({ stepMs: options.clockStepMs ?? 1_000 });

  const specById = new Map<string, BaselineNodeSpec>(specs.map((spec) => [spec.id, spec]));
  if (specById.size !== specs.length) {
    throw new BaselineDriverUsageError("duplicate node ids in baseline scenario specs");
  }

  // ---- dag: the single pre-start gate (A08/A03/A02 before anything runs) ---
  createRunGraph(db, { runId, workflow, definitionRevision, now: clock.tick() });

  const acceptedOutputs = new Map<string, { readonly branch: string; readonly headSha: string }>();
  const baselines = new Map<string, string>();
  const candidates = new Map<string, string>();
  const trace: NodeExecutionTrace[] = [];
  const quotaRejections: DriverQuotaRejection[] = [];
  const worktreeFingerprints: string[] = [];
  let firstUserRepoSnapshot: RepositorySnapshot | null = null;

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
      limit: 8,
      concurrency
    });
    for (const rejection of poll.quotaRejected) {
      quotaRejections.push({
        nodeId: rejection.nodeId,
        round,
        blockedBy: rejection.blockedBy,
        attempts: rejection.attempts,
        lastReason: lastReasonOf(db, rejection.entryId)
      });
    }
    if (poll.dispatched.length === 0) {
      const waiting = listQueueEntries(db, { state: "WAITING" });
      if (waiting.length === 0) {
        throw new BaselineDriverError(
          siteSummary(db, { repoPath, runId }),
          `round ${String(round)}: nothing dispatchable and no WAITING entries, ` +
            `but not every node SUCCEEDED (quota-rejections so far: ${String(quotaRejections.length)})`
        );
      }
      continue; // retry-window entries become due on a later synthetic tick
    }
    const context: DispatchContext = {
      options,
      tick: clock.tick,
      round,
      definitionRevision,
      acceptedOutputs,
      baselines,
      candidates,
      trace,
      worktreeFingerprints,
      setFirstSnapshot: (snapshot: RepositorySnapshot): void => {
        if (firstUserRepoSnapshot === null) firstUserRepoSnapshot = snapshot;
      }
    };
    await Promise.all(
      poll.dispatched.map((outcome) =>
        runDispatchedNode(context, outcome, requireSpec(specById, outcome.nodeId))
      )
    );
  }

  if (!allSucceeded()) {
    throw new BaselineDriverError(
      siteSummary(db, { repoPath, runId }),
      `run did not converge after ${String(round)} rounds`
    );
  }
  if (firstUserRepoSnapshot === null) {
    throw new BaselineDriverUsageError("baseline ran without creating any worktree");
  }

  const nodes: Record<
    string,
    { state: NodeState; baselineSha: string; outputSha: string | null; branch: string }
  > = {};
  const storedNodes = listRunNodes(db, runId);
  for (const spec of specs) {
    const output = acceptedOutputs.get(spec.id);
    const baseline = baselines.get(spec.id) ?? baseSha;
    nodes[spec.id] = {
      state: storedNodes.find((node) => node.nodeId === spec.id)?.state ?? "PENDING",
      baselineSha: baseline,
      outputSha: output !== undefined && output.headSha !== baseline ? output.headSha : null,
      branch: output?.branch ?? branchNameFor(runId, spec.id, 1)
    };
  }

  return {
    runId,
    rounds: round,
    trace,
    quotaRejections,
    nodes,
    candidates: Object.fromEntries(candidates),
    firstUserRepoSnapshot,
    worktreeFingerprints
  };
}

function requireSpec(
  specById: ReadonlyMap<string, BaselineNodeSpec>,
  nodeId: string
): BaselineNodeSpec {
  const spec = specById.get(nodeId);
  if (spec === undefined) {
    throw new BaselineDriverUsageError(`scheduler dispatched unknown baseline node "${nodeId}"`);
  }
  return spec;
}

function lastReasonOf(db: DatabaseSync, entryId: string): string | null {
  return listQueueEntries(db).find((entry) => entry.id === entryId)?.lastReason ?? null;
}

/** Last dependency with an accepted output, else the run's base commit. */
function baselineFor(
  spec: BaselineNodeSpec,
  acceptedOutputs: ReadonlyMap<string, { readonly branch: string; readonly headSha: string }>,
  baseSha: string
): string {
  for (let index = spec.dependencies.length - 1; index >= 0; index -= 1) {
    const dep = acceptedOutputs.get(spec.dependencies[index] as string);
    if (dep !== undefined) return dep.headSha;
  }
  return baseSha;
}

interface DispatchContext {
  readonly options: DriverOptions;
  readonly tick: () => string;
  readonly round: number;
  readonly definitionRevision: string;
  readonly acceptedOutputs: Map<string, { readonly branch: string; readonly headSha: string }>;
  readonly baselines: Map<string, string>;
  readonly candidates: Map<string, string>;
  readonly trace: NodeExecutionTrace[];
  readonly worktreeFingerprints: string[];
  readonly setFirstSnapshot: (snapshot: RepositorySnapshot) => void;
}

async function runDispatchedNode(
  context: DispatchContext,
  outcome: DispatchedOutcome,
  spec: BaselineNodeSpec
): Promise<void> {
  const { db, git, repoPath, worktreesRoot, runId, baseSha } = context.options;
  const { tick, round, definitionRevision, acceptedOutputs, baselines, candidates } = context;
  const nodeId = spec.id;
  const wallStartMs = performance.now();

  // The claim created attempt N for this slot; N = current row count.
  const attempt = listAttemptsForSlot(db, { runId, nodeId }).length;
  const branch = branchNameFor(runId, nodeId, attempt);
  const worktreePath = worktreePathFor(worktreesRoot, runId, nodeId, attempt);

  // ---- integration nodes: the IntegrationService assembles the baseline ----
  let baselineSha: string;
  let integrationTrace: DriverIntegrationTrace | null = null;
  if (spec.kind === "integration") {
    const parents: ParentCommit[] = spec.dependencies.map((dep) => {
      const output = acceptedOutputs.get(dep);
      if (output === undefined) {
        throw new BaselineDriverUsageError(
          `integration node "${nodeId}" depends on "${dep}" which has no accepted output yet`
        );
      }
      return { nodeId: dep, branch: output.branch, headSha: output.headSha };
    });
    const integrated = await integrateParents(
      { db, git },
      { repoPath, worktreesRoot, runId, nodeId, baseSha, parents, now: tick() }
    );
    candidates.set(nodeId, integrated.candidateSha);
    baselineSha = integrated.candidateSha;
    integrationTrace =
      integrated.kind === "integrated"
        ? {
            kind: "integrated",
            candidateSha: integrated.candidateSha,
            inputShaSet: integrated.inputShaSet
          }
        : { kind: "already-integrated", candidateSha: integrated.candidateSha, inputShaSet: parents };
  } else {
    baselineSha = baselineFor(spec, acceptedOutputs, baseSha);
  }
  baselines.set(nodeId, baselineSha);

  // ---- worktree isolation from the fixed baseline (M2-03) ------------------
  const created = await createWorktree(git, {
    repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt,
    baseSha: baselineSha
  });
  context.worktreeFingerprints.push(created.userRepoSnapshot.rawStatusSha256);
  context.setFirstSnapshot(created.userRepoSnapshot);

  // ---- engine: real fake-cli subprocess on the claimed attempt (M2-06) -----
  const invocationArgs: string[] = ["--scenario", spec.scenario];
  if (spec.delayMs !== undefined) {
    invocationArgs.push("--delay-ms", String(spec.delayMs));
  }
  const run = startExecution(db, {
    executionId: outcome.executionId,
    runId,
    roleId: spec.role,
    nodeId,
    definitionRevision,
    attempt,
    dispatchToken: outcome.dispatchToken,
    cwd: created.worktreePath,
    prompt: `e2e baseline node ${runId}/${nodeId} (${spec.title}); scenario ${spec.scenario}`,
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
    throw new BaselineDriverError(
      siteSummary(db, {
        repoPath,
        runId,
        failed: { nodeId, executionId: outcome.executionId, result, worktreePath }
      }),
      `node "${nodeId}" finished ${result.finalPhase} (reasons: ${result.reasons.join(", ")})`
    );
  }

  // ---- writer output commit (benchmark stand-in; see writer-commit.ts) -----
  let outputSha: string | null = null;
  if (spec.kind === "writer" && spec.files !== undefined) {
    outputSha = await commitNodeOutput(git, {
      worktreePath: created.worktreePath,
      files: spec.files,
      message: `${runId}/${nodeId}: e2e baseline node output`
    });
  }

  // ---- review node: fixed-SHA session over the reviewed candidate ----------
  let reviewTrace: DriverReviewTrace | null = null;
  if (spec.kind === "review") {
    if (spec.reviewsNode === undefined) {
      throw new BaselineDriverUsageError(`review node "${nodeId}" declares no reviewsNode`);
    }
    const candidateSha = candidates.get(spec.reviewsNode);
    if (candidateSha === undefined) {
      throw new BaselineDriverUsageError(
        `review node "${nodeId}" reviews "${spec.reviewsNode}" which produced no candidateSha`
      );
    }
    const session = await openReviewSession(
      { db, git },
      { repoPath, worktreesRoot, runId, nodeId, candidateSha, now: tick() }
    );
    const validation = await runValidationCommand(session, {
      argv: [process.execPath, "-e", reviewValidationScript(spec, candidateSha, context.options.specs)],
      timeoutMs: 60_000
    });
    const verdict = validation.exitCode === 0 ? "pass" : "fail";
    await completeReview(
      { db, git },
      session,
      {
        review: {
          verdict,
          candidateSha: session.candidateSha,
          evidenceRefs: [validation.artifactRef.id],
          findings:
            verdict === "pass" ? [] : [`validation command exited ${String(validation.exitCode)}`]
        },
        now: tick()
      }
    );
    reviewTrace = {
      reviewId: session.reviewId,
      candidateSha,
      verdict,
      validationExitCode: validation.exitCode
    };
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
  acceptedOutputs.set(nodeId, { branch, headSha: outputSha ?? baselineSha });

  context.trace.push({
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
    integration: integrationTrace,
    review: reviewTrace,
    wallStartMs,
    wallEndMs: performance.now()
  });
}

/**
 * The reviewer's machine evidence: a node script that runs in the one-shot
 * workspace copy of the candidate and checks that the candidate tree really
 * contains the seed content AND every accepted parent output (content-level
 * A09 evidence), then writes a disposable artifact into the workspace to prove
 * the validation directory is writable while the reviewed source is not (A13).
 */
function reviewValidationScript(
  reviewSpec: BaselineNodeSpec,
  candidateSha: string,
  specs: readonly BaselineNodeSpec[]
): string {
  const reviewed = specs.find((spec) => spec.id === reviewSpec.reviewsNode);
  const expected: Record<string, string> = { ...FIXTURE_SEED_FILES };
  for (const dep of reviewed?.dependencies ?? []) {
    const parent = specs.find((spec) => spec.id === dep);
    if (parent?.files !== undefined) {
      Object.assign(expected, parent.files);
    }
  }
  return [
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const candidate = ${JSON.stringify(candidateSha)};`,
    `const expected = ${JSON.stringify(expected)};`,
    `let ok = true;`,
    `for (const [rel, want] of Object.entries(expected)) {`,
    `  const p = path.join(process.cwd(), ...rel.split("/"));`,
    `  let got = null;`,
    `  try { got = fs.readFileSync(p, "utf8"); } catch { got = null; }`,
    `  if (got !== want) { console.error("candidate " + candidate + " content mismatch: " + rel); ok = false; }`,
    `}`,
    `fs.mkdirSync(path.join(process.cwd(), "validation-artifacts"), { recursive: true });`,
    `fs.writeFileSync(path.join(process.cwd(), "validation-artifacts", "e2e-validation.txt"), "e2e baseline validation ran\\n", "utf8");`,
    `process.exit(ok ? 0 : 1);`
  ].join("\n");
}

/**
 * The diagnosable site summary: store FACTS only. Returned as part of any
 * BaselineDriverError so a red run explains itself.
 */
function siteSummary(
  db: DatabaseSync,
  input: {
    readonly repoPath: string;
    readonly runId: string;
    readonly failed?: {
      readonly nodeId: string;
      readonly executionId: string;
      readonly result: ExecutionRunResult;
      readonly worktreePath: string;
    };
  }
): string {
  const lines: string[] = ["--- e2e baseline site summary ---"];
  lines.push(`run: ${input.runId}  repo: ${input.repoPath}`);
  lines.push(
    `nodes: ${listRunNodes(db, input.runId).map((node) => `${node.nodeId}=${node.state}`).join(", ")}`
  );
  lines.push(
    `executions: ${
      listExecutionsForRun(db, input.runId)
        .map((row) => `${row.id}[${row.nodeId}]#${String(row.attempt)}=${row.phase}`)
        .join(", ") || "(none)"
    }`
  );
  if (input.failed !== undefined) {
    const { result, worktreePath, nodeId } = input.failed;
    lines.push(
      `failed node: ${nodeId} phase=${result.finalPhase} reasons=[${result.reasons.join(", ")}] ` +
        `exitCode=${String(result.exitCode)} timedOut=${String(result.timedOut)}`
    );
    lines.push(`worktree preserved (A40): ${worktreePath}`);
    const events = listEventsForExecution(db, input.failed.executionId);
    const tail = events.slice(-6).map((event) => `#${String(event.seq)}:${event.type}`);
    lines.push(`last events of ${input.failed.executionId}: ${tail.join(", ") || "(none)"}`);
  }
  lines.push(`event checksum mismatches: ${String(verifyEventChecksums(db).length)}`);
  lines.push(
    `queue: ${
      listQueueEntries(db)
        .map(
          (entry) =>
            `${entry.nodeId}:${entry.state}${entry.lastReason === null ? "" : `(${entry.lastReason})`}`
        )
        .join(", ") || "(empty)"
    }`
  );
  return lines.join("\n");
}
