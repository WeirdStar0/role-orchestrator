/**
 * Locates the built `@role-orchestrator/fake-cli` dist tree (workspace
 * dependency resolved through node_modules, so this works from source, from
 * dist, and from vitest) and installs a private copy into a scratch
 * directory. A copy — not a reference — is what makes the Unicode/space path
 * scenarios honest: the whole launcher chain runs from the scratch location.
 *
 * IMPORTANT (M0-05 finding, Node 25.0.0 / win32): `fs.cpSync` is unusable on
 * non-ASCII destination paths — it either hard-crashes the process (silent
 * exit code 9) or silently copies nothing. The copy therefore uses only
 * primitives that were verified per-operation on Unicode paths:
 * mkdirSync/readdirSync/statSync/copyFileSync, with an existsSync check.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findJsonValue } from "./lines.js";

export type FakeDialect = "claude" | "codex";

export interface FakeCliInstall {
  /** Root of the copied dist tree. */
  readonly distDir: string;
  /** Absolute path of one dialect's bin entry (forward or back slashes per platform). */
  binPath(dialect: FakeDialect): string;
}

function fakeCliPackageDir(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@role-orchestrator/fake-cli/package.json");
  return path.dirname(manifest);
}

export function fakeCliDistSource(): string {
  const dist = path.join(fakeCliPackageDir(), "dist");
  if (!existsSync(path.join(dist, "bin", "fake-claude.js"))) {
    throw new Error('fake-cli is not built. Run "pnpm build" at the repo root before using process-lab.');
  }
  return dist;
}

/** Recursive copy built only from Unicode-verified primitives. */
function copyTree(srcDir: string, destDir: string): number {
  mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(srcDir)) {
    const srcEntry = path.join(srcDir, entry);
    const destEntry = path.join(destDir, entry);
    if (statSync(srcEntry).isDirectory()) {
      count += copyTree(srcEntry, destEntry);
    } else {
      copyFileSync(srcEntry, destEntry);
      count += 1;
    }
  }
  return count;
}

/**
 * Copies the fake-cli dist tree into `<destDir>/<distName>` and returns the
 * installed entry points. The grandchild chain keeps working because the
 * child resolves its grandchild script relative to its own module URL.
 */
export function installFakeCli(destDir: string, distName = "fake-cli-dist"): FakeCliInstall {
  const distDir = path.join(destDir, distName);
  const copied = copyTree(fakeCliDistSource(), distDir);
  if (!existsSync(path.join(distDir, "bin", "fake-claude.js")) || copied === 0) {
    throw new Error(`fake-cli dist copy incomplete (${copied} files) into ${destDir}`);
  }
  return {
    distDir,
    binPath: (dialect) => path.join(distDir, "bin", dialect === "claude" ? "fake-claude.js" : "fake-codex.js")
  };
}

export interface GrandchildReport {
  readonly childPid: number;
  readonly grandchildPid: number;
}

/**
 * Extracts {childPid, grandchildPid} from a fake-cli grandchild report line
 * (claude dialect nests them under a tool_use input; codex dialect under an
 * item). Returns null for lines without both numbers.
 */
export function parseGrandchildReport(line: string): GrandchildReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const childPid = findJsonValue(parsed, "childPid");
  const grandchildPid = findJsonValue(parsed, "grandchildPid");
  if (typeof childPid !== "number" || typeof grandchildPid !== "number") return null;
  return { childPid, grandchildPid };
}
