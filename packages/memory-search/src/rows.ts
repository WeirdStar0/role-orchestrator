/**
 * Row mapping for retrieval hits (M3-03) — extends the M3-02 read
 * discipline to the source/staleness columns: every read recomputes the
 * content hash (a tampered `content` column never maps cleanly), every
 * field goes through narrowing/schema parsing, and the stale mark must be
 * PAIRED (stale_since ⇔ stale_reason) or the row is refused as unreadable.
 */
import { z } from "zod";
import type { Row } from "@role-orchestrator/store";
import { optStr, reqInt, reqStr, TimestampSchema } from "@role-orchestrator/store";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import {
  MemoryIntegrityError,
  memoryContentHash
} from "@role-orchestrator/memory";
import {
  CommitShaSchema,
  StaleReasonSchema,
  type MemorySearchHit
} from "./types.js";

const EvidenceRefsSchema = z.array(IdSchema).max(32);

/**
 * Map one `memories` row (migrations 001..010 shape) into a retrieval hit.
 * `row` must carry the staleness columns added by migration 009.
 */
export function mapMemoryHitRow(row: Row): MemorySearchHit {
  const id = reqStr(row, "id");
  const content = reqStr(row, "content");
  const contentHash = reqStr(row, "content_hash");
  if (memoryContentHash(content) !== contentHash) {
    throw new MemoryIntegrityError({
      memoryId: id,
      kind: "content-hash",
      detail: "stored content does not hash to the recorded content_hash"
    });
  }
  let evidenceRefs: readonly string[];
  try {
    const parsed: unknown = JSON.parse(reqStr(row, "evidence_refs"));
    evidenceRefs = EvidenceRefsSchema.parse(parsed);
  } catch (error) {
    throw new MemoryIntegrityError({
      memoryId: id,
      kind: "content-hash",
      detail: `evidence_refs column is not a valid refs array (${error instanceof Error ? error.message : String(error)})`
    });
  }
  const sourceShaRaw = optStr(row, "source_sha");
  const sourceSha = sourceShaRaw === null ? null : CommitShaSchema.parse(sourceShaRaw);
  const staleSince = optStr(row, "stale_since");
  const staleReasonRaw = optStr(row, "stale_reason");
  const staleReason = staleReasonRaw === null ? null : StaleReasonSchema.parse(staleReasonRaw);
  if ((staleSince === null) !== (staleReason === null)) {
    throw new MemoryIntegrityError({
      memoryId: id,
      kind: "content-hash",
      detail: `unpaired stale mark (stale_since=${String(staleSince)}, stale_reason=${String(staleReason)})`
    });
  }
  const supersedesVersion = optInt(row, "supersedes_version");
  return {
    id,
    projectId: IdSchema.parse(reqStr(row, "project_id")),
    scope: "project",
    type: memoryTypeOf(reqStr(row, "type")),
    status: memoryStatusOf(reqStr(row, "status")),
    version: reqInt(row, "version"),
    content,
    contentHash,
    evidenceRefs,
    authorExecutionId: optStr(row, "author_execution_id"),
    proposedBy: reqStr(row, "proposed_by"),
    proposedByRole: RoleIdSchema.parse(reqStr(row, "proposed_by_role")),
    expiresAt: optStr(row, "expires_at"),
    verifiedBy: optStr(row, "verified_by"),
    verifiedAt: optStr(row, "verified_at"),
    disputedBy: optStr(row, "disputed_by"),
    disputedAt: optStr(row, "disputed_at"),
    promotedBy: optStr(row, "promoted_by"),
    promotedVia: optStr(row, "promoted_via"),
    promotedAt: optStr(row, "promoted_at"),
    supersedesVersion,
    createdAt: TimestampSchema.parse(reqStr(row, "created_at")),
    updatedAt: TimestampSchema.parse(reqStr(row, "updated_at")),
    sourceSha,
    stale: staleSince !== null,
    staleSince,
    staleReason
  };
}

function memoryTypeOf(raw: string): MemorySearchHit["type"] {
  const parsed = z.enum(["temporary", "fact", "discovery", "decision", "project_rule"]).safeParse(raw);
  if (!parsed.success) {
    throw new MemoryIntegrityError({
      memoryId: "(row)",
      kind: "content-hash",
      detail: `unknown memory type "${raw}"`
    });
  }
  return parsed.data;
}

function memoryStatusOf(raw: string): MemorySearchHit["status"] {
  const parsed = z
    .enum(["proposed", "verified", "active", "disputed", "superseded", "expired"])
    .safeParse(raw);
  if (!parsed.success) {
    throw new MemoryIntegrityError({
      memoryId: "(row)",
      kind: "content-hash",
      detail: `unknown memory status "${raw}"`
    });
  }
  return parsed.data;
}

function optInt(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  return reqInt(row, column);
}
