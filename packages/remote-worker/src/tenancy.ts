/**
 * The tenancy + simulation boundary, stated IN DATA so tests can pin it.
 *
 * 1. A remote worker is NOT multi-tenant security. It concentrates the same
 *    user's own executions on another machine; it does not isolate mutually
 *    distrusting principals, and no claim in this package may be read as
 *    tenant isolation. docs/SECURITY_MODEL.md keeps the product posture at
 *    Local Trusted unless a Hardened boundary is MEASURED (A31).
 * 2. Everything in this package is a protocol-level SIMULATION: an in-memory
 *    fake transport, a simulated worker object, a real SQLite lease authority
 *    (via @role-orchestrator/store) — and NOTHING else. No real container
 *    runtime, no real network connection, no real TLS/mTLS handshake, no real
 *    remote process has ever been exercised by this code. Evidence produced
 *    here is protocol-level evidence only.
 */

export const TENANCY_BOUNDARY_STATEMENT =
  "A remote worker execution target is NOT multi-tenant security: it runs one trusted user's own " +
  "orchestrated executions on another machine, does not isolate mutually distrusting principals, " +
  "and must never be presented as tenant isolation. Hardened claims require measured OS/container " +
  "filesystem and network boundary evidence per execution target (A31); without that evidence the " +
  "posture stays local-trusted and the Hardened claim is disabled, not relaxed.";

export const SIMULATION_DISCLOSURE =
  "This package is a protocol-level simulation (in-memory fake transport + simulated worker + real " +
  "SQLite lease authority). It has NEVER exercised a real container runtime, a real network " +
  "connection, a real TLS/mTLS handshake, or a real remote process. All fault-matrix evidence is " +
  "protocol-level evidence; real-runtime behaviors are unverified and listed as such in " +
  "reports/M7-03-remote-worker.md.";

export const NOT_MULTI_TENANT_MARKER = "NOT multi-tenant security";
