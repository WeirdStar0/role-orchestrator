/**
 * Read paths for shared memory (M3-02).
 *
 * Project scoping is structural: every query REQUIRES the project id and
 * filters on it, so a memory from another project is indistinguishable from
 * an unknown id (A15 data-plane baseline — M3-03 adds the authorization layer
 * on top; the data layer never offers an unscoped scan).
 *
 * Integrity: every read recomputes the content hash — a tampered `content`
 * column never maps cleanly (throws `MemoryIntegrityError` instead of serving
 * doctored memory as "what happened").
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Row } from "@role-orchestrator/store";
import { optStr, reqInt, reqStr, TimestampSchema } from "@role-orchestrator/store";
import { IdSchema } from "@role-orchestrator/contracts";
import {
  MemoryIntegrityError,
  MemoryNotVerifiedError,
  UnknownMemoryError
} from "./errors.js";
import { memoryContentHash } from "./hashing.js";
import {
  IdSchema as MemoryIdSchema,
  MemoryEventTypeSchema,
  MemoryStatusSchema,
  MemoryTransitionSchema,
  MemoryTypeSchema,
  type MemoryEventRecord,
  type MemoryEventType,
  type MemoryRecord,
  type MemoryRevisionRecord,
  type MemoryStatus,
  type MemoryType
} from "./types.js";

const EventPayloadSchema = z.record(z.string(), z.union([z.string(), z.number()]));

function optInt(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  return reqInt(row, column);
}

function mapMemoryRow(row: Row): MemoryRecord {
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
    const result = z.array(IdSchema).max(32).parse(parsed);
    evidenceRefs = result;
  } catch (error) {
    throw new MemoryIntegrityError({
      memoryId: id,
      kind: "content-hash",
      detail: `evidence_refs column is not a valid refs array (${error instanceof Error ? error.message : String(error)})`
    });
  }
  const supersedesVersion = optInt(row, "supersedes_version");
  const proposedByRole = MemoryIdSchema.parse(reqStr(row, "proposed_by_role"));
  return {
    id,
    projectId: IdSchema.parse(reqStr(row, "project_id")),
    scope: "project",
    type: MemoryTypeSchema.parse(reqStr(row, "type")),
    status: MemoryStatusSchema.parse(reqStr(row, "status")),
    version: reqInt(row, "version"),
    content,
    contentHash,
    evidenceRefs,
    authorExecutionId: optStr(row, "author_execution_id"),
    proposedBy: reqStr(row, "proposed_by"),
    proposedByRole: proposedByRole as MemoryRecord["proposedByRole"],
    expiresAt: optStr(row, "expires_at"),
    verifiedBy: optStr(row, "verified_by"),
    verifiedAt: optStr(row, "verified_at"),
    disputedBy: optStr(row, "disputed_by"),
    disputedAt: optStr(row, "disputed_at"),
    promotedBy: optStr(row, "promoted_by"),
    promotedVia: optStr(row, "promoted_via"),
    promotedAt: optStr(row, "promoted_at"),
    supersedesVersion: supersedesVersion === null ? null : reqInt(row, "supersedes_version"),
    createdAt: TimestampSchema.parse(reqStr(row, "created_at")),
    updatedAt: TimestampSchema.parse(reqStr(row, "updated_at"))
  };
}

/** Raw fetch used by the write paths: scoped lookup, integrity-checked. */
export function findMemoryRow(
  db: DatabaseSync,
  projectId: string,
  memoryId: string
): MemoryRecord | null {
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ? AND project_id = ?")
    .get(memoryId, projectId) as Row | undefined;
  return row === undefined ? null : mapMemoryRow(row);
}

/** Scoped fetch that refuses to stay silent: unknown-or-foreign id throws. */
export function requireMemory(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly memoryId: string }
): MemoryRecord {
  const projectId = IdSchema.parse(input.projectId);
  const memoryId = MemoryIdSchema.parse(input.memoryId);
  const record = findMemoryRow(db, projectId, memoryId);
  if (record === null) {
    throw new UnknownMemoryError({ projectId, memoryId });
  }
  return record;
}

/** Read one memory (project-scoped, hash-verified). Foreign ids read as null. */
export function getMemory(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly memoryId: string }
): MemoryRecord | null {
  const projectId = IdSchema.parse(input.projectId);
  const memoryId = MemoryIdSchema.parse(input.memoryId);
  return findMemoryRow(db, projectId, memoryId);
}

export interface ListMemoriesInput {
  readonly projectId: string;
  readonly type?: MemoryType;
  readonly status?: MemoryStatus;
}

/** List a project's memories, oldest first; optional type/status filters. */
export function listMemories(db: DatabaseSync, input: ListMemoriesInput): readonly MemoryRecord[] {
  const projectId = IdSchema.parse(input.projectId);
  const type = input.type === undefined ? null : MemoryTypeSchema.parse(input.type);
  const status = input.status === undefined ? null : MemoryStatusSchema.parse(input.status);
  const rows = db
    .prepare("SELECT * FROM memories WHERE project_id = ? ORDER BY created_at ASC, id ASC")
    .all(projectId) as Row[];
  return rows
    .map(mapMemoryRow)
    .filter(
      (record) =>
        (type === null || record.type === type) && (status === null || record.status === status)
    );
}

/** The project's ACTIVE project rules — the set a context bundle may inject. */
export function listActiveProjectRules(
  db: DatabaseSync,
  input: { readonly projectId: string }
): readonly MemoryRecord[] {
  return listMemories(db, { projectId: input.projectId, type: "project_rule", status: "active" });
}

/**
 * Cite a memory where only verified/active is acceptable. A disputed memory
 * is NEVER referable as verified — this is the check that pins it (M3-02
 * 完成标准: disputed 不能被引用为已验证).
 */
export function requireVerifiedMemory(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly memoryId: string }
): MemoryRecord {
  const record = requireMemory(db, input);
  if (record.status !== "verified" && record.status !== "active") {
    throw new MemoryNotVerifiedError({ memoryId: record.id, status: record.status });
  }
  return record;
}

function mapRevisionRow(row: Row): MemoryRevisionRecord {
  const memoryId = reqStr(row, "memory_id");
  const content = reqStr(row, "content");
  const contentHash = reqStr(row, "content_hash");
  if (memoryContentHash(content) !== contentHash) {
    throw new MemoryIntegrityError({
      memoryId,
      kind: "revision-hash",
      detail: `revision ${String(reqInt(row, "version"))} content does not hash to its recorded content_hash`
    });
  }
  return {
    memoryId,
    version: reqInt(row, "version"),
    status: MemoryStatusSchema.parse(reqStr(row, "status")),
    content,
    contentHash,
    transition: MemoryTransitionSchema.parse(reqStr(row, "transition")),
    actor: reqStr(row, "actor"),
    occurredAt: TimestampSchema.parse(reqStr(row, "occurred_at"))
  };
}

/** Append-only revision history of one memory, oldest (v1) first. */
export function listMemoryRevisions(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly memoryId: string }
): readonly MemoryRevisionRecord[] {
  const projectId = IdSchema.parse(input.projectId);
  const memoryId = MemoryIdSchema.parse(input.memoryId);
  // The scope check doubles as the existence check: a foreign memory id must
  // not reveal even its (empty) history.
  requireMemory(db, { projectId, memoryId });
  const rows = db
    .prepare("SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY version ASC")
    .all(memoryId) as Row[];
  return rows.map(mapRevisionRow);
}

function mapEventRow(row: Row): MemoryEventRecord {
  let payload: Record<string, string | number>;
  try {
    const parsed: unknown = JSON.parse(reqStr(row, "payload"));
    payload = EventPayloadSchema.parse(parsed);
  } catch (error) {
    throw new MemoryIntegrityError({
      memoryId: reqStr(row, "memory_id"),
      kind: "content-hash",
      detail: `audit event payload is not a valid object (${error instanceof Error ? error.message : String(error)})`
    });
  }
  return {
    id: reqStr(row, "id"),
    memoryId: reqStr(row, "memory_id"),
    projectId: IdSchema.parse(reqStr(row, "project_id")),
    seq: reqInt(row, "seq"),
    type: MemoryEventTypeSchema.parse(reqStr(row, "type")),
    actor: reqStr(row, "actor"),
    payload,
    occurredAt: TimestampSchema.parse(reqStr(row, "occurred_at"))
  };
}

/** Audit trail of one memory, oldest first; optional event-type filter. */
export function listMemoryEvents(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly memoryId: string; readonly type?: MemoryEventType }
): readonly MemoryEventRecord[] {
  const projectId = IdSchema.parse(input.projectId);
  const memoryId = MemoryIdSchema.parse(input.memoryId);
  const type = input.type === undefined ? null : MemoryEventTypeSchema.parse(input.type);
  requireMemory(db, { projectId, memoryId });
  const rows = db
    .prepare("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY seq ASC")
    .all(memoryId) as Row[];
  return rows
    .map(mapEventRow)
    .filter((event) => type === null || event.type === type);
}

export interface VerifyMemoryIntegrityResult {
  readonly ok: true;
  readonly memoryId: string;
  readonly contentHash: string;
  readonly version: number;
  readonly checkedRevisions: number;
}

/**
 * Full integrity check of one stored memory:
 * - the current content hashes to content_hash (implied by the read);
 * - the revision history is a contiguous 1..version chain;
 * - every revision's content hashes to its own content_hash;
 * - the tip revision (version === current) equals the current row's content
 *   and status — history and current state cannot disagree silently.
 */
export function verifyMemoryIntegrity(
  db: DatabaseSync,
  input: { readonly projectId: string; readonly memoryId: string }
): VerifyMemoryIntegrityResult {
  const record = requireMemory(db, input);
  const revisions = listMemoryRevisions(db, input);
  if (revisions.length !== record.version) {
    throw new MemoryIntegrityError({
      memoryId: record.id,
      kind: "revision-chain",
      detail: `expected ${String(record.version)} revisions (contiguous 1..version), found ${String(revisions.length)}`
    });
  }
  revisions.forEach((revision, index) => {
    if (revision.version !== index + 1) {
      throw new MemoryIntegrityError({
        memoryId: record.id,
        kind: "revision-chain",
        detail: `revision chain is not contiguous at position ${String(index)} (found version ${String(revision.version)})`
      });
    }
  });
  const tip = revisions[revisions.length - 1];
  if (tip === undefined || tip.version !== record.version) {
    throw new MemoryIntegrityError({
      memoryId: record.id,
      kind: "revision-chain",
      detail: "no revision matches the current version"
    });
  }
  if (tip.content !== record.content || tip.status !== record.status) {
    throw new MemoryIntegrityError({
      memoryId: record.id,
      kind: "revision-chain",
      detail: "tip revision contradicts the current row (content or status drifted)"
    });
  }
  return {
    ok: true,
    memoryId: record.id,
    contentHash: record.contentHash,
    version: record.version,
    checkedRevisions: revisions.length
  };
}
