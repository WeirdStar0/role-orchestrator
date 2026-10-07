/**
 * M11-03 review handover D — the CREATE primitive's three refusal branches,
 * at the primitive level (setup.test.ts covers the route level; this file
 * pins each branch's code, its zero-side-effect contract and — the point the
 * handover flagged — the NO-TEMP-LEFTOVER claim, asserted for real here):
 *   ① parent directory missing → 409 PROFILE_SOURCE_ABSENT (serve never
 *      mkdir -p user data), nothing created;
 *   ② destination already exists → 409 PROFILES_ALREADY_EXISTS BEFORE any
 *      filesystem mutation (the original file byte-untouched, no temp file);
 *   ③ destination APPEARS while the temp file is being written → the
 *      last-look re-check refuses 409 PROFILES_ALREADY_EXISTS (via the
 *      injectable last-look probe — a synchronous test cannot win the race
 *      against real fs timing), the destination is still absent and the temp
 *      file is cleaned up.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfilesFileAtomic } from "../src/profiles-config.js";
import { parseProfilesFile } from "../src/orchestrator.js";

const VALID_CONTENT = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      id: "create-primitive-claude",
      runtime: "claude",
      executable: "claude.cmd",
      executionTarget: process.platform === "win32" ? "windows-native" : "linux-native",
      configDir: join(tmpdir(), "ro-create-primitive-cfg"),
      model: null,
      credentialGroup: "personal",
      maxConcurrency: 1,
      timeoutSeconds: 600,
      extraArgs: []
    }
  ]
});

function newDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ro-profiles-create-${label}-`));
}

/** The no-temp-leftover assertion the route-level comment claims. */
function expectOnlyProfileFile(directory: string, name: string): void {
  const entries = readdirSync(directory).sort();
  expect(entries).toEqual([name]);
}

describe("createProfilesFileAtomic refusal branches (handover D, primitive level)", () => {
  it("① refuses a missing parent directory with PROFILE_SOURCE_ABSENT and creates nothing", () => {
    const missingDir = join(newDir("parent-missing"), "no-such-dir");
    const source = join(missingDir, "profiles.json");
    expect(() => createProfilesFileAtomic(source, VALID_CONTENT)).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "PROFILE_SOURCE_ABSENT" })
    );
    expect(existsSync(source)).toBe(false);
    expect(existsSync(missingDir)).toBe(false);
  });

  it("② refuses an existing destination with PROFILES_ALREADY_EXISTS before any mutation (original bytes untouched, no temp file)", () => {
    const directory = newDir("exists");
    const source = join(directory, "profiles.json");
    const original = '{"existing":"operator file"}\n';
    writeFileSync(source, original, "utf8");
    expect(() => createProfilesFileAtomic(source, VALID_CONTENT)).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "PROFILES_ALREADY_EXISTS" })
    );
    // The precondition refusal never touched the filesystem: the original is
    // byte-identical and no temp file was left behind (asserted, not just
    // claimed).
    expect(readFileSync(source, "utf8")).toBe(original);
    expectOnlyProfileFile(directory, "profiles.json");
  });

  it("③ the last-look re-check refuses a destination that appeared mid-write (nothing overwritten, temp cleaned)", () => {
    const directory = newDir("last-look");
    const source = join(directory, "profiles.json");
    expect(() =>
      createProfilesFileAtomic(source, VALID_CONTENT, () => true)
    ).toThrowError(
      expect.objectContaining({
        statusCode: 409,
        code: "PROFILES_ALREADY_EXISTS"
      })
    );
    // The destination was never created and the temp file was removed — the
    // directory is empty.
    expect(existsSync(source)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("④ (control) the default last-look still creates a valid file — the injection seam changed nothing", () => {
    const directory = newDir("happy");
    const source = join(directory, "profiles.json");
    const profiles = createProfilesFileAtomic(source, VALID_CONTENT);
    expect(profiles.map((profile) => profile.id)).toEqual(["create-primitive-claude"]);
    // The file on disk re-validates through the SAME frozen parser.
    expect(parseProfilesFile(readFileSync(source, "utf8")).map((profile) => profile.id)).toEqual([
      "create-primitive-claude"
    ]);
    expectOnlyProfileFile(directory, "profiles.json");
  });
});
