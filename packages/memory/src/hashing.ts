/**
 * Content addressing for memory entries: sha256 over the exact stored string.
 * The same hash is written at propose/update time, recomputed on every read,
 * and used as the current-content digest inside CAS conflict errors — one
 * definition, so tampering can never pass unnoticed (M3-02 content_hash
 * completeness).
 */
import { createHash } from "node:crypto";

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
