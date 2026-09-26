/**
 * Deterministic DB-boundary crash injection (M4-05).
 *
 * Generalizes the M2-04 A25 pattern (`packages/integration/test/helpers.ts`
 * `dbCrashingOn`) with a FIXED injection ordinal: the proxy crashes the FIRST
 * `prepare` call whose SQL matches `matchSql` AND whose occurrence number
 * equals `ordinal` (1-based). Because every matrix case feeds the same
 * statement sequence in the same order, the injection point is fully
 * deterministic — rerunning a case dies at exactly the same statement.
 *
 * Everything the code under test committed BEFORE the crashing statement
 * stays committed (autocommit statements, or transactions that already
 * returned); the crashing statement and everything after it never happened.
 * When the crash lands inside a `withTransaction` (BEGIN IMMEDIATE), the
 * whole surrounding transaction rolls back — which is precisely the real
 * process-death window the matrix asserts recovery semantics for.
 */
import type { DatabaseSync } from "node:sqlite";
import { MatrixCrashInjectionError, MatrixUsageError } from "./errors.js";

export interface CrashInjection {
  /** Matches the SQL text handed to `prepare`. */
  readonly matchSql: (sql: string) => boolean;
  /** 1-based occurrence of the matching statement that dies. */
  readonly ordinal: number;
  /** Stable label carried by the thrown error and the matrix report. */
  readonly label: string;
}

export function crashInjection(
  label: string,
  matchSql: (sql: string) => boolean,
  ordinal = 1
): CrashInjection {
  return { label, matchSql, ordinal };
}

/** A DatabaseSync proxy that dies at exactly one injected statement. */
export function dbCrashingAt(db: DatabaseSync, injection: CrashInjection): DatabaseSync {
  if (!Number.isInteger(injection.ordinal) || injection.ordinal < 1) {
    throw new MatrixUsageError(`crash injection "${injection.label}" needs an ordinal >= 1`);
  }
  let seen = 0;
  return new Proxy(db, {
    get(target, prop, _receiver) {
      if (prop === "prepare") {
        return (sql: string, ...rest: unknown[]) => {
          if (injection.matchSql(sql)) {
            seen += 1;
            if (seen === injection.ordinal) {
              throw new MatrixCrashInjectionError(injection.label, injection.ordinal);
            }
          }
          type PrepareFn = (sql: string, ...rest: unknown[]) => unknown;
          return (target.prepare as unknown as PrepareFn)(sql, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  }) as DatabaseSync;
}

/** Convenience: crash when the SQL CONTAINS the given fragment. */
export function crashOnSqlFragment(
  db: DatabaseSync,
  label: string,
  fragment: string,
  ordinal = 1
): DatabaseSync {
  return dbCrashingAt(db, {
    label,
    ordinal,
    matchSql: (sql) => sql.includes(fragment)
  });
}
