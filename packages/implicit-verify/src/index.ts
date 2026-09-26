/**
 * @role-orchestrator/implicit-verify — public entry point (M4-06).
 *
 * CLI 隐式配置与代理预算的纯验证包（A34/A35）。NO product logic, NO CLI
 * invocation — the real-CLI behavior verification belongs to the M0-03/M0-04
 * capability reports and their extensions; what this package verifies is the
 * CONTROL PLANE's handling of that measured invisibility:
 *
 * - `evidence.ts` — the frozen M0-03/M0-04 data-plane measurements
 *   (claude init: 9 MCP / 13 agents / 133 skills / 4 plugins / 171 slash
 *   commands / SessionStart hooks / subagent_stats; codex: in-stream skills
 *   budget hint, MCP manifest invisible) plus the expected capability-gate
 *   cell and blocked-assumption verdicts;
 * - `control-plane.ts` — read-only probes composing the existing control
 *   surfaces: the unattended-write decision (gate + scheduling layer, refused
 *   while implicit loading is unverified), the A34 pre-start drift gate
 *   (drift → refuse to start; frozen snapshots never implicitly swap), and
 *   the quota-ledger census proving grants/consumption tie ONLY to
 *   orchestrator-dispatched executions (CLI-internal activity is never
 *   billable, so it can never buy unattended operation).
 */
export * from "./errors.js";
export * from "./evidence.js";
export * from "./control-plane.js";
