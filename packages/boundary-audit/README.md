# @role-orchestrator/boundary-audit

M7-04 open-core vs commercial control-plane boundary audit
(`docs/adr/009-open-core-and-license.md`, design task; **no
commercial-edition code exists in this repository**).

## What it enforces

Reads every `packages/*/package.json` and returns violations as data:

| Rule | Meaning |
|---|---|
| `commercial-dep-in-core` (R1) | An open-core package's `dependencies` (startup path) or `optionalDependencies` (optional runtime path: optional deps are still installed and loaded by the runtime when present, so they are runtime edges, not build-only edges — HARDENING-1) contain a workspace package marked `commercial: true`. |
| `commercial-devdep-in-core` (R1b) | The same through `devDependencies` (build path; turbo `build` depends on `^build` across the package graph) or `peerDependencies` (peer/integration path: a peer requirement makes the host resolve and link that package into the core's integration surface — treated as the dev-channel edge it is so the finding vocabulary stays closed; HARDENING-1). |
| `external-dep-outside-allowlist` (R2) | An open-core package's `dependencies`, `optionalDependencies` or `peerDependencies` introduce an external dependency outside `CORE_EXTERNAL_RUNTIME_ALLOWLIST` (ws/yaml/zod): an optional runtime dep is runtime surface by definition; an unallowlisted peer of a core package is an external integration surface the host must resolve at install time. `devDependencies` stay dev/test tooling, outside the allowlist's scope (M7-04 semantics). |
| `workspace-dependency-cycle` (R3) | The workspace runtime dependency graph (`dependencies` edges only) has a cycle; an optional edge is not a hard startup cycle and is still boundary-checked by R1/R2/R5. |
| `core-manifest-drift` (R4a) | A non-commercial workspace package is not on the closed `OPEN_CORE_PACKAGE_MANIFEST` (the manifest cannot go stale silently). |
| `core-manifest-contradiction` (R4b) | A commercial package is listed on the open-core manifest. |
| `malformed-commercial-marker` (R4c) | The marker field is not a boolean, or an alias `/commercial/i` key exists. The package stays under core scrutiny (fail-closed toward scrutiny, never toward exemption). |
| `dangling-workspace-dep` (R5) | A `workspace:`-style reference (or a name that resolves to nothing) points at no workspace package, in ANY of the four dependency sections (`dependencies`, `optionalDependencies`, `devDependencies`, `peerDependencies` — HARDENING-1: optional/peer included). |

**Commercial marking mechanism**: a workspace package joins the commercial
control plane ONLY via the literal field `"commercial": true` in its own
`package.json`. There is no second mechanism and aliases are findings.

**Pinned statements** (exported as data, pinned verbatim by tests):
`COMMERCIAL_BOUNDARY_STATEMENT`, `A01_COMMERCIAL_STATEMENT` (single-select
Profile binding holds unchanged in any future commercial control plane, via
the same `runtime-profile` authority), `A02_COMMERCIAL_STATEMENT` (override
rejection holds unchanged at every layer, same closed vocabulary), and
`DESIGN_ONLY_DISCLOSURE` (mechanism verification, not existence
verification — every audit result carries it).

## Usage

```bash
# Library
import { auditCommercialBoundary } from "@role-orchestrator/boundary-audit";

# CLI against this repository (exit 0 pass / 1 violations / 2 precondition)
pnpm --filter @role-orchestrator/boundary-audit build
node packages/boundary-audit/dist/cli.js <repoRoot>
```

The real-repository run is an operator command, deliberately not a pinned
test: per-package-Add baseline maintenance stays with release-audit's
pinned workspace count plus the PROPOSALS.md disclosure protocol, so this
package does not add a second drift point.

Scope note: devDependencies tooling (typescript/vitest/@types/node) is not
covered by the external allowlist — lockfile integrity, registry and
license auditing for ALL dependencies remain release-audit's job.
