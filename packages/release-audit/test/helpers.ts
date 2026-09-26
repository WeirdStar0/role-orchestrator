import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const testDir = path.dirname(fileURLToPath(import.meta.url));
/** Monorepo root: packages/release-audit/test -> repo root. */
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
