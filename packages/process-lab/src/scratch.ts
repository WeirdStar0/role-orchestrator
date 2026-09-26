/**
 * Shared experiment plumbing: scratch directories under the system temp dir
 * (never inside the repository) with explicit labels, including the
 * Unicode+space variant used by the A28 scenario.
 *
 * Removal note (M0-05 finding, Node 25.0.0 / win32): `fs.rmSync` is broken
 * on non-ASCII paths — recursive form hard-crashes (silent exit 9), and even
 * the per-file form silently deletes nothing. Removal therefore walks the
 * tree with unlinkSync/rmdirSync, which were verified per-operation.
 */
import { mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LabResult {
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

const UNICODE_LABEL = "process-lab 中文 目录 带空格-";

/** Plain ASCII scratch dir: <tmp>/process-lab-<label>-<random>. */
export function makeScratchDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `process-lab-${label}-`));
}

/** Scratch dir whose name contains CJK characters and spaces (A28). */
export function makeUnicodeScratchDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), UNICODE_LABEL));
}

function removeTree(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // already gone
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    try {
      if (statSync(entryPath).isDirectory()) {
        removeTree(entryPath);
      } else {
        unlinkSync(entryPath);
      }
    } catch {
      // best effort; never let cleanup mask the actual result
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // best effort
  }
}

export function removeScratch(dir: string): void {
  removeTree(dir);
}

export function driveOf(p: string): string {
  const resolved = path.resolve(p);
  return resolved.slice(0, 2).toUpperCase();
}
