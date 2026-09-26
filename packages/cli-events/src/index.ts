/**
 * @role-orchestrator/cli-events — public entry point.
 *
 * Layered API:
 *  - JsonlByteLineSplitter: byte-level JSONL reassembly with fail-closed limits.
 *  - buildNormalizedEvents: dialect -> 12 normalized event types (contracts).
 *  - EventStreamPipeline: stdout/stderr ports, dedup, stats, protocol errors.
 *  - evaluateOutcome: fail-closed business verdict (exit code, final result,
 *    business schema).
 *  - redact: the shared A36 secret-shape redaction (single source of truth);
 *    every writer on the event pipeline (engine persistence, local-api
 *    egress) imports it from here.
 */
export * from "./jsonl.js";
export * from "./normalizer.js";
export * from "./pipeline.js";
export * from "./outcome.js";
export * from "./redact.js";
