import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  TokenStoreError,
  constantTimeEquals,
  deriveCsrfToken,
  generateSessionToken,
  readSessionTokenFile,
  tokenFileLocationProblem,
  writeSessionTokenFile
} from "../src/index.js";

const tempRoots: string[] = [];

function makeTokenDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ro-localapi-token-"));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateSessionToken", () => {
  it("produces 43-char base64url tokens (256-bit) that never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const token = generateSessionToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(20);
  });
});

describe("token file round-trip", () => {
  it("writes and reads back the token under a user directory", () => {
    const tokenFile = join(makeTokenDir(), "session-token.txt");
    const token = generateSessionToken();
    writeSessionTokenFile(tokenFile, token);
    expect(readSessionTokenFile(tokenFile)).toBe(token);
  });

  it("creates missing parent directories", () => {
    const tokenFile = join(makeTokenDir(), "nested", "deeper", "session-token.txt");
    const token = generateSessionToken();
    writeSessionTokenFile(tokenFile, token);
    expect(readSessionTokenFile(tokenFile)).toBe(token);
  });

  it("refuses to store a token with the wrong shape", () => {
    const tokenFile = join(makeTokenDir(), "bad.txt");
    expect(() => writeSessionTokenFile(tokenFile, "short-secret")).toThrow(TokenStoreError);
  });

  it("refuses to read back a tampered file", () => {
    const tokenFile = join(makeTokenDir(), "tampered.txt");
    writeSessionTokenFile(tokenFile, generateSessionToken());
    writeFileSync(tokenFile, "attacker-replaced-value\n", "utf8");
    expect(() => readSessionTokenFile(tokenFile)).toThrow(TokenStoreError);
  });

  it("refuses a missing token file", () => {
    expect(() => readSessionTokenFile(join(makeTokenDir(), "absent.txt"))).toThrow(TokenStoreError);
  });
});

describe("token file location guard", () => {
  it("accepts the user temp directory and home directory", () => {
    expect(tokenFileLocationProblem(join(tmpdir(), "ro-token-test.txt"))).toBeNull();
    expect(tokenFileLocationProblem(join(homedir(), "ro-token-test.txt"))).toBeNull();
  });

  it("refuses relative paths and locations outside user directories", () => {
    expect(tokenFileLocationProblem("relative/token.txt")).toMatch(/relative/);
    // One level above the home directory (e.g. C:\Users on Windows, /home on
    // Linux): a shared root other users can write watch-points into.
    const outside = resolve(join(homedir(), ".."), "ro-outside-token.txt");
    expect(tokenFileLocationProblem(outside)).toMatch(/outside the current user/);
  });

  it("writeSessionTokenFile refuses the outside location before touching disk", () => {
    const outside = resolve(join(homedir(), ".."), "ro-outside-token.txt");
    expect(() => writeSessionTokenFile(outside, generateSessionToken())).toThrow(TokenStoreError);
  });
});

describe("constantTimeEquals", () => {
  it("matches equal strings and rejects unequal ones without length signal", () => {
    const token = generateSessionToken();
    expect(constantTimeEquals(token, token)).toBe(true);
    expect(constantTimeEquals(token, `${token}x`)).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
    expect(constantTimeEquals("a", "b")).toBe(false);
  });
});

describe("deriveCsrfToken", () => {
  it("binds to the session: same secret+token -> same csrf; any change -> different", () => {
    const secret1 = Buffer.alloc(32, 1);
    const secret2 = Buffer.alloc(32, 2);
    const tokenA = generateSessionToken();
    const tokenB = generateSessionToken();
    const csrf = deriveCsrfToken(tokenA, secret1);
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deriveCsrfToken(tokenA, secret1)).toBe(csrf);
    expect(deriveCsrfToken(tokenB, secret1)).not.toBe(csrf);
    expect(deriveCsrfToken(tokenA, secret2)).not.toBe(csrf);
  });
});
