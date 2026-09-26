/**
 * @role-orchestrator/engine — public entry point (M1-03).
 *
 * Single-execution lifecycle over the fake-cli dist bin (dogfood):
 *  - prepareExecutionInvocation: frozen-snapshot -> argv-array invocation,
 *    never a shell string; manifest hash; stdin file;
 *  - startExecution: the PREPARING -> STARTING -> RUNNING -> FINALIZING ->
 *    terminal lifecycle with immediate pid/session recording, event
 *    persistence through the cli-events pipeline, the fail-closed A06
 *    success formula (incl. the evidence gate) and timeout/cancel tree
 *    termination;
 *  - evidence: the dialect-aware "required evidence exists" gate;
 *  - persistence helpers for durable protocol + lifecycle events.
 *
 * Full startup reconcile is M1-05; this package provides the query/state
 * primitives it will build on (they live in @role-orchestrator/store).
 */
export * from "./errors.js";
export * from "./invocation.js";
export * from "./evidence.js";
export * from "./persistence.js";
export * from "./tree-kill.js";
export * from "./lifecycle.js";
