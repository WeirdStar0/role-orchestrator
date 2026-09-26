import { z } from "zod";
import type { JsonValue } from "@role-orchestrator/contracts";

/**
 * Strict recursive JSON validation. The `JsonValue` type is reused from
 * `@role-orchestrator/contracts` (not redefined here); the schema gives it a
 * runtime body. Payloads stored in `events` and `outbox` must be JSON
 * *objects* — arrays, scalars and anything non-JSON are rejected at the
 * boundary, mirroring the "unknown fields rejected by default" rule.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

export type JsonRecord = Record<string, JsonValue>;

export const JsonRecordSchema = z.record(z.string(), JsonValueSchema);

/**
 * Canonical serialization: the value is parsed+revalidated, then serialized
 * once; the stored string is exactly what checksums are computed over.
 */
export function serializeJsonRecord(payload: JsonRecord): string {
  return JSON.stringify(payload);
}

export function parseJsonRecord(text: string, context: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`stored payload in ${context} is not valid JSON`, { cause: error });
  }
  const result = JsonRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`stored payload in ${context} is not a JSON object`, {
      cause: result.error
    });
  }
  return result.data;
}
