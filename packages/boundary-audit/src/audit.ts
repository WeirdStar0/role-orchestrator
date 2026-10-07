/**
 * M7-04 open-core vs commercial control-plane boundary audit.
 *
 * Reads every workspace package.json directly under the packages directory
 * and enforces
 * the ADR 009 dependency-direction rules as DATA (violations are results,
 * never exceptions):
 *
 * - R1  `commercial-dep-in-core`         a core package's `dependencies`
 *   (startup/runtime path) or `optionalDependencies` (OPTIONAL runtime path:
 *   optional deps are still installed and loaded by the runtime when
 *   present, so they are runtime edges, not build-only edges — HARDENING-1,
 *   review minor #2) contain a workspace package marked `commercial: true`
 *   [the M7-04 ask's rule 1a]
 * - R1b `commercial-devdep-in-core`      same through `devDependencies`
 *   (build path: turbo `build` depends on `^build` across the package
 *   graph, and pnpm links devDependencies into the workspace install) or
 *   `peerDependencies` (build/integration path: a peer requirement makes the
 *   host resolve and link that package into the core's own integration
 *   surface — treated as the dev-channel edge it is, not a separate rule;
 *   both channels are the "not the runtime dependencies list" direction, and
 *   one shared rule keeps the finding vocabulary closed — HARDENING-1) -
 *   the deliberate strengthening of the ask's "startup/build path" boundary
 * - R2  `external-dep-outside-allowlist` a core package's `dependencies`,
 *   `optionalDependencies` or `peerDependencies` introduce an external
 *   dependency outside CORE_EXTERNAL_RUNTIME_ALLOWLIST (an optional runtime
 *   dep is runtime surface by definition; an unallowlisted peer of a core
 *   package is an external integration surface the host must resolve at
 *   install time)  [the M7-04 ask's rule 1b, extended by HARDENING-1]
 * - R3  `workspace-dependency-cycle`     the workspace runtime dependency
 *   graph (dependencies edges) has a cycle; an acyclic core is what makes
 *   the direction rules statically decidable at all
 * - R4a `core-manifest-drift`            a non-commercial package is not on
 *   the (effective) open-core manifest - the closed list cannot go stale
 * - R4b `core-manifest-contradiction`    a commercial package IS on the
 *   open-core manifest
 * - R4c `malformed-commercial-marker`    the marker field is not a boolean
 *   or an alias /commercial/i key exists (the package stays under core
 *   scrutiny - fail-closed toward scrutiny, never toward exemption)
 * - R5  `dangling-workspace-dep`         a `workspace:`-style reference (or
 *   a name that resolves to nothing) points at no workspace package, in ANY
 *   of the four dependency sections (HARDENING-1: optional/peer included)
 *
 * A core↔commercial edge can never hide in the dev graph either: R1b pins
 * the dev and peer directions, R1 pins the runtime AND optional-runtime
 * directions, R3 pins acyclicity of the hard runtime graph. R3 deliberately
 * stays `dependencies`-only (a cycle through an optional edge is not a hard
 * startup cycle; the edge is still boundary-checked by R1/R2/R5), and
 * `runtimeWorkspaceEdges` serializes exactly that hard runtime graph.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AuditTargetMissingError } from "./errors.js";
import { parseWorkspaceManifest, DEPENDENCY_SECTIONS, type DependencySection, type WorkspaceManifest } from "./manifest.js";
import {
  COMMERCIAL_MARKER_FIELD,
  CORE_EXTERNAL_RUNTIME_ALLOWLIST,
  OPEN_CORE_PACKAGE_MANIFEST
} from "./core-manifest.js";
import { COMMERCIAL_BOUNDARY_STATEMENT, DESIGN_ONLY_DISCLOSURE } from "./statements.js";

export const BoundaryAuditOptionsSchema = z.strictObject({
  repoRoot: z.string().min(1),
  packagesDirName: z.string().min(1).default("packages"),
  /**
   * M11-01: additional workspace directories scanned AFTER the main one
   * (same package.json-discovery rules). The repo audit passes ["apps"] so
   * the desktop renderer under apps/ is inside the boundary; the default []
   * keeps every existing fixture/layout byte-compatible.
   */
  additionalPackageDirs: z.array(z.string().min(1)).default([]),
  /** Override of OPEN_CORE_PACKAGE_MANIFEST (fixtures inject small lists). */
  corePackages: z.array(z.string().min(1)).optional(),
  /** Override of CORE_EXTERNAL_RUNTIME_ALLOWLIST (fixtures inject small lists). */
  coreExternalAllowlist: z.array(z.string().min(1)).optional()
});

export type BoundaryAuditInput = z.input<typeof BoundaryAuditOptionsSchema>;

export type BoundaryViolationRule =
  | "commercial-dep-in-core"
  | "commercial-devdep-in-core"
  | "external-dep-outside-allowlist"
  | "workspace-dependency-cycle"
  | "core-manifest-drift"
  | "core-manifest-contradiction"
  | "malformed-commercial-marker"
  | "dangling-workspace-dep";

export interface BoundaryViolation {
  readonly rule: BoundaryViolationRule;
  /** Offending package; `null` where no single package owns the finding (cycles). */
  readonly packageName: string | null;
  /** Offending dependency, where the rule is about one edge. */
  readonly dependencyName: string | null;
  readonly detail: string;
}

export interface BoundaryAuditResult {
  readonly repoRoot: string;
  readonly packagesDir: string;
  /** Workspace packages discovered (directories with a parseable package.json). */
  readonly workspacePackageCount: number;
  readonly corePackagesUsed: readonly string[];
  readonly externalAllowlistUsed: readonly string[];
  readonly commercialPackages: readonly string[];
  /** Runtime workspace edges `A -> B` (dependencies section), sorted. */
  readonly runtimeWorkspaceEdges: readonly string[];
  readonly violations: readonly BoundaryViolation[];
  readonly verdict: "pass" | "fail";
  /** The boundary claim travels with the data. */
  readonly boundaryStatement: string;
  /** Honesty disclosure travels with the data (mechanism vs existence). */
  readonly designDisclosure: string;
  readonly markerField: string;
}

function normalizeNameList(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** DFS back-edge collection with rotation-normalized, deduplicated rings. */
export function findRuntimeCycles(adjacency: ReadonlyMap<string, readonly string[]>): readonly string[][] {
  const state = new Map<string, 1 | 2>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (state.get(next) === 1) {
        const ring = [...stack.slice(stack.indexOf(next)), next];
        const smallest = ring.reduce((acc, cur) => (cur.localeCompare(acc) < 0 ? cur : acc), ring[0] as string);
        const pivot = ring.indexOf(smallest);
        const normalized = [...ring.slice(pivot, -1), ...ring.slice(0, pivot)];
        const key = normalized.join("->");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(normalized);
        }
      } else if (state.get(next) === undefined) {
        visit(next, stack);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of [...adjacency.keys()].sort((a, b) => a.localeCompare(b))) {
    if (!state.has(node)) visit(node, []);
  }
  return cycles.sort((a, b) => a.join("->").localeCompare(b.join("->")));
}

/**
 * Audit the open-core boundary of the workspace tree at `options.repoRoot`.
 * Throws {@link AuditTargetMissingError} when the root or packages
 * directory is absent; every boundary OUTCOME is returned as data.
 */
export function auditCommercialBoundary(input: BoundaryAuditInput): BoundaryAuditResult {
  const options = BoundaryAuditOptionsSchema.parse(input);
  const packagesDir = path.join(options.repoRoot, options.packagesDirName);
  if (!existsSync(options.repoRoot)) throw new AuditTargetMissingError([options.repoRoot]);
  if (!existsSync(packagesDir)) throw new AuditTargetMissingError([packagesDir]);

  const corePackagesUsed = normalizeNameList(options.corePackages ?? OPEN_CORE_PACKAGE_MANIFEST);
  const externalAllowlistUsed = normalizeNameList(options.coreExternalAllowlist ?? CORE_EXTERNAL_RUNTIME_ALLOWLIST);
  const coreSet = new Set(corePackagesUsed);
  const allowSet = new Set(externalAllowlistUsed);

  const manifests: WorkspaceManifest[] = [];
  const scanDirs = [packagesDir, ...options.additionalPackageDirs.map((dir) => path.join(options.repoRoot, dir))];
  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) throw new AuditTargetMissingError([scanDir]);
    for (const entry of readdirSync(scanDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const manifestPath = path.join(scanDir, entry, "package.json");
      if (!existsSync(manifestPath)) continue; // a stray directory is not a workspace package
      manifests.push(parseWorkspaceManifest(entry, readFileSync(manifestPath, "utf8"), manifestPath));
    }
  }
  const byName = new Map(manifests.map((m) => [m.name, m]));

  const violations: BoundaryViolation[] = [];
  const push = (violation: BoundaryViolation): void => {
    violations.push(violation);
  };

  // Marker + manifest membership rules (R4a/R4b/R4c).
  for (const manifest of manifests) {
    for (const anomaly of manifest.markerAnomalies) {
      push({ rule: "malformed-commercial-marker", packageName: manifest.name, dependencyName: null, detail: anomaly });
    }
    if (manifest.commercial) {
      if (coreSet.has(manifest.name)) {
        push({
          rule: "core-manifest-contradiction",
          packageName: manifest.name,
          dependencyName: null,
          detail: `commercial package "${manifest.name}" is listed on the open-core manifest; a package cannot be both`
        });
      }
    } else if (!coreSet.has(manifest.name)) {
      push({
        rule: "core-manifest-drift",
        packageName: manifest.name,
        dependencyName: null,
        detail:
          `non-commercial workspace package "${manifest.name}" is not on the open-core manifest; ` +
          "extend OPEN_CORE_PACKAGE_MANIFEST (or mark it commercial) so the boundary cannot change silently"
      });
    }
  }

  // Edge classification + R5 (dangling workspace references) — over ALL four
  // dependency sections (HARDENING-1: optional/peer can carry the same
  // dangling `workspace:` references as the classic two).
  interface WorkspaceEdge {
    readonly from: string;
    readonly to: string;
    readonly section: DependencySection;
  }
  const workspaceEdges: WorkspaceEdge[] = [];
  for (const manifest of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [depName, specifier] of Object.entries(manifest[section])) {
        const target = byName.get(depName);
        if (!specifier.startsWith("workspace:") && target === undefined) continue; // external, not a workspace edge
        if (target === undefined) {
          push({
            rule: "dangling-workspace-dep",
            packageName: manifest.name,
            dependencyName: depName,
            detail: `"${manifest.name}" ${section} "${depName}" (${specifier}) matches no workspace package`
          });
          continue;
        }
        workspaceEdges.push({ from: manifest.name, to: depName, section });
      }
    }
  }

  // R1 / R1b / R2 apply to open-core packages only; commercial packages sit
  // outside the core rule set (their externals stay release-audit's scope).
  // Section semantics (HARDENING-1): dependencies + optionalDependencies are
  // RUNTIME edges (R1); devDependencies + peerDependencies are BUILD and
  // BUILD/INTEGRATION edges respectively (R1b).
  for (const manifest of manifests) {
    if (manifest.commercial) continue;
    const coreRules: readonly [DependencySection, BoundaryViolationRule, string][] = [
      ["dependencies", "commercial-dep-in-core", "startup path"],
      ["optionalDependencies", "commercial-dep-in-core", "optional runtime path"],
      ["devDependencies", "commercial-devdep-in-core", "build path"],
      ["peerDependencies", "commercial-devdep-in-core", "peer/integration path"]
    ];
    for (const [section, rule, channel] of coreRules) {
      for (const [depName, specifier] of Object.entries(manifest[section])) {
        const target = byName.get(depName);
        if (target === undefined || !target.commercial) continue;
        push({
          rule,
          packageName: manifest.name,
          dependencyName: depName,
          detail:
            `open-core package "${manifest.name}" ${section} depends on commercial package "${depName}" ` +
            `(${specifier}); commercial dependencies must not enter the open core's ${channel}`
        });
      }
    }
    // R2: runtime-channel externals (hard + optional + peer) must be
    // allowlisted. devDependencies stay dev/test tooling, outside the
    // runtime allowlist's scope (unchanged from M7-04).
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
      for (const [depName, specifier] of Object.entries(manifest[section])) {
        const isWorkspaceRef = specifier.startsWith("workspace:") || byName.has(depName);
        if (!isWorkspaceRef && !allowSet.has(depName)) {
          push({
            rule: "external-dep-outside-allowlist",
            packageName: manifest.name,
            dependencyName: depName,
            detail:
              `open-core package "${manifest.name}" introduces external runtime dependency "${depName}" ` +
              `(${specifier}, via ${section}) outside the core allowlist [${externalAllowlistUsed.join(", ")}]`
          });
        }
      }
    }
  }

  // R3: cycles over runtime (dependencies) workspace edges.
  const runtimeAdjacency = new Map<string, string[]>();
  for (const edge of workspaceEdges) {
    if (edge.section !== "dependencies") continue;
    const list = runtimeAdjacency.get(edge.from) ?? [];
    list.push(edge.to);
    runtimeAdjacency.set(edge.from, list);
  }
  for (const cycle of findRuntimeCycles(runtimeAdjacency)) {
    push({
      rule: "workspace-dependency-cycle",
      packageName: null,
      dependencyName: null,
      detail: `workspace runtime dependency cycle: ${[...cycle, cycle[0] as string].join(" -> ")}`
    });
  }

  violations.sort((a, b) =>
    a.rule.localeCompare(b.rule) ||
    (a.packageName ?? "").localeCompare(b.packageName ?? "") ||
    (a.dependencyName ?? "").localeCompare(b.dependencyName ?? "") ||
    a.detail.localeCompare(b.detail)
  );

  const runtimeWorkspaceEdges = workspaceEdges
    .filter((e) => e.section === "dependencies")
    .map((e) => `${e.from} -> ${e.to}`)
    .sort((a, b) => a.localeCompare(b));

  return {
    repoRoot: options.repoRoot,
    packagesDir,
    workspacePackageCount: manifests.length,
    corePackagesUsed,
    externalAllowlistUsed,
    commercialPackages: manifests.filter((m) => m.commercial).map((m) => m.name).sort((a, b) => a.localeCompare(b)),
    runtimeWorkspaceEdges,
    violations,
    verdict: violations.length === 0 ? "pass" : "fail",
    boundaryStatement: COMMERCIAL_BOUNDARY_STATEMENT,
    designDisclosure: DESIGN_ONLY_DISCLOSURE,
    markerField: COMMERCIAL_MARKER_FIELD
  };
}
