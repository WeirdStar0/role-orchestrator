/**
 * @role-orchestrator/orchestration — the ONE formal run-execution truth
 * (M10-02, multi-node since M10-03).
 *
 * Layers (each importable on its own, composed by createRunDriver):
 *  - driver-contract: the RunDriver interface, config/view types (M1);
 *  - errors: this package's OWN typed error family (M1; error-carrier
 *    inversion — the serving HTTP layer maps, the domain decides);
 *  - constants: the frozen pump constant groups (M1);
 *  - ports: Clock/LogSink/OutputCommitter injection with production-default
 *    behavior (M12; the committer is a multi-node-only injection);
 *  - run-creation: fail-closed run creation + the ONLY role-binding write
 *    surface (M2; the M10-01 read-over-bindings semantics live here); since
 *    M10-03 also the multi-node declaration path (strict spec validation,
 *    frozen-graph mapping, kind registration);
 *  - run-driver: createRunDriver — serial pump, chains, activeCancels,
 *    shutdown (M3);
 *  - node-driver: claimed-node settlement (M4); since M10-03 the kind
 *    dispatch (agent = CLI execution / integration = M7 merge / review = M8
 *    fixed-SHA verdict + M10 rework on fail);
 *  - dependency-resolver: baselineFor (M5);
 *  - execution-input: node -> execution input mapping (M6); since M10-03 the
 *    role-context prompt builder; since M10-04 the read-side Memory/Context
 *    injection blocks (fail-open collector, budget truncation, A36 redaction);
 *  - memory-injection: the M10-04 read-side collector behind that seam —
 *    memory-search retrieval + context-manifest references, READ ONLY (the
 *    memory/context write paths are never touched); any read fault degrades
 *    to no injection plus one stderr notice;
 *  - multi-node: the declaration layer — spec validation, frozen-graph
 *    mapping, fail-closed dispatch-kind resolution (M10-03);
 *  - integration-driver (M7) / review-driver (M8) / rework-driver (M10) /
 *    recovery-driver (M11): the optional phases, standalone exports;
 *  - approval-driver: proposal mining -> checkpoint -> APPROVED continuation;
 *    the driver NEVER approves (M9).
 *
 * This package NEVER depends on a serving package (no local-api edge) and
 * only COMPOSES the downstream service packages — it re-implements none of
 * them. Zero external npm dependencies.
 */
export type {
  AcceptedOutput,
  AcceptedOutputs
} from "./dependency-resolver.js";
export { baselineFor, buildParents } from "./dependency-resolver.js";
export {
  buildNodePrompt,
  executionPrompt,
  nodePromptObjective,
  objectiveOfNode,
  objectiveOfRun,
  repoRootOf,
  resolveExecutionSettings,
  storedEventViews,
  type DependencyArtifactReference,
  type ExecutionLaunchInput
} from "./execution-input.js";
export {
  collectNodeMemoryInjection,
  eprintln,
  objectiveTokens,
  CONTEXT_REFS_MAX_ENTRIES,
  EMPTY_MEMORY_INJECTION,
  MEMORY_INJECTION_BUDGET_BYTES,
  MEMORY_INJECTION_MAX_HITS,
  MEMORY_QUERY_MAX_TOKENS,
  type ContextManifestRefEntry,
  type MemoryInjectionEntry,
  type NodeMemoryInjection
} from "./memory-injection.js";
export {
  OrchestrationDriverError,
  OrchestrationError,
  OrchestrationRejectionError
} from "./errors.js";
export {
  APPROVAL_TTL_SECONDS,
  EXECUTE_NODE_ID,
  GRAPH_DEFINITION_REVISION,
  MAX_PUMP_ROUNDS,
  POLL_LEASE_MS,
  POLL_LIMIT,
  POLL_RETRY_WINDOW_MS,
  POLL_STARVATION_MS,
  PUMP_CONCURRENCY,
  SHUTDOWN_GRACE_MS
} from "./constants.js";
export {
  createStdoutLogSink,
  systemClock,
  type Clock,
  type LogSink,
  type OutputCommitter
} from "./ports.js";
export type {
  CreatedRunView,
  NodeDispatchKind,
  ProfileDefinition,
  ProfileSummaryView,
  ProjectRoleBindingsView,
  RoleBindingView,
  RunCreateInput,
  RunDriver,
  RunDriverConfig,
  RunDriverPorts,
  WorkflowNodeSpec
} from "./driver-contract.js";
export type { DriverContext, MultiNodeRunBook } from "./context.js";
export {
  createRunChecked,
  ensureProfileRevision,
  ensureProfileRow,
  requireCompleteRoleBindings,
  setProjectRoleBindings
} from "./run-creation.js";
export {
  launchExecution,
  runClaimedDispatch,
  settleMultiNodeTerminal,
  settleNodeTerminal,
  type ClaimedDispatch
} from "./node-driver.js";
export {
  continueApprovedCheckpoints,
  openCheckpointsForProposals,
  type LaunchExecution,
  type SettleMultiNodeContinuation
} from "./approval-driver.js";
export {
  createRunBook,
  resolveNodeKind,
  toFrozenWorkflow,
  validateWorkflowSpecs,
  workflowTitleFor,
  MULTI_NODE_WORKFLOW_NAME
} from "./multi-node.js";
export {
  isConvergedStates,
  runPumpRounds,
  settleClaimBookkeeping,
  settleClaimedNode,
  transitionNodeTerminal,
  type Convergence,
  type DispatchJoin,
  type ErrorIsolation,
  type PumpRoundsDeps,
  type PumpRoundsOptions,
  type PumpRoundsResult,
  type PumpRoundsStopReason
} from "./pump-primitives.js";
export {
  settleIntegrationClaim,
  type IntegrationCandidates,
  type IntegrationClaimInput,
  type IntegrationSettlement
} from "./integration-driver.js";
export {
  settleReviewClaim,
  settleAgentReviewClaim,
  parseAgentReviewVerdict,
  type AgentReviewClaim,
  type AgentReviewSettlement,
  type AgentReviewSettlementInput,
  type ReviewClaimInput,
  type ReviewSettlement
} from "./review-driver.js";
export {
  requestReworkExpansion,
  type ReworkRequestInput
} from "./rework-driver.js";
export {
  landRecoveryOutcome,
  listRecoveryItems,
  resolveRecoveryItem,
  scanStartupRecovery
} from "./recovery-driver.js";
export { createRunDriver } from "./run-driver.js";
