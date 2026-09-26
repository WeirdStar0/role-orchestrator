/**
 * Typed error taxonomy for @role-orchestrator/plugin-registry (M7-02).
 *
 * Invariants (same discipline as scm-contracts/errors.ts):
 * - No manifest content (name/description/free text) is ever embedded in an
 *   error message. Errors carry structural facts only (ids, digests, zod issue
 *   paths + codes) because error text is the easiest accidental exfiltration
 *   channel (A42) and an injection vector when logged raw (A36).
 * - EXPECTED load refusals are NOT errors: they are values of the
 *   PluginLoadDecision union (./decision.js) so a host cannot confuse "the
 *   plugin was refused" with "the registry itself broke". Errors here mean the
 *   HOST miswired the decision input — a programming/configuration fault.
 */
import { z } from "zod";

export class PluginRegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginRegistryError";
  }
}

/**
 * The host supplied a malformed DECISION INPUT (not a malformed manifest —
 * that is an ordinary `schema-invalid` rejection value). Examples: an
 * artifactSha256 that is not 64 lowercase hex chars, an inventory record
 * whose "verified" tier lacks the required digest pin, an unknown field on
 * the input container itself. Fail-closed: the registry refuses to guess.
 */
export class PluginDecisionInputError extends PluginRegistryError {
  /** Structural issue summaries only: zod path + code, never received values. */
  readonly issues: readonly string[];

  constructor(error: z.ZodError) {
    super(
      `plugin-registry decision input failed its schema (${error.issues.length} issue[s]); ` +
        "refusing to evaluate with a mis-wired input",
      { cause: error.issues.map((issue) => ({ path: issue.path, code: issue.code })) }
    );
    this.name = "PluginDecisionInputError";
    this.issues = error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`);
  }
}
