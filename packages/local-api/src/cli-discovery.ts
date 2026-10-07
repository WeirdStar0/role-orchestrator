/**
 * M11-02 "首启零配置" — read-only CLI auto-discovery for the first-run
 * experience. Detects whether the `claude` and `codex` CLIs are installed by
 * PROBING THE FILE SYSTEM ONLY:
 *
 *   1. every directory on the PATH environment variable, in PATH order (the
 *      order that also wins at spawn time);
 *   2. the common user-local install location (`~/.local/bin` — the native
 *      installers' target, whether or not it is on PATH);
 *   3. the npm global prefix taken from the environment ONLY
 *      (`npm_config_prefix` / `NPM_CONFIG_PREFIX`). npm is NEVER executed
 *      and `.npmrc` files are never parsed: a prefix configured only in
 *      `.npmrc` is honestly not discovered through this source (PATH still
 *      finds the shim in the common case).
 *
 * Hard red lines (M11-02 ask): pure read-only probing — ZERO shell
 * invocation, ZERO process execution of the probed paths, ZERO privilege
 * escalation. The only I/O is a caller-injected regular-file check
 * (`isRegularFile` in production); nothing is executed, nothing is written,
 * and a CLI that cannot be found is reported as NOT FOUND — never guessed.
 * A structural canary test pins that this module never imports
 * node:child_process and never contains spawn/exec vocabulary.
 *
 * Determinism notes:
 * - Candidate construction is PURE: `cliDiscoveryProbes` returns the full
 *   ordered candidate list so tests can drive the exact fixture matrix
 *   (found / not found / multiple candidates) with an injected file probe.
 * - Path semantics follow the INJECTED platform (win32 vs posix), not the
 *   host runtime, so the fixture matrix is byte-stable on every OS.
 * - Relative or empty PATH entries are IGNORED, not resolved against an
 *   arbitrary working directory (a cwd-dependent probe result would be a
 *   silent environment guess). Absolute installs only.
 * - Since a discovered profile stores the ABSOLUTE executable path, a CLI
 *   found through sources ②/③ keeps working at spawn time even though it is
 *   not on PATH.
 */
import { statSync } from "node:fs";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";

/** The CLIs this product can drive (frozen contracts RuntimeSchema values). */
export const DISCOVERED_CLI_NAMES = ["claude", "codex"] as const;
export type DiscoveredCliName = (typeof DISCOVERED_CLI_NAMES)[number];

/** Discovery platform selector: win32 path semantics vs posix path semantics. */
export type CliDiscoveryPlatform = "win32" | "posix";

/**
 * Where a found executable came from. `path` = a PATH directory (spawn-time
 * semantics); `user-local-bin` = ~/.local/bin; `npm-global-prefix` = the
 * npm prefix taken from the environment (prefix itself on win32 — the npm
 * bin directory IS the prefix there — prefix/bin on posix).
 */
export type CliDiscoverySource = "path" | "user-local-bin" | "npm-global-prefix";

/**
 * The environment snapshot discovery reads. Injected (never process.env
 * directly) so the pure functions stay fixture-testable; the production
 * snapshot is `cliDiscoveryEnvFromProcess(process.env)`.
 */
export interface CliDiscoveryEnv {
  readonly PATH?: string | undefined;
  readonly USERPROFILE?: string | undefined;
  readonly HOME?: string | undefined;
  readonly npm_config_prefix?: string | undefined;
}

/** The discovery verdict for ONE CLI. found:false carries nulls — no guesses. */
export interface CliFinding {
  readonly found: boolean;
  /** Absolute path of the discovered executable; null when not found. */
  readonly path: string | null;
  /** Which source produced the hit; null when not found. */
  readonly source: CliDiscoverySource | null;
}

const NOT_FOUND: CliFinding = { found: false, path: null, source: null };

/** Node path implementation following the INJECTED platform, not the host. */
export function platformPath(platform: CliDiscoveryPlatform): typeof pathPosix {
  return platform === "win32" ? pathWin32 : pathPosix;
}

/** Map a raw process.platform onto the discovery platform selector. */
export function cliDiscoveryPlatform(processPlatform: string): CliDiscoveryPlatform {
  return processPlatform === "win32" ? "win32" : "posix";
}

/**
 * Production environment snapshot: the few variables discovery reads. On
 * Windows the variable is spelled "Path" or "PATH" depending on the machine;
 * both forms are accepted. npm's prefix reaches the environment as
 * `npm_config_prefix` (npm-run context) or `NPM_CONFIG_PREFIX`.
 */
export function cliDiscoveryEnvFromProcess(
  processEnv: Readonly<Record<string, string | undefined>>
): CliDiscoveryEnv {
  return {
    PATH: processEnv.PATH ?? processEnv.Path,
    USERPROFILE: processEnv.USERPROFILE,
    HOME: processEnv.HOME,
    npm_config_prefix: processEnv.npm_config_prefix ?? processEnv.NPM_CONFIG_PREFIX
  };
}

/**
 * The executable file names tried per candidate directory. win32 spawns
 * through CreateProcess, so only extensioned, spawnable forms count
 * (.exe, then the npm shim forms .cmd/.bat); a POSIX directory resolves the
 * bare name. Order inside a directory is the preference order.
 */
export function cliExecutableNames(cli: DiscoveredCliName, platform: CliDiscoveryPlatform): readonly string[] {
  if (platform === "win32") {
    return [`${cli}.exe`, `${cli}.cmd`, `${cli}.bat`];
  }
  return [cli];
}

/**
 * Split a raw PATH-style variable into the absolute directories to probe, in
 * order, deduplicated. Empty entries (they would resolve against whatever
 * the current working directory happens to be) and RELATIVE entries (a
 * cwd-dependent result, i.e. an environment guess) are ignored.
 */
export function splitSearchPath(rawPathList: string | undefined, platform: CliDiscoveryPlatform): readonly string[] {
  if (rawPathList === undefined) return [];
  const { isAbsolute } = platformPath(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of rawPathList.split(delimiter)) {
    const dir = entry.trim();
    if (dir === "" || !isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/** One constructed candidate: an absolute path plus the source it came from. */
export interface CliProbe {
  readonly path: string;
  readonly source: CliDiscoverySource;
}

/**
 * The FULL ordered candidate list for one CLI — the pure heart of discovery.
 * Priority: PATH directories in PATH order, then the user-local bin
 * directory, then the npm global prefix. Sources whose environment variable
 * is absent are skipped (an absent HOME never fabricates a path).
 */
export function cliDiscoveryProbes(
  env: CliDiscoveryEnv,
  platform: CliDiscoveryPlatform,
  cli: DiscoveredCliName
): readonly CliProbe[] {
  const { join, isAbsolute } = platformPath(platform);
  const names = cliExecutableNames(cli, platform);
  const usable = (value: string | undefined): value is string =>
    value !== undefined && value.trim() !== "" && isAbsolute(value);

  const probes: CliProbe[] = [];
  for (const dir of splitSearchPath(env.PATH, platform)) {
    for (const name of names) probes.push({ path: join(dir, name), source: "path" });
  }
  const homeDir = platform === "win32" ? env.USERPROFILE : env.HOME;
  if (usable(homeDir)) {
    for (const name of names) {
      probes.push({ path: join(homeDir, ".local", "bin", name), source: "user-local-bin" });
    }
  }
  if (usable(env.npm_config_prefix)) {
    const npmPrefix = env.npm_config_prefix;
    // On Windows npm's global bin directory IS the prefix (e.g. %APPDATA%\npm);
    // on POSIX executables land in <prefix>/bin.
    const binDir = platform === "win32" ? npmPrefix : join(npmPrefix, "bin");
    for (const name of names) probes.push({ path: join(binDir, name), source: "npm-global-prefix" });
  }
  return probes;
}

/**
 * Discover ONE CLI: the first candidate that is an existing REGULAR file
 * wins. Everything else — including probe errors — is an honest NOT FOUND.
 * `isFile` is injected (production: `isRegularFile`); NO process is ever
 * started and NO shell is ever involved.
 */
export function discoverCli(
  env: CliDiscoveryEnv,
  platform: CliDiscoveryPlatform,
  cli: DiscoveredCliName,
  isFile: (candidate: string) => boolean
): CliFinding {
  for (const probe of cliDiscoveryProbes(env, platform, cli)) {
    if (isFile(probe.path)) {
      return { found: true, path: probe.path, source: probe.source };
    }
  }
  return NOT_FOUND;
}

/** Discover both known CLIs (the fixed contracts vocabulary: claude, codex). */
export function discoverKnownClis(
  env: CliDiscoveryEnv,
  platform: CliDiscoveryPlatform,
  isFile: (candidate: string) => boolean
): Readonly<Record<DiscoveredCliName, CliFinding>> {
  return {
    claude: discoverCli(env, platform, "claude", isFile),
    codex: discoverCli(env, platform, "codex", isFile)
  };
}

/**
 * Production file probe: a REGULAR file (a directory named `claude` never
 * counts as an installed CLI); every stat error — including permission
 * noise — is simply "not found". Read-only; never follows into contents.
 */
export function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
