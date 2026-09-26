import { createHash } from "node:crypto";
import { IdSchema } from "@role-orchestrator/contracts";

/**
 * Deterministic derived identifiers for budget-domain rows.
 *
 * Holds are keyed by the natural identity of what they record
 * (`run + reason`), hashed into the shared `^[a-z][a-z0-9_-]{0,63}$` id
 * vocabulary. Determinism is what makes a repeated pause ABSORB into the
 * same hold row instead of minting a second one (the same pattern as the
 * scheduler's derived queue ids and expand's hold ids).
 */
export function derivedBudgetId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 40);
  return IdSchema.parse(`${prefix}-${digest}`);
}
