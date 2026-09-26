import { createHash } from "node:crypto";

/**
 * Hashing + canonical serialization used for config hashes, external-config
 * manifests and snapshot hashes. All hashes are sha256 hex.
 */

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      out[key] = sortValue(val);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted recursively, so the same logical
 * value always hashes to the same digest regardless of insertion order.
 * Accepts validated domain objects (e.g. the contracts `ProfileSnapshot`
 * interface, which structurally is JSON) as well as plain JSON values;
 * anything JSON.stringify cannot represent raises instead of hashing `null`.
 */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortValue(value));
  if (serialized === undefined) {
    throw new Error("canonicalJson: value is not JSON-serializable");
  }
  return serialized;
}
