/**
 * Override-vocabulary injection scan (M7-02) — the decision chain's FIRST step.
 *
 * Threat (A02/A16 by analogy): a plugin manifest that smuggles host control
 * vocabulary — model / Profile / role / permission / budget / approval /
 * argv / env keys, or permission-skip flag text inside any string value — is
 * an attempt to rewrite the authorization surface through DATA. This scan
 * runs on the RAW input BEFORE schema parsing so the refusal names the attack
 * (`override-field`) instead of a generic strictness failure, and so a
 * schema-valid-looking carrier object with a hostile nested key is caught
 * even where a strict object would only say "unknown field".
 *
 * Closed vocabulary, two layers:
 * 1. FORBIDDEN_OVERRIDE_KEYS — object key names (compared lowercase). The
 *    set contains authorization-bearing words ONLY; it is not a heuristic
 *    blocklist of innocent words.
 * 2. Value scan delegates to @role-orchestrator/capability-gate `isBlocked`,
 *    i.e. the SAME blocked argv-pattern registry the M0-06 gate ships
 *    (argv.permission-skip-flags: --dangerously-* / danger-full-access, plus
 *    argv.environment-gate-bypass). If the gate registry grows, the manifest
 *    surface tightens automatically — one source of truth, no drifted copy.
 *
 * Findings are STRUCTURAL: paths are built from matched key names (members
 * of the closed set), array indices, and two sentinels — the value scan
 * reports the fixed path "$<string-value>" without echoing any manifest
 * text, so findings can be logged/audited without leaking hostile content
 * (A42/A36 discipline).
 */
import { isBlocked } from "@role-orchestrator/capability-gate";

/** Authorization-bearing key names that must never appear anywhere in a manifest. */
export const FORBIDDEN_OVERRIDE_KEYS: readonly string[] = Object.freeze([
  // model / profile overrides (A02: schema/API/UI three-layer refusal — this
  // scan is the manifest-surface layer)
  "model",
  "modelid",
  "modeloverride",
  "model_override",
  "profiles",
  "profile",
  "profileid",
  "profilerevision",
  "profileoverride",
  "profile_override",
  // role/binding overrides (A01: single-select binding is not re-decidable by data)
  "role",
  "roles",
  "roleid",
  // permission grants (effective permission is an intersection, never a grant from data)
  "permission",
  "permissions",
  "requiredpermissions",
  "grantedpermissions",
  "capabilitytags",
  // budget/quota (A35: plugins cannot resize their own metering)
  "budget",
  "budgets",
  "quota",
  "quotas",
  "maxexecutions",
  "maxnodesperrun",
  // approval control plane (approval refs are method arguments, never manifest data)
  "approval",
  "approvals",
  "actiondigest",
  // prompt/env/process surfaces (instruction text is not authorization (A16);
  // env/argv are the classic override channels)
  "systemprompt",
  "ignorepolicy",
  "skipermissions",
  "dangerouslyskipermissions",
  "extraargs",
  "args",
  "argv",
  "env",
  "envfile",
  // unmanaged extension loading surfaces (capability-gate: implicit loading
  // requires explicit-management; a plugin must not ship more of itself)
  "hooks",
  "mcp",
  "mcpserver",
  "mcpservers",
  "plugins",
  "subagents"
]);

const MAX_SCAN_DEPTH = 8;

export interface InjectionScanResult {
  readonly detected: boolean;
  /** Structural paths (closed vocabulary + sentinels), e.g. "$.scopes[0].model". */
  readonly paths: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(value: unknown, path: string, depth: number, seen: WeakSet<object>, out: string[]): void {
  if (out.length >= 16) return; // report enough to act on; never unbounded
  if (depth > MAX_SCAN_DEPTH) {
    out.push("$<depth-limit-exceeded>");
    return;
  }
  if (typeof value === "string") {
    // Delegate to the capability-gate blocked argv registry (no drifted copy).
    if (isBlocked(value)) out.push("$<string-value>");
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) {
    out.push("$<cycle>");
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walk(item, `${path}[${index}]`, depth + 1, seen, out);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_OVERRIDE_KEYS.includes(key.toLowerCase())) {
        out.push(`${path}.${key}`);
      }
      walk(item, `${path}.${key}`, depth + 1, seen, out);
    }
  }
}

/**
 * Scan a raw (pre-schema) manifest value for override vocabulary.
 * Pure, hermetic, cycle-safe, depth-bounded. `detected` is true when any
 * forbidden key or blocked flag-shaped string value is found — and when the
 * structure exceeds the scan depth (fail closed: an unscannable manifest is
 * not a loadable manifest).
 */
export function scanForOverrideInjection(value: unknown): InjectionScanResult {
  const paths: string[] = [];
  walk(value, "$", 0, new WeakSet(), paths);
  return { detected: paths.length > 0, paths };
}
