/**
 * Workspace package.json projection for the M7-04 boundary audit.
 *
 * Reading strategy (mirrors release-audit's dependency audit): a workspace
 * package.json is an EXTERNAL artifact with dozens of legitimate
 * npm/pnpm-standard fields, so the auditor validates the PROJECTION it
 * consumes (name, dependency sections, the commercial marker) and reports
 * marker-vocabulary anomalies as findings, instead of rejecting the whole
 * manifest for fields outside its projection. The auditor's own INPUT
 * options are a z.strictObject - unknown fields rejected (repo rule).
 *
 * Marker rules (fail-closed toward scrutiny):
 * - `commercial` present and boolean -> the marker is authoritative.
 * - `commercial` present but NOT boolean (e.g. the string "true") -> the
 *   package is treated as NOT commercial (it keeps core scrutiny: R1/R2/
 *   manifest-membership all still apply to it) and a
 *   `malformed-commercial-marker` finding is recorded.
 * - any OTHER key matching /commercial/i (e.g. `isCommercial`) -> recorded
 *   as a marker anomaly too; aliases can never smuggle the marker past the
 *   canonical field.
 */
import { ManifestParseError } from "./errors.js";
import { COMMERCIAL_MARKER_FIELD } from "./core-manifest.js";

/**
 * The four npm dependency sections the audit walks (HARDENING-1: added
 * `optionalDependencies` and `peerDependencies` — review minor #2; a
 * commercial package can enter the core through those channels exactly as
 * through the two classic ones, so the edge collection can no longer stop at
 * dependencies/devDependencies).
 */
export type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";

/** The sections in the order the audit walks them (deterministic output). */
export const DEPENDENCY_SECTIONS: readonly DependencySection[] = [
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies"
];

export interface WorkspaceManifest {
  /** Directory name under packages/ (unique per audited tree). */
  readonly dirName: string;
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** Authoritative only when every marker anomaly is absent. */
  readonly commercial: boolean;
  /** Marker-vocabulary anomalies; non-empty -> finding + fail-closed core treatment. */
  readonly markerAnomalies: readonly string[];
}

function readDependencySection(
  manifestPath: string,
  manifestName: string,
  section: DependencySection,
  raw: unknown
): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(manifestPath, `"${section}" of ${manifestName} is not an object`);
  }
  const out: Record<string, string> = {};
  for (const [depName, specifier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof specifier !== "string") {
      throw new ManifestParseError(
        manifestPath,
        `"${section}.${depName}" of ${manifestName} is not a string specifier`
      );
    }
    out[depName] = specifier;
  }
  return out;
}

/**
 * Parse one package.json into the auditable projection. Throws
 * {@link ManifestParseError} when the text is not JSON, `name` is missing
 * or not a non-empty string, or a dependency specifier is not a string -
 * those are preconditions. Marker anomalies are OUTCOMES, returned as data.
 * All four dependency sections ({@link DEPENDENCY_SECTIONS}) are projected;
 * an absent section projects to an empty record.
 */
export function parseWorkspaceManifest(dirName: string, rawText: string, manifestPath: string): WorkspaceManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (cause) {
    throw new ManifestParseError(manifestPath, "not valid JSON", { cause });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestParseError(manifestPath, "root is not a JSON object");
  }
  const root = raw as Record<string, unknown>;
  if (typeof root.name !== "string" || root.name.length === 0) {
    throw new ManifestParseError(manifestPath, "required string field \"name\" is missing or empty");
  }
  const dependencies = readDependencySection(manifestPath, root.name, "dependencies", root.dependencies);
  const optionalDependencies = readDependencySection(manifestPath, root.name, "optionalDependencies", root.optionalDependencies);
  const devDependencies = readDependencySection(manifestPath, root.name, "devDependencies", root.devDependencies);
  const peerDependencies = readDependencySection(manifestPath, root.name, "peerDependencies", root.peerDependencies);

  const markerAnomalies: string[] = [];
  let commercial = false;
  if (Object.prototype.hasOwnProperty.call(root, COMMERCIAL_MARKER_FIELD)) {
    const value = root[COMMERCIAL_MARKER_FIELD];
    if (typeof value !== "boolean") {
      markerAnomalies.push(
        `field "${COMMERCIAL_MARKER_FIELD}" must be the boolean true/false, got ${value === null ? "null" : typeof value}; ` +
          "the package is audited as open core (fail-closed toward scrutiny)"
      );
    } else {
      commercial = value;
    }
  }
  const aliasKeys = Object.keys(root).filter(
    (key) => key !== COMMERCIAL_MARKER_FIELD && /commercial/i.test(key)
  );
  for (const key of aliasKeys) {
    markerAnomalies.push(
      `unknown marker-vocabulary key "${key}" (canonical field is "${COMMERCIAL_MARKER_FIELD}"); ` +
        "aliases never mark a package commercial"
    );
  }
  return { dirName, name: root.name, dependencies, optionalDependencies, devDependencies, peerDependencies, commercial, markerAnomalies };
}
