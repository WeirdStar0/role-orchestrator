/**
 * The end-to-end chain drive of the fault matrix (M4-05).
 *
 * MATRIX DRIVER PLUMBING, not product logic — the direct counterpart of the
 * M2-06 baseline driver, reduced to the steps the matrix injects faults
 * between, and NEVER throwing a failure away: every step returns its
 * observable outcome so a case can assert the recovery semantics around it.
 *
 *   dag.createRunGraph            (plan validation + graph, before any spawn)
 *   scheduler.enqueueReadyNodes   (fair READY queue)
 *   scheduler.pollQueue           (atomic dispatch claim: real three-level
 *                                  quota + credential lock, STARTING attempt)
 *   worktree.createWorktree       (isolated exec worktree from a fixed base)
 *   engine.startExecution         (claimedAttempt composition; the fake-cli
 *                                  dist bin runs as a real subprocess)
 *   writer output commit          (fixed-identity stand-in, same as M2-06)
 *   integration.integrateParents  (single-writer task-branch merge)
 *   review session + verdict      (fixed-SHA baseline + machine evidence)
 *   dag.propagateNodeStates       (PENDING -> READY -> ...; FAILED -> BLOCKED)
 *
 * All quota, state-machine, integration and review semantics come from the
 * packages; this file only sequences them deterministically.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import type { EngineTerminalPhase, ExecutionRunResult } from "@role-orchestrator/engine";
import { startExecution } from "@role-orchestrator/engine";
import type { ParentCommit } from "@role-orchestrator/integration";
import { integrateParents } from "@role-orchestrator/integration";
import {
  completeReview,
  openReviewSession,
  runValidationCommand
} from "@role-orchestrator/review";
import {
  enqueueReadyNodes,
  markQueueEntryCompleted,
  pollQueue,
  releaseExecutionQuotaGrants,
  type DispatchedOutcome
} from "@role-orchestrator/scheduler";
import { listAttemptsForSlot } from "@role-orchestrator/store";
import { createRunGraph, propagateNodeStates, transitionNodeState } from "@role-orchestrator/dag";
import { branchNameFor, createWorktree } from "@role-orchestrator/worktree";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MatrixWorld } from "./world.js";
import { iso, T0 } from "./world.js";

/** How a node behaves in the chain drive (same vocabulary as M2-06). */
export type ChainNodeKind = "plain" | "writer" | "integration" | "review";

export interface ChainNodeSpec {
  readonly id: string;
  readonly role: RoleId;
  readonly kind: ChainNodeKind;
  readonly dependencies: readonly string[];
  readonly capabilityTags: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly title: string;
  readonly objective: string;
  /** Writer only: files the output commit contains. */
  readonly files?: Readonly<Record<string, string>>;
  /** Review only: the node whose candidateSha this reviewer consumes. */
  readonly reviewsNode?: string;
}

export const CHAIN_WORKFLOW_ID = "wf-fault-matrix-chain";

/** The RAW workflow input for `createRunGraph` (frozen contracts schema rules). */
export function chainWorkflowRaw(specs: readonly ChainNodeSpec[]): unknown {
  return {
    id: CHAIN_WORKFLOW_ID,
    name: "M4-05 故障注入矩阵链路",
    nodes: specs.map((spec) => ({
      id: spec.id,
      role: spec.role,
      title: spec.title,
      objective: spec.objective,
      dependencies: [...spec.dependencies],
      capabilityTags: [...spec.capabilityTags],
      acceptanceCriteria: [...spec.acceptanceCriteria]
    }))
  };
}

/** Validate the plan and build the graph — the single pre-start gate. */
export function planGraph(
  world: MatrixWorld,
  runId: string,
  specs: readonly ChainNodeSpec[],
  definitionRevision: string
): void {
  createRunGraph(world.db, {
    runId,
    workflow: chainWorkflowRaw(specs),
    definitionRevision,
    now: T0
  });
}

export interface ChainLaunchDecision {
  /** fake-cli scenario passed as `--scenario`. */
  readonly scenario: string;
  readonly delayMs?: number;
  readonly timeoutSeconds: number;
}

export interface NodeTrace {
  readonly nodeId: string;
  readonly executionId: string;
  readonly dispatchToken: string;
  readonly attempt: number;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baselineSha: string;
  readonly outputSha: string | null;
  readonly finalPhase: EngineTerminalPhase;
  readonly reasons: readonly string[];
  readonly candidateSha: string | null;
  readonly reviewVerdict: "pass" | "fail" | "blocked" | null;
}

export interface ChainState {
  readonly acceptedOutputs: Map<string, { readonly branch: string; readonly headSha: string }>;
  readonly candidates: Map<string, string>;
  readonly baselines: Map<string, string>;
  readonly traces: NodeTrace[];
}

export function newChainState(): ChainState {
  return {
    acceptedOutputs: new Map(),
    candidates: new Map(),
    baselines: new Map(),
    traces: []
  };
}

export const CHAIN_CONCURRENCY = {
  globalMax: 4,
  projectMax: 4,
  unverifiedCredentialGroupMax: 1
} as const;

const COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "fault-matrix-writer",
  GIT_AUTHOR_EMAIL: "fault-matrix@role-orchestrator.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "fault-matrix-writer",
  GIT_COMMITTER_EMAIL: "fault-matrix@role-orchestrator.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

/** Last dependency with an accepted output, else the run's base commit. */
function baselineFor(
  spec: ChainNodeSpec,
  state: ChainState,
  baseSha: string
): string {
  for (let index = spec.dependencies.length - 1; index >= 0; index -= 1) {
    const dep = state.acceptedOutputs.get(spec.dependencies[index] as string);
    if (dep !== undefined) return dep.headSha;
  }
  return baseSha;
}

async function commitNodeOutput(
  world: MatrixWorld,
  input: {
    readonly worktreePath: string;
    readonly files: Readonly<Record<string, string>>;
    readonly message: string;
  }
): Promise<string> {
  const relativePaths = Object.keys(input.files);
  if (relativePaths.length === 0) {
    throw new Error(`writer commit at ${input.worktreePath} has an empty file set`);
  }
  for (const [relativePath, content] of Object.entries(input.files)) {
    const absolute = join(input.worktreePath, ...relativePath.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  await world.git.run(input.worktreePath, ["add", ...relativePaths]);
  await world.git.run(input.worktreePath, ["commit", "-m", input.message], { env: { ...COMMIT_ENV } });
  const head = await world.git.run(input.worktreePath, ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}

export interface PumpOptions {
  readonly runId: string;
  readonly specs: readonly ChainNodeSpec[];
  readonly definitionRevision: string;
  /** Per-launch scenario decision (the fault the case wants this attempt to hit). */
  readonly launch: (spec: ChainNodeSpec, attempt: number) => ChainLaunchDecision;
  /** Injectable DB (a crash proxy) for the integration step only; default the world's. */
  readonly integrationDb?: DatabaseSync;
  /**
   * Content the review's validation command requires the candidate workspace
   * to carry (seed + accepted writer outputs); the machine evidence of a
   * "the recovered chain produced the CORRECT result" assertion.
   */
  readonly reviewExpectedFiles: Readonly<Record<string, string>>;
}

export interface PumpRoundResult {
  readonly round: number;
  readonly dispatched: number;
  readonly traces: readonly NodeTrace[];
}

/**
 * ONE deterministic pump round: propagate -> enqueue -> poll -> run every
 * dispatched node through the chain. A node whose execution fails is still
 * driven through the fail-closed bookkeeping (queue completed, grants
 * released, node FAILED, propagate) exactly like the M2-06 driver — the
 * trace carries the failure to the case, which owns the retry decisions.
 */
export async function pumpRound(
  world: MatrixWorld,
  state: ChainState,
  options: PumpOptions,
  round: number
): Promise<PumpRoundResult> {
  const { runId, definitionRevision } = options;
  // Synthetic clock, one step per round (the M2-06 driver pattern): retry
  // windows and lease comparisons always move forward, deterministically.
  const now = iso(round * 1_000);
  const specById = new Map<string, ChainNodeSpec>(options.specs.map((spec) => [spec.id, spec]));

  propagateNodeStates(world.db, { runId, now });
  enqueueReadyNodes(world.db, { runId, now });
  const poll = pollQueue(world.db, {
    now,
    leaseMs: 600_000,
    retryWindowMs: 50,
    starvationMs: 600_000,
    limit: 8,
    concurrency: CHAIN_CONCURRENCY
  });

  const traces: NodeTrace[] = [];
  await Promise.all(poll.dispatched.map((outcome) => driveDispatched(world, state, options, outcome, traces)));
  return { round, dispatched: poll.dispatched.length, traces };

  async function driveDispatched(
    worldRef: MatrixWorld,
    chainState: ChainState,
    pumpOptions: PumpOptions,
    outcome: DispatchedOutcome,
    collected: NodeTrace[]
  ): Promise<void> {
    const spec = specById.get(outcome.nodeId);
    if (spec === undefined) {
      throw new Error(`chain pump dispatched unknown node "${outcome.nodeId}"`);
    }
    const db = worldRef.db;
    const attempt = listAttemptsForSlot(db, { runId, nodeId: spec.id }).length;
    const branch = branchNameFor(runId, spec.id, attempt);

    let baselineSha: string;
    if (spec.kind === "integration") {
      const parents: ParentCommit[] = spec.dependencies.map((dep) => {
        const output = chainState.acceptedOutputs.get(dep);
        if (output === undefined) {
          throw new Error(`integration node "${spec.id}" depends on "${dep}" with no accepted output`);
        }
        return { nodeId: dep, branch: output.branch, headSha: output.headSha };
      });
      const integrated = await integrateParents(
        { db: pumpOptions.integrationDb ?? db, git: worldRef.git },
        {
          repoPath: worldRef.repoPath,
          worktreesRoot: worldRef.worktreesRoot,
          runId,
          nodeId: spec.id,
          baseSha: worldRef.baseSha,
          parents,
          now
        }
      );
      baselineSha = integrated.candidateSha;
      chainState.candidates.set(spec.id, integrated.candidateSha);
    } else {
      baselineSha = baselineFor(spec, chainState, worldRef.baseSha);
    }
    chainState.baselines.set(spec.id, baselineSha);

    const created = await createWorktree(worldRef.git, {
      repoPath: worldRef.repoPath,
      worktreesRoot: worldRef.worktreesRoot,
      runId,
      nodeId: spec.id,
      attempt,
      baseSha: baselineSha
    });

    const decision = pumpOptions.launch(spec, attempt);
    const invocationArgs: string[] = ["--scenario", decision.scenario];
    if (decision.delayMs !== undefined) invocationArgs.push("--delay-ms", String(decision.delayMs));
    const run = startExecution(db, {
      executionId: outcome.executionId,
      runId,
      roleId: spec.role,
      nodeId: spec.id,
      definitionRevision,
      attempt,
      dispatchToken: outcome.dispatchToken,
      cwd: created.worktreePath,
      prompt: `fault matrix chain node ${runId}/${spec.id}`,
      invocationArgs,
      timeoutSeconds: decision.timeoutSeconds,
      now,
      claimedAttempt: true
    });
    const result: ExecutionRunResult = await run.result;

    let outputSha: string | null = null;
    if (result.finalPhase === "SUCCEEDED" && spec.kind === "writer" && spec.files !== undefined) {
      outputSha = await commitNodeOutput(worldRef, {
        worktreePath: created.worktreePath,
        files: spec.files,
        message: `${runId}/${spec.id}: fault matrix chain output`
      });
    }

    let reviewVerdict: NodeTrace["reviewVerdict"] = null;
    let candidateSha: string | null = null;
    if (result.finalPhase === "SUCCEEDED" && spec.kind === "review") {
      if (spec.reviewsNode === undefined) {
        throw new Error(`review node "${spec.id}" declares no reviewsNode`);
      }
      const reviewed = chainState.candidates.get(spec.reviewsNode);
      if (reviewed === undefined) {
        throw new Error(`review node "${spec.id}" reviews "${spec.reviewsNode}" with no candidateSha`);
      }
      candidateSha = reviewed;
      const session = await openReviewSession(
        { db, git: worldRef.git },
        {
          repoPath: worldRef.repoPath,
          worktreesRoot: worldRef.worktreesRoot,
          runId,
          nodeId: spec.id,
          candidateSha: reviewed,
          now
        }
      );
      const validation = await runValidationCommand(session, {
        argv: [process.execPath, "-e", reviewScript(reviewed, pumpOptions.reviewExpectedFiles)],
        timeoutMs: 60_000
      });
      const verdict = validation.exitCode === 0 ? "pass" : "fail";
      await completeReview(
        { db, git: worldRef.git },
        session,
        {
          review: {
            verdict,
            candidateSha: session.candidateSha,
            evidenceRefs: [validation.artifactRef.id],
            findings: verdict === "pass" ? [] : ["fault matrix validation failed"]
          },
          now
        }
      );
      reviewVerdict = verdict;
    }

    markQueueEntryCompleted(db, { entryId: outcome.entryId, now });
    releaseExecutionQuotaGrants(db, { executionId: outcome.executionId, now });
    transitionNodeState(db, {
      runId,
      nodeId: spec.id,
      to: result.finalPhase === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      whereStateIn: ["RUNNING"],
      now
    });
    if (result.finalPhase === "SUCCEEDED") {
      chainState.acceptedOutputs.set(spec.id, {
        branch,
        headSha: outputSha ?? baselineSha
      });
    }

    const trace: NodeTrace = {
      nodeId: spec.id,
      executionId: outcome.executionId,
      dispatchToken: outcome.dispatchToken,
      attempt,
      branch,
      worktreePath: created.worktreePath,
      baselineSha,
      outputSha,
      finalPhase: result.finalPhase,
      reasons: [...result.reasons],
      candidateSha,
      reviewVerdict
    };
    chainState.traces.push(trace);
    collected.push(trace);
  }
}

/** Machine evidence for the review: the candidate workspace carries `expected`. */
function reviewScript(candidateSha: string, expected: Readonly<Record<string, string>>): string {
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
    `fs.writeFileSync(path.join(process.cwd(), "validation-artifacts", "matrix-validation.txt"), "reviewed " + candidate + "\\n", "utf8");`,
    `process.exit(ok ? 0 : 1);`
  ].join("\n");
}
