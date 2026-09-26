/**
 * Path comparison helpers for the worktree lifecycle.
 *
 * Git prints Windows paths with forward slashes ("C:/tmp/…") while Node's
 * path.join produces backslashes, and Windows filesystems are
 * case-insensitive by default — so equality and containment checks
 * normalize both. Containment is the A11 guard: a worktree must never be
 * created inside the user repository, and discard must never target the
 * repository root.
 */
import path from "node:path";

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value.trim());
  const unified = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** True when two paths denote the same directory on this platform. */
export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * True when `candidate` equals or lies inside `root`. `path.relative` on
 * win32 already compares drive letters and case insensitively.
 */
export function isInsidePath(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !rel.startsWith("..");
}
