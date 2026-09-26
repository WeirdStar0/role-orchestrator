/**
 * Business outcome evaluation, per docs/CLI_ADAPTERS.md:
 *
 *   成功条件至少为 exitCode=0、最终结果无 error、业务 schema 有效。
 *   不仅检查退出码。
 *
 * The verdict is fail-closed: every unmet condition is reported as an
 * explicit reason, and protocol-level failures (truncation, limit
 * violations, unparseable lines) poison the stream so a broken pipe can
 * never be reported as a successful run.
 */
import { ExecutionResultSchema, type NormalizedEvent } from "@role-orchestrator/contracts";
import type { StreamResult } from "./pipeline.js";

export type OutcomeFailureReason =
  | "nonzero-exit"
  | "protocol-error"
  | "missing-final-result"
  | "final-result-error"
  | "business-schema-invalid";

/** Minimal structural type any Zod schema satisfies. */
export interface BusinessSchema {
  safeParse(data: unknown): { success: boolean };
}

export const executionResultBusinessSchema: BusinessSchema = ExecutionResultSchema;

export interface OutcomeInput {
  /** Exit code from the process wait; null when the process was killed. */
  readonly exitCode: number | null;
  /** Defaults to the frozen ExecutionResult contract schema. */
  readonly businessSchema?: BusinessSchema | undefined;
}

export interface OutcomeVerdict {
  readonly success: boolean;
  /** Deterministic, ordered failure reasons; empty exactly when successful. */
  readonly reasons: readonly OutcomeFailureReason[];
  readonly finalResultEventId: string | null;
}

export function evaluateOutcome(
  stream: Pick<StreamResult, "events" | "protocolErrors">,
  input: OutcomeInput
): OutcomeVerdict {
  const reasons: OutcomeFailureReason[] = [];

  if (input.exitCode === null || input.exitCode !== 0) {
    reasons.push("nonzero-exit");
  }
  if (stream.protocolErrors.length > 0) {
    reasons.push("protocol-error");
  }

  let finalResult: NormalizedEvent | undefined;
  for (const event of stream.events) {
    if (event.type === "result_reported") {
      finalResult = event;
    }
  }

  if (finalResult === undefined) {
    reasons.push("missing-final-result");
  } else {
    if (finalResult.payload["isError"] === true) {
      reasons.push("final-result-error");
    } else {
      // Schema validation applies to a non-error final result. An
      // error-marked result already fails the verdict; its business payload
      // (typically absent on error paths) is not additionally demanded.
      const schema = input.businessSchema ?? executionResultBusinessSchema;
      if (!schema.safeParse(finalResult.payload["businessResult"]).success) {
        reasons.push("business-schema-invalid");
      }
    }
  }

  return {
    success: reasons.length === 0,
    reasons,
    finalResultEventId: finalResult === undefined ? null : finalResult.eventId
  };
}
