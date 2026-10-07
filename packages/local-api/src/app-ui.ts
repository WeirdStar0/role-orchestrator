/**
 * M11-01 — the desktop renderer (/app) static shell. The new UI is built as
 * ONE inline single-file HTML artifact (apps/desktop-ui, see its vite
 * config); this module LOCATES the built file, and derives a strict
 * content-hash CSP from the SERVED bytes so the inline script/style blocks
 * are pinned exactly — no 'unsafe-inline', no external origins, the same
 * discipline as the old page's `script-src 'self'` (here the "self" is the
 * exact build output, which is STRONGER: any other inline script is refused
 * by the browser).
 *
 * Design notes:
 * - The file is read ONCE per server start (startLocalApiServer), never per
 *   request: the artifact is immutable build output.
 * - Location is resolved relative to THIS module's compiled location
 *   (import.meta.url survives both the tsc dist layout and the esbuild
 *   serve-bundle.mjs): ① exe/install-adjacent `desktop-ui.html` (the NSIS
 *   resource staged by scripts/sync-shell-sidecar.mjs), ② the repo dev
 *   layout `apps/desktop-ui/dist/index.html`. `startLocalApiServer` also
 *   accepts an explicit override (tests / unusual installs).
 * - ABSENCE IS NOT AN ERROR: a server started without the built artifact
 *   (old installer, unbuilt tree) answers /app with a 302 to / — the OLD
 *   page — so every candidate stays usable (product continuity) and nothing
 *   pretends to be the new UI.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppUiAsset {
  /** The exact HTML bytes served at /app and /app/ *. */
  readonly html: string;
  /** CSP derived from the served bytes (inline content hash-pinned). */
  readonly cspHeader: string;
}

/**
 * Candidate locations, most specific first. Exposed for the unit test.
 * @param moduleDir the directory of THIS compiled file (dist/ in production,
 *   src/ under vitest — both are one level below the package root, so the
 *   dev-layout depth is identical).
 */
export function appUiCandidatePaths(moduleDir: string): readonly string[] {
  return [
    // Installed layout: NSIS resource `desktop-ui.html` next to serve-bundle.mjs.
    join(moduleDir, "desktop-ui.html"),
    // Repo dev layout: packages/local-api/{dist|src} -> repo root -> apps/.
    join(moduleDir, "..", "..", "..", "apps", "desktop-ui", "dist", "index.html")
  ];
}

/**
 * Derive the strict CSP for the single-file app: every non-empty inline
 * <script>/<style> body is pinned by its sha256; everything else stays
 * closed (default-src 'none', no external origins, no framing). A document
 * whose script/style bodies cannot be extracted (zero scripts — i.e. the
 * artifact does not match the expected shape) yields null: fail-closed to
 * the 302 fallback, never a guessed policy.
 */
export function buildAppUiAsset(html: string, sha256Hex: (text: string) => string): AppUiAsset | null {
  const scriptHashes = collectHashes(html, /<script\b[^>]*>([\s\S]*?)<\/script>/gi, sha256Hex);
  const styleHashes = collectHashes(html, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, sha256Hex);
  if (scriptHashes.length === 0) return null;
  const cspHeader =
    "default-src 'none'; " +
    `script-src ${scriptHashes.join(" ")}; ` +
    `style-src ${styleHashes.length > 0 ? styleHashes.join(" ") : "'none'"}; ` +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  return { html, cspHeader };
}

function collectHashes(html: string, pattern: RegExp, sha256Hex: (text: string) => string): readonly string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? "";
    if (body.length === 0) continue;
    hashes.push(`'sha256-${Buffer.from(sha256Hex(body), "hex").toString("base64")}'`);
  }
  return hashes;
}

/** Real sha256 (hex) used by the production loader. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Load the app-UI asset from the first candidate that exists and parses.
 * IO is injected so the decision stays unit-testable; any read/parse
 * failure on a PRESENT candidate is treated as absence (the 302 fallback),
 * never a broken server.
 */
export function loadAppUiAsset(
  candidates: readonly string[],
  exists: (path: string) => boolean,
  read: (path: string) => string | null
): AppUiAsset | null {
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const html = read(candidate);
    if (html === null) continue;
    const asset = buildAppUiAsset(html, sha256Hex);
    if (asset !== null) return asset;
  }
  return null;
}

/** The production wiring: resolve against this module's compiled location. */
export function loadAppUiAssetFromModuleLocation(
  exists: (path: string) => boolean,
  read: (path: string) => string | null
): AppUiAsset | null {
  return loadAppUiAsset(appUiCandidatePaths(dirname(fileURLToPath(import.meta.url))), exists, read);
}
