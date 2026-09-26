import type { SQLOutputValue } from "node:sqlite";
import { StoreError } from "./errors.js";

/**
 * Narrowing helpers for rows returned by `StatementSync.get()/all()`
 * (`Record<string, SQLOutputValue>`). Every column read goes through these,
 * so schema drift turns into a loud error instead of `undefined` flowing
 * into business logic.
 */

export type Row = Record<string, SQLOutputValue>;

export function reqStr(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new StoreError(`row read: expected TEXT in column "${column}", got ${typeof value}`);
  }
  return value;
}

export function optStr(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new StoreError(`row read: expected TEXT or NULL in column "${column}", got ${typeof value}`);
  }
  return value;
}

export function reqInt(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StoreError(`row read: expected INTEGER in column "${column}", got ${typeof value}`);
  }
  return value;
}
