/**
 * @role-orchestrator/orchestration — the ONE formal run-execution truth
 * (M10-02).
 *
 * Layers (each importable on its own, composed by createRunDriver):
 *  - driver-contract: the RunDriver interface, config/view types (M1);
 *  - errors: this package's OWN typed error family (M1; error-carrier
 *    inversion — the serving HTTP layer maps, the domain decides);
 *  - constants: the frozen pump constant groups (M1);
 *  - ports: Clock/LogSink injection with production-default behavior (M12);
 *  - run-creation: fail-closed run creation + the ONLY role-binding write
 *    surface (M2; the M10-01 read-over-bindings semantics live here);
 *  - run-driver: createRunDriver — serial pump, chains, activeCancels,
 *    shutdown (M3);
 *  - node-driver: claimed-node settlement (M4);
 *  - dependency-resolver: baselineFor (M5);
 *  - execution-input: node -> execution input mapping (M6);
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
  executionPrompt,
  objectiveOfRun,
  repoRootOf,
  resolveExecutionSettings,
  storedEventViews,
  type ExecutionLaunchInput
} from "./execution-input.js";
export {
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
  type LogSink
} from "./ports.js";
export type {
  CreatedRunView,
  ProfileDefinition,
  ProfileSummaryView,
  ProjectRoleBindingsView,
  RoleBindingView,
  RunCreateInput,
  RunDriver,
  RunDriverConfig,
  RunDriverPorts
} from "./driver-contract.js";
export type { DriverContext } from "./context.js";
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
  settleNodeTerminal,
  type ClaimedDispatch
} from "./node-driver.js";
export {
  continueApprovedCheckpoints,
  openCheckpointsForProposals,
  type LaunchExecution
} from "./approval-driver.js";
export { createRunDriver } from "./run-driver.js";
