/**
 * The dogfood driver (M6-04, M10-02 step-3 composition root) — walks ONE run
 * over the isolated fixture repo through the FULL orchestration chain. Since
 * the M10-02 extraction this driver is a TEST COMPOSITION ROOT + ASSERTIONS:
 * the pump mechanics come from @role-orchestrator/orchestration (settlement
 * sequences, baseline rule, M7 integration / M8 review / M10 rework / M11
 * recovery phases, approval mining), and what remains here is the dogfood
 * injections, the timeline evidence and the acceptance assertions:
 *
 *   建图      createRunnableDogfoodRun (frozen snapshots + graph + revision)
 *   调度      scheduler.enqueueReadyNodes -> pollQueue (real quotas + fencing)
 *   执行      engine.startExecution (fake-cli dist bins as real subprocesses)
 *             + writer output commits (the Git-Service commit stand-in)
 *   集成      M7 settleIntegrationClaim (integrateParents + candidateSha 入表
 *             + candidate as successor baseline)
 *   review    M8 settleReviewClaim (fixed-SHA session -> injected validation
 *             script -> candidateSha-bound verdict, A12)
 *   扩图返工  INJECTED content-grounded review FAIL -> M10
 *             requestReworkExpansion (A04 requester permission; the A38
 *             revision lock is read by the DRIVER at the call instant — the
 *             composition root cannot supply or stale it)
 *   审批      the repair execution REALLY proposes an unscoped write (fake-cli
 *             `action-proposal`); the persisted event stream is mined with
 *             checkpoint.extractActionProposals; openApprovalCheckpoint ->
 *             A17 digest tamper probe -> approveApproval -> bounded
 *             continueAfterApproval -> the ONLY process that performs the write
 *   中断      INJECTED launch-window interrupt: the scheduler claim is real
 *             (attempt row STARTING, node RUNNING, dispatch outbox, quota
 *             grants) and the launcher never runs — the durable A24 window
 *   恢复      M11 scanStartupRecovery (the REAL reconcile scan, explicit
 *             standalone entry — never in a pump loop) -> landRecoveryOutcome
 *             -> RECOVERY_REQUIRED (A22: nothing auto re-runs) ->
 *             listRecoveryItems -> resolveRecoveryItem -> explicit retry ->
 *             M8 re-review PASS
 *
 * Every injection point, recovery action and acceptance observation is
 * appended to the driver timeline. The driver NEVER modifies governance
 * state, never self-approves beyond the protocol's explicit operator steps,
 * and never merges or delivers anything anywhere.
 */
import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RoleId } from "@role-orchestrator/contracts";
import {
  enqueueReadyNodes,
  listQueueEntries,
  pollQueue,
  releaseExecutionQuotaGrants,
  type DispatchedOutcome
} from "@role-orchestrator/scheduler";
import { createSequenceClock, commitNodeOutput } from "@role-orchestrator/e2e-baseline";
import { getReviewVerdict } from "@role-orchestrator/review";
import {
  listRunNodes,
  propagateNodeStates,
  transitionNodeState
} from "@role-orchestrator/dag";
import { startExecution, type EngineTerminalPhase } from "@role-orchestrator/engine";
import {
  ActiveAttemptConflictError,
  createActiveAttempt,
  getExecution,
  getTaskRun,
  listActiveAttempts,
  listAttemptsForSlot,
  listPendingOutboxMessages,
  verifyEventChecksums
} from "@role-orchestrator/store";
import { branchNameFor, createWorktree, snapshotRepositoryState, worktreePathFor } from "@role-orchestrator/worktree";
import {
  continueAfterApproval,
  extractActionProposals,
  getCheckpoint,
  openApprovalCheckpoint,
  type ActionProposal
} from "@role-orchestrator/checkpoint";
import { approveApproval, getApproval, ApprovalDigestMismatchError } from "@role-orchestrator/approval";
import {
  baselineFor,
  landRecoveryOutcome,
  listRecoveryItems,
  requestReworkExpansion,
  resolveRecoveryItem,
  scanStartupRecovery,
  settleClaimBookkeeping,
  settleClaimedNode,
  settleIntegrationClaim,
  settleReviewClaim,
  storedEventViews
} from "@role-orchestrator/orchestration";
import { DogfoodDispatchError, DogfoodDriverError } from "./errors.js";
import type { Evidence } from "./evidence.js";
import type { DogfoodWorld } from "./world.js";
import { DF_FIX_FILE_CONTENT, DF_FIX_FILE_REL, DF_SPECS, dfReviewExpectations } from "./scenario.js";

/** One recorded step of the dogfood timeline (injection or recovery). */
export interface DogfoodTimelineEntry {
  readonly step: number;
  readonly at: string;
  /** Which boundary this entry belongs to, e.g. "review-fail-injection". */
  readonly boundary: string;
  /** "inject" | "recover" | "assert" — the entry's role in the story. */
  readonly kind: "inject" | "recover" | "assert";
  readonly detail: string;
}

export interface DogfoodNodeTrace {
  readonly nodeId: string;
  readonly executionId: string;
  readonly attempt: number;
  readonly branch: string;
  readonly finalPhase: EngineTerminalPhase;
  readonly outputSha: string | null;
  readonly reviewVerdict: "pass" | "fail" | null;
}

export interface DogfoodExpansionRecord {
  readonly expansionId: string;
  readonly requesterRoleId: string;
  readonly triggerReviewNodeId: string;
  readonly triggerCandidateSha: string;
  readonly fixNodeId: string;
  readonly reReviewNodeId: string;
  readonly graphRevisionBefore: number;
  readonly graphRevisionAfter: number;
  readonly mintedStatesAfter: readonly string[];
}

export interface DogfoodA17Evidence {
  readonly checkpointId: string;
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly proposedWritePath: string;
  readonly riskGrade: string;
  /** The side effect the proposal describes exists BEFORE any approval. */
  readonly sideEffectBeforeApproval: boolean;
  /** The tampered action (changed command path) that was refused. */
  readonly tamperedWritePath: string;
  readonly tamperRefusalError: string;
  readonly checkpointStatusAfterTamper: string;
  readonly approvalStatusAfterTamper: string;
  readonly attemptsAfterTamper: number;
  readonly consumedByExecutionId: string;
  readonly approvalStatusAfterContinuation: string;
  /** The side effect exists ONLY after the approved continuation ran. */
  readonly sideEffectAfterContinuation: boolean;
}

export interface DogfoodA22Evidence {
  readonly executionId: string;
  readonly scannedAttempts: number;
  readonly probeOsQueries: number;
  readonly decisionOutcome: string;
  readonly decisionReason: string;
  readonly nodeStateAfterBridge: string;
  readonly recoveryItemStatus: string;
  readonly recoveryFollowUp: string;
  /** A second attempt on the interrupted slot is refused (A23 constraint). */
  readonly secondAttemptRefusedError: string;
  /** The scan is idempotent — never a second marker. */
  readonly rescanApplied: string;
  /** The interrupted claim's queue entry is NOT requeued. */
  readonly queueEntryState: string;
  /** The claim's dispatch outbox message stays pending. */
  readonly pendingSchedulerDispatchMessages: number;
  /** The claim's quota grants stay held until the recovery bookkeeping. */
  readonly quotaGrantsHeld: number;
  readonly phaseAfterOperatorResolution: string;
  readonly retryExecutionId: string;
  readonly retryFinalPhase: EngineTerminalPhase;
  readonly attemptsInSlot: number;
}

export interface DogfoodA11Evidence {
  readonly baseSha: string;
  readonly branch: string;
  /** Every createWorktree's user-repo status fingerprint, in order. */
  readonly worktreeFingerprints: readonly string[];
  readonly finalHeadSha: string | null;
  readonly finalBranch: string | null;
  readonly finalFingerprint: string;
  readonly dirtyEntryPaths: readonly string[];
  readonly dirtyFileContent: string;
}

export interface DogfoodRunResult {
  readonly runId: string;
  readonly timeline: readonly DogfoodTimelineEntry[];
  readonly trace: readonly DogfoodNodeTrace[];
  readonly firstReviewVerdict: "fail";
  readonly failedCandidateSha: string;
  readonly expansion: DogfoodExpansionRecord;
  readonly a17: DogfoodA17Evidence;
  readonly a22: DogfoodA22Evidence;
  readonly a11: DogfoodA11Evidence;
  readonly eventChecksumMismatches: number;
  readonly allNodesSucceeded: boolean;
}

export interface DogfoodDriverOptions {
  readonly world: DogfoodWorld;
  readonly evidence: Evidence;
  readonly runId: string;
  /** Who approves the checkpoint (recorded, never a governance change). */
  readonly operatorId?: string | undefined;
}

/**
 * Run the whole dogfood chain. Throws (typed, with site facts) on the first
 * dishonest state — the caller's assertions then pin the RECORDS, not hopes.
 */
export async function runDogfoodChain(options: DogfoodDriverOptions): Promise<DogfoodRunResult> {
  const { world, evidence, runId } = options;
  const operatorId = options.operatorId ?? "dogfood-operator";
  const db = world.db;
  const clock = createSequenceClock({ stepMs: 1_000 });
  const tick = (): string => clock.tick();
  const definitionRevision = "rev-dogfood-1";
  const timeline: DogfoodTimelineEntry[] = [];
  const trace: DogfoodNodeTrace[] = [];
  const worktreeFingerprints: string[] = [];
  let step = 0;

  const record = (boundary: string, kind: "inject" | "recover" | "assert", detail: string): void => {
    step += 1;
    timeline.push({ step, at: tick(), boundary, kind, detail });
    evidence.log(`[${String(step).padStart(2, "0")}] ${kind.toUpperCase()} ${boundary}: ${detail}`);
  };

  const acceptedOutputs = new Map<string, { readonly branch: string; readonly headSha: string }>();
  const candidates = new Map<string, string>();

  // ---- 建图 ---------------------------------------------------------------
  const run = getTaskRun(db, runId);
  if (run === null) {
    throw new DogfoodDriverError(`dogfood run "${runId}" does not exist (create it via createRunnableDogfoodRun)`);
  }
  const graphRevisionBefore = run.graphRevision;
  // The caller already created the run; assert the graph really landed.
  const initialNodes = listRunNodes(db, runId);
  if (initialNodes.length !== DF_SPECS.length) {
    throw new DogfoodDriverError(
      `run "${runId}" has ${String(initialNodes.length)} nodes, expected ${String(DF_SPECS.length)}`
    );
  }
  record(
    "graph-creation",
    "assert",
    `run ${runId} graph created over base ${world.baseSha.slice(0, 12)}…: ` +
      initialNodes.map((nodeRow) => `${nodeRow.nodeId}=${nodeRow.state}`).join(", ")
  );

  // ---- 调度 -> 执行 -> 集成 -> review(注入 fail) ---------------------------
  for (const spec of DF_SPECS) {
    const outcome = dispatchExactlyOne(world, { runId, tick }, spec.id);
    const done = await runClaimedNode(world, { runId, tick, definitionRevision }, outcome, spec, {
      acceptedOutputs,
      candidates,
      worktreeFingerprints,
      reviewExpectation: spec.kind === "review" ? dfReviewExpectations() : undefined
    });
    trace.push(done.trace);
    if (spec.kind === "review") {
      // INJECTION POINT 1: the round-1 review validation required the repair
      // file, which the round-1 candidate genuinely does not contain.
      if (done.reviewVerdict !== "fail") {
        throw new DogfoodDriverError(
          `round-1 review of "${spec.id}" was expected to FAIL (the injected content gap), got ${String(done.reviewVerdict)}`
        );
      }
      const failedCandidate = candidates.get("integrate");
      if (failedCandidate === undefined) {
        throw new DogfoodDriverError("the integrate node produced no candidateSha");
      }
      const verdict = getReviewVerdict(db, { runId, nodeId: spec.id, candidateSha: failedCandidate });
      if (verdict.kind !== "valid" || verdict.verdict !== "fail") {
        throw new DogfoodDriverError(
          `the durable round-1 verdict is not a valid fail for candidate ${failedCandidate}`
        );
      }
      record(
        "review-fail-injection",
        "inject",
        `review "${spec.id}" FAIL grounded on missing ${DF_FIX_FILE_REL}; verdict durably bound to candidate ${failedCandidate.slice(0, 12)}… (A12)`
      );
    } else {
      record(
        spec.kind === "integration" ? "integration" : "execution",
        "assert",
        `${spec.id}: attempt ${String(done.trace.attempt)} ${done.trace.finalPhase}` +
          (done.trace.outputSha === null ? "" : ` output ${done.trace.outputSha.slice(0, 12)}…`) +
          (done.candidateSha === null ? "" : ` candidateSha ${done.candidateSha.slice(0, 12)}…`)
      );
    }
  }
  const failedCandidate = candidates.get("integrate");
  if (failedCandidate === undefined) {
    throw new DogfoodDriverError("no failed candidate for the expansion trigger");
  }

  // ---- 受控扩图（M10 rework-driver：A38 乐观锁由驱动在调用瞬间读取，组合根不供给）----
  const expansion = requestReworkExpansion(db, {
    runId,
    reviewNodeId: "review",
    candidateSha: failedCandidate,
    requesterRoleId: "coordinator",
    now: tick()
  });
  if (!expansion.created) {
    throw new DogfoodDriverError(`expansion ${expansion.expansionId} was an unexpected idempotent replay`);
  }
  if (expansion.fixNode.nodeId !== "integrate-fix-2" || expansion.reviewNode.nodeId !== "integrate-review-2") {
    throw new DogfoodDriverError(
      `unexpected minted pair ${expansion.fixNode.nodeId}/${expansion.reviewNode.nodeId}`
    );
  }
  const fixNodeState = requireNodeState(db, runId, expansion.fixNode.nodeId);
  const reReviewNodeState = requireNodeState(db, runId, expansion.reviewNode.nodeId);
  const expansionRecord: DogfoodExpansionRecord = {
    expansionId: expansion.expansionId,
    requesterRoleId: expansion.requesterRoleId,
    triggerReviewNodeId: expansion.triggerReviewNodeId,
    triggerCandidateSha: expansion.triggerCandidateSha,
    fixNodeId: expansion.fixNode.nodeId,
    reReviewNodeId: expansion.reviewNode.nodeId,
    graphRevisionBefore,
    graphRevisionAfter: expansion.revision,
    mintedStatesAfter: [fixNodeState, reReviewNodeState]
  };
  record(
    "controlled-expansion",
    "recover",
    `requester coordinator (canCreateSubtasks) minted ${expansion.fixNode.nodeId} (${fixNodeState}) + ` +
      `${expansion.reviewNode.nodeId} (${reReviewNodeState}); graphRevision ${String(graphRevisionBefore)} -> ${String(expansion.revision)} (A04/A38/A20 guards intact)`
  );

  // ---- 审批检查点（提案 -> A17 拒改 -> 批准 -> 续行）------------------------
  const a17 = await runApprovalCheckpointPhase(world, evidence, {
    runId,
    tick,
    definitionRevision,
    operatorId,
    record,
    acceptedOutputs,
    worktreeFingerprints,
    trace
  });

  // ---- 中断注入 -> reconcile 恢复 -> 重试成功 -------------------------------
  const a22 = await runRecoveryPhase(world, evidence, {
    runId,
    tick,
    definitionRevision,
    record,
    acceptedOutputs,
    worktreeFingerprints,
    trace,
    reReviewNodeId: expansion.reviewNode.nodeId,
    fixCandidateSha: requireAccepted(acceptedOutputs, expansion.fixNode.nodeId).headSha
  });

  // ---- 终态与 A11 验收 ------------------------------------------------------
  const finalNodes = listRunNodes(db, runId);
  const allNodesSucceeded = finalNodes.every((nodeRow) => nodeRow.state === "SUCCEEDED");
  const finalSnapshot = await snapshotRepositoryState(world.fixture.git, world.repoPath);
  const dirtyFileContent = world.fixture.readDirtyFile();
  const a11: DogfoodA11Evidence = {
    baseSha: world.baseSha,
    branch: finalSnapshot.branch ?? "(null)",
    worktreeFingerprints,
    finalHeadSha: finalSnapshot.headSha,
    finalBranch: finalSnapshot.branch,
    finalFingerprint: finalSnapshot.rawStatusSha256,
    dirtyEntryPaths: finalSnapshot.dirtyEntries.map((entry) => entry.path),
    dirtyFileContent
  };
  if (finalSnapshot.headSha !== world.baseSha || finalSnapshot.branch !== "main") {
    throw new DogfoodDriverError(
      `A11 violated: user repo HEAD moved to ${String(finalSnapshot.headSha)} (${String(finalSnapshot.branch)})`
    );
  }
  const firstFingerprint = worktreeFingerprints[0];
  if (
    firstFingerprint === undefined ||
    worktreeFingerprints.some((fingerprint) => fingerprint !== firstFingerprint) ||
    finalSnapshot.rawStatusSha256 !== firstFingerprint
  ) {
    throw new DogfoodDriverError("A11 violated: the user repo's dirty-state fingerprint changed during the run");
  }
  if (dirtyFileContent !== world.fixture.readDirtyFile() || finalSnapshot.dirtyEntries.length !== 1) {
    throw new DogfoodDriverError("A11 violated: the user's uncommitted file changed");
  }
  record(
    "a11-user-repo",
    "assert",
    `user repo unchanged across ${String(worktreeFingerprints.length)} worktree creations and the whole run: HEAD ${world.baseSha.slice(0, 12)}… still on main, status fingerprint stable, dirty ${a11.dirtyEntryPaths.join(", ")} byte-identical`
  );

  const eventChecksumMismatches = verifyEventChecksums(db).length;
  record("event-integrity", "assert", `event checksum mismatches: ${String(eventChecksumMismatches)}`);
  const active = listActiveAttempts(db);
  if (active.length !== 0) {
    throw new DogfoodDriverError(`${String(active.length)} active attempts remain after the dogfood run`);
  }

  return {
    runId,
    timeline,
    trace,
    firstReviewVerdict: "fail",
    failedCandidateSha: failedCandidate,
    expansion: expansionRecord,
    a17,
    a22,
    a11,
    eventChecksumMismatches,
    allNodesSucceeded
  };
}

// ---------------------------------------------------------------------------
// dispatch + execution plumbing (the pump primitives, one node per round)
// ---------------------------------------------------------------------------

interface DriverContext {
  readonly runId: string;
  readonly tick: () => string;
  readonly definitionRevision: string;
}

function requireAccepted(
  acceptedOutputs: ReadonlyMap<string, { readonly branch: string; readonly headSha: string }>,
  nodeId: string
): { readonly branch: string; readonly headSha: string } {
  const output = acceptedOutputs.get(nodeId);
  if (output === undefined) {
    throw new DogfoodDriverError(`node "${nodeId}" has no accepted output`);
  }
  return output;
}

function requireNodeState(db: DatabaseSync, runId: string, nodeId: string): string {
  const row = listRunNodes(db, runId).find((candidate) => candidate.nodeId === nodeId);
  if (row === undefined) {
    throw new DogfoodDriverError(`node "${nodeId}" of run "${runId}" does not exist`);
  }
  return row.state;
}

function runNodeDependencies(db: DatabaseSync, runId: string, nodeId: string): readonly string[] {
  const row = listRunNodes(db, runId).find((candidate) => candidate.nodeId === nodeId);
  if (row === undefined) {
    throw new DogfoodDriverError(`node "${nodeId}" of run "${runId}" does not exist`);
  }
  return row.dependencies;
}

function dispatchExactlyOne(
  world: DogfoodWorld,
  context: { readonly runId: string; readonly tick: () => string },
  expectedNodeId: string
): DispatchedOutcome {
  const { db } = world;
  propagateNodeStates(db, { runId: context.runId, now: context.tick() });
  enqueueReadyNodes(db, { runId: context.runId, now: context.tick() });
  const poll = pollQueue(db, {
    now: context.tick(),
    leaseMs: 600_000,
    retryWindowMs: 50,
    starvationMs: 600_000,
    limit: 8,
    concurrency: { globalMax: 4, projectMax: 4, unverifiedCredentialGroupMax: 1 }
  });
  if (poll.dispatched.length !== 1 || poll.dispatched[0]?.nodeId !== expectedNodeId) {
    const queue = listQueueEntries(db)
      .map((entry) => `${entry.nodeId}:${entry.state}`)
      .join(", ");
    throw new DogfoodDispatchError(
      `expected exactly one dispatch for "${expectedNodeId}", got ` +
        `[${poll.dispatched.map((entry) => entry.nodeId).join(", ")}] (queue: ${queue})`
    );
  }
  const outcome = poll.dispatched[0];
  if (outcome === undefined) {
    throw new DogfoodDispatchError("dispatch vanished between claim and use");
  }
  return outcome;
}

interface ClaimedRunRecord {
  readonly trace: DogfoodNodeTrace;
  readonly candidateSha: string | null;
  readonly reviewVerdict: "pass" | "fail" | null;
}

interface ClaimedRunOptions {
  readonly acceptedOutputs: Map<string, { readonly branch: string; readonly headSha: string }>;
  readonly candidates: Map<string, string>;
  readonly worktreeFingerprints: string[];
  /** Review nodes only: the exact file set a PASS verdict requires. */
  readonly reviewExpectation?: Readonly<Record<string, string>> | undefined;
}

/**
 * Run ONE claimed dispatch through the real chain and land the node at
 * SUCCEEDED (writer commit / integration / review verdict included). For a
 * review node the verdict may be "fail" — the node still succeeds (the
 * reviewer's run succeeded; the verdict is DATA that grounds the expansion).
 */
async function runClaimedNode(
  world: DogfoodWorld,
  context: DriverContext,
  outcome: DispatchedOutcome,
  spec: {
    readonly id: string;
    readonly role: RoleId;
    readonly kind: string;
    readonly reviewsNode?: string | undefined;
    readonly files?: Readonly<Record<string, string>> | undefined;
  },
  options: ClaimedRunOptions
): Promise<ClaimedRunRecord> {
  const { db, worktreesRoot, repoPath, fixture } = world;
  const { runId, tick, definitionRevision } = context;
  const nodeId = spec.id;

  const attempt = listAttemptsForSlot(db, { runId, nodeId }).length;
  const branch = branchNameFor(runId, nodeId, attempt);
  const dependencies = runNodeDependencies(db, runId, nodeId);

  // ---- integration nodes: the M7 integration-driver (optional phase) ------
  let candidateSha: string | null = null;
  let baselineSha: string;
  if (spec.kind === "integration") {
    const integrated = await settleIntegrationClaim(
      { db, git: fixture.git },
      {
        repoPath,
        worktreesRoot,
        runId,
        nodeId,
        baseSha: world.baseSha,
        dependencies,
        acceptedOutputs: options.acceptedOutputs,
        candidates: options.candidates,
        now: tick()
      }
    );
    candidateSha = integrated.candidateSha;
    baselineSha = integrated.baselineSha;
  } else {
    // The SHARED baseline rule (M10-02 step 2): last accepted dependency
    // wins, else the run's base commit.
    baselineSha = baselineFor(dependencies, options.acceptedOutputs, world.baseSha);
  }

  const created = await createWorktree(fixture.git, {
    repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt,
    baseSha: baselineSha
  });
  options.worktreeFingerprints.push(created.userRepoSnapshot.rawStatusSha256);

  const engineRun = startExecution(db, {
    executionId: outcome.executionId,
    runId,
    roleId: spec.role,
    nodeId,
    definitionRevision,
    attempt,
    dispatchToken: outcome.dispatchToken,
    cwd: created.worktreePath,
    prompt: `dogfood node ${runId}/${nodeId}`,
    invocationArgs: ["--scenario", "success"],
    timeoutSeconds: 120,
    now: tick(),
    claimedAttempt: true
  });
  const result = await engineRun.result;
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
    throw new DogfoodDriverError(
      `node "${nodeId}" finished ${result.finalPhase} (reasons: ${result.reasons.join(", ")})`,
      { cause: result }
    );
  }

  // ---- writer output commit (the Git-Service commit stand-in) --------------
  let outputSha: string | null = null;
  if (spec.kind === "writer" && spec.files !== undefined) {
    outputSha = await commitNodeOutput(fixture.git, {
      worktreePath: created.worktreePath,
      files: spec.files,
      message: `${runId}/${nodeId}: dogfood node output`
    });
  }

  // ---- review node: the M8 review-driver (optional phase; the validation
  // script is THIS test composition root's injected machine evidence) -------
  let reviewVerdict: "pass" | "fail" | null = null;
  if (spec.kind === "review") {
    if (spec.reviewsNode === undefined) {
      throw new DogfoodDriverError(`review node "${nodeId}" declares no reviewsNode`);
    }
    const reviewed = requireAccepted(options.acceptedOutputs, spec.reviewsNode);
    const expected = options.reviewExpectation ?? {};
    const settlement = await settleReviewClaim(
      { db, git: fixture.git },
      {
        repoPath,
        worktreesRoot,
        runId,
        nodeId,
        candidateSha: reviewed.headSha,
        now: tick(),
        validationScript: reviewValidationScript(reviewed.headSha, expected, nodeId),
        validationTimeoutMs: 60_000,
        failureFindings: (validationExitCode) => [
          `${nodeId}: candidate ${reviewed.headSha} misses required content (validation exit ${String(validationExitCode)})`
        ]
      }
    );
    reviewVerdict = settlement.verdict;
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
  options.acceptedOutputs.set(nodeId, { branch, headSha: outputSha ?? baselineSha });

  return {
    candidateSha,
    reviewVerdict,
    trace: {
      nodeId,
      executionId: outcome.executionId,
      attempt,
      branch,
      finalPhase: result.finalPhase,
      outputSha,
      reviewVerdict
    }
  };
}

/** The reviewer's machine evidence: content checks + a disposable artifact. */
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
    `fs.writeFileSync(path.join(process.cwd(), "validation-artifacts", "dogfood-validation.txt"), "dogfood validation ran\\n", "utf8");`,
    `process.exit(ok ? 0 : 1);`
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 审批检查点 phase: proposal -> A17 tamper refusal -> approve -> continuation
// ---------------------------------------------------------------------------

interface ApprovalPhaseArgs {
  readonly runId: string;
  readonly tick: () => string;
  readonly definitionRevision: string;
  readonly operatorId: string;
  readonly record: (boundary: string, kind: "inject" | "recover" | "assert", detail: string) => void;
  readonly acceptedOutputs: Map<string, { readonly branch: string; readonly headSha: string }>;
  readonly worktreeFingerprints: string[];
  readonly trace: DogfoodNodeTrace[];
}

async function runApprovalCheckpointPhase(
  world: DogfoodWorld,
  evidence: Evidence,
  args: ApprovalPhaseArgs
): Promise<DogfoodA17Evidence> {
  const { db, worktreesRoot, repoPath, fixture } = world;
  const { runId, tick, definitionRevision } = args;
  const nodeId = "integrate-fix-2";

  // The repair's first execution REALLY proposes an unscoped write through
  // the fake-cli `action-proposal` scenario (INJECTION POINT 2: the proposal
  // describes writing the repair file; nothing writes it).
  const outcome = dispatchExactlyOne(world, { runId, tick }, nodeId);
  const attempt1 = listAttemptsForSlot(db, { runId, nodeId }).length;
  const deps = runNodeDependencies(db, runId, nodeId);
  // The SHARED baseline rule (M10-02 step 2): last accepted dependency wins,
  // else the run's base commit.
  const baselineSha = baselineFor(deps, args.acceptedOutputs, world.baseSha);
  const worktree1 = await createWorktree(fixture.git, {
    repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt: attempt1,
    baseSha: baselineSha
  });
  args.worktreeFingerprints.push(worktree1.userRepoSnapshot.rawStatusSha256);

  // The proposed write path is the attempt-2 worktree's repair file — the
  // attempt-2 worktree path is a PURE path computation, so the proposal can
  // name it before attempt 2 exists.
  const worktree2Path = worktreePathFor(worktreesRoot, runId, nodeId, attempt1 + 1);
  const proposedWritePath = join(worktree2Path, ...DF_FIX_FILE_REL.split("/"));
  const sideEffectBeforeApproval = existsSync(proposedWritePath);
  if (sideEffectBeforeApproval) {
    throw new DogfoodDriverError("the proposed write already exists before any approval — A19 violated");
  }

  const proposingRun = startExecution(db, {
    executionId: outcome.executionId,
    runId,
    roleId: "architect",
    nodeId,
    definitionRevision,
    attempt: attempt1,
    dispatchToken: outcome.dispatchToken,
    cwd: worktree1.worktreePath,
    prompt: `dogfood ${runId}/${nodeId}: propose the unscoped repair write`,
    invocationArgs: ["--scenario", "action-proposal", "--propose-write", proposedWritePath],
    timeoutSeconds: 120,
    now: tick(),
    claimedAttempt: true
  });
  const result1 = await proposingRun.result;
  if (result1.finalPhase !== "FAILED") {
    throw new DogfoodDriverError(
      `the proposing execution was expected to end FAILED (the CLI ended safely mid-task), got ${result1.finalPhase}`,
      { cause: result1 }
    );
  }
  args.record(
    "approval-proposal",
    "inject",
    `execution ${outcome.executionId} ended FAILED (${result1.reasons.join(", ")}) having ONLY proposed the ` +
      `unscoped write of ${DF_FIX_FILE_REL}; the side effect has NOT happened (A19: 未审批的副作用不发生)`
  );
  // The claim's bookkeeping WITHOUT a node transition (the SHARED two-entry
  // sequence, M10-02 step 2): the proposing execution's checkpoint parks the
  // node at WAITING_APPROVAL — no terminal transition applies here.
  settleClaimBookkeeping(db, {
    entryId: outcome.entryId,
    executionId: outcome.executionId,
    now: tick()
  });

  // The structured proposal is mined from the PERSISTED event stream.
  const extraction = extractActionProposals(storedEventViews(db, outcome.executionId));
  if (extraction.proposals.length !== 1 || extraction.unparsable.length !== 0) {
    throw new DogfoodDriverError(
      `expected exactly one parsable proposal on ${outcome.executionId}, got ` +
        `${String(extraction.proposals.length)} parsable / ${String(extraction.unparsable.length)} unparsable`
    );
  }
  const proposal = extraction.proposals[0]?.proposal;
  if (proposal === undefined) {
    throw new DogfoodDriverError("proposal vanished");
  }
  if (!proposal.action.argv.includes(proposedWritePath)) {
    throw new DogfoodDriverError("the extracted proposal does not name the proposed write path");
  }
  evidence.log(`extracted proposal ${proposal.proposalId} from the persisted events of ${outcome.executionId}`);

  const opened = openApprovalCheckpoint(db, {
    executionId: outcome.executionId,
    proposal,
    cwd: worktree1.worktreePath,
    grantedPermissions: ["repo.read"],
    ttlSeconds: 2_592_000,
    now: tick()
  });
  if (opened.nodeState !== "WAITING_APPROVAL") {
    throw new DogfoodDriverError(`checkpoint left the node at ${opened.nodeState}, expected WAITING_APPROVAL`);
  }
  args.record(
    "approval-checkpoint",
    "recover",
    `checkpoint ${opened.checkpoint.id} WAITING; approval ${opened.approval.id} risk=${opened.approval.riskGrade} ` +
      `requiresApproval=${String(opened.approval.requiresApproval)}; node ${nodeId}=WAITING_APPROVAL`
  );

  // ---- 批准（operator step；一次批准只对单个 actionDigest 生效）------------
  approveApproval(db, {
    approvalId: opened.approval.id,
    approvedBy: args.operatorId,
    now: tick()
  });

  // ---- A17: 批准后改变命令的续行被拒绝，原审批保持可被正确动作消费 ---------
  const tamperedPath = join(worktree2Path, "src", "feature", "TAMPERED.txt");
  const tamperedAction: ActionProposal["action"] = {
    ...proposal.action,
    argv: proposal.action.argv.map((element) => (element === proposedWritePath ? tamperedPath : element))
  };
  let tamperRefusal = "(no refusal observed)";
  try {
    continueAfterApproval(db, {
      checkpointId: opened.checkpoint.id,
      newExecutionId: `exec-${nodeId}-tampered`,
      presentedAction: tamperedAction,
      now: tick()
    });
  } catch (error) {
    if (!(error instanceof ApprovalDigestMismatchError)) {
      throw error;
    }
    tamperRefusal = error.name;
  }
  const checkpointStatusAfterTamper = getCheckpoint(db, opened.checkpoint.id)?.status ?? "(missing)";
  const approvalAfterTamper = getApproval(db, opened.approval.id);
  if (approvalAfterTamper === null) {
    throw new DogfoodDriverError("the approval vanished after the tampered continuation");
  }
  const attemptsAfterTamper = listAttemptsForSlot(db, { runId, nodeId }).length;
  if (approvalAfterTamper.status !== "APPROVED") {
    throw new DogfoodDriverError(
      `A17 violated: the tampered continuation left the approval at ${approvalAfterTamper.status}`
    );
  }
  if (checkpointStatusAfterTamper !== "WAITING") {
    throw new DogfoodDriverError(
      `A17 violated: the tampered continuation left the checkpoint at ${checkpointStatusAfterTamper}`
    );
  }
  if (attemptsAfterTamper !== attempt1) {
    throw new DogfoodDriverError("A17 violated: the tampered continuation created an attempt row");
  }
  args.record(
    "a17-digest-binding",
    "assert",
    `continuation with a CHANGED command path (${tamperedPath}) refused (${tamperRefusal}); approval still ` +
      `${approvalAfterTamper.status}, checkpoint still ${checkpointStatusAfterTamper}, no attempt row created — ` +
      `the original approval is bound to exactly one actionDigest and cannot be consumed by a different action`
  );

  // ---- 续行：唯一被授权执行该动作的执行 ------------------------------------
  const continuationExecutionId = `exec-${nodeId}-cont`;
  const plan = continueAfterApproval(db, {
    checkpointId: opened.checkpoint.id,
    newExecutionId: continuationExecutionId,
    now: tick()
  });
  if (plan.execution.attempt !== attempt1 + 1) {
    throw new DogfoodDriverError(
      `continuation attempt ${String(plan.execution.attempt)} is not ${String(attempt1 + 1)}`
    );
  }
  transitionNodeState(db, { runId, nodeId, to: "READY", whereStateIn: ["WAITING_APPROVAL"], now: tick() });
  transitionNodeState(db, { runId, nodeId, to: "RUNNING", whereStateIn: ["READY"], now: tick() });
  const continuationBranch = branchNameFor(runId, nodeId, plan.execution.attempt);
  const worktree2 = await createWorktree(fixture.git, {
    repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt: plan.execution.attempt,
    baseSha: baselineSha
  });
  args.worktreeFingerprints.push(worktree2.userRepoSnapshot.rawStatusSha256);
  const continuationRun = startExecution(db, {
    executionId: continuationExecutionId,
    runId,
    roleId: "architect",
    nodeId,
    definitionRevision,
    attempt: plan.execution.attempt,
    dispatchToken: plan.execution.dispatchToken,
    cwd: worktree2.worktreePath,
    prompt: `dogfood ${runId}/${nodeId}: the approved continuation performs the write`,
    invocationArgs: ["--scenario", "success", "--write-file", proposedWritePath],
    timeoutSeconds: 120,
    now: tick(),
    claimedAttempt: true
  });
  const result2 = await continuationRun.result;
  if (result2.finalPhase !== "SUCCEEDED") {
    throw new DogfoodDriverError(`the approved continuation finished ${result2.finalPhase}`, { cause: result2 });
  }
  const sideEffectAfterContinuation = existsSync(proposedWritePath);
  if (!sideEffectAfterContinuation) {
    throw new DogfoodDriverError("the approved continuation did not perform the proposed write");
  }
  const fixOutputSha = await commitNodeOutput(fixture.git, {
    worktreePath: worktree2.worktreePath,
    files: { [DF_FIX_FILE_REL]: DF_FIX_FILE_CONTENT },
    message: `${runId}/${nodeId}: approved continuation output`
  });
  // The queue entry was completed after the proposing attempt; the
  // continuation is the engine-owned attempt path — only the (no-op) grant
  // release bookkeeping applies to it.
  releaseExecutionQuotaGrants(db, { executionId: continuationExecutionId, now: tick() });
  transitionNodeState(db, { runId, nodeId, to: "SUCCEEDED", whereStateIn: ["RUNNING"], now: tick() });
  args.acceptedOutputs.set(nodeId, { branch: continuationBranch, headSha: fixOutputSha });
  args.trace.push({
    nodeId,
    executionId: continuationExecutionId,
    attempt: plan.execution.attempt,
    branch: continuationBranch,
    finalPhase: result2.finalPhase,
    outputSha: fixOutputSha,
    reviewVerdict: null
  });
  args.record(
    "approval-continuation",
    "recover",
    `continuation ${continuationExecutionId} (attempt ${String(plan.execution.attempt)}) consumed the approval ` +
      `and performed the write; repair candidate ${fixOutputSha.slice(0, 12)}… committed on ${continuationBranch}`
  );

  const consumed = getApproval(db, opened.approval.id);
  if (consumed === null || consumed.status !== "CONSUMED" || consumed.consumedByExecutionId !== continuationExecutionId) {
    throw new DogfoodDriverError("the approval was not consumed by the continuation execution");
  }

  return {
    checkpointId: opened.checkpoint.id,
    approvalId: opened.approval.id,
    actionDigest: opened.approval.actionDigest,
    proposedWritePath,
    riskGrade: opened.approval.riskGrade,
    sideEffectBeforeApproval,
    tamperedWritePath: tamperedPath,
    tamperRefusalError: tamperRefusal,
    checkpointStatusAfterTamper,
    approvalStatusAfterTamper: approvalAfterTamper.status,
    attemptsAfterTamper,
    consumedByExecutionId: consumed.consumedByExecutionId ?? "(unknown)",
    approvalStatusAfterContinuation: consumed.status,
    sideEffectAfterContinuation
  };
}

// ---------------------------------------------------------------------------
// 中断 -> reconcile 恢复 -> 重试成功 phase
// ---------------------------------------------------------------------------

interface RecoveryPhaseArgs {
  readonly runId: string;
  readonly tick: () => string;
  readonly definitionRevision: string;
  readonly record: (boundary: string, kind: "inject" | "recover" | "assert", detail: string) => void;
  readonly acceptedOutputs: Map<string, { readonly branch: string; readonly headSha: string }>;
  readonly worktreeFingerprints: string[];
  readonly trace: DogfoodNodeTrace[];
  readonly reReviewNodeId: string;
  readonly fixCandidateSha: string;
}

async function runRecoveryPhase(
  world: DogfoodWorld,
  evidence: Evidence,
  args: RecoveryPhaseArgs
): Promise<DogfoodA22Evidence> {
  const { db, worktreesRoot, repoPath, fixture } = world;
  const { runId, tick, definitionRevision } = args;
  const nodeId = args.reReviewNodeId;

  // ---- INJECTION POINT 3: the real scheduler claim, then no launch --------
  const outcome = dispatchExactlyOne(world, { runId, tick }, nodeId);
  const interruptedExecutionId = outcome.executionId;
  const interruptedAttempt = listAttemptsForSlot(db, { runId, nodeId }).length;
  args.record(
    "launch-window-interrupt",
    "inject",
    `scheduler claimed ${interruptedExecutionId} (attempt ${String(interruptedAttempt)}, token ${outcome.dispatchToken.slice(0, 16)}…); ` +
      "the launcher NEVER runs — the durable state is exactly the A24 window (attempt STARTING, dispatch outbox committed, quota grants held, no pid identity)"
  );

  // ---- the REAL reconcile scan decides from the stored evidence ------------
  // (the M11 recovery-driver EXPLICIT entry — this test composition root
  // injects the no-OS-query probe; the pump loop never calls this).
  let probeOsQueries = 0;
  const scan = await scanStartupRecovery(db, {
    now: tick(),
    probe: async () => {
      probeOsQueries += 1;
      return { kind: "indeterminate" as const, reason: "the launch-window decision must not need an OS query" };
    }
  });
  if (scan.scanned !== 1 || scan.decisions[0] === undefined) {
    throw new DogfoodDriverError(
      `the reconcile scan saw ${String(scan.scanned)} active attempts, expected exactly the interrupted one`
    );
  }
  const decision = scan.decisions[0];
  if (decision === undefined || decision.executionId !== interruptedExecutionId || decision.outcome !== "recovery-required") {
    const first = scan.decisions[0];
    throw new DogfoodDriverError(
      `reconcile decided ${String(first?.outcome)} for ${String(first?.executionId)}, expected recovery-required for ${interruptedExecutionId}`
    );
  }
  if (decision.detail.reason !== "launch-window-undetermined") {
    throw new DogfoodDriverError(`reconcile reason ${decision.detail.reason}, expected launch-window-undetermined`);
  }
  if (probeOsQueries !== 0) {
    throw new DogfoodDriverError("the launch-window decision consulted the OS probe");
  }
  if (decision.applied !== "applied") {
    throw new DogfoodDriverError(`reconcile marker application returned ${decision.applied}`);
  }

  // The decision lands on the NODE layer through the M11 bridge (A22).
  const interruptedLanding = landRecoveryOutcome(db, { runId, nodeId, outcome: "interrupted", now: tick() });
  const recoveryLanding = landRecoveryOutcome(db, { runId, nodeId, outcome: "recovery-required", now: tick() });
  if (recoveryLanding.state !== "RECOVERY_REQUIRED") {
    throw new DogfoodDriverError(`the node landed at ${recoveryLanding.state}, expected RECOVERY_REQUIRED`);
  }
  args.record(
    "a22-landing",
    "recover",
    `reconcileStartup: outcome=${decision.outcome} reason=${decision.detail.reason} (A24 window, no OS query needed, probe calls: ${String(probeOsQueries)}); ` +
      `node ${nodeId}: RUNNING -> ${interruptedLanding.state} -> ${recoveryLanding.state}`
  );

  // ---- A22: nothing auto re-runs -------------------------------------------
  let secondAttemptRefused = "(no refusal observed)";
  try {
    createActiveAttempt(db, {
      id: `${interruptedExecutionId}-attempt2`,
      runId,
      nodeId,
      definitionRevision,
      attempt: interruptedAttempt + 1,
      dispatchToken: `dt-${interruptedExecutionId}-blocked`,
      phase: "PREPARING",
      now: tick()
    });
    throw new DogfoodDriverError("A22 violated: a second attempt was created on the interrupted slot");
  } catch (error) {
    if (error instanceof DogfoodDriverError) {
      throw error;
    }
    if (!(error instanceof ActiveAttemptConflictError)) {
      throw error;
    }
    secondAttemptRefused = error.name;
  }
  const recoveryItem = listRecoveryItems(db).find((item) => item.executionId === interruptedExecutionId);
  if (recoveryItem === undefined || recoveryItem.status !== "RECOVERY_REQUIRED" || recoveryItem.followUp !== "manual-recovery") {
    throw new DogfoodDriverError("the recovery list does not surface the interrupted item for a human");
  }
  const rescan = await scanStartupRecovery(db, { now: tick() });
  const queueEntry = listQueueEntries(db).find((entry) => entry.id === outcome.entryId);
  const pendingSchedulerDispatch = listPendingOutboxMessages(db).filter(
    (message) => message.aggregateId === interruptedExecutionId && message.type === "scheduler.dispatch"
  );
  const quotaGrantsRow = db
    .prepare("SELECT COUNT(*) AS n FROM quota_grants WHERE execution_id = ?")
    .get(interruptedExecutionId) as { n: number } | undefined;
  const quotaGrantsHeld = quotaGrantsRow?.n ?? -1;
  if (queueEntry === undefined || queueEntry.state !== "DISPATCHED") {
    throw new DogfoodDriverError("the interrupted claim's queue entry is not durably DISPATCHED (nothing requeues it)");
  }
  if (pendingSchedulerDispatch.length !== 1) {
    throw new DogfoodDriverError(
      `the interrupted claim's dispatch outbox messages: ${String(pendingSchedulerDispatch.length)}, expected exactly 1`
    );
  }
  args.record(
    "a22-no-auto-rerun",
    "assert",
    `second attempt refused (${secondAttemptRefused}); recovery item ${recoveryItem.status}/${recoveryItem.followUp}; ` +
      `rescan idempotent (${String(rescan.decisions[0]?.applied)}); queue entry stays ${queueEntry.state}; ` +
      `dispatch outbox pending: ${String(pendingSchedulerDispatch.length)}; quota grants held: ${String(quotaGrantsHeld)}`
  );

  // ---- 人工解决（operator step; a human decision, never automatic) ----------
  const resolved = resolveRecoveryItem(db, {
    executionId: interruptedExecutionId,
    note: "dogfood operator confirmed the launch never started (launch-window interruption)",
    now: tick()
  });
  if (resolved !== "applied") {
    throw new DogfoodDriverError(`resolveRecoveryItem returned ${resolved}`);
  }
  const resolvedPhase = getExecution(db, interruptedExecutionId)?.phase ?? "(missing)";
  if (resolvedPhase !== "INTERRUPTED") {
    throw new DogfoodDriverError(`the interrupted attempt is at ${resolvedPhase}, expected INTERRUPTED`);
  }
  // The driver's recovery bookkeeping (the pump's failure-path stand-in):
  // release the dead claim's quota grants. Reconcile itself never does this.
  releaseExecutionQuotaGrants(db, { executionId: interruptedExecutionId, now: tick() });
  args.record(
    "operator-resolution",
    "recover",
    `operator resolved the recovery item (${resolved}); ${interruptedExecutionId} = INTERRUPTED; ` +
      "the dead claim's quota grants released by the driver's bookkeeping (reconcile never touches quota)"
  );

  // ---- 重试成功（explicit engine-owned attempt, exactly one) -----------------
  transitionNodeState(db, { runId, nodeId, to: "READY", whereStateIn: ["RECOVERY_REQUIRED"], now: tick() });
  transitionNodeState(db, { runId, nodeId, to: "RUNNING", whereStateIn: ["READY"], now: tick() });
  const retryAttempt = listAttemptsForSlot(db, { runId, nodeId }).length + 1;
  const retryWorktree = await createWorktree(fixture.git, {
    repoPath,
    worktreesRoot,
    runId,
    nodeId,
    attempt: retryAttempt,
    baseSha: args.fixCandidateSha
  });
  args.worktreeFingerprints.push(retryWorktree.userRepoSnapshot.rawStatusSha256);
  const retryExecutionId = `${interruptedExecutionId}-retry`;
  const retryRun = startExecution(db, {
    executionId: retryExecutionId,
    runId,
    roleId: "reviewer",
    nodeId,
    definitionRevision,
    attempt: retryAttempt,
    dispatchToken: `dt-${retryExecutionId}`,
    cwd: retryWorktree.worktreePath,
    prompt: `dogfood ${runId}/${nodeId}: retry after human resolution`,
    invocationArgs: ["--scenario", "success"],
    timeoutSeconds: 120,
    now: tick()
  });
  const retryResult = await retryRun.result;
  if (retryResult.finalPhase !== "SUCCEEDED") {
    transitionNodeState(db, { runId, nodeId, to: "FAILED", whereStateIn: ["RUNNING"], now: tick() });
    throw new DogfoodDriverError(
      `the retry finished ${retryResult.finalPhase} (reasons: ${retryResult.reasons.join(", ")})`,
      { cause: retryResult }
    );
  }

  // The re-review now consumes the FIX candidate through the M8 review-driver
  // (fixed-SHA protocol) and records a PASS bound to the NEW candidateSha (A12).
  const reReview = await settleReviewClaim(
    { db, git: fixture.git },
    {
      repoPath,
      worktreesRoot,
      runId,
      nodeId,
      candidateSha: args.fixCandidateSha,
      now: tick(),
      validationScript: reviewValidationScript(args.fixCandidateSha, dfReviewExpectations(), nodeId),
      validationTimeoutMs: 60_000,
      failureFindings: (validationExitCode) => [
        `re-review still missing content (exit ${String(validationExitCode)})`
      ]
    }
  );
  const verdict = reReview.verdict;
  if (verdict !== "pass") {
    throw new DogfoodDriverError("the re-review did not pass after the repair");
  }
  transitionNodeState(db, { runId, nodeId, to: "SUCCEEDED", whereStateIn: ["RUNNING"], now: tick() });
  const retryBranch = branchNameFor(runId, nodeId, retryAttempt);
  args.acceptedOutputs.set(nodeId, { branch: retryBranch, headSha: args.fixCandidateSha });
  args.trace.push({
    nodeId,
    executionId: retryExecutionId,
    attempt: retryAttempt,
    branch: retryBranch,
    finalPhase: retryResult.finalPhase,
    outputSha: null,
    reviewVerdict: verdict
  });
  const attemptsInSlot = listAttemptsForSlot(db, { runId, nodeId }).length;
  args.record(
    "retry-success",
    "recover",
    `retry ${retryExecutionId} (attempt ${String(retryAttempt)}) SUCCEEDED; re-review PASS durably bound to fix candidate ` +
      `${args.fixCandidateSha.slice(0, 12)}… (A12); slot attempts: ${String(attemptsInSlot)} (one interrupted + one success, never a duplicate writer)`
  );
  evidence.log(`re-review verdict: ${verdict} on candidate ${args.fixCandidateSha}`);

  return {
    executionId: interruptedExecutionId,
    scannedAttempts: scan.scanned,
    probeOsQueries,
    decisionOutcome: decision.outcome,
    decisionReason: decision.detail.reason,
    nodeStateAfterBridge: recoveryLanding.state,
    recoveryItemStatus: recoveryItem.status,
    recoveryFollowUp: recoveryItem.followUp,
    secondAttemptRefusedError: secondAttemptRefused,
    rescanApplied: rescan.decisions[0]?.applied ?? "(none)",
    queueEntryState: queueEntry.state,
    pendingSchedulerDispatchMessages: pendingSchedulerDispatch.length,
    quotaGrantsHeld,
    phaseAfterOperatorResolution: resolvedPhase,
    retryExecutionId,
    retryFinalPhase: retryResult.finalPhase,
    attemptsInSlot
  };
}
