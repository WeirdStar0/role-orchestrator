/**
 * Typed error taxonomy for @role-orchestrator/memory-search (M3-03).
 *
 * The load-bearing member is `CrossProjectAccessError`: the A15
 * authorization-layer refusal. Its message and fields deliberately carry
 * ONLY the caller's OWN authorized project id and the requested memory id —
 * never the foreign project's id, never any foreign content — so a refusal
 * cannot become a side channel.
 */
import type { StaleReason } from "./types.js";


export class MemorySearchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemorySearchError";
  }
}

/**
 * A15: a call reached for data outside the caller's authorized project.
 * Raised by EVERY entry point of a bound `MemoryAccess` session — direct id
 * reads, retrieval, CAS updates, source checks — and by the bundle-injection
 * glue when the access session does not belong to the bundle's project.
 *
 * The refusal is side-effect free (nothing is audited into the foreign
 * project — that would itself be a cross-project write) and leaks nothing:
 * message and fields contain the AUTHORIZED project id and the requested id
 * only. A foreign id is, by design, also indistinguishable from an unknown
 * one at the data layer; this type exists because the CALLER here is
 * identified, so the refusal can be explicit.
 */
export class CrossProjectAccessError extends MemorySearchError {
  /** The authorized project the session (or bundle) belongs to. */
  readonly projectId: string;
  /** The requested memory id, when the refusal was about one specific id. */
  readonly memoryId: string | null;

  constructor(input: { readonly projectId: string; readonly memoryId?: string }) {
    super(
      input.memoryId === undefined
        ? `project "${input.projectId}" is not the authorized scope of this access session; ` +
            "cross-project access is refused at the authorization layer (A15)"
        : `memory "${input.memoryId}" is not accessible from project "${input.projectId}"; ` +
            "cross-project access is refused at the authorization layer (A15) and the id " +
            "is treated as unknown-or-foreign — no foreign project or content is disclosed"
    );
    this.name = "CrossProjectAccessError";
    this.projectId = input.projectId;
    this.memoryId = input.memoryId ?? null;
  }
}

/** The search query (or a resolver output) failed structural validation. */
export class MemorySearchQueryInvalidError extends MemorySearchError {
  readonly detail: string;

  constructor(detail: string) {
    super(`invalid memory search query: ${detail}`);
    this.name = "MemorySearchQueryInvalidError";
    this.detail = detail;
  }
}

/**
 * Attaching a source SHA raced a concurrent attach: the CAS guard on
 * (id, project, version, source_sha IS NULL) found the provenance already
 * set to a DIFFERENT sha. Nothing was overwritten — provenance is append-
 * to-history, and a change of mind goes through a visible conflict.
 */
export class MemorySourceAttachConflictError extends MemorySearchError {
  readonly memoryId: string;
  readonly attachedSourceSha: string | null;

  constructor(input: { readonly memoryId: string; readonly attachedSourceSha: string | null }) {
    super(
      `memory "${input.memoryId}" already carries a source SHA` +
        `${input.attachedSourceSha === null ? "" : ` (${input.attachedSourceSha})`}; ` +
        "attaching a different one is a visible conflict, not a silent overwrite — " +
        "propose a new memory revision instead"
    );
    this.name = "MemorySourceAttachConflictError";
    this.memoryId = input.memoryId;
    this.attachedSourceSha = input.attachedSourceSha;
  }
}

/** The injected source-sha resolver returned an unparseable observation. */
export class MemorySourceResolverError extends MemorySearchError {
  readonly sourceSha: string;
  readonly detail: string;

  constructor(input: { readonly sourceSha: string; readonly detail: string }) {
    super(
      `source-sha resolver returned an invalid observation for "${input.sourceSha}": ${input.detail}`
    );
    this.name = "MemorySourceResolverError";
    this.sourceSha = input.sourceSha;
    this.detail = input.detail;
  }
}

/** The stale reason vocabulary, re-exported as a type for error messages. */
export type { StaleReason };
