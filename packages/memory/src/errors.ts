/**
 * Typed error taxonomy for @role-orchestrator/memory.
 *
 * Every error names the memory/project it concerns and carries its `cause`
 * where one exists. None of them ever guesses a successful outcome: a refused
 * write, a CAS conflict or an integrity failure is always a thrown typed
 * error, never a silent overwrite or a downgraded result.
 */
import type { MemoryStatus, MemoryType } from "./types.js";

export class MemoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryError";
  }
}

/**
 * The actor tried to write a memory type its role may not write (or tried a
 * role-only action as a user / a user-only action as a role). The matrix is
 * the frozen 可提交者 column of docs/MEMORY_AND_CONTEXT.md section 2 — no
 * content, context or retry path widens it (A16).
 */
export class MemoryWriteRefusedError extends MemoryError {
  readonly roleId: string | null;
  readonly actorKind: string;
  readonly type: MemoryType | null;
  readonly detail: string;

  constructor(input: {
    readonly actorKind: string;
    readonly roleId?: string;
    readonly type?: MemoryType;
    readonly detail: string;
  }) {
    super(
      `memory write refused for ${input.actorKind}` +
        `${input.roleId !== undefined ? ` "${input.roleId}"` : ""}` +
        `${input.type !== undefined ? ` on type "${input.type}"` : ""}: ${input.detail}`
    );
    this.name = "MemoryWriteRefusedError";
    this.actorKind = input.actorKind;
    this.roleId = input.roleId ?? null;
    this.type = input.type ?? null;
    this.detail = input.detail;
  }
}

/**
 * A user-only operation (promoting or editing an active project_rule) was
 * attempted by a role actor. This is the A16 backstop: instruction text in
 * memory content cannot call the promotion entry point — only a caller that
 * presents a user identity can, and the attempt itself is audited.
 */
export class MemoryUserRequiredError extends MemoryError {
  readonly memoryId: string;
  readonly action: string;

  constructor(input: { readonly memoryId: string; readonly action: string }) {
    super(
      `memory "${input.memoryId}": action "${input.action}" is reserved for the human operator ` +
        "(user actor); role actors — including instruction text inside memory content — are refused"
    );
    this.name = "MemoryUserRequiredError";
    this.memoryId = input.memoryId;
    this.action = input.action;
  }
}

/** An illegal lifecycle transition was requested (guard failed). */
export class MemoryLifecycleError extends MemoryError {
  readonly memoryId: string;
  readonly from: MemoryStatus | null;
  readonly to: MemoryStatus | null;
  readonly detail: string;

  constructor(input: {
    readonly memoryId: string;
    readonly from?: MemoryStatus;
    readonly to?: MemoryStatus;
    readonly detail: string;
  }) {
    super(
      `memory "${input.memoryId}": lifecycle guard failed` +
        `${input.from !== undefined ? ` (from "${input.from}"` : ""}` +
        `${input.to !== undefined ? ` to "${input.to}")` : input.from !== undefined ? ")" : ""}` +
        `: ${input.detail}`
    );
    this.name = "MemoryLifecycleError";
    this.memoryId = input.memoryId;
    this.from = input.from ?? null;
    this.to = input.to ?? null;
    this.detail = input.detail;
  }
}

/**
 * A14: the caller's (memoryId, expectedVersion) did not match the stored
 * version. The write was NOT applied — nothing is silently overwritten. The
 * error carries the CURRENT version and a sha256 digest of the CURRENT
 * content so the loser of the race can re-base consciously.
 */
export class MemoryCasConflictError extends MemoryError {
  readonly memoryId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly currentContentDigest: string;

  constructor(input: {
    readonly memoryId: string;
    readonly expectedVersion: number;
    readonly currentVersion: number;
    readonly currentContentDigest: string;
  }) {
    super(
      `memory "${input.memoryId}": compare-and-swap conflict — expected version ` +
        `${String(input.expectedVersion)}, current version is ${String(input.currentVersion)} ` +
        `(current content sha256 ${input.currentContentDigest}). The write was not applied; ` +
        "re-base on the current version instead of overwriting"
    );
    this.name = "MemoryCasConflictError";
    this.memoryId = input.memoryId;
    this.expectedVersion = input.expectedVersion;
    this.currentVersion = input.currentVersion;
    this.currentContentDigest = input.currentContentDigest;
  }
}

/** The memory id does not exist — or exists under a DIFFERENT project, in which case it is reported the same way (no cross-project leakage, A15 data-plane baseline). */
export class UnknownMemoryError extends MemoryError {
  readonly projectId: string;
  readonly memoryId: string;

  constructor(input: { readonly projectId: string; readonly memoryId: string }) {
    super(
      `memory "${input.memoryId}" does not exist in project "${input.projectId}"; ` +
        "cross-project memory ids are indistinguishable from unknown ones by design"
    );
    this.name = "UnknownMemoryError";
    this.projectId = input.projectId;
    this.memoryId = input.memoryId;
  }
}

/** The proposal/update references a project that has no store row. */
export class UnknownMemoryProjectError extends MemoryError {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`project "${projectId}" does not exist; memory is project-scoped (scope=project)`);
    this.name = "UnknownMemoryProjectError";
    this.projectId = projectId;
  }
}

/** Two live memories with the same (project, type, content) cannot coexist and the collision cannot be absorbed (id already taken with different content, or update colliding with another live memory). */
export class DuplicateMemoryError extends MemoryError {
  readonly memoryId: string;
  readonly existingMemoryId: string;

  constructor(input: { readonly memoryId: string; readonly existingMemoryId: string }) {
    super(
      input.memoryId === input.existingMemoryId
        ? `memory id "${input.memoryId}" is already taken by a different memory; ids are immutable`
        : `this write would duplicate the live memory "${input.existingMemoryId}" (same project, type and content)`
    );
    this.name = "DuplicateMemoryError";
    this.memoryId = input.memoryId;
    this.existingMemoryId = input.existingMemoryId;
  }
}

/** fact/decision/project_rule were submitted without the evidence refs contracts require. */
export class MemoryEvidenceRequiredError extends MemoryError {
  readonly type: MemoryType;

  constructor(type: MemoryType) {
    super(
      `memory proposals of type "${type}" require at least one evidenceRef ` +
        "(file, SHA, test or command evidence; docs/MEMORY_AND_CONTEXT.md section 2)"
    );
    this.name = "MemoryEvidenceRequiredError";
    this.type = type;
  }
}

/**
 * A memory was cited where only a verified/active entry is acceptable — its
 * actual status is proposed/disputed/expired/superseded. A disputed memory is
 * never referable as verified (M3-02 完成标准).
 */
export class MemoryNotVerifiedError extends MemoryError {
  readonly memoryId: string;
  readonly status: MemoryStatus;

  constructor(input: { readonly memoryId: string; readonly status: MemoryStatus }) {
    super(
      `memory "${input.memoryId}" has status "${input.status}" and cannot be referenced as verified; ` +
        "only verified/active memories pass this check"
    );
    this.name = "MemoryNotVerifiedError";
    this.memoryId = input.memoryId;
    this.status = input.status;
  }
}

export type MemoryIntegrityKind = "content-hash" | "revision-hash" | "revision-chain";

/**
 * Recomputation found stored content that does not hash to its recorded
 * content_hash, or a revision history that is not a contiguous chain ending
 * at the current row. Tampering is loud: the memory is treated as unreadable.
 */
export class MemoryIntegrityError extends MemoryError {
  readonly memoryId: string;
  readonly kind: MemoryIntegrityKind;
  readonly detail: string;

  constructor(input: { readonly memoryId: string; readonly kind: MemoryIntegrityKind; readonly detail: string }) {
    super(
      `memory "${input.memoryId}" failed integrity verification (${input.kind}): ${input.detail}`
    );
    this.name = "MemoryIntegrityError";
    this.memoryId = input.memoryId;
    this.kind = input.kind;
    this.detail = input.detail;
  }
}
