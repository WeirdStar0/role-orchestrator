/**
 * The A15 authorization layer (M3-03).
 *
 * `openMemoryAccess(db, { projectId })` binds ONE authorized project; every
 * retrieval, read and write entry point lives on that session. Enforcement
 * is at the QUERY layer, not result filtering:
 *  - retrieval/listing SQL always carries `WHERE project_id = <authorized>`,
 *    so another project's rows are structurally invisible — they cannot be
 *    expressed, let alone returned;
 *  - direct id reads/updates run a scoped query first; when the id exists
 *    under a DIFFERENT project, the typed `CrossProjectAccessError` is
 *    thrown and NOTHING of the foreign row (owner project, content, hash)
 *    is disclosed. The existence probe selects no columns at all.
 *
 * The session refuses to open for a project with no store row, so a typo'd
 * project id fails closed instead of silently authorizing an empty scope.
 *
 * Scope note (honest boundary): this layer enforces PROJECT scoping of the
 * memory data plane. Actor/role permission checks remain where M3-02 put
 * them (the frozen 可提交者 matrix inside the memory write paths); nothing
 * here — and nothing in memory content (A16) — widens them.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Row } from "@role-orchestrator/store";
import { reqStr, withTransaction, TimestampSchema } from "@role-orchestrator/store";
import { IdSchema } from "@role-orchestrator/contracts";
import type {
  MemoryEventRecord,
  MemoryRecord,
  MemoryRevisionRecord
} from "@role-orchestrator/memory";
import {
  MemoryActorSchema,
  MemoryCasConflictError,
  MemoryEventTypeSchema,
  MemoryLifecycleError,
  MemoryNotVerifiedError,
  MemoryTypeSchema,
  MemoryStatusSchema,
  UnknownMemoryError,
  UnknownMemoryProjectError,
  ExpectedVersionSchema,
  listMemoryEvents,
  listMemoryRevisions,
  memoryContentHash,
  updateMemory
} from "@role-orchestrator/memory";
import { CommitShaSchema } from "@role-orchestrator/integration";
import {
  CrossProjectAccessError,
  MemorySourceAttachConflictError,
  MemorySourceResolverError
} from "./errors.js";
import { mapMemoryHitRow } from "./rows.js";
import { likePattern, tokenizeSearchQuery } from "./tokenize.js";
import {
  DEFAULT_SEARCH_STATUSES,
  MAX_QUERY_LENGTH,
  SourceShaObservationSchema,
  type MemorySearchHit,
  type MemorySourceCheckResult,
  type MemorySourceCheckRun,
  type MemorySourceStatus,
  type SourceShaObservation,
  type SourceShaResolver,
  type StaleReason
} from "./types.js";

const OpenMemoryAccessInputSchema = z.strictObject({ projectId: IdSchema });

const MemoryIdInputSchema = z.strictObject({ memoryId: IdSchema });

const ListMemoriesInputSchema = z
  .strictObject({
    type: MemoryTypeSchema.optional(),
    status: MemoryStatusSchema.optional()
  })
  .default({});

const SearchMemoriesInputSchema = z.strictObject({
  query: z.string().max(MAX_QUERY_LENGTH),
  types: z.array(MemoryTypeSchema).min(1).max(5).optional(),
  /** Defaults to verified+active (docs section 5); override is explicit. */
  statuses: z.array(MemoryStatusSchema).min(1).max(6).optional()
});

const UpdateMemoryAccessInputSchema = z.strictObject({
  memoryId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  actor: MemoryActorSchema,
  content: z.string().min(1).max(10000).optional(),
  evidenceRefs: z.array(IdSchema).max(32).optional(),
  now: TimestampSchema
});

export type UpdateMemoryAccessInput = z.input<typeof UpdateMemoryAccessInputSchema>;

const AttachSourceInputSchema = z.strictObject({
  memoryId: IdSchema,
  expectedVersion: ExpectedVersionSchema,
  sourceSha: CommitShaSchema,
  now: TimestampSchema
});

export type AttachSourceInput = z.input<typeof AttachSourceInputSchema>;

const CheckSourcesInputSchema = z.strictObject({
  now: TimestampSchema,
  resolve: z.custom<SourceShaResolver>((value) => typeof value === "function")
});

export type CheckSourcesInput = z.input<typeof CheckSourcesInputSchema>;

const ListEventsInputSchema = z.strictObject({
  memoryId: IdSchema,
  type: MemoryEventTypeSchema.optional()
});

export type ListEventsInput = z.input<typeof ListEventsInputSchema>;

/** The persisted check outcome vocabulary (memory_source_checks.outcome). */
export type SourceCheckOutcome = "current" | "missing" | "superseded";

/**
 * ONE authorized memory session. Obtain via `openMemoryAccess`; every
 * method enforces the bound project at the query layer (A15).
 */
export class MemoryAccess {
  /** The authorized project — the whole scope this session can ever see. */
  readonly projectId: string;

  private constructor(
    private readonly db: DatabaseSync,
    projectId: string
  ) {
    this.projectId = projectId;
  }

  /** Validate + bind. Unknown project -> `UnknownMemoryProjectError`. */
  static open(db: DatabaseSync, input: { readonly projectId: string }): MemoryAccess {
    const value = OpenMemoryAccessInputSchema.parse(input);
    const row = db.prepare("SELECT 1 AS present FROM projects WHERE id = ?").get(value.projectId);
    if (row === undefined) {
      throw new UnknownMemoryProjectError(value.projectId);
    }
    return new MemoryAccess(db, value.projectId);
  }

  // -- direct id reads ---------------------------------------------------

  /** Get one memory (scoped + hash-verified). Foreign id -> typed refusal. */
  get(memoryId: string): MemorySearchHit | null {
    const id = MemoryIdInputSchema.parse({ memoryId }).memoryId;
    const hit = this.findHitRow(id);
    if (hit !== null) {
      return hit;
    }
    this.refuseIfForeign(id);
    return null;
  }

  /** Get or throw `UnknownMemoryError` (foreign ids refuse, never blur). */
  require(memoryId: string): MemorySearchHit {
    const hit = this.get(memoryId);
    if (hit === null) {
      throw new UnknownMemoryError({ projectId: this.projectId, memoryId });
    }
    return hit;
  }

  /**
   * Cite a memory where only verified/active is acceptable. A disputed
   * memory is never referable as verified (M3-02 rule, same entry shape).
   */
  requireVerified(memoryId: string): MemorySearchHit {
    const hit = this.require(memoryId);
    if (hit.status !== "verified" && hit.status !== "active") {
      throw new MemoryNotVerifiedError({ memoryId: hit.id, status: hit.status });
    }
    return hit;
  }

  // -- listing / retrieval -------------------------------------------------

  /** List the project's memories (optional type/status filters), oldest first. */
  list(input: z.input<typeof ListMemoriesInputSchema> = {}): readonly MemorySearchHit[] {
    const value = ListMemoriesInputSchema.parse(input);
    const where: string[] = ["project_id = ?"];
    const params: string[] = [this.projectId];
    if (value.type !== undefined) {
      where.push("type = ?");
      params.push(value.type);
    }
    if (value.status !== undefined) {
      where.push("status = ?");
      params.push(value.status);
    }
    return this.selectHits(where, params);
  }

  /** The project's ACTIVE project rules — the set a bundle may inject. */
  listActiveProjectRules(): readonly MemorySearchHit[] {
    return this.list({ type: "project_rule", status: "active" });
  }

  /** Every memory whose persisted stale mark is set, oldest stale first. */
  listStale(): readonly MemorySearchHit[] {
    return this.selectHits(
      ["project_id = ?", "stale_since IS NOT NULL"],
      [this.projectId],
      "ORDER BY stale_since ASC, id ASC"
    );
  }

  /**
   * Text retrieval over the authorized project's memories (docs section 5:
   * SQLite 文本索引, no vectors). AND-tokenized SQL LIKE over the
   * authoritative table; statuses default to verified+active. Stale hits
   * are INCLUDED and carry their explicit stale marks — marking, never
   * hiding, is the retrieval contract (bundle injection excludes by
   * default instead).
   */
  search(input: z.input<typeof SearchMemoriesInputSchema>): readonly MemorySearchHit[] {
    const value = SearchMemoriesInputSchema.parse(input);
    const tokens = tokenizeSearchQuery(value.query);
    const statuses = value.statuses ?? DEFAULT_SEARCH_STATUSES;
    const types = value.types;

    const where: string[] = ["project_id = ?"];
    const params: string[] = [this.projectId];
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
    if (types !== undefined) {
      where.push(`type IN (${types.map(() => "?").join(", ")})`);
      params.push(...types);
    }
    for (const token of tokens) {
      where.push("content LIKE ? ESCAPE '\\'");
      params.push(likePattern(token));
    }
    return this.selectHits(where, params);
  }

  // -- writes (authorization probe, then ONE shared implementation) --------

  /**
   * CAS content/evidence update (A14) through the memory package's
   * `updateMemory`. The authorization probe runs FIRST: a foreign id is a
   * `CrossProjectAccessError`, and the foreign row's version/content is
   * never read, never hinted at.
   */
  update(input: UpdateMemoryAccessInput): MemoryRecord {
    const value = UpdateMemoryAccessInputSchema.parse(input);
    this.refuseIfForeign(value.memoryId);
    return updateMemory(this.db, {
      projectId: this.projectId,
      memoryId: value.memoryId,
      expectedVersion: value.expectedVersion,
      actor: value.actor,
      ...(value.content === undefined ? {} : { content: value.content }),
      ...(value.evidenceRefs === undefined ? {} : { evidenceRefs: [...value.evidenceRefs] }),
      now: value.now
    });
  }

  /**
   * Attach the memory's source SHA (provenance metadata — content CAS
   * semantics untouched, no version bump, no revision row). Guarded by
   * (id, project, expectedVersion, source_sha IS NULL): a concurrent first
   * attach wins, the racer gets a visible `MemorySourceAttachConflictError`;
   * re-attaching the SAME sha is an idempotent success; a stale
   * expectedVersion is a CAS conflict.
   */
  attachSource(input: AttachSourceInput): MemorySearchHit {
    const value = AttachSourceInputSchema.parse(input);
    this.refuseIfForeign(value.memoryId);
    return withTransaction(this.db, () => {
      const scoped = this.findHitRow(value.memoryId);
      if (scoped === null) {
        throw new UnknownMemoryError({ projectId: this.projectId, memoryId: value.memoryId });
      }
      if (scoped.status === "expired" || scoped.status === "superseded") {
        throw new MemoryLifecycleError({
          memoryId: scoped.id,
          from: scoped.status,
          detail: "a terminal memory cannot receive a source reference"
        });
      }
      if (scoped.version !== value.expectedVersion) {
        throw new MemoryCasConflictError({
          memoryId: scoped.id,
          expectedVersion: value.expectedVersion,
          currentVersion: scoped.version,
          currentContentDigest: memoryContentHash(scoped.content)
        });
      }
      const applied = this.db
        .prepare(
          "UPDATE memories SET source_sha = ? WHERE id = ? AND project_id = ? AND version = ? AND source_sha IS NULL"
        )
        .run(value.sourceSha, scoped.id, this.projectId, value.expectedVersion);
      if (Number(applied.changes) !== 1) {
        const current = this.findHitRow(value.memoryId);
        if (current !== null && current.sourceSha === value.sourceSha) {
          return current; // idempotent re-attach of the same provenance
        }
        throw new MemorySourceAttachConflictError({
          memoryId: scoped.id,
          attachedSourceSha: current?.sourceSha ?? null
        });
      }
      const attached = this.findHitRow(value.memoryId);
      if (attached === null) {
        throw new UnknownMemoryError({ projectId: this.projectId, memoryId: value.memoryId });
      }
      return attached;
    });
  }

  // -- source-sha freshness (docs section 6) -------------------------------

  /**
   * Reference-check every sourced memory of the project. The resolver port
   * is consulted OUTSIDE the write transaction (git/spawn I/O must never
   * sit inside BEGIN IMMEDIATE); marks + audit rows land in ONE transaction.
   * Outcomes: `missing` (sha gone) and `superseded` (baseline moved) set
   * the persisted stale mark with an explicit reason; `current` clears any
   * previous mark. Every check appends to `memory_source_checks`.
   */
  checkSources(input: CheckSourcesInput): MemorySourceCheckRun {
    const { now, resolve } = CheckSourcesInputSchema.parse(input);
    const rows = this.db
      .prepare(
        "SELECT id, source_sha FROM memories WHERE project_id = ? AND source_sha IS NOT NULL " +
          "ORDER BY created_at ASC, id ASC"
      )
      .all(this.projectId) as Row[];

    const observations = rows.map((row) => {
      const memoryId = reqStr(row, "id");
      const sourceSha = CommitShaSchema.parse(reqStr(row, "source_sha"));
      let observation: SourceShaObservation;
      try {
        observation = SourceShaObservationSchema.parse(resolve(sourceSha));
      } catch (error) {
        throw new MemorySourceResolverError({
          sourceSha,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
      return { memoryId, sourceSha, observation };
    });

    return withTransaction(this.db, () => {
      const results: MemorySourceCheckResult[] = [];
      for (const entry of observations) {
        const outcome = outcomeOf(entry.observation, entry.sourceSha);
        const stale = outcome !== "current";
        const staleSince: string | null = stale ? now : null;
        const staleReason: StaleReason | null =
          outcome === "missing" ? "missing" : outcome === "superseded" ? "superseded" : null;
        this.db
          .prepare("UPDATE memories SET stale_since = ?, stale_reason = ? WHERE id = ? AND project_id = ?")
          .run(staleSince, staleReason, entry.memoryId, this.projectId);
        const seq = nextCheckSeq(this.db, entry.memoryId);
        this.db
          .prepare(
            "INSERT INTO memory_source_checks(id, project_id, memory_id, source_sha, outcome, observed_sha, checked_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            `${entry.memoryId}#chk${String(seq).padStart(4, "0")}`,
            this.projectId,
            entry.memoryId,
            entry.sourceSha,
            outcome,
            entry.observation.exists ? entry.observation.currentSha : null,
            now
          );
        results.push({
          memoryId: entry.memoryId,
          sourceSha: entry.sourceSha,
          outcome,
          stale,
          staleSince,
          staleReason
        });
      }
      return {
        projectId: this.projectId,
        checkedAt: now,
        checkedCount: results.length,
        results
      };
    });
  }

  /** The persisted freshness state of one memory (last check + marks). */
  sourceStatus(memoryId: string): MemorySourceStatus {
    const id = MemoryIdInputSchema.parse({ memoryId }).memoryId;
    this.refuseIfForeign(id);
    const hit = this.findHitRow(id);
    if (hit === null) {
      throw new UnknownMemoryError({ projectId: this.projectId, memoryId: id });
    }
    const last = this.db
      .prepare(
        "SELECT outcome, observed_sha, checked_at FROM memory_source_checks " +
          "WHERE memory_id = ? ORDER BY checked_at DESC, id DESC"
      )
      .get(id) as Row | undefined;
    return {
      memoryId: hit.id,
      sourceSha: hit.sourceSha,
      stale: hit.stale,
      staleSince: hit.staleSince,
      staleReason: hit.staleReason,
      lastCheck:
        last === undefined
          ? null
          : {
              outcome: z.enum(["current", "missing", "superseded"]).parse(reqStr(last, "outcome")),
              observedSha:
                last["observed_sha"] === null || last["observed_sha"] === undefined
                  ? null
                  : CommitShaSchema.parse(reqStr(last, "observed_sha")),
              checkedAt: TimestampSchema.parse(reqStr(last, "checked_at"))
            }
    };
  }

  /** Append-only audit trail of one memory's reference checks, oldest first. */
  listSourceChecks(memoryId: string): readonly {
    readonly id: string;
    readonly sourceSha: string;
    readonly outcome: SourceCheckOutcome;
    readonly observedSha: string | null;
    readonly checkedAt: string;
  }[] {
    const id = MemoryIdInputSchema.parse({ memoryId }).memoryId;
    this.refuseIfForeign(id);
    const rows = this.db
      .prepare(
        "SELECT id, source_sha, outcome, observed_sha, checked_at FROM memory_source_checks " +
          "WHERE memory_id = ? ORDER BY checked_at ASC, id ASC"
      )
      .all(id) as Row[];
    return rows.map((row) => ({
      id: reqStr(row, "id"),
      sourceSha: CommitShaSchema.parse(reqStr(row, "source_sha")),
      outcome: z.enum(["current", "missing", "superseded"]).parse(reqStr(row, "outcome")),
      observedSha:
        row["observed_sha"] === null || row["observed_sha"] === undefined
          ? null
          : CommitShaSchema.parse(reqStr(row, "observed_sha")),
      checkedAt: TimestampSchema.parse(reqStr(row, "checked_at"))
    }));
  }

  // -- history (delegated to the memory package's implementations) ---------

  /** Append-only revision history of one memory, oldest (v1) first. */
  listRevisions(memoryId: string): readonly MemoryRevisionRecord[] {
    const id = MemoryIdInputSchema.parse({ memoryId }).memoryId;
    this.refuseIfForeign(id);
    return listMemoryRevisions(this.db, { projectId: this.projectId, memoryId: id });
  }

  /** Audit trail of one memory (including refusal audits), oldest first. */
  listEvents(input: ListEventsInput): readonly MemoryEventRecord[] {
    const value = ListEventsInputSchema.parse(input);
    this.refuseIfForeign(value.memoryId);
    return listMemoryEvents(this.db, {
      projectId: this.projectId,
      memoryId: value.memoryId,
      ...(value.type === undefined ? {} : { type: value.type })
    });
  }

  // -- internals -----------------------------------------------------------

  /**
   * Scoped, integrity-checked read of one row — or null. The WHERE carries
   * the AUTHORIZED project id, so a foreign id and an unknown id return the
   * same way here; `refuseIfForeign` then turns the foreign case into the
   * typed A15 refusal.
   */
  private findHitRow(memoryId: string): MemorySearchHit | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND project_id = ?")
      .get(memoryId, this.projectId) as Row | undefined;
    return row === undefined ? null : mapMemoryHitRow(row);
  }

  /**
   * The existence probe behind every typed refusal. It selects NOTHING
   * (`1`), and the owner project's id is never read, so the error that
   * follows cannot quote foreign data — only the fact "not yours" remains.
   */
  private refuseIfForeign(memoryId: string): void {
    const scoped = this.db
      .prepare("SELECT 1 AS present FROM memories WHERE id = ? AND project_id = ?")
      .get(memoryId, this.projectId);
    if (scoped !== undefined) {
      return;
    }
    const foreign = this.db
      .prepare("SELECT 1 AS present FROM memories WHERE id = ? AND project_id <> ?")
      .get(memoryId, this.projectId);
    if (foreign !== undefined) {
      throw new CrossProjectAccessError({ projectId: this.projectId, memoryId });
    }
  }

  private selectHits(
    where: readonly string[],
    params: readonly string[],
    order = "ORDER BY created_at ASC, id ASC"
  ): readonly MemorySearchHit[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ${order}`)
      .all(...params) as Row[];
    return rows.map(mapMemoryHitRow);
  }
}

/**
 * Open an authorized memory session. Fails closed when the project has no
 * store row — an empty-looking scope must never be silently authorized.
 */
export function openMemoryAccess(
  db: DatabaseSync,
  input: { readonly projectId: string }
): MemoryAccess {
  return MemoryAccess.open(db, input);
}

function outcomeOf(
  observation: SourceShaObservation,
  sourceSha: string
): SourceCheckOutcome {
  if (!observation.exists) {
    return "missing";
  }
  if (observation.currentSha !== null && observation.currentSha !== sourceSha) {
    return "superseded";
  }
  return "current";
}

function nextCheckSeq(db: DatabaseSync, memoryId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM memory_source_checks WHERE memory_id = ?")
    .get(memoryId) as { n: number };
  return Number(row.n);
}
