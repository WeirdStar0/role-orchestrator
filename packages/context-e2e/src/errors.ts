/**
 * Typed errors for the cross-CLI context dogfood package (M3-04).
 *
 * Mirrors the e2e-baseline discipline: a driver failure is never a bare
 * message — `ContextE2eDriverError` carries a plain-text site summary built
 * from the real store state at failure time (node states, execution phases
 * and reasons, the tail of the failing execution's persisted events), so a
 * red run is diagnosable from the error alone.
 */
export class ContextE2eError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContextE2eError";
  }
}

/** Driver-side failure with a store-fact site summary (never interpretations). */
export class ContextE2eDriverError extends ContextE2eError {
  /** The diagnosable site summary (store facts only). */
  readonly summary: string;

  constructor(summary: string, headline: string, options?: { cause?: unknown }) {
    super(`context-e2e failed: ${headline}\n${summary}`, options);
    this.name = "ContextE2eDriverError";
    this.summary = summary;
  }
}

/** Harness-side misuse (unknown node, wrong project scope, missing record). */
export class ContextE2eUsageError extends ContextE2eError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContextE2eUsageError";
  }
}
