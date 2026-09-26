/**
 * Typed error taxonomy for @role-orchestrator/store.
 *
 * Every error carries enough context to be actionable; none of them ever
 * guess a successful outcome. SQLite-level failures are wrapped with their
 * original error as `cause` so callers can still inspect the raw driver info.
 */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreError";
  }
}

export type MigrationErrorKind =
  | "already-applied"
  | "checksum-mismatch"
  | "unknown-applied-version"
  | "application-failed";

/** Raised by the migration runner/verifier; `version` is null for list-level problems. */
export class MigrationError extends StoreError {
  readonly kind: MigrationErrorKind;
  readonly version: number | null;

  constructor(
    kind: MigrationErrorKind,
    version: number | null,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "MigrationError";
    this.kind = kind;
    this.version = version;
  }
}

/** Backup or restore could not be completed; nothing is ever half-claimed as done. */
export class BackupError extends StoreError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackupError";
  }
}

/**
 * A second ACTIVE attempt was refused for a (run, node) slot that already has
 * one. This is the A23 backstop: the partial unique index
 * `ux_executions_one_active_per_slot` makes duplicate dispatch of an
 * already-active slot impossible at the constraint level, even across
 * processes/connections.
 */
export class ActiveAttemptConflictError extends StoreError {
  readonly runId: string;
  readonly nodeId: string;

  constructor(runId: string, nodeId: string, options?: { cause?: unknown }) {
    super(
      `an active attempt already exists for run "${runId}" node "${nodeId}"; reconcile it to a terminal phase before creating another attempt`,
      options
    );
    this.name = "ActiveAttemptConflictError";
    this.runId = runId;
    this.nodeId = nodeId;
  }
}

/** Same (run, node, definition revision, attempt) tuple used twice. */
export class DuplicateAttemptError extends StoreError {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;

  constructor(
    runId: string,
    nodeId: string,
    attempt: number,
    options?: { cause?: unknown }
  ) {
    super(
      `attempt ${attempt} already exists for run "${runId}" node "${nodeId}" with this definition revision`,
      options
    );
    this.name = "DuplicateAttemptError";
    this.runId = runId;
    this.nodeId = nodeId;
    this.attempt = attempt;
  }
}

/** A project already occupies the canonical repo root. */
export class DuplicateRepoRootError extends StoreError {
  readonly repoRoot: string;

  constructor(repoRoot: string, options?: { cause?: unknown }) {
    super(`a project already exists for canonical repo root "${repoRoot}"`, options);
    this.name = "DuplicateRepoRootError";
    this.repoRoot = repoRoot;
  }
}

/** Transaction-level misuse (for example nested `withTransaction` on one connection). */
export class TransactionStateError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "TransactionStateError";
  }
}

/** Raised when an UPDATE/DELETE affected zero rows, so the caller learns the entity was absent or not in the expected state. */
export class NoRowUpdatedError extends StoreError {
  constructor(description: string, options?: { cause?: unknown }) {
    super(`no matching row: ${description}`, options);
    this.name = "NoRowUpdatedError";
  }
}

/**
 * SQLite reports unique violations through the driver message
 * "UNIQUE constraint failed: table.col, table.col". Matching on the exact
 * column list is what lets us distinguish our own indexes (the message text
 * is produced by SQLite itself for this schema, so it is stable for a given
 * schema version).
 */
export function isUniqueViolation(error: unknown, columnSignature: string): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:/i.test(error.message) &&
    error.message.includes(columnSignature)
  );
}
