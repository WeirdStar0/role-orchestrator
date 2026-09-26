/**
 * Typed errors for the e2e baseline driver.
 *
 * A driver failure is never a bare message: `BaselineDriverError` carries a
 * plain-text现场摘要 (site summary) built from the real store/git state at
 * failure time — node states, execution phases and reasons, the last persisted
 * events of the failing execution, integration/queue records and the preserved
 * worktree path — so a red baseline run is diagnosable from the error alone.
 */
export class E2eBaselineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "E2eBaselineError";
  }
}

export class BaselineDriverError extends E2eBaselineError {
  /** The diagnosable site summary (store + git facts, not interpretations). */
  readonly summary: string;

  constructor(summary: string, headline: string, options?: { cause?: unknown }) {
    super(`e2e baseline failed: ${headline}\n${summary}`, options);
    this.name = "BaselineDriverError";
    this.summary = summary;
  }
}

/** Driver-side misuse (unknown node id, missing accepted output) — a bug. */
export class BaselineDriverUsageError extends E2eBaselineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BaselineDriverUsageError";
  }
}
