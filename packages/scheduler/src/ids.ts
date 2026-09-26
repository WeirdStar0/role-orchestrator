import { createHash } from "node:crypto";
import { IdSchema } from "@role-orchestrator/contracts";

/**
 * Deterministic derived identifiers for scheduler rows.
 *
 * Queue entries, quota grants and dispatch outbox messages are keyed by the
 * natural identity of what they represent (`run + node`, `execution +
 * dimension`, `entry`), hashed into the shared `^[a-z][a-z0-9_-]{0,63}$` id
 * vocabulary. Determinism is what makes re-enqueue and re-dispatch ABSORB
 * duplicates instead of creating second rows: the second insert collides on
 * the PRIMARY KEY and is treated as "already present".
 *
 * A 40-hex-char digest keeps every derived id at 42 characters, safely below
 * the 64-char id bound even when the input ids themselves use the full budget.
 */
export function derivedId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 40);
  // Validation (not cosmetic): a malformed prefix must fail here, at the
  // single construction point, instead of surfacing as a SQLite constraint
  // error far from its cause.
  return IdSchema.parse(`${prefix}-${digest}`);
}
