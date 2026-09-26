/**
 * Typed errors of the fault-matrix package (M4-05).
 *
 * The package is a matrix driver, not product logic: its errors exist so a
 * misused driver fails loudly instead of silently reporting a green matrix.
 * A case whose recovery-semantics assertions fail surfaces as a plain Error
 * (the assertion message is the report payload), never as a report entry
 * marked "pass".
 */
export class MatrixUsageError extends Error {
  override readonly name = "MatrixUsageError";
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options === undefined ? undefined : { cause: options.cause });
  }
}

/**
 * Thrown by the deterministic DB crash proxy at the EXACT injected statement
 * (the M2-04 `dbCrashingOn` pattern, generalized with an injection ordinal).
 * Everything the wrapped code committed before this statement stays
 * committed; everything after it never happened — the process state at throw
 * time IS the real crash state.
 */
export class MatrixCrashInjectionError extends Error {
  override readonly name = "MatrixCrashInjectionError";
  constructor(public readonly injectionLabel: string, ordinal: number) {
    super(
      `SIMULATED CRASH (injection "${injectionLabel}", ordinal ${String(ordinal)}): ` +
        `the process died at this DB statement; all earlier commits stand`
    );
  }
}
