import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_FILE_EXTENSIONS,
  CREDENTIAL_NAME_SUBSTRINGS,
  DEFAULT_EXTERNAL_CONFIG_MAX_FILE_BYTES,
  detectExternalConfigDrift,
  ExternalConfigViolationError,
  hashExternalConfigFiles,
  isCredentialishRelativePath,
  normalizeExternalConfigManifest,
  normalizeExternalConfigRelativePath
} from "../src/index.js";
import { makeFixtureConfigDir } from "./helpers.js";

const tempRoots: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ro-rp-drift-"));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("A34 detection: credential filename patterns are pinned by tests", () => {
  it("refuses auth/credentials/token-style names (case-insensitive, any directory depth)", () => {
    const mustRefuse = [
      "auth.json",
      ".auth",
      ".credentials.json",
      "credentials.yaml",
      "creds/credentials.json",
      "token.txt",
      "oauth_token.json",
      "OAuth-Tokens.dat",
      "api_key.yaml",
      "apikey.json",
      "API-KEY.env",
      "secrets.toml",
      "secret_store.db",
      "password.txt",
      "passwd",
      ".netrc",
      "netrc",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      "deeply/nested/private_key.pem",
      "keystore.jks",
      "login.cookie.json",
      "sessionkey.bin",
      "masterkey.dat"
    ];
    for (const path of mustRefuse) {
      expect(isCredentialishRelativePath(path), path).toBe(true);
    }
  });

  it("refuses key-material extensions", () => {
    for (const ext of CREDENTIAL_FILE_EXTENSIONS) {
      expect(isCredentialishRelativePath(`server${ext}`), ext).toBe(true);
    }
  });

  it("does not over-block ordinary config names", () => {
    const mustAllow = [
      "settings.json",
      "mcp.json",
      "config.toml",
      "keybindings.json",
      "monkey.json",
      "prompts.md",
      "themes.json",
      "sub/dir/settings.local.json"
    ];
    for (const path of mustAllow) {
      expect(isCredentialishRelativePath(path), path).toBe(false);
    }
  });

  it("the exported pattern lists are non-empty (drift protection for the list itself)", () => {
    expect(CREDENTIAL_NAME_SUBSTRINGS.length).toBeGreaterThan(10);
    expect(CREDENTIAL_FILE_EXTENSIONS).toContain(".pem");
  });
});

describe("manifest path normalization", () => {
  it("normalizes backslashes and keeps relative paths", () => {
    expect(normalizeExternalConfigRelativePath("settings.json")).toBe("settings.json");
    expect(normalizeExternalConfigRelativePath("sub\\dir\\mcp.json")).toBe("sub/dir/mcp.json");
  });

  it("refuses absolute paths in every spelling", () => {
    for (const path of ["/etc/config", "C:\\config", "C:config", "\\\\server\\share\\c", "\\config"]) {
      expect(() => normalizeExternalConfigRelativePath(path), path).toThrowError(
        ExternalConfigViolationError
      );
    }
  });

  it("refuses '..' escapes and malformed segments", () => {
    for (const path of ["../outside", "a/../../b", "a//b", "./a", "."]) {
      expect(() => normalizeExternalConfigRelativePath(path), path).toThrowError(
        ExternalConfigViolationError
      );
    }
    expect(() => normalizeExternalConfigRelativePath("../outside")).toThrowError(/'\.\.'/);
  });

  it("refuses control characters and empty paths", () => {
    expect(() => normalizeExternalConfigRelativePath("a\u0000b")).toThrowError(
      ExternalConfigViolationError
    );
    expect(() => normalizeExternalConfigRelativePath("")).toThrowError(/empty/);
  });

  it("manifest-level normalization dedupes and sorts; clean mode throws on refusals", () => {
    const entries = normalizeExternalConfigManifest(
      ["mcp.json", "settings.json", "mcp.json", "sub/dir/b.toml"],
      true
    );
    expect(entries.map((e) => e.path)).toEqual(["mcp.json", "settings.json", "sub/dir/b.toml"]);
    // Clean mode (registration) refuses the whole manifest on any bad entry:
    expect(() =>
      normalizeExternalConfigManifest(["mcp.json", "auth.json", "../escape"], true)
    ).toThrowError(ExternalConfigViolationError);
  });

  it("manifest-level normalization in drift mode returns structured refusals", () => {
    const entries = normalizeExternalConfigManifest(["auth.json", "settings.json"], false);
    expect(entries.find((e) => e.path === "auth.json")?.status).toBe("credential-pattern");
    expect(entries.find((e) => e.path === "settings.json")?.status).toBe("ok");
  });
});

describe("baseline hashing (hashExternalConfigFiles)", () => {
  it("hashes exactly the declared files, deterministically", async () => {
    const { dir } = makeFixtureConfigDir();
    const first = await hashExternalConfigFiles(dir, ["settings.json", "mcp.json"]);
    const second = await hashExternalConfigFiles(dir, ["mcp.json", "settings.json"]);
    expect(first.manifestHash).toBe(second.manifestHash);
    expect(first.files.map((f) => f.path)).toEqual(["mcp.json", "settings.json"]);
    expect(first.files.every((f) => f.sha256.length === 64)).toBe(true);
  });

  it("a changed file produces a different baseline", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "config.toml"), "a = 1\n", "utf8");
    const before = await hashExternalConfigFiles(dir, ["config.toml"]);
    writeFileSync(join(dir, "config.toml"), "a = 2\n", "utf8");
    const after = await hashExternalConfigFiles(dir, ["config.toml"]);
    expect(before.manifestHash).not.toBe(after.manifestHash);
  });

  it("refuses credential files from ever entering a baseline", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "auth.json"), "{}", "utf8");
    await expectRejectionKind(
      hashExternalConfigFiles(dir, ["auth.json"]),
      "credential-pattern"
    );
  });

  it("refuses missing files (a baseline over absent files is never produced)", async () => {
    const dir = makeDir();
    await expectRejectionKind(
      hashExternalConfigFiles(dir, ["does-not-exist.toml"]),
      "missing-file"
    );
  });

  it("enforces the file size cap instead of hashing oversized files", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "big.toml"), "x".repeat(32), "utf8");
    await expectRejectionKind(
      hashExternalConfigFiles(dir, ["big.toml"], { maxFileBytes: 16 }),
      "too-large"
    );
  });

  it("the default cap is 1 MiB", () => {
    expect(DEFAULT_EXTERNAL_CONFIG_MAX_FILE_BYTES).toBe(1_048_576);
  });
});

describe("drift detection (detectExternalConfigDrift) returns structured results", () => {
  it("unchanged files: drifted=false with matching hashes", async () => {
    const { dir } = makeFixtureConfigDir();
    const baseline = await hashExternalConfigFiles(dir, ["settings.json", "mcp.json"]);
    const result = await detectExternalConfigDrift({
      configDir: dir,
      files: ["settings.json", "mcp.json"],
      expectedHash: baseline.manifestHash
    });
    expect(result.drifted).toBe(false);
    expect(result.actualHash).toBe(baseline.manifestHash);
    expect(result.files.every((f) => f.status === "ok")).toBe(true);
  });

  it("a modified declared file: drifted=true, actualHash present and different", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "config.toml"), "a = 1\n", "utf8");
    const baseline = await hashExternalConfigFiles(dir, ["config.toml"]);
    writeFileSync(join(dir, "config.toml"), "a = 999\n", "utf8");
    const result = await detectExternalConfigDrift({
      configDir: dir,
      files: ["config.toml"],
      expectedHash: baseline.manifestHash
    });
    expect(result.drifted).toBe(true);
    expect(result.actualHash).not.toBeNull();
    expect(result.actualHash).not.toBe(baseline.manifestHash);
  });

  it("a deleted declared file: drifted=true with a missing-file status (fail-closed)", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "config.toml"), "a = 1\n", "utf8");
    const baseline = await hashExternalConfigFiles(dir, ["config.toml"]);
    rmSync(join(dir, "config.toml"));
    const result = await detectExternalConfigDrift({
      configDir: dir,
      files: ["config.toml"],
      expectedHash: baseline.manifestHash
    });
    expect(result.drifted).toBe(true);
    expect(result.actualHash).toBeNull();
    expect(result.files[0]?.status).toBe("missing-file");
  });

  it("UNTRACKED extra files in the configDir are irrelevant (only the explicit list is read)", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "config.toml"), "a = 1\n", "utf8");
    const baseline = await hashExternalConfigFiles(dir, ["config.toml"]);
    writeFileSync(join(dir, "untracked-extra.toml"), "surprise = true\n", "utf8");
    const result = await detectExternalConfigDrift({
      configDir: dir,
      files: ["config.toml"],
      expectedHash: baseline.manifestHash
    });
    expect(result.drifted).toBe(false);
  });

  it("a tampered manifest row containing a credential path yields a structured refusal, never a hash", async () => {
    const { dir } = makeFixtureConfigDir();
    writeFileSync(join(dir, "auth.json"), '{"token":"synthetic"}', "utf8");
    const result = await detectExternalConfigDrift({
      configDir: dir,
      files: ["auth.json"],
      expectedHash: "a".repeat(64)
    });
    expect(result.drifted).toBe(true);
    expect(result.files[0]?.status).toBe("credential-pattern");
    expect(result.files[0]?.sha256).toBeNull();
  });

  it("oversized files are refused at drift time too (structured, fail-closed)", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, "big.toml"), "x".repeat(32), "utf8");
    const baseline = await hashExternalConfigFiles(dir, ["big.toml"]);
    const result = await detectExternalConfigDrift({
      configDir: dir,
      files: ["big.toml"],
      expectedHash: baseline.manifestHash,
      options: { maxFileBytes: 16 }
    });
    expect(result.drifted).toBe(true);
    expect(result.actualHash).toBeNull();
    expect(result.files[0]?.status).toBe("too-large");
    expect(result.maxFileBytes).toBe(16);
  });

  it("a missing configDir is drift, not an exception", async () => {
    const result = await detectExternalConfigDrift({
      configDir: join(makeDir(), "vanished"),
      files: ["config.toml"],
      expectedHash: "a".repeat(64)
    });
    expect(result.drifted).toBe(true);
    expect(result.actualHash).toBeNull();
  });
});

describe("symlinks are refused, never followed", () => {
  it("a linked entry inside configDir is refused with status 'symlink'", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(dir, "config.toml"), "a = 1\n", "utf8");
    writeFileSync(join(outside, "config.toml"), "a = 2\n", "utf8");
    const linkPath = createLink(join(outside, "config.toml"), join(dir, "linked.toml"));
    if (linkPath === null) {
      throw new Error(
        "test environment cannot create symlinks or junctions; the no-follow guarantee could not be exercised"
      );
    }
    return (async () => {
      const result = await detectExternalConfigDrift({
        configDir: dir,
        files: ["linked.toml"],
        expectedHash: "a".repeat(64)
      });
      expect(result.drifted).toBe(true);
      expect(result.files[0]?.status).toBe("symlink");
      expect(result.files[0]?.sha256).toBeNull();
      // Baseline path refuses outright:
      await expectRejectionKind(hashExternalConfigFiles(dir, ["linked.toml"]), "symlink");
    })();
  });

  it("a symlinked PARENT directory that escapes configDir is refused via containment", () => {
    const dir = makeDir();
    const outside = makeDir();
    writeFileSync(join(outside, "config.toml"), "a = 2\n", "utf8");
    const linkPath = createLink(outside, join(dir, "link"));
    if (linkPath === null) {
      throw new Error(
        "test environment cannot create symlinks or junctions; the containment guarantee could not be exercised"
      );
    }
    return (async () => {
      const result = await detectExternalConfigDrift({
        configDir: dir,
        files: ["link/config.toml"],
        expectedHash: "a".repeat(64)
      });
      expect(result.drifted).toBe(true);
      expect(["path-escape", "symlink"]).toContain(result.files[0]?.status);
    })();
  }
  );
});

/**
 * Create a link without following it. Tries a file symlink first (needs
 * privilege on Windows, often EPERM) and falls back to an NTFS junction
 * (unprivileged; surfaces as a symlink to lstat). Returns the link path or
 * null when the environment supports neither.
 */
function createLink(target: string, linkPath: string): string | null {
  try {
    symlinkSync(target, linkPath, "file");
    return linkPath;
  } catch {
    // fall through to junction
  }
  try {
    symlinkSync(target, linkPath, "junction");
    return linkPath;
  } catch {
    return null;
  }
}

async function expectRejectionKind(
  promise: Promise<unknown>,
  kind: ExternalConfigViolationError["kind"]
): Promise<ExternalConfigViolationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExternalConfigViolationError) {
      expect(error.kind, `expected kind ${kind}, got ${error.kind}`).toBe(kind);
      return error;
    }
    throw error;
  }
  throw new Error(`expected ExternalConfigViolationError(${kind}) to be thrown, but the promise resolved`);
}
