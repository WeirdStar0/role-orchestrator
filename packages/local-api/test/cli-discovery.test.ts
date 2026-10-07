/**
 * M11-02 — the READ-ONLY CLI auto-discovery pure functions, driven through
 * the full fixture matrix (found / not found / multiple candidates) with an
 * INJECTED file probe: no real filesystem, no real environment, and — the
 * red line this file pins — ZERO process execution anywhere in the module
 * under test (the structural canary at the bottom reads the source and
 * refuses child_process import or spawn/exec vocabulary).
 *
 * Path semantics follow the INJECTED platform, so the win32 and posix
 * matrices both run on every host OS.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cliDiscoveryPlatform,
  cliDiscoveryProbes,
  cliExecutableNames,
  discoverCli,
  discoverKnownClis,
  isRegularFile,
  platformPath,
  splitSearchPath,
  type CliDiscoveryEnv
} from "../src/cli-discovery.js";

/** A fixture "filesystem": the probe answers true exactly for these paths. */
function fsProbe(existing: ReadonlySet<string>): (candidate: string) => boolean {
  return (candidate) => existing.has(candidate);
}

const WIN_ENV: CliDiscoveryEnv = {
  PATH: "C:\\Windows\\system32;D:\\tools;C:\\Windows\\system32",
  USERPROFILE: "C:\\users\\dev",
  npm_config_prefix: "C:\\npm\\global"
};

const POSIX_ENV: CliDiscoveryEnv = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: "/home/dev",
  npm_config_prefix: "/usr"
};

describe("cliExecutableNames (per-platform spawnable forms)", () => {
  it("win32 prefers .exe, then the npm shim forms .cmd/.bat", () => {
    expect(cliExecutableNames("claude", "win32")).toEqual(["claude.exe", "claude.cmd", "claude.bat"]);
    expect(cliExecutableNames("codex", "win32")).toEqual(["codex.exe", "codex.cmd", "codex.bat"]);
  });

  it("posix resolves the bare name only", () => {
    expect(cliExecutableNames("claude", "posix")).toEqual(["claude"]);
    expect(cliExecutableNames("codex", "posix")).toEqual(["codex"]);
  });
});

describe("splitSearchPath (PATH hygiene)", () => {
  it("splits on the platform delimiter, in order, deduplicated", () => {
    expect(splitSearchPath("C:\\a;C:\\b;C:\\a", "win32")).toEqual(["C:\\a", "C:\\b"]);
    expect(splitSearchPath("/a:/b:/a", "posix")).toEqual(["/a", "/b"]);
  });

  it("ignores empty and RELATIVE entries (a cwd-dependent probe is an environment guess)", () => {
    expect(splitSearchPath(";.;bin\\;C:\\abs;;", "win32")).toEqual(["C:\\abs"]);
    expect(splitSearchPath("::bin:.:/abs", "posix")).toEqual(["/abs"]);
  });

  it("an absent PATH variable contributes no directories", () => {
    expect(splitSearchPath(undefined, "win32")).toEqual([]);
  });
});

describe("cliDiscoveryProbes (pure candidate construction)", () => {
  it("orders PATH dirs first (each win32 name form), then user-local bin, then the npm prefix", () => {
    const probes = cliDiscoveryProbes(WIN_ENV, "win32", "claude");
    expect(probes).toEqual([
      { path: "C:\\Windows\\system32\\claude.exe", source: "path" },
      { path: "C:\\Windows\\system32\\claude.cmd", source: "path" },
      { path: "C:\\Windows\\system32\\claude.bat", source: "path" },
      { path: "D:\\tools\\claude.exe", source: "path" },
      { path: "D:\\tools\\claude.cmd", source: "path" },
      { path: "D:\\tools\\claude.bat", source: "path" },
      { path: "C:\\users\\dev\\.local\\bin\\claude.exe", source: "user-local-bin" },
      { path: "C:\\users\\dev\\.local\\bin\\claude.cmd", source: "user-local-bin" },
      { path: "C:\\users\\dev\\.local\\bin\\claude.bat", source: "user-local-bin" },
      { path: "C:\\npm\\global\\claude.exe", source: "npm-global-prefix" },
      { path: "C:\\npm\\global\\claude.cmd", source: "npm-global-prefix" },
      { path: "C:\\npm\\global\\claude.bat", source: "npm-global-prefix" }
    ]);
  });

  it("posix form: bare names; the npm prefix contributes <prefix>/bin", () => {
    const probes = cliDiscoveryProbes(POSIX_ENV, "posix", "codex");
    expect(probes).toEqual([
      { path: "/usr/local/bin/codex", source: "path" },
      { path: "/usr/bin/codex", source: "path" },
      { path: "/home/dev/.local/bin/codex", source: "user-local-bin" },
      { path: "/usr/bin/codex", source: "npm-global-prefix" }
    ]);
  });

  it("sources whose environment variable is missing are skipped (never fabricated)", () => {
    const probes = cliDiscoveryProbes({ PATH: "C:\\only" }, "win32", "claude");
    expect(probes).toEqual([
      { path: "C:\\only\\claude.exe", source: "path" },
      { path: "C:\\only\\claude.cmd", source: "path" },
      { path: "C:\\only\\claude.bat", source: "path" }
    ]);
  });

  it("a relative npm prefix or home is not probed (absolute installs only)", () => {
    const probes = cliDiscoveryProbes(
      { PATH: "C:\\a", USERPROFILE: "relative-user", npm_config_prefix: "relative-npm" },
      "win32",
      "claude"
    );
    expect(probes.every((probe) => probe.source === "path")).toBe(true);
  });
});

describe("discoverCli / discoverKnownClis (the verdict matrix)", () => {
  it("found: the first existing regular file wins — PATH order across dirs", () => {
    const { join } = platformPath("win32");
    // A hit in the FIRST PATH dir outranks a hit in a later PATH dir.
    const first = join("C:\\Windows\\system32", "claude.exe");
    const later = join("D:\\tools", "claude.exe");
    expect(discoverCli(WIN_ENV, "win32", "claude", fsProbe(new Set([first, later])))).toEqual({
      found: true,
      path: first,
      source: "path"
    });
  });

  it("multiple candidates: within one directory the spawn-preference order holds (.exe > .cmd > .bat)", () => {
    const { join } = platformPath("win32");
    const existing = new Set([join("C:\\Windows\\system32", "claude.cmd"), join("C:\\Windows\\system32", "claude.bat")]);
    const found = discoverCli(WIN_ENV, "win32", "claude", fsProbe(existing));
    expect(found).toEqual({
      found: true,
      path: "C:\\Windows\\system32\\claude.cmd",
      source: "path"
    });
  });

  it("found via user-local-bin when nothing is on PATH; PATH still outranks it when both exist", () => {
    const { join } = platformPath("win32");
    const userLocal = join("C:\\users\\dev\\.local\\bin", "claude.exe");
    expect(discoverCli({ ...WIN_ENV, PATH: "C:\\nowhere" }, "win32", "claude", fsProbe(new Set([userLocal])))).toEqual({
      found: true,
      path: userLocal,
      source: "user-local-bin"
    });
    // PATH hit outranks the same file discoverable as user-local-bin.
    const onPath = join("D:\\tools", "claude.exe");
    expect(discoverCli(WIN_ENV, "win32", "claude", fsProbe(new Set([userLocal, onPath])))).toEqual({
      found: true,
      path: onPath,
      source: "path"
    });
  });

  it("found via the npm global prefix (win32: the prefix IS the bin dir; posix: <prefix>/bin)", () => {
    const { join } = platformPath("win32");
    expect(
      discoverCli({ ...WIN_ENV, PATH: undefined, USERPROFILE: undefined }, "win32", "codex", fsProbe(new Set([join("C:\\npm\\global", "codex.cmd")])))
    ).toEqual({ found: true, path: "C:\\npm\\global\\codex.cmd", source: "npm-global-prefix" });

    expect(
      discoverCli({ ...POSIX_ENV, PATH: undefined, HOME: undefined }, "posix", "claude", fsProbe(new Set(["/usr/bin/claude"])))
    ).toEqual({ found: true, path: "/usr/bin/claude", source: "npm-global-prefix" });
  });

  it("not found anywhere is an honest null-verdict (no path, no source, no guess)", () => {
    expect(discoverCli(WIN_ENV, "win32", "claude", fsProbe(new Set()))).toEqual({
      found: false,
      path: null,
      source: null
    });
    // A DIRECTORY named like the CLI does not count (probe = regular file).
    expect(discoverKnownClis(WIN_ENV, "win32", () => false)).toEqual({
      claude: { found: false, path: null, source: null },
      codex: { found: false, path: null, source: null }
    });
  });

  it("a misbehaving injected probe propagates (fail-loud); the PRODUCTION probe never throws", () => {
    // discoverCli's contract expects a boolean-answering probe; misuse of the
    // injection point is the caller's bug and surfaces loudly. The production
    // probe (isRegularFile, tested above) swallows every stat error itself.
    expect(() =>
      discoverCli(WIN_ENV, "win32", "codex", () => {
        throw new Error("EACCES noise");
      })
    ).toThrow("EACCES noise");
  });
});

describe("production helpers", () => {
  it("cliDiscoveryPlatform maps the raw process platform (win32 vs everything else)", () => {
    expect(cliDiscoveryPlatform("win32")).toBe("win32");
    expect(cliDiscoveryPlatform("linux")).toBe("posix");
    expect(cliDiscoveryPlatform("darwin")).toBe("posix");
  });

  it("isRegularFile: true for a real file, false for a directory and for misses", () => {
    // This spec file is a real regular file; its parent directory is not.
    const thisFile = fileURLToPath(import.meta.url);
    expect(isRegularFile(thisFile)).toBe(true);
    expect(isRegularFile(thisFile.replace(/[^\\/]+$/, ""))).toBe(false);
    expect(isRegularFile(thisFile + ".definitely-absent")).toBe(false);
  });
});

describe("structural canary: discovery NEVER executes a process (M11-02 red line)", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/cli-discovery.ts", import.meta.url)), "utf8");

  it("never imports node:child_process", () => {
    // Import-statement forms only: the module doc NAMES the red line in
    // prose, so a whole-file substring check would self-trip.
    expect(source).not.toMatch(/from\s+"node:child_process"/);
    expect(source).not.toMatch(/require\(\s*"node:child_process"/);
  });

  it("carries no spawn/exec vocabulary", () => {
    expect(source).not.toMatch(/\bspawn\(/);
    expect(source).not.toMatch(/\bexec(Fork|File|FileSync)?\s*\(/);
    expect(source).not.toMatch(/\bexecSync\b/);
  });

  it("only touches node:fs metadata and node:path (no net, no shell)", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(["node:fs", "node:path"]);
  });
});
