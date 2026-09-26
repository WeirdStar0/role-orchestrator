import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYamlText } from "yaml";
import { expect } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the planning bundle root (this package's parent's parent). */
export const repoRoot = path.resolve(testDir, "..", "..", "..");
const configDir = path.join(repoRoot, "config");

/**
 * Loads a frozen bundle example from the repo's config/ directory.
 * `.yaml` files go through the yaml package, `.json` through JSON.parse.
 */
export function loadExample(fileName: string): unknown {
  const text = readFileSync(path.join(configDir, fileName), "utf8");
  return fileName.endsWith(".json") ? JSON.parse(text) : parseYamlText(text);
}

/**
 * Parses YAML text with duplicate-key rejection — the yaml package refuses
 * duplicate map keys by default, matching UniqueKeyLoader in
 * scripts/validate_bundle.py.
 */
export function parseYamlStrict(text: string): unknown {
  return parseYamlText(text);
}

/**
 * Parses an example file with the given schema and returns the typed result.
 * Throws when the frozen example does not satisfy its own contract.
 */
export function loadValidated<T>(schema: { parse(input: unknown): T }, fileName: string): T {
  return schema.parse(loadExample(fileName));
}

/** Adds or overrides fields on a deep clone — the TS counterpart of the
 * Python self-tests' `dict.update` on a `deepcopy` of the bundle. */
export function withProps<T extends object>(
  value: T,
  props: Record<string, unknown>
): T & Record<string, unknown> {
  return Object.assign(structuredClone(value), props);
}

/** Returns a copy of a readonly list with one element replaced. */
export function replaceElement<T>(list: readonly T[], index: number, element: T): T[] {
  const copy = list.slice();
  copy.splice(index, 1, element);
  return copy;
}

/** Asserts that `schema` rejects `data`; names the case in the failure message. */
export function expectRejected(
  schema: { safeParse(data: unknown): { success: boolean } },
  data: unknown,
  label = "expected schema to reject the input"
): void {
  const outcome = schema.safeParse(data);
  expect(outcome.success, label).toBe(false);
}
