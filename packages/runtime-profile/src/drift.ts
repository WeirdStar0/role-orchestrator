import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ExternalConfigViolationKind } from "./errors.js";
import { ExternalConfigViolationError } from "./errors.js";
import { canonicalJson, sha256Hex, sha256HexOfBytes } from "./hashing.js";

/**
 * A34 (detection half) — external host-configuration drift detection.
 *
 * SECURITY BOUNDARY (summarized here, detailed in README.md):
 * - Only files EXPLICITLY listed in the profile revision's manifest are read
 *   and hashed. Nothing is ever scanned, globbed or enumerated beyond the
 *   declared list.
 * - Files whose name matches a credential pattern (auth/token/secret/...)
 *   are refused at manifest registration AND again at hash time — the check
 *   below re-runs the screen so a tampered database row cannot resurrect a
 *   credential path.
 * - Manifest entries must be relative, must stay inside the profile's
 *   configDir (`..` and absolute forms refused), and symlinks are refused
 *   rather than followed (junctions/symlinks surface as `symlink`, and a
 *   parent-directory link that resolves outside configDir is refused via
 *   realpath containment).
 * - Files above the size cap are refused, not truncated and not hashed.
 * - File CONTENT never leaves this module: only sha256 digests and sizes do.
 */

/** Default per-file cap: host CLI config files are small; 1 MiB is generous. */
export const DEFAULT_EXTERNAL_CONFIG_MAX_FILE_BYTES = 1_048_576;

/**
 * Credential filename patterns. Matching is case-insensitive against the full
 * relative path (so dotfiles like `.credentials.json` and nested paths like
 * `creds/credentials.json` hit). Bare "key" is deliberately NOT a substring
 * pattern (too many false positives like `keybindings.json`); key material is
 * caught via the extension list (`.key`, `.pem`, ...).
 */
export const CREDENTIAL_NAME_SUBSTRINGS: readonly string[] = [
  "auth",
  "credential",
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "api-key",
  "oauth",
  "cookie",
  "netrc",
  "privatekey",
  "private_key",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "keystore",
  "sessionkey",
  "masterkey"
] as const;

export const CREDENTIAL_FILE_EXTENSIONS: readonly string[] = [
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".kdbx",
  ".jks"
] as const;

/** True when the relative path looks like credential material and must never be hashed. */
export function isCredentialishRelativePath(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (CREDENTIAL_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return true;
  }
  // Collapse separators so "creds\auth.json" and "creds/auth.json" both match.
  const collapsed = lower.replaceAll("\\", "/");
  return CREDENTIAL_NAME_SUBSTRINGS.some((needle) => collapsed.includes(needle));
}

export type ExternalFileStatus = ExternalConfigViolationKind | "ok";

export interface ExternalFileCheck {
  /** Normalized, configDir-relative POSIX path. */
  readonly path: string;
  readonly status: ExternalFileStatus;
  /** sha256 hex when status is "ok"; never the content itself. */
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly detail: string | null;
}

const ExternalConfigOptionsSchema = z.strictObject({
  maxFileBytes: z.number().int().min(1).max(64 * 1_048_576).default(DEFAULT_EXTERNAL_CONFIG_MAX_FILE_BYTES)
});

export interface ExternalConfigOptions {
  readonly maxFileBytes?: number | undefined;
}

/**
 * Normalize and validate ONE manifest path (static checks only, no fs):
 * separators normalized to POSIX; absolute forms, `..` escapes, empty/`.`
 * segments and control characters refused. Returns the normalized path.
 * Throws `ExternalConfigViolationError`.
 */
export function normalizeExternalConfigRelativePath(rawPath: string): string {
  if (rawPath.length === 0) {
    throw new ExternalConfigViolationError("invalid-path", rawPath, "manifest path is empty");
  }
  if (/[\0-\x1f]/.test(rawPath)) {
    throw new ExternalConfigViolationError("invalid-path", rawPath, "manifest path contains control characters");
  }
  if (path.win32.isAbsolute(rawPath) || path.posix.isAbsolute(rawPath)) {
    throw new ExternalConfigViolationError("absolute-path", rawPath, "manifest path must be relative");
  }
  const posix = rawPath.replaceAll("\\", "/");
  const segments = posix.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      throw new ExternalConfigViolationError("path-escape", rawPath, "manifest path must not contain '..'");
    }
    if (segment === "." || segment.length === 0) {
      throw new ExternalConfigViolationError("invalid-path", rawPath, "manifest path contains an empty or '.' segment");
    }
    if (segment.includes(":")) {
      // Covers "C:" and drive-relative forms like "C:config", which Windows
      // would resolve against the drive's current directory.
      throw new ExternalConfigViolationError(
        "absolute-path",
        rawPath,
        "manifest path must be relative (no drive-qualified forms)"
      );
    }
  }
  return posix;
}

/**
 * Validate + normalize a whole manifest: every entry statically checked,
 * credential-screened, deduplicated, sorted. `requireClean` (registration
 * path) throws on the first refusal; otherwise refusals are returned as
 * structured per-file entries (drift path).
 */
export function normalizeExternalConfigManifest(
  rawFiles: readonly string[],
  requireClean: boolean
): readonly ExternalFileCheck[] {
  const seen = new Set<string>();
  const out: ExternalFileCheck[] = [];
  for (const raw of rawFiles) {
    try {
      const normalized = normalizeExternalConfigRelativePath(raw);
      if (isCredentialishRelativePath(normalized)) {
        throw new ExternalConfigViolationError(
          "credential-pattern",
          normalized,
          `manifest entry "${normalized}" matches a credential filename pattern and must not be hashed`
        );
      }
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      out.push({ path: normalized, status: "ok", sha256: null, sizeBytes: null, detail: null });
    } catch (error) {
      if (requireClean || !(error instanceof ExternalConfigViolationError)) {
        throw error;
      }
      out.push({
        path: raw,
        status: error.kind,
        sha256: null,
        sizeBytes: null,
        detail: error.message
      });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

interface InspectedFile {
  readonly path: string;
  readonly status: ExternalFileStatus;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly detail: string | null;
}

async function inspectVettedFile(
  configDir: string,
  entry: ExternalFileCheck,
  maxFileBytes: number,
  realBase: string
): Promise<InspectedFile> {
  if (entry.status !== "ok") {
    return entry;
  }
  const absolutePath = path.resolve(configDir, entry.path);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ...entry, status: "missing-file", detail: "file does not exist" };
    }
    return { ...entry, status: "unreadable", detail: `lstat failed (${code ?? "unknown"})` };
  }
  if (stats.isSymbolicLink()) {
    return { ...entry, status: "symlink", detail: "symlinks are refused, never followed" };
  }
  if (!stats.isFile()) {
    return { ...entry, status: "not-regular-file", detail: "only regular files can be hashed" };
  }
  if (stats.size > maxFileBytes) {
    return {
      ...entry,
      status: "too-large",
      sizeBytes: stats.size,
      detail: `file is ${String(stats.size)} bytes; cap is ${String(maxFileBytes)}`
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...entry, status: "unreadable", detail: `read failed (${code ?? "unknown"})` };
  }
  if (bytes.length > maxFileBytes) {
    return {
      ...entry,
      status: "too-large",
      sizeBytes: bytes.length,
      detail: "file grew past the cap between stat and read"
    };
  }
  // Containment re-check with symlinks RESOLVED: a symlinked parent directory
  // must not move the file outside configDir. (The file itself was already
  // refused if it was a symlink; this catches directory-level escapes.)
  try {
    const realFile = await realpath(absolutePath);
    const contained =
      realFile === realBase || realFile.startsWith(realBase + path.sep);
    if (!contained) {
      return {
        ...entry,
        status: "path-escape",
        detail: "path resolves outside the profile configDir through a linked parent"
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...entry, status: "unreadable", detail: `realpath failed (${code ?? "unknown"})` };
  }
  return { ...entry, sha256: sha256HexOfBytes(bytes), sizeBytes: bytes.length, detail: null };
}

function manifestHashOf(files: readonly { readonly path: string; readonly sha256: string }[]): string {
  return sha256Hex(
    canonicalJson({ files: files.map((f) => ({ path: f.path, sha256: f.sha256 })) })
  );
}

export interface ExternalConfigBaseline {
  readonly manifestHash: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }[];
}

/**
 * Compute the baseline hash for an EXPLICIT manifest. Every entry must pass
 * the static checks and read cleanly — a baseline over missing/refused files
 * is never produced (throws `ExternalConfigViolationError`).
 */
export async function hashExternalConfigFiles(
  configDir: string,
  rawFiles: readonly string[],
  options: ExternalConfigOptions = {}
): Promise<ExternalConfigBaseline> {
  const parsedOptions = ExternalConfigOptionsSchema.parse(options);
  const manifest = normalizeExternalConfigManifest(rawFiles, true);
  const realBase = await resolveConfigDirBase(configDir);
  const inspected: InspectedFile[] = [];
  for (const entry of manifest) {
    inspected.push(
      await inspectVettedFile(configDir, entry, parsedOptions.maxFileBytes, realBase)
    );
  }
  const bad = inspected.find(
    (file): file is InspectedFile & { readonly status: Exclude<ExternalFileStatus, "ok"> } =>
      file.status !== "ok"
  );
  if (bad !== undefined) {
    throw new ExternalConfigViolationError(
      bad.status,
      bad.path,
      `cannot baseline "${bad.path}": ${bad.status}${bad.detail === null ? "" : ` (${bad.detail})`}`
    );
  }
  const files = inspected.flatMap((file) =>
    file.sha256 !== null && file.sizeBytes !== null
      ? [{ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }]
      : []
  );
  return { manifestHash: manifestHashOf(files), files };
}

async function resolveConfigDirBase(configDir: string): Promise<string> {
  let stats;
  try {
    stats = await lstat(configDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ExternalConfigViolationError(
      "missing-file",
      configDir,
      `configDir is not accessible (${code ?? "unknown"})`,
      { cause: error }
    );
  }
  if (stats.isSymbolicLink()) {
    throw new ExternalConfigViolationError(
      "symlink",
      configDir,
      "configDir itself is a symlink; refusing rather than following it"
    );
  }
  if (!stats.isDirectory()) {
    throw new ExternalConfigViolationError("not-regular-file", configDir, "configDir is not a directory");
  }
  return realpath(configDir);
}

export interface ExternalConfigDriftResult {
  readonly configDir: string;
  readonly maxFileBytes: number;
  readonly expectedHash: string;
  /** null when any file could not be verified (drift is then true, fail-closed). */
  readonly actualHash: string | null;
  readonly drifted: boolean;
  readonly files: readonly ExternalFileCheck[];
}

const DetectDriftInputSchema = z.strictObject({
  configDir: z.string().min(1).max(2048),
  files: z.array(z.string().min(1).max(1024)).max(256),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  options: ExternalConfigOptionsSchema.optional()
});

/**
 * Recompute the manifest hash NOW and compare with the revision's baseline.
 * Returns a STRUCTURED result — drift is a finding, not an exception:
 * - any file modified/missing/refused  -> drifted: true, actualHash: null
 * - all files verifiable, hash differs -> drifted: true with actualHash
 * - all files verifiable, hash equal   -> drifted: false
 * Files present in the configDir but NOT in the manifest are irrelevant by
 * design (only the explicit list is ever read).
 */
export async function detectExternalConfigDrift(input: {
  readonly configDir: string;
  readonly files: readonly string[];
  readonly expectedHash: string;
  readonly options?: ExternalConfigOptions | undefined;
}): Promise<ExternalConfigDriftResult> {
  const value = DetectDriftInputSchema.parse(input);
  const parsedOptions =
    value.options === undefined
      ? ExternalConfigOptionsSchema.parse({})
      : value.options;
  const manifest = normalizeExternalConfigManifest(value.files, false);
  const files: ExternalFileCheck[] = [];
  try {
    const realBase = await resolveConfigDirBase(value.configDir);
    for (const entry of manifest) {
      files.push(
        await inspectVettedFile(value.configDir, entry, parsedOptions.maxFileBytes, realBase)
      );
    }
  } catch (error) {
    if (error instanceof ExternalConfigViolationError) {
      // configDir itself missing/symlinked/not-a-directory: fail closed.
      return {
        configDir: value.configDir,
        maxFileBytes: parsedOptions.maxFileBytes,
        expectedHash: value.expectedHash,
        actualHash: null,
        drifted: true,
        files: [
          ...files,
          { path: value.configDir, status: error.kind, sha256: null, sizeBytes: null, detail: error.message }
        ]
      };
    }
    throw error;
  }
  const allOk = files.every((file) => file.status === "ok");
  const hashed = files.flatMap((file) =>
    file.status === "ok" && file.sha256 !== null ? [{ path: file.path, sha256: file.sha256 }] : []
  );
  const actualHash = allOk && hashed.length === files.length ? manifestHashOf(hashed) : null;
  return {
    configDir: value.configDir,
    maxFileBytes: parsedOptions.maxFileBytes,
    expectedHash: value.expectedHash,
    actualHash,
    drifted: !allOk || actualHash !== value.expectedHash,
    files
  };
}
