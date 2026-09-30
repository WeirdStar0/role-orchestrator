/**
 * M8-05 task 1: bundle the standalone serve entry into ONE self-contained
 * file (packages/local-api/dist/serve-bundle.mjs) for the desktop-shell
 * sidecar (NSIS extraFiles lands in a later M8-05 task).
 *
 * Constraints this script is bound by (repo hard rules + M8-05 acceptance):
 * - PACKAGING ONLY: the guard pipeline, token logic and serve.ts behavior are
 *   untouched — the bundle input is the BUILT dist/serve-bin.js, byte-for-byte
 *   the artifact the shell already spawns in dev layout. Nothing here changes
 *   what serve does; it only removes the node_modules dependency tree around
 *   it.
 * - NO NETWORK: esbuild resolves every module from local files (workspace
 *   links + node_modules). No download, no registry access, repeatable:
 *   running this script twice over the same dist produces the same output.
 * - OUTPUT FORMAT IS ESM, NOT CJS (deviation from the original task text,
 *   disclosed): dist/serve-bin.js uses top-level await, which esbuild
 *   refuses for --format=cjs ("Top-level await is currently not supported
 *   with the \"cjs\" output format", verified 2026-09-30). Rewriting the
 *   entry to drop TLA would change a product source file, which the red
 *   lines forbid for this batch — so the bundle is a single-file ESM module
 *   (serve-bundle.mjs). node executes it identically:
 *   `node dist/serve-bundle.mjs --db <path> --port 0`.
 * - node: builtins stay external automatically (--platform=node); npm
 *   dependencies (zod, ws, workspace @role-orchestrator/* dist) are INLINED
 *   — that is the point of the sidecar file.
 * - ws's optional native accelerators (bufferutil / utf-8-validate) are not
 *   installed (optional peers, absent from the lockfile); esbuild preserves
 *   those require() calls as runtime requires, and ws's own try/catch falls
 *   back to its JS implementations when they are missing — the designed
 *   optional path, exercised by the bundle smoke test.
 * - The ESM banner below is the esbuild-documented pattern for CJS deps that
 *   `require()` externals at runtime (ws requires node: events): ESM output
 *   has no ambient `require`, and esbuild's __require shim delegates to one
 *   when defined. createRequire(import.meta.url) provides it; for the
 *   optional native requires above it throws MODULE_NOT_FOUND, which ws
 *   catches.
 */
import { build } from "esbuild";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = join(packageRoot, "dist", "serve-bin.js");
const outfile = join(packageRoot, "dist", "serve-bundle.mjs");

if (!existsSync(entryPoint)) {
  console.error(
    `bundle-serve: ${entryPoint} does not exist — run ` +
      `"pnpm --filter @role-orchestrator/local-api run build" first`
  );
  process.exit(1);
}

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node25",
  outfile,
  // See module doc: gives esbuild's __require shim a real require for CJS
  // deps that require() externals (node builtins) at runtime.
  banner: {
    js:
      "import { createRequire as __bundle_createRequire } from 'node:module'; " +
      "const require = __bundle_createRequire(import.meta.url);"
  },
  // Sourcemaps intentionally off: the sidecar ships without a source tree;
  // diagnostics parity with serve-bin.js is asserted by the smoke test.
  sourcemap: false,
  logLevel: "info",
  metafile: true
});

if (result.errors.length > 0) {
  // build() rejects on errors in API mode; this guard is belt-and-braces so
  // the script can never exit 0 without a bundle on disk.
  console.error("bundle-serve: esbuild reported errors");
  process.exit(1);
}

const bytes = statSync(outfile).size;
console.log(`bundle-serve: wrote ${outfile} (${bytes} bytes)`);
