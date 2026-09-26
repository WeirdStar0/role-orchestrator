/**
 * Compile-time assertion helpers used by the schema modules to prove that the
 * Zod inference still matches the frozen contract interfaces. They are types
 * only and disappear at runtime; `tsc` enforces them on every typecheck/build.
 */

/**
 * Strict type identity check. Sensitive to modifiers such as `readonly`, so it
 * is only used where the two sides are expected to be truly identical.
 */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Compile-time assertion: `T` must resolve to `true`. */
export type Expect<T extends true> = T;
