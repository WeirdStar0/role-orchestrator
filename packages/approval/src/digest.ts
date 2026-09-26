/**
 * actionDigest (M4-01, A17) — the pure binding function between an approval
 * and ONE exact action.
 *
 * Construction: the action descriptor's full essentials are serialized with
 * the repo's canonical JSON (object keys sorted recursively, array order
 * preserved — that order is semantic for argv) and hashed with sha256. The
 * digest covers, per the ask and docs/SECURITY_MODEL.md 人工审批:
 *
 * - the COMPLETE argv array including argv[0] (order-preserving);
 * - the target repository: canonical root + baseSha + targetSha (nullable);
 * - the working directory (verbatim — normalization happens before grading);
 * - the DERIVED permission-increment set (required minus granted, sorted
 *   unique — set identity, order is not a permission property);
 * - the frozen profile revision the action runs under;
 * - the declared effect dimensions + write scope;
 * - the required capability-gate capability ids.
 *
 * Consequences pinned by tests: changing ANY argv element, permuting argv,
 * changing baseSha/targetSha/repo root/cwd, adding or removing a permission
 * increment, changing the profile revision, the dimensions or the required
 * capabilities — all produce a DIFFERENT digest, so a granted approval can
 * never be consumed for the changed action (A17). The descriptor schema is
 * strict: unknown fields are rejected, not silently ignored into the hash.
 */
import { canonicalJson, sha256Hex } from "@role-orchestrator/runtime-profile";
import {
  ActionDescriptorSchema,
  permissionIncrementsOf,
  type ActionDescriptor
} from "./risk.js";

/** Bumped only when the digest input shape itself changes deliberately. */
export const ACTION_DIGEST_SCHEMA_VERSION = 1;

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * The canonical serialization of one action. Exported for tests and audit
 * display; the digest is always sha256 of exactly this string.
 */
export function canonicalActionDescriptor(action: ActionDescriptor): string {
  const parsed = ActionDescriptorSchema.parse(action);
  return canonicalJson({
    schemaVersion: ACTION_DIGEST_SCHEMA_VERSION,
    runtime: parsed.runtime,
    argv: [...parsed.argv],
    cwd: parsed.cwd,
    repo: {
      root: parsed.repo.root,
      baseSha: parsed.repo.baseSha,
      targetSha: parsed.repo.targetSha
    },
    profileRevision: parsed.profileRevision,
    permissionIncrements: permissionIncrementsOf(parsed),
    dimensions: sortedUnique(parsed.dimensions),
    writeScope: parsed.writeScope,
    requiredCapabilities: sortedUnique(parsed.requiredCapabilities)
  });
}

/** sha256 hex of the canonical action serialization. Pure. */
export function actionDigest(action: ActionDescriptor): string {
  return sha256Hex(canonicalActionDescriptor(action));
}
