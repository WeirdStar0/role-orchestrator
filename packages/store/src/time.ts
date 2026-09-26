import { z } from "zod";

/**
 * Timestamps are stored as TEXT and compared lexicographically, so every
 * timestamp must use exactly the fixed-width UTC form produced by
 * `Date.prototype.toISOString()` (e.g. `2026-09-22T00:00:00.000Z`).
 * Any other ISO variant is rejected: mixed widths would order incorrectly
 * as strings and silently corrupt lease-expiry and outbox-due comparisons.
 */
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const TimestampSchema = z.string().regex(ISO_UTC_PATTERN, {
  message: "timestamp must be a fixed-width UTC ISO string as produced by Date.prototype.toISOString()"
});
