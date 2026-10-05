/**
 * The graph pump (M5-05) — the benchmark harness that walks ONE run through
 * the REAL chain, using each package's public service surface and nothing
 * else (same discipline as the M2-06 baseline driver, which this is adapted
 * from):
 *
 *   dag.propagateNodeStates / transitionNodeState
 *   scheduler.enqueueReadyNodes -> pollQueue (real quotas + credential lock)
 *   integration.integrateParents (single-writer merge, candidateSha)
 *   worktree.createWorktree (isolated exec worktree)
 *   engine.startExecution (the fake-cli dist bin as a real subprocess)
 *   review.openReviewSession -> runValidationCommand -> completeReview
 *
 * The two pieces the pump itself supplies are BENCHMARK PLUMBING, documented
 * as such: the writer output commit (the e2e-baseline package's
 * `commitNodeOutput`) stands in for the controlled Git Service commit step,
 * and the review validation script is the machine evidence a reviewer would
 * derive from the candidate. All state, quota, integration and review
 * semantics come from the packages.
 *
 * The pump NEVER creates the graph — `createRunnableRun` (world.ts) owns
 * graph creation + the revision baseline, and the rework flow's second pump
 * call walks EXPANSION-MINTED nodes that the expander itself appended.
 *
 * The one addition over the M2-06 driver is the `onRoundStarted` hook: it
 * fires AFTER a round's executions STARTED (their promises are running, not
 * yet joined) and is awaited before the round is joined — the window the
 * browser tests use to load the live page and capture the RUNNING canvas.
 */
import type { DispatchedOutcome, QuotaRejectedOutcome } from "@role-orchestrator/scheduler";
import { enqueueReadyNodes, listQueueEntries, pollQueue } from "@role-orchestrator/scheduler";
import { createSequenceClock, commitNodeOutput } from "@role-orchestrator/e2e-baseline";
import { integrateParents } from "@role-orchestrator/integration";
import { completeReview, openReviewSession, runValidationCommand } from "@role-orchestrator/review";
import { propagateNodeStates } from "@role-orchestrator/dag";
import { startExecution } from "@role-orchestrator/engine";
import type { EngineTerminalPhase } from "@role-orchestrator/engine";
import { listAttemptsForSlot } from "@role-orchestrator/store";
import { branchNameFor, createWorktree } from "@role-orchestrator/worktree";
import type { BaselineNodeSpec } from "@role-orchestrator/e2e-baseline";
import {
  baselineFor,
  buildParents,
  runPumpRounds,
  settleClaimedNode
} from "@role-orchestrator/orchestration";
import { PumpConvergenceError } from "./errors.js";
import type { BrowserE2eWorld } from "./world.js";

export interface PumpRoundQuotaRejection {
  readonly round: number;
  readonly nodeId: string;
  readonly dimension: string;
  readonly resourceKey: string;
  readonly max: number;
  readonly liveCount: number;
}

export interface PumpNodeTrace {
  readonly nodeId: string;
  readonly round: number;
  readonly executionId: string;
  readonly attempt: number;
  readonly branch: string;
  readonly worktreePath: string;
  readonly outputSha: string | null;
  readonly finalPhase: EngineTerminalPhase;
  readonly candidateSha: string | null;
  readonly reviewVerdict: "pass" | "fail" | "blocked" | null;
  /** Wall-clock start/end (Date.now) — the serialization-evidence window. */
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

export interface PumpResult {
  readonly rounds: number;
  readonly trace: readonly PumpNodeTrace[];
  readonly quotaRejections: readonly PumpRoundQuotaRejection[];
  /** node id -> accepted output {branch, headSha} after the pump converged. */
  readonly acceptedOutputs: ReadonlyMap<string, { readonly branch: string; readonly headSha: string }>;
  /** node id -> recorded candidateSha (integration nodes). */
  readonly candidates: ReadonlyMap<string, string>;
}

export interface PumpOptions {
  readonly world: BrowserE2eWorld;
  readonly runId: string;
  readonly baseSha: string;
  readonly specs: readonly BaselineNodeSpec[];
  /**
   * Review node id -> the file set the reviewed candidate MUST contain for
   * the validation command to pass. Absent entries fall back to the files
   * declared along the reviewed chain. The rework flow pins the round-1
   * review to require the (not yet existing) repair file — a genuine,
   * content-grounded FAIL — and the round-2 re-review to require BOTH files
   * (now present) — a genuine PASS.
   */
  readonly reviewExpectations?: ReadonlyMap<string, Readonly<Record<string, string>>> | undefined;
  /**
   * Accepted outputs from a PREVIOUS pump call over the same run (the rework
   * flow's round 2 walks expansion-minted nodes whose baselines are round
   * 1's outputs). Seeded into the map so dependency baselines resolve.
   */
  readonly seedAcceptedOutputs?: ReadonlyMap<string, { readonly branch: string; readonly headSha: string }> | undefined;
  /**
   * Invoked after a round's executions STARTED (promises running, not yet
   * joined) — the browser captures the live canvas here. Awaited.
   */
  readonly onRoundStarted?:
    | ((round: number, dispatched: readonly DispatchedOutcome[]) => Promise<void>)
    | undefined;
}

export async function runPump(options: PumpOptions): Promise<PumpResult> {
  const { world, runId, baseSha, specs } = options;
  const definitionRevision = "rev-browser-e2e-1";
  const clock = createSequenceClock({ stepMs: 1_000 });
  const tick = (): string => clock.tick();

  const specById = new Map<string, BaselineNodeSpec>(specs.map((spec) => [spec.id, spec]));
  if (specById.size !== specs.length) {
    throw new PumpConvergenceError("duplicate node ids in pump specs");
  }

  const trace: PumpNodeTrace[] = [];
  const quotaRejections: PumpRoundQuotaRejection[] = [];
  const acceptedOutputs = new Map<string, { readonly branch: string; readonly headSha: string }>();
  const candidates = new Map<string, string>();
  if (options.seedAcceptedOutputs !== undefined) {
    for (const [nodeId, output] of options.seedAcceptedOutputs) {
      acceptedOutputs.set(nodeId, output);
    }
  }

  const allSucceeded = (): boolean =>
    listRunNodeStates(world.db, runId).every((node) => node.state === "SUCCEEDED");

  // The round loop is the SHARED pump primitive (M10-02 step 2): the
  // benchmark strategy parameters — parallel join, throw-up isolation,
  // all-succeeded convergence, the live-canvas onRoundStarted window — are
  // this pump's configuration of it.
  const pump = await runPumpRounds<DispatchedOutcome, QuotaRejectedOutcome>({
    listNodeStates: () => listRunNodeStates(world.db, runId).map((node) => node.state),
    propagate: () => propagateNodeStates(world.db, { runId, now: tick() }),
    enqueueReady: () => enqueueReadyNodes(world.db, { runId, now: tick() }),
    poll: () =>
      pollQueue(world.db, {
        now: tick(),
        leaseMs: 600_000,
        retryWindowMs: 50,
        starvationMs: 600_000,
        limit: 8,
        concurrency: { globalMax: 4, projectMax: 4, unverifiedCredentialGroupMax: 1 }
      }),
    onQuotaRejected: (rejection, round) => {
      quotaRejections.push({
        round,
        nodeId: rejection.nodeId,
        dimension: rejection.blockedBy.dimension,
        resourceKey: rejection.blockedBy.resourceKey,
        max: rejection.blockedBy.max,
        liveCount: rejection.blockedBy.liveCount
      });
    },
    onNoneDispatchable: (round) => {
      const waiting = listQueueEntries(world.db, { state: "WAITING" });
      if (waiting.length === 0) {
        throw new PumpConvergenceError(
          `round ${String(round)}: nothing dispatchable, no WAITING entries, not every node SUCCEEDED ` +
            `(${describeNodes(world.db, runId)})`
        );
      }
      return "continue"; // retry-window entries become due on a later synthetic tick
    },
    onRoundStarted: options.onRoundStarted,
    onDispatched: (outcome, round) => {
      const spec = specById.get(outcome.nodeId);
      if (spec === undefined) {
        throw new PumpConvergenceError(`scheduler dispatched unknown pump node "${outcome.nodeId}"`);
      }
      return runDispatchedNode(world, options, { runId, baseSha, definitionRevision, tick }, outcome, spec, acceptedOutputs, candidates, trace, round);
    }
  }, { convergence: "all-succeeded", dispatchJoin: "parallel", errorIsolation: "throw-up" });

  if (!allSucceeded()) {
    throw new PumpConvergenceError(
      `run "${runId}" did not converge after ${String(pump.rounds)} rounds (${describeNodes(world.db, runId)})`
    );
  }
  return { rounds: pump.rounds, trace, quotaRejections, acceptedOutputs, candidates };
}

interface PumpContext {
  readonly runId: string;
  readonly baseSha: string;
  readonly definitionRevision: string;
  readonly tick: () => string;
}

async function runDispatchedNode(
  world: BrowserE2eWorld,
  options: PumpOptions,
  context: PumpContext,
  outcome: DispatchedOutcome,
  spec: BaselineNodeSpec,
  acceptedOutputs: Map<string, { readonly branch: string; readonly headSha: string }>,
  candidates: Map<string, string>,
  trace: PumpNodeTrace[],
  round: number
): Promise<void> {
  const { db, worktreesRoot } = world;
  const git = world.fixture.git;
  const { runId, baseSha, definitionRevision, tick } = context;
  const nodeId = spec.id;
  const wallStartMs = Date.now();

  const attempt = listAttemptsForSlot(db, { runId, nodeId }).length;
  const branch = branchNameFor(runId, nodeId, attempt);

  // ---- integration nodes: the single-writer assembly -----------------------
  let baselineSha: string;
  let candidateSha: string | null = null;
  if (spec.kind === "integration") {
    // The SHARED parents constructor (M10-02 step 2): dependency order,
    // accepted outputs only.
    const parents = buildParents(nodeId, spec.dependencies, acceptedOutputs);
    const integrated = await integrateParents(
      { db, git },
      { repoPath: world.repoPath, worktreesRoot, runId, nodeId, baseSha, parents, now: tick() }
    );
    candidateSha = integrated.candidateSha;
    candidates.set(nodeId, integrated.candidateSha);
    baselineSha = integrated.candidateSha;
  } else {
    // The SHARED baseline rule (M10-02 step 2): last accepted dependency
    // wins, else the run's base commit.
    baselineSha = baselineFor(spec.dependencies, acceptedOutputs, baseSha);
  }

  const created = await createWorktree(git, {
    repoPath: world.repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt,
    baseSha: baselineSha
  });

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
    prompt: `browser e2e node ${runId}/${nodeId} (${spec.title}); scenario ${spec.scenario}`,
    invocationArgs,
    timeoutSeconds: 120,
    now: tick(),
    claimedAttempt: true
  });
  const result = await run.result;

  if (result.finalPhase !== "SUCCEEDED") {
    // Fail-closed settlement (the SHARED sequence, M10-02 step 2).
    settleClaimedNode(db, {
      entryId: outcome.entryId,
      executionId: outcome.executionId,
      runId,
      nodeId,
      to: "FAILED",
      now: tick()
    });
    throw new PumpConvergenceError(
      `node "${nodeId}" finished ${result.finalPhase} (reasons: ${result.reasons.join(", ")})`,
      { cause: result }
    );
  }

  // ---- writer output commit (benchmark stand-in, see commitNodeOutput) -----
  let outputSha: string | null = null;
  if (spec.kind === "writer" && spec.files !== undefined) {
    outputSha = await commitNodeOutput(git, {
      worktreePath: created.worktreePath,
      files: spec.files,
      message: `${runId}/${nodeId}: browser e2e node output`
    });
  }

  // ---- review node: fixed-SHA session + machine validation -----------------
  let reviewVerdict: PumpNodeTrace["reviewVerdict"] = null;
  if (spec.kind === "review") {
    if (spec.reviewsNode === undefined) {
      throw new PumpConvergenceError(`review node "${nodeId}" declares no reviewsNode`);
    }
    // The reviewed node's accepted output: the integration candidate for an
    // integration node, the writer's output commit otherwise (set before the
    // review can become READY, since the review depends on it).
    const accepted = acceptedOutputs.get(spec.reviewsNode);
    const candidateShaForReview = accepted?.headSha ?? candidates.get(spec.reviewsNode) ?? outputSha;
    if (candidateShaForReview === undefined || candidateShaForReview === null) {
      throw new PumpConvergenceError(
        `review node "${nodeId}" reviews "${spec.reviewsNode}" which produced no candidate`
      );
    }
    const expectedFiles =
      options.reviewExpectations?.get(spec.id) ??
      reviewedChainFiles(spec, options.specs, acceptedOutputs);
    const session = await openReviewSession(
      { db, git },
      { repoPath: world.repoPath, worktreesRoot, runId, nodeId, candidateSha: candidateShaForReview, now: tick() }
    );
    const validation = await runValidationCommand(session, {
      argv: [process.execPath, "-e", reviewValidationScript(candidateShaForReview, expectedFiles, spec.id)],
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
            verdict === "pass"
              ? []
              : [`${spec.id}: candidate ${candidateShaForReview} misses required content (validation exit ${String(validation.exitCode)})`]
        },
        now: tick()
      }
    );
    reviewVerdict = verdict;
  }

  // ---- bookkeeping: the SHARED settlement sequence (M10-02 step 2) --------
  settleClaimedNode(db, {
    entryId: outcome.entryId,
    executionId: outcome.executionId,
    runId,
    nodeId,
    to: "SUCCEEDED",
    now: tick()
  });
  acceptedOutputs.set(nodeId, { branch, headSha: outputSha ?? baselineSha });

  trace.push({
    nodeId,
    round,
    executionId: outcome.executionId,
    attempt,
    branch,
    worktreePath: created.worktreePath,
    outputSha,
    finalPhase: result.finalPhase,
    candidateSha,
    reviewVerdict,
    wallStartMs,
    wallEndMs: Date.now()
  });
}

/**
 * Default expectation for a review node: every file declared along the
 * reviewed chain (the reviewed node and its accepted ancestors).
 */
function reviewedChainFiles(
  spec: BaselineNodeSpec,
  specs: readonly BaselineNodeSpec[],
  acceptedOutputs: ReadonlyMap<string, { readonly branch: string; readonly headSha: string }>
): Readonly<Record<string, string>> {
  const expected: Record<string, string> = {};
  if (spec.reviewsNode === undefined) return expected;
  const chain = new Set<string>([spec.reviewsNode]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of specs) {
      if (!chain.has(candidate.id)) continue;
      for (const dep of candidate.dependencies) {
        if (!chain.has(dep) && acceptedOutputs.has(dep)) {
          chain.add(dep);
          grew = true;
        }
      }
    }
  }
  for (const candidate of specs) {
    if (chain.has(candidate.id) && candidate.files !== undefined) {
      Object.assign(expected, candidate.files);
    }
  }
  return expected;
}

/**
 * The reviewer's machine evidence: a node script run in the one-shot
 * workspace copy of the candidate that checks the candidate tree really
 * contains every expected file, then writes a disposable artifact (A13).
 */
function reviewValidationScript(
  candidateSha: string,
  expected: Readonly<Record<string, string>>,
  reviewNodeId: string
): string {
  return [
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const candidate = ${JSON.stringify(candidateSha)};`,
    `const reviewNode = ${JSON.stringify(reviewNodeId)};`,
    `const expected = ${JSON.stringify(expected)};`,
    `let ok = true;`,
    `for (const [rel, want] of Object.entries(expected)) {`,
    `  const p = path.join(process.cwd(), ...rel.split("/"));`,
    `  let got = null;`,
    `  try { got = fs.readFileSync(p, "utf8"); } catch { got = null; }`,
    `  if (got !== want) { console.error("candidate " + candidate + " content mismatch: " + rel + " (" + reviewNode + ")"); ok = false; }`,
    `}`,
    `fs.mkdirSync(path.join(process.cwd(), "validation-artifacts"), { recursive: true });`,
    `fs.writeFileSync(path.join(process.cwd(), "validation-artifacts", "browser-e2e-validation.txt"), "browser e2e validation ran\\n", "utf8");`,
    `process.exit(ok ? 0 : 1);`
  ].join("\n");
}

interface NodeStateRow {
  readonly nodeId: string;
  readonly state: string;
}

function listRunNodeStates(db: BrowserE2eWorld["db"], runId: string): readonly NodeStateRow[] {
  return (
    db
      .prepare("SELECT node_id, state FROM task_nodes WHERE run_id = ? ORDER BY node_id")
      .all(runId) as unknown as readonly { node_id: string; state: string }[]
  ).map((row) => ({ nodeId: row.node_id, state: row.state }));
}

function describeNodes(db: BrowserE2eWorld["db"], runId: string): string {
  return listRunNodeStates(db, runId)
    .map((node) => `${node.nodeId}=${node.state}`)
    .join(", ");
}
