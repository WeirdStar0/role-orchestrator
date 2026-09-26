/**
 * @role-orchestrator/capability-gate — M0-06 typed registry + query functions.
 *
 * Data for M1 consumption. This package intentionally contains NO runtime
 * interceptor: consumers (execution layer, adapters, planners) call these
 * pure functions and are responsible for acting on the answers.
 *
 * Fail-closed posture (docs/SECURITY_MODEL.md: Unknown 能力不视作允许):
 * - isBlocked / blockedPatternFor: argv-shaped dangerous patterns.
 * - checkAssumption: blocked implementation claims; UNKNOWN ids are denied by
 *   default, never treated as approved.
 * - statusOf: capability lookup; UNKNOWN capability ids report
 *   status "unverified" (known:false), which isUsable rejects.
 * - isUsable: true only for "verified" — 能力未知绝不标记支持.
 */
import {
  BLOCKED_ARGV_PATTERNS,
  BLOCKED_ASSUMPTIONS,
  CAPABILITY_RECORDS
} from "./registry.js";
import type {
  BlockedArgvPattern,
  CapabilityStatus,
  CapabilityStatusRecord,
  GateCliId,
  RequiredControl
} from "./schema.js";

export {
  BLOCKED_ARGV_PATTERNS,
  BLOCKED_ASSUMPTIONS,
  CAPABILITY_RECORDS
} from "./registry.js";
export {
  CAPABILITY_STATUSES,
  CapabilityStatusSchema,
  GATE_CLI_IDS,
  GateCliIdSchema,
  GateIdSchema,
  REQUIRED_CONTROLS,
  RequiredControlSchema,
  BlockedArgvPatternSchema,
  BlockedAssumptionSchema,
  CapabilityStatusRecordSchema
} from "./schema.js";
export type {
  BlockedArgvPattern,
  BlockedAssumption,
  CapabilityStatus,
  CapabilityStatusRecord,
  GateCliId,
  GateId,
  RequiredControl
} from "./schema.js";

const COMPILED_ARGV_PATTERNS: readonly { readonly entry: BlockedArgvPattern; readonly regex: RegExp }[] =
  BLOCKED_ARGV_PATTERNS.map((entry) => ({
    entry,
    regex: new RegExp(entry.patternSource, "i")
  }));

/**
 * True when the given argv text (a single argument token or a joined argv
 * string) matches a blocked dangerous pattern. Case-insensitive.
 */
export function isBlocked(argvText: string): boolean {
  return blockedPatternFor(argvText) !== null;
}

/** The blocked pattern matching the given argv text, or null. */
export function blockedPatternFor(argvText: string): BlockedArgvPattern | null {
  for (const { entry, regex } of COMPILED_ARGV_PATTERNS) {
    if (regex.test(argvText)) {
      return entry;
    }
  }
  return null;
}

/** Decision for an assumption/claim id. Fail-closed: unknown ids are denied too. */
export interface AssumptionDecision {
  readonly id: string;
  /** True when the id exists in the blocked-assumption registry. */
  readonly listed: boolean;
  /** Always true in v1: listed claims are blocked, unknown ids denied by default. */
  readonly blocked: boolean;
  readonly requiredControl: RequiredControl;
  readonly reason: string;
}

const ASSUMPTIONS_BY_ID: ReadonlyMap<string, (typeof BLOCKED_ASSUMPTIONS)[number]> = new Map(
  BLOCKED_ASSUMPTIONS.map((entry) => [entry.id, entry])
);

/**
 * Check an implementation claim/assumption id against the blocked registry.
 * Unknown ids are reported blocked with requiredControl "unknown-deny" — an
 * id absent from an allowlist is never treated as approved.
 */
export function checkAssumption(assumptionId: string): AssumptionDecision {
  const entry = ASSUMPTIONS_BY_ID.get(assumptionId);
  if (entry) {
    return {
      id: entry.id,
      listed: true,
      blocked: true,
      requiredControl: entry.requiredControl,
      reason: entry.title
    };
  }
  return {
    id: assumptionId,
    listed: false,
    blocked: true,
    requiredControl: "unknown-deny",
    reason:
      "unknown assumption id — denied by default (docs/SECURITY_MODEL.md: Unknown 能力不视作允许)"
  };
}

/** Result of a capability lookup, including the unknown-capability denial. */
export interface CapabilityLookup {
  readonly capability: string;
  /** False when the id is not in the registry (fail-closed denial below). */
  readonly known: boolean;
  /** Registry CLI for known ids; null for unknown ids. */
  readonly cli: GateCliId | null;
  readonly status: CapabilityStatus;
  readonly summary: string;
  readonly evidence: readonly string[];
}

const RECORDS_BY_CAPABILITY: ReadonlyMap<string, CapabilityStatusRecord> = new Map(
  CAPABILITY_RECORDS.map((record) => [record.capability, record])
);

/**
 * Look up a capability-matrix cell. Unknown capability ids return
 * status "unverified" (known:false) — never "verified", never "allowed".
 */
export function statusOf(capability: string): CapabilityLookup {
  const record = RECORDS_BY_CAPABILITY.get(capability);
  if (record) {
    return {
      capability: record.capability,
      known: true,
      cli: record.cli,
      status: record.status,
      summary: record.summary,
      evidence: record.evidence
    };
  }
  return {
    capability,
    known: false,
    cli: null,
    status: "unverified",
    summary:
      "unknown capability id — denied by default; add a matrix cell with real evidence before treating this as usable",
    evidence: ["docs/SECURITY_MODEL.md 授权规则: Unknown 能力不视作允许"]
  };
}

/** Only verified capabilities are usable; unverified/unknown/blocked are not. */
export function isUsable(status: CapabilityStatus): boolean {
  return status === "verified";
}
