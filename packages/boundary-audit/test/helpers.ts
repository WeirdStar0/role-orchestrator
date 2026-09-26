import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const testDir = path.dirname(fileURLToPath(import.meta.url));
/** Monorepo root: packages/boundary-audit/test -> repo root. */
export const repoRoot = path.resolve(testDir, "..", "..", "..");

export function makeTmpRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Tree {
  readonly [relativePath: string]: string | Buffer;
}

/** Materialize a file tree under a directory (creates intermediate dirs). */
export function writeTree(root: string, tree: Tree): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export interface FixturePackageOptions {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  /** Raw value for the "commercial" field (undefined = field absent). */
  readonly commercialMarker?: unknown;
  /** Extra top-level manifest keys (e.g. alias marker spellings). */
  readonly extraKeys?: Readonly<Record<string, unknown>>;
}

/** Build a package.json text for a fixture package. */
export function fixturePackage(options: FixturePackageOptions): string {
  const manifest: Record<string, unknown> = {
    name: options.name,
    version: "0.1.0",
    private: true,
    type: "module"
  };
  if (options.dependencies !== undefined) manifest.dependencies = options.dependencies;
  if (options.optionalDependencies !== undefined) manifest.optionalDependencies = options.optionalDependencies;
  if (options.devDependencies !== undefined) manifest.devDependencies = options.devDependencies;
  if (options.peerDependencies !== undefined) manifest.peerDependencies = options.peerDependencies;
  if (options.commercialMarker !== undefined) manifest.commercial = options.commercialMarker;
  for (const [key, value] of Object.entries(options.extraKeys ?? {})) {
    manifest[key] = value;
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
