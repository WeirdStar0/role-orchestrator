/**
 * Built-in open-core inventory for M7-04 (ADR 009: open local core vs
 * independent commercial extension).
 *
 * OPEN_CORE_PACKAGE_MANIFEST is a CLOSED list: it names every workspace
 * package that is on the open-core side of the boundary as of 2026-09-24
 * (34 names = the 33 packages shipped through M7-03 plus this auditor).
 * The audit cross-checks the tree against it (rule `core-manifest-drift` /
 * `core-manifest-contradiction`), so the list CANNOT silently go stale:
 * adding a workspace package without extending the manifest fails the
 * audit, which is the deliberate "boundary change must be noticed"
 * property (same philosophy as release-audit's pinned package count).
 * A future commercial package is NOT added here - it self-identifies via
 * the `commercial: true` marker in its own package.json.
 */
export const OPEN_CORE_PACKAGE_MANIFEST: readonly string[] = [
  "@role-orchestrator/approval",
  "@role-orchestrator/boundary-audit",
  "@role-orchestrator/browser-e2e",
  "@role-orchestrator/budget",
  "@role-orchestrator/capability-gate",
  "@role-orchestrator/checkpoint",
  "@role-orchestrator/cli-events",
  "@role-orchestrator/context",
  "@role-orchestrator/context-e2e",
  "@role-orchestrator/contracts",
  "@role-orchestrator/dag",
  "@role-orchestrator/dogfood",
  "@role-orchestrator/e2e-baseline",
  "@role-orchestrator/engine",
  "@role-orchestrator/expand",
  "@role-orchestrator/fake-cli",
  "@role-orchestrator/fault-matrix",
  "@role-orchestrator/implicit-verify",
  "@role-orchestrator/integration",
  "@role-orchestrator/local-api",
  "@role-orchestrator/maintenance",
  "@role-orchestrator/memory",
  "@role-orchestrator/memory-search",
  "@role-orchestrator/plugin-registry",
  "@role-orchestrator/process-lab",
  "@role-orchestrator/reconcile",
  "@role-orchestrator/release-audit",
  "@role-orchestrator/remote-worker",
  "@role-orchestrator/review",
  "@role-orchestrator/runtime-profile",
  "@role-orchestrator/scheduler",
  "@role-orchestrator/scm-contracts",
  "@role-orchestrator/store",
  "@role-orchestrator/worktree"
];

/**
 * The exact set of external runtime dependencies the open core may use in
 * `dependencies` (verified against the real tree on 2026-09-24: the runtime
 * externals of all core packages are exactly ws/yaml/zod, also pinned by
 * release-audit's repo audit). Anything else in a core package's
 * `dependencies` is a boundary violation (rule
 * `external-dep-outside-allowlist`). devDependencies tooling (typescript,
 * vitest, @types/node) is intentionally NOT covered by this allowlist: it
 * is dev/test tooling, not the runtime surface; lockfile integrity and
 * licensing for ALL externals remain release-audit's job.
 */
export const CORE_EXTERNAL_RUNTIME_ALLOWLIST: readonly string[] = ["ws", "yaml", "zod"];

/**
 * The literal package.json field that marks a workspace package as part of
 * the commercial control plane. The value must be the boolean `true`
 * (or `false`); any other shape, and any OTHER key matching /commercial/i,
 * is a `malformed-commercial-marker` finding - and the package KEEPS being
 * audited as open core (fail-closed toward scrutiny, never toward exemption).
 */
export const COMMERCIAL_MARKER_FIELD = "commercial";
