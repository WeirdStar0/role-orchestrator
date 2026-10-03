/**
 * M9-04 review handover #56 — the short-write tripwire inside
 * writeProfilesFullAtomic (profiles-config.ts).
 *
 * node's writeSync on a string writes the whole string or throws: a SHORT
 * byte count is not producible through any public input, which is exactly why
 * the guard exists (defence in depth on a pathological OS path). The guard is
 * therefore exercised by intercepting node:fs.writeSync in THIS file only
 * (the mock is file-scoped; no other test file sees it) to perform the real
 * write but report a short count once. Asserted on the refusal path: the
 * write-back throws, the temporary file is removed (no residue), and the
 * original file is byte-for-byte unchanged — the temp-file isolation means
 * the refusal can never damage the source. The normal path is asserted in
 * the same file: byte-exact replacement, no temp file left.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Only writeSync is replaced; every other export (readFileSync included)
  // stays the real implementation.
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

// Imported AFTER the mock declaration (vitest hoists vi.mock above imports):
// writeSync here is the mocked vi.fn wrapping the real implementation.
import { writeSync } from "node:fs";
import { writeProfilesFullAtomic } from "../src/profiles-config.js";
import { makeConfigDir } from "./helpers.js";

const VALID_PROFILES_JSON = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      id: "profile-shortwrite",
      runtime: "claude",
      executable: "C:/tmp/fake-claude.cmd",
      executionTarget: "windows-native",
      configDir: makeConfigDir(),
      model: null,
      credentialGroup: "shortwrite",
      maxConcurrency: 1,
      timeoutSeconds: 60,
      extraArgs: []
    }
  ]
});

describe("writeProfilesFullAtomic short-write tripwire (M9-04 #56)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ro-localapi-shortwrite-"));
    file = join(dir, "profiles.json");
    writeFileSync(file, "ORIGINAL", "utf8");
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("normal path: replaces the file byte-exactly and leaves no temp file", () => {
    const entriesBefore = readdirSync(dir).sort();
    const parsed = writeProfilesFullAtomic(file, VALID_PROFILES_JSON);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("profile-shortwrite");
    expect(readFileSync(file, "utf8")).toBe(VALID_PROFILES_JSON);
    expect(readdirSync(dir).sort()).toEqual(entriesBefore);
  });

  it("short write: refuses loudly, temp file cleaned, original byte-for-byte intact", () => {
    const originalBytes = readFileSync(file, "utf8");
    const entriesBefore = readdirSync(dir).sort();
    // Perform the REAL write, then report a short count (one-off): the
    // on-disk bytes are complete but the returned count is one short, which
    // is exactly the pathological OS behaviour the tripwire guards against.
    const realWrite = writeSync as unknown as (fd: number, data: string) => number;
    vi.mocked(writeSync).mockImplementationOnce(((fd: number, data: string | Buffer) => {
      const full = realWrite(fd, data as string);
      const expected = Buffer.byteLength(data as string, "utf8");
      return expected > 0 ? expected - 1 : full;
    }) as typeof writeSync);

    expect(() => writeProfilesFullAtomic(file, VALID_PROFILES_JSON)).toThrow(
      /short write on the temporary file/
    );
    // The original was never touched; no temp residue remains.
    expect(readFileSync(file, "utf8")).toBe(originalBytes);
    expect(readdirSync(dir).sort()).toEqual(entriesBefore);
  });
});
