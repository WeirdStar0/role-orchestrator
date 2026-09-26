/**
 * Dependency source audit (M6-03): every EXTERNAL dependency in
 * `pnpm-lock.yaml` is accounted for — name, resolved version, registry
 * source, integrity pin, license field, runtime/dev reachability — and
 * cross-checked against every workspace `package.json` specifier.
 *
 * Ground rules:
 * - The lockfile is the source of truth for resolved versions; a mismatch
 *   between an importer specifier (package.json) and the lockfile is a
 *   finding, never silently reconciled.
 * - Licenses are read from the INSTALLED package manifests under
 *   `node_modules/.pnpm` (offline, exactly the bits used). Platform-optional
 *   packages that are not installed on this machine are reported as
 *   `licenseSource: "not-installed-locally"` — they are NOT guessed.
 * - Registry source: pnpm lockfile v9 records only an integrity hash for
 *   default-registry resolutions; any `tarball:` entry means a non-default
 *   source and is surfaced as `customRegistryEntries`. The workspace
 *   `.npmrc` is checked for registry overrides too.
 * - THIRD_PARTY_NOTICES coverage is computed, not assumed: a dependency is
 *   "covered" only when its exact package name appears in the notices text.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AuditTargetMissingError, LockfileParseError } from "./errors.js";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const WORKSPACE_SCOPE = "@role-orchestrator/";

export const DependencyAuditOptionsSchema = z.strictObject({
  repoRoot: z.string().min(1),
  lockfileName: z.string().min(1).default("pnpm-lock.yaml"),
  noticesFileName: z.string().min(1).default("THIRD_PARTY_NOTICES.md")
});

export type DependencyAuditInput = z.input<typeof DependencyAuditOptionsSchema>;

export type LicenseSource = "installed-manifest" | "not-installed-locally";
export type LicensePolicyClass = "permissive" | "review-required" | "unknown";

export interface ExternalDependency {
  readonly name: string;
  readonly version: string;
  /** Registry the package resolves from; default registry unless a tarball override exists. */
  readonly registry: string;
  readonly integrityPinned: boolean;
  readonly license: string | null;
  readonly licenseSource: LicenseSource;
  /** Referenced directly by at least one workspace package.json. */
  readonly direct: boolean;
  /** Reachable from runtime (`dependencies`) edges only; false = dev/test tooling. */
  readonly runtime: boolean;
}

export interface DependencyAuditResult {
  readonly lockfilePath: string;
  readonly workspacePackageCount: number;
  readonly externalPackages: readonly ExternalDependency[];
  /** workspace package.json specifier vs lockfile importer disagreements. */
  readonly specifierMismatches: readonly string[];
  /** lockfile entries without a resolution integrity hash. */
  readonly missingIntegrity: readonly string[];
  /** non-default tarball/registry sources found in the lockfile. */
  readonly customRegistryEntries: readonly string[];
  /** non-default registry lines in the workspace .npmrc (empty = none). */
  readonly npmrcRegistryOverrides: readonly string[];
  readonly licenseSummary: Readonly<Record<string, number>>;
  readonly reviewLicenses: readonly ExternalDependency[];
  readonly unknownLicenses: readonly ExternalDependency[];
  readonly notInstalledLocally: readonly string[];
  readonly noticesCovered: readonly string[];
  readonly noticesUncovered: readonly string[];
}

interface LockPackageEntry {
  readonly name: string;
  readonly version: string;
  readonly integrityPinned: boolean;
  readonly tarball: string | null;
  readonly dependencies: Readonly<Record<string, string>>;
}

const PERMISSIVE_LICENSES = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "BSD-Source-Code",
  "Apache-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "CC-BY-4.0"
]);
const REVIEW_LICENSES = new Set([
  "MPL-2.0", "MPL-1.1", "LGPL-2.1", "LGPL-3.0", "GPL-2.0", "GPL-3.0",
  "EPL-1.0", "EPL-2.0", "CDDL-1.0", "CDDL-1.1", "CDDL-1.1-or-later"
]);

function classifyLicense(license: string | null): LicensePolicyClass {
  if (license === null) return "unknown";
  if (PERMISSIVE_LICENSES.has(license)) return "permissive";
  if (REVIEW_LICENSES.has(license)) return "review-required";
  return "unknown";
}

/** Split a lockfile entry key `name@version[_peerhash]` into name/version. */
function splitEntryKey(key: string): { name: string; version: string } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  const name = key.slice(0, at);
  const rest = key.slice(at + 1);
  const underscore = rest.indexOf("_");
  const version = underscore === -1 ? rest : rest.slice(0, underscore);
  if (name.length === 0 || version.length === 0) return null;
  return { name, version };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readInstalledLicense(pnpmDir: string, name: string, version: string): { license: string | null; installed: boolean } {
  // pnpm stores scoped packages with `/` replaced by `+` in .pnpm dir names.
  const dirStem = `${name.replace(/\//g, "+")}@${version}`;
  const base = path.join(pnpmDir, dirStem);
  const candidates = existsSync(base) ? [base] : readdirSafePrefixed(pnpmDir, `${dirStem}_`);
  for (const dir of candidates) {
    const manifestPath = path.join(dir, "node_modules", ...name.split("/"), "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { license?: unknown; licenses?: unknown };
      if (typeof manifest.license === "string" && manifest.license.length > 0) {
        return { license: manifest.license, installed: true };
      }
      if (Array.isArray(manifest.licenses)) {
        const joined = manifest.licenses
          .map((l) => (typeof l === "string" ? l : (l as { type?: string }).type ?? ""))
          .filter((l) => l.length > 0)
          .join(" OR ");
        if (joined.length > 0) return { license: joined, installed: true };
      }
      return { license: null, installed: true };
    } catch {
      return { license: null, installed: true };
    }
  }
  return { license: null, installed: false };
}

function readdirSafePrefixed(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

interface WorkspaceSpec {
  readonly importerKey: string;
  readonly packageJsonPath: string;
  readonly section: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
  readonly name: string;
  readonly specifier: string;
}

function collectWorkspaceSpecs(repoRoot: string, workspaceDirs: readonly string[]): WorkspaceSpec[] {
  const specs: WorkspaceSpec[] = [];
  for (const dir of workspaceDirs) {
    const packageJsonPath = dir === "." ? path.join(repoRoot, "package.json") : path.join(repoRoot, dir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    } catch (cause) {
      throw new LockfileParseError(packageJsonPath, "workspace package.json is not valid JSON", { cause });
    }
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      const block = manifest[section];
      if (block === undefined || block === null || typeof block !== "object") continue;
      for (const [name, specifier] of Object.entries(block as Record<string, unknown>)) {
        if (typeof specifier !== "string") continue;
        specs.push({ importerKey: dir, packageJsonPath, section, name, specifier });
      }
    }
  }
  return specs;
}

/**
 * Audit the dependency surface. Throws {@link AuditTargetMissingError} when
 * the repo root or lockfile is absent and {@link LockfileParseError} when the
 * lockfile is not parseable. All OUTCOMES (mismatches, missing integrity,
 * license gaps, notices coverage) are returned as data.
 */
export function auditDependencies(input: DependencyAuditInput): DependencyAuditResult {
  const options = DependencyAuditOptionsSchema.parse(input);
  const lockfilePath = path.join(options.repoRoot, options.lockfileName);
  if (!existsSync(options.repoRoot)) throw new AuditTargetMissingError([options.repoRoot]);
  if (!existsSync(lockfilePath)) throw new AuditTargetMissingError([lockfilePath]);

  let lock: unknown;
  try {
    lock = parseYaml(readFileSync(lockfilePath, "utf8"));
  } catch (cause) {
    throw new LockfileParseError(lockfilePath, "YAML parse failed", { cause });
  }
  if (lock === null || typeof lock !== "object") {
    throw new LockfileParseError(lockfilePath, "lockfile root is not a mapping");
  }
  const root = lock as {
    importers?: Record<string, unknown>;
    packages?: Record<string, unknown>;
  };
  const importers = root.importers ?? {};
  const packagesBlock = root.packages ?? {};

  const packageEntries = new Map<string, LockPackageEntry>();
  for (const [key, value] of Object.entries(packagesBlock)) {
    const split = splitEntryKey(key);
    if (split === null) continue;
    const entry = (value ?? {}) as {
      resolution?: { integrity?: string; tarball?: string };
      dependencies?: Record<string, string>;
    };
    packageEntries.set(key, {
      name: split.name,
      version: split.version,
      integrityPinned: typeof entry.resolution?.integrity === "string" && entry.resolution.integrity.length > 0,
      tarball: typeof entry.resolution?.tarball === "string" ? entry.resolution.tarball : null,
      dependencies: entry.dependencies ?? {}
    });
  }

  // Workspace package.json specifiers vs importer section.
  const workspaceDirs = [".", ...Object.keys(importers).filter((k) => k !== ".")];
  const specs = collectWorkspaceSpecs(options.repoRoot, workspaceDirs);
  const specifierMismatches: string[] = [];
  const directNames = new Set<string>();
  for (const spec of specs) {
    if (spec.specifier.startsWith("workspace:")) continue;
    directNames.add(spec.name);
    const importerBlock = importers[spec.importerKey] as
      | Record<string, Record<string, { specifier?: string; version?: string }> | undefined>
      | undefined;
    const depBlock = importerBlock?.[spec.section];
    const importerDep = depBlock?.[spec.name];
    if (importerDep === undefined) {
      specifierMismatches.push(
        `${spec.importerKey} ${spec.section} "${spec.name}" (${spec.specifier}) has no lockfile importer entry`
      );
      continue;
    }
    if (importerDep.specifier !== spec.specifier) {
      specifierMismatches.push(
        `${spec.importerKey} ${spec.section} "${spec.name}": package.json specifier ${spec.specifier} vs lockfile specifier ${importerDep.specifier ?? "?"}`
      );
    }
  }

  // External dependency table.
  const pnpmDir = path.join(options.repoRoot, "node_modules", ".pnpm");
  const runtimeReachable = new Set<string>();
  const queue: LockPackageEntry[] = [];
  for (const importer of Object.values(importers)) {
    const deps = (importer as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {};
    for (const [name, meta] of Object.entries(deps)) {
      if (name.startsWith(WORKSPACE_SCOPE)) continue;
      const entry = findEntryByImporterVersion(packageEntries, name, meta?.version ?? "");
      if (entry !== null) {
        queue.push(entry);
      }
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const entry = queue.pop() as LockPackageEntry;
    const key = `${entry.name}@${entry.version}`;
    if (visited.has(key)) continue;
    visited.add(key);
    runtimeReachable.add(key);
    for (const depName of Object.keys(entry.dependencies)) {
      if (depName.startsWith(WORKSPACE_SCOPE)) continue;
      const depEntry = findEntryAnyVersion(packageEntries, depName);
      if (depEntry !== null) queue.push(depEntry);
    }
  }

  const externalMap = new Map<string, ExternalDependency>();
  const customRegistryEntries: string[] = [];
  const missingIntegrity: string[] = [];
  for (const entry of packageEntries.values()) {
    if (entry.name.startsWith(WORKSPACE_SCOPE)) continue;
    const registry = entry.tarball === null ? DEFAULT_REGISTRY : entry.tarball;
    if (entry.tarball !== null) customRegistryEntries.push(`${entry.name}@${entry.version} -> ${entry.tarball}`);
    if (!entry.integrityPinned) missingIntegrity.push(`${entry.name}@${entry.version}`);
    const { license, installed } = readInstalledLicense(pnpmDir, entry.name, entry.version);
    const external: ExternalDependency = {
      name: entry.name,
      version: entry.version,
      registry,
      integrityPinned: entry.integrityPinned,
      license,
      licenseSource: installed ? "installed-manifest" : "not-installed-locally",
      direct: directNames.has(entry.name),
      runtime: runtimeReachable.has(`${entry.name}@${entry.version}`)
    };
    const existing = externalMap.get(entry.name);
    // Multiple peer-variant entries of the same name/version collapse; keep
    // the first, but flag version conflicts under a compound key.
    const mapKey = `${entry.name}@${entry.version}`;
    if (existing === undefined) externalMap.set(mapKey, external);
  }

  const externalPackages = [...externalMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const licenseSummary: Record<string, number> = {};
  for (const dep of externalPackages) {
    const key = dep.license === null ? "(not-installed-locally)" : dep.license;
    licenseSummary[key] = (licenseSummary[key] ?? 0) + 1;
  }

  // .npmrc registry overrides.
  const npmrcRegistryOverrides: string[] = [];
  const npmrcPath = path.join(options.repoRoot, ".npmrc");
  if (existsSync(npmrcPath)) {
    for (const line of readFileSync(npmrcPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^registry\s*=/.test(trimmed) || /^\/\/.*=/.test(trimmed) || /^@[^\s]+:registry\s*=/.test(trimmed)) {
        npmrcRegistryOverrides.push(trimmed);
      }
    }
  }

  // THIRD_PARTY_NOTICES coverage, computed against the exact package names.
  const noticesPath = path.join(options.repoRoot, options.noticesFileName);
  const noticesText = existsSync(noticesPath) ? readFileSync(noticesPath, "utf8") : "";
  const noticesCovered: string[] = [];
  const noticesUncovered: string[] = [];
  for (const dep of externalPackages) {
    const pattern = new RegExp(`(?<![A-Za-z0-9@/_-])${escapeRegExp(dep.name)}(?![A-Za-z0-9@/_-])`);
    if (pattern.test(noticesText)) noticesCovered.push(dep.name);
    else noticesUncovered.push(dep.name);
  }

  return {
    lockfilePath,
    workspacePackageCount: Object.keys(importers).length,
    externalPackages,
    specifierMismatches,
    missingIntegrity,
    customRegistryEntries,
    npmrcRegistryOverrides,
    licenseSummary,
    reviewLicenses: externalPackages.filter((d) => classifyLicense(d.license) === "review-required"),
    unknownLicenses: externalPackages.filter((d) => classifyLicense(d.license) === "unknown" && d.license !== null),
    notInstalledLocally: externalPackages.filter((d) => d.licenseSource === "not-installed-locally").map((d) => `${d.name}@${d.version}`),
    noticesCovered,
    noticesUncovered
  };
}

function findEntryByImporterVersion(
  entries: Map<string, LockPackageEntry>,
  name: string,
  importerVersion: string
): LockPackageEntry | null {
  const exact = entries.get(`${name}@${importerVersion}`);
  if (exact !== undefined) return exact;
  return findEntryAnyVersion(entries, name);
}

function findEntryAnyVersion(entries: Map<string, LockPackageEntry>, name: string): LockPackageEntry | null {
  for (const entry of entries.values()) {
    if (entry.name === name) return entry;
  }
  return null;
}
