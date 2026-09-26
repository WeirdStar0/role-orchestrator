import type { OverrideFieldName } from "@role-orchestrator/contracts";
import { NodeOverrideRejectedError } from "./errors.js";

/**
 * A02 — the no node/task/workflow-level override guard (runtime half).
 *
 * The type half lives in the input schemas: every service input in this
 * package is a `z.strictObject` whose fields never include a model/profile
 * override key, so a typed caller CANNOT pass one and an untyped caller is
 * rejected by the strict parse. This guard is the second, independent layer:
 * it deep-scans raw input (before schema parsing) and produces a typed
 * `NodeOverrideRejectedError` naming every offending path, so even a JSON
 * payload smuggled through an `any`/`unknown` boundary is refused.
 *
 * Scope: this guard is applied to surfaces where profile/model selection is
 * FORBIDDEN (run creation, and node/workflow definitions consumed by later
 * milestones). It is intentionally NOT applied to `setRoleBinding` /
 * `createProfile` / `createProfileRevision` — those are exactly the user-driven
 * surfaces where profile selection is ALLOWED (Project RoleBinding level).
 */

/**
 * Starts from the frozen contract vocabulary (`OverrideFieldName` in
 * contracts/schema/node.ts) and adds the revision-level and alias spellings
 * seen in the wild. Matching is case-insensitive.
 */
export const FORBIDDEN_OVERRIDE_KEYS: readonly string[] = [
  ...([
    "model",
    "modelId",
    "profile",
    "profileId",
    "profiles",
    "fallbackProfileId",
    "fallbackProfileIds"
  ] as const satisfies readonly OverrideFieldName[]),
  "requestedModel",
  "modelOverride",
  "fallbackModel",
  "profileRevision",
  "profileOverride",
  "profileSnapshot",
  "profilesOverride"
] as const;

const FORBIDDEN_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_OVERRIDE_KEYS.map((key) => key.toLowerCase())
);

/** Depth cap: JSON payloads deeper than this are not scanned (documented boundary). */
export const OVERRIDE_SCAN_MAX_DEPTH = 32;

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_SET.has(key.toLowerCase());
}

function collect(
  value: unknown,
  path: string,
  depth: number,
  out: string[],
  seen: Set<object>
): void {
  if (depth > OVERRIDE_SCAN_MAX_DEPTH) {
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collect(item, `${path}[${String(index)}]`, depth + 1, out, seen);
    });
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (isForbiddenKey(key)) {
      out.push(childPath);
    }
    collect(child, childPath, depth + 1, out, seen);
  }
}

/**
 * Deep-scan `candidate` (any JSON-like value) for forbidden override keys and
 * throw `NodeOverrideRejectedError` listing every offending path. Primitives
 * pass; object cycles are handled; scanning stops past the documented depth
 * cap (JSON.from-parse payloads cannot be cyclic; in-memory cyclic graphs are
 * a programming error that schema parsing rejects anyway).
 */
export function assertNoProfileModelOverride(candidate: unknown, context = "input"): void {
  const paths: string[] = [];
  collect(candidate, "$", 0, paths, new Set<object>());
  if (paths.length > 0) {
    throw new NodeOverrideRejectedError(context, paths);
  }
}
