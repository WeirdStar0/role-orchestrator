/**
 * M8-05 task 2: sync the built serve bundle into the desktop-shell tree so
 * tauri.conf.json `bundle.resources` can reference an IN-TREE path.
 *
 * Why this copy exists (verified empirically 2026-09-30): tauri-build's
 * resource resolution does not accept `../`-escapes out of the package dir —
 * with `"../packages/local-api/dist/serve-bundle.mjs"` as a resource the
 * build script aborts (`resource path ... doesn't exist`) even when the file
 * is present and even when cargo runs from the package directory. The Tauri
 * pattern is therefore: stage the artifact inside the app dir
 * (apps/desktop-shell/sidecar/), reference it as `sidecar/serve-bundle.mjs`,
 * and let the resource map rename it to `serve-bundle.mjs` at the install
 * root (exe directory — where the shell's locate chain looks, see
 * src/locate.rs).
 *
 * fail-closed: missing inputs are an ERROR with the producing command named —
 * never a silent skip (a stale/absent sidecar would otherwise ship an
 * installer whose bundled shell cannot start).
 *
 * Idempotent: safe to run repeatedly; overwrites the staged copy with the
 * current dist bytes.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "packages", "local-api", "dist", "serve-bundle.mjs");
const sidecarDir = path.join(repoRoot, "apps", "desktop-shell", "sidecar");
const target = path.join(sidecarDir, "serve-bundle.mjs");
const nodeExe = path.join(repoRoot, "apps", "desktop-shell", "node-runtime", "node.exe");
// M11-01: the /app renderer (apps/desktop-ui, ONE inline single-file HTML)
// rides beside the bundle as a second resource — local-api's candidate chain
// reads `desktop-ui.html` from its own entry directory (packages/local-api/
// src/app-ui.ts). Fail-closed like everything here: a missing artifact is an
// error naming the producing command, never a silent skip (the installer
// would otherwise ship a shell whose /app always 302s back to the old page).
const appUiSource = path.join(repoRoot, "apps", "desktop-ui", "dist", "index.html");
const appUiTarget = path.join(sidecarDir, "desktop-ui.html");

if (!existsSync(source)) {
  console.error(
    `sync-shell-sidecar: ${source} does not exist — run ` +
      `"pnpm --filter @role-orchestrator/local-api run bundle:serve" (after build) first`
  );
  process.exit(1);
}

// Preflight the OTHER bundled resource too: cargo tauri build fails late and
// cryptically without it; here the fix command is one line away.
if (!existsSync(nodeExe)) {
  console.error(
    `sync-shell-sidecar: ${nodeExe} does not exist — run "node scripts/fetch-node-runtime.mjs" first`
  );
  process.exit(1);
}
if (!existsSync(appUiSource)) {
  console.error(
    `sync-shell-sidecar: ${appUiSource} does not exist — run ` +
      `"pnpm --filter @role-orchestrator/desktop-ui run build" first`
  );
  process.exit(1);
}

// M11-02 review handover K: a STAGED-BUT-STALE serve bundle is exactly as
// dangerous as a missing one — the installer would ship the PREVIOUS
// server. The staging command bundles from dist/, so when the bundle is
// OLDER than the dist entry module it was built from, dist has moved on
// and the staged copy is stale: refuse with the producing command named
// (mirroring the fail-closed missing-input refusals above). Equal mtimes
// are fine (same build); a missing dist marker skips the check — the
// bundle's own absence is already refused above.
const serveDistMarker = path.join(repoRoot, "packages", "local-api", "dist", "server.js");
if (existsSync(serveDistMarker) && statSync(source).mtimeMs < statSync(serveDistMarker).mtimeMs) {
  console.error(
    `sync-shell-sidecar: staged serve bundle ${source} is OLDER than ${serveDistMarker} ` +
      `(staged ${statSync(source).mtime.toISOString()}, dist ${statSync(serveDistMarker).mtime.toISOString()}) — ` +
      `the sidecar would ship a stale server; run ` +
      `"pnpm --filter @role-orchestrator/local-api run bundle:serve" (after build) again, then re-run this script`
  );
  process.exit(1);
}

mkdirSync(sidecarDir, { recursive: true });
copyFileSync(source, target);
copyFileSync(appUiSource, appUiTarget);
console.log(
  `sync-shell-sidecar: staged ${target} (${statSync(target).size} bytes), ` +
    `${appUiTarget} (${statSync(appUiTarget).size} bytes); ` +
    `node-runtime present (${statSync(nodeExe).size} bytes)`
);
