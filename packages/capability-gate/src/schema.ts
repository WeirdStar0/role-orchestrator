import { z } from "zod";

/**
 * Status vocabulary for every capability-matrix cell (M0-06).
 *
 * - `verified`    : proven by real executed commands/fixtures recorded in an
 *                   accepted M0 report.
 * - `unsupported` : proven absent (kept for completeness; no M0 cell earned it,
 *                   absence windows are bounded and never claimed universal).
 * - `unverified`  : no real evidence, or evidence covers only part of the
 *                   dimension. Unknown is denied by default
 *                   (docs/SECURITY_MODEL.md: Unknown 能力不视作允许).
 * - `blocked`     : the usage mode itself is dangerous and must not be enabled
 *                   (e.g. unattended writes without a node checkpoint).
 *
 * 能力未知绝不标记支持: anything that is not `verified` is NOT usable.
 */
export const CAPABILITY_STATUSES = [
  "verified",
  "unsupported",
  "unverified",
  "blocked"
] as const;
export const CapabilityStatusSchema = z.enum(CAPABILITY_STATUSES);
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** The two bundled CLI runtimes measured in M0 (mirrors contracts RuntimeSchema). */
export const GATE_CLI_IDS = ["claude", "codex"] as const;
export const GateCliIdSchema = z.enum(GATE_CLI_IDS);
export type GateCliId = (typeof GATE_CLI_IDS)[number];

/** Identifier for registry entries and capability rows. */
export const GateIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/);
export type GateId = z.infer<typeof GateIdSchema>;

/**
 * The control a consumer must apply instead of the blocked pattern/assumption.
 * These are names for design requirements consumed by M1; this package holds
 * data only and enforces nothing at runtime.
 */
export const REQUIRED_CONTROLS = [
  /** Never use, no authorization path exists in v1. */
  "forbidden",
  /** Only with an explicit, recorded user authorization for one action. */
  "explicit-authorization",
  /** CLI ends / safely stops, then a new authorized Execution continues. */
  "node-checkpoint",
  /** Inventory + hash + explicit trust/disable before execution. */
  "explicit-management",
  /** Requires a `verified` capability status (see statusOf/isUsable). */
  "verified-only",
  /** exitCode=0 + no error + valid business schema + required evidence. */
  "full-success-conditions",
  /** (pid, name, parentPid, creationTime) identity plus tree termination. */
  "identity-and-tree-kill",
  /** Windows and WSL process semantics are defined separately, never mixed. */
  "per-target-semantics",
  /** Unknown ids are denied by default (fail-closed). */
  "unknown-deny"
] as const;
export const RequiredControlSchema = z.enum(REQUIRED_CONTROLS);
export type RequiredControl = (typeof REQUIRED_CONTROLS)[number];

/** An argv-shaped dangerous pattern that must never reach a CLI spawn. */
export const BlockedArgvPatternSchema = z.strictObject({
  id: GateIdSchema,
  /** RegExp source; compiled with the "i" flag by the registry. */
  patternSource: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  requiredControl: RequiredControlSchema,
  /** Each entry cites accepted M0 reports/fixtures or frozen docs. */
  evidence: z.array(z.string().min(1)).min(1)
});
export type BlockedArgvPattern = z.infer<typeof BlockedArgvPatternSchema>;

/**
 * An implementation claim/assumption that is forbidden to encode because the
 * real CLI behavior contradicts it (verified) or provides no basis for it.
 */
export const BlockedAssumptionSchema = z.strictObject({
  id: GateIdSchema,
  /** The exact claim an implementation must not make. */
  claim: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  requiredControl: RequiredControlSchema,
  evidence: z.array(z.string().min(1)).min(1)
});
export type BlockedAssumption = z.infer<typeof BlockedAssumptionSchema>;

/** One capability-matrix cell (CLI x dimension) with its evidence trail. */
export const CapabilityStatusRecordSchema = z.strictObject({
  capability: GateIdSchema,
  cli: GateCliIdSchema,
  status: CapabilityStatusSchema,
  /** One-line human summary; the reports carry the full detail. */
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1)
});
export type CapabilityStatusRecord = z.infer<typeof CapabilityStatusRecordSchema>;
