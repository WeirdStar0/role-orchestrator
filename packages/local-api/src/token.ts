/**
 * Session token bootstrapping (docs/SECURITY_MODEL.md, "本地 Web 安全"):
 * the API is loopback-only, but loopback is NOT an authentication excuse —
 * every API request must carry a bearer token that an attacker web page
 * cannot obtain.
 *
 * At server start a 256-bit token is generated (`crypto.randomBytes`) and
 * written to a token file whose location and visibility are checked
 * fail-closed:
 * - The resolved path MUST live under the current user's home directory or
 *   the user's temp directory (both carry per-user ACLs by default). A
 *   shared/world-readable location is refused with `TokenStoreError`.
 * - The file is created with mode 0o600; on POSIX the mode is verified by
 *   `stat` after writing (group/other bits must be clear). On Windows the
 *   libuv mode emulation cannot express NTFS ACLs, so the per-user
 *   directory check above IS the visibility guarantee (documented
 *   equivalent mechanism) — no attempt is made to pretend otherwise.
 * - The token never appears in URLs, logs or the repository; callers that
 *   display it must treat it like a credential.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
  type Stats
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { TokenStoreError } from "./errors.js";

/** 32 random bytes; base64url without padding is exactly 43 characters. */
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Owner read/write only; group and other must see nothing. */
const TOKEN_FILE_MODE = 0o600;

/** A freshly minted session token together with the file that holds it. */
export interface SessionTokenMaterial {
  readonly token: string;
  readonly tokenFile: string;
}

/** Generate one high-entropy session token (256 bits, base64url). */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function isUnder(base: string, candidate: string): boolean {
  const normalizedBase = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(normalizedBase) || candidate === base;
}

/**
 * Fail-closed location check: the token file must resolve under the current
 * user's home or temp directory. `null` means the location is acceptable.
 */
export function tokenFileLocationProblem(tokenFile: string): string | null {
  if (!isAbsolute(tokenFile)) {
    return `token file path "${tokenFile}" is relative; refusing ambiguous storage`;
  }
  const resolved = resolve(tokenFile);
  const home = resolve(homedir());
  const temp = resolve(tmpdir());
  if (!isUnder(home, resolved) && !isUnder(temp, resolved)) {
    return (
      `token file "${resolved}" is outside the current user's home directory and temp directory; ` +
      "refusing a location that may be readable by other local users"
    );
  }
  return null;
}

function verifyPosixMode(stats: Stats, tokenFile: string): void {
  const groupOrOther = stats.mode & 0o077;
  if (groupOrOther !== 0) {
    throw new TokenStoreError(
      `token file "${tokenFile}" is readable beyond its owner (mode ${stats.mode.toString(8)}); ` +
        "refusing to keep a session token in a group/world-readable file"
    );
  }
}

/**
 * Write the token to `tokenFile` with current-user-only visibility, creating
 * parent directories with 0o700 on POSIX. Throws `TokenStoreError` when the
 * location or resulting visibility cannot be proven safe.
 */
export function writeSessionTokenFile(tokenFile: string, token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new TokenStoreError("refusing to store a token that does not match the 43-char base64url shape");
  }
  const problem = tokenFileLocationProblem(tokenFile);
  if (problem !== null) {
    throw new TokenStoreError(problem);
  }
  const resolved = resolve(tokenFile);
  const parent = resolve(join(resolved, ".."));
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new TokenStoreError(`cannot create token file directory "${parent}"`, { cause: error });
  }
  let fd: number;
  try {
    fd = openSync(resolved, "w", TOKEN_FILE_MODE);
  } catch (error) {
    throw new TokenStoreError(`cannot open token file "${resolved}" for writing`, { cause: error });
  }
  try {
    writeSync(fd, `${token}\n`, 0, "utf8");
  } catch (error) {
    throw new TokenStoreError(`cannot write token file "${resolved}"`, { cause: error });
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(resolved, TOKEN_FILE_MODE);
      verifyPosixMode(statSync(resolved), resolved);
    } catch (error) {
      if (error instanceof TokenStoreError) throw error;
      throw new TokenStoreError(`cannot verify token file permissions on "${resolved}"`, { cause: error });
    }
  }
}

/**
 * Read the token back from its file, re-checking the location and (on
 * POSIX) the file mode. Constant-shape validation prevents a tampered file
 * from smuggling arbitrary strings into the bearer comparison.
 */
export function readSessionTokenFile(tokenFile: string): string {
  const problem = tokenFileLocationProblem(tokenFile);
  if (problem !== null) {
    throw new TokenStoreError(problem);
  }
  const resolved = resolve(tokenFile);
  let stats: Stats;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new TokenStoreError(`token file "${resolved}" does not exist or is unreadable`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new TokenStoreError(`token file path "${resolved}" is not a regular file`);
  }
  if (process.platform !== "win32") {
    verifyPosixMode(stats, resolved);
  }
  let content: string;
  try {
    content = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new TokenStoreError(`cannot read token file "${resolved}"`, { cause: error });
  }
  const token = content.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new TokenStoreError(
      `token file "${resolved}" does not contain a well-formed session token; refusing to use it`
    );
  }
  return token;
}

/**
 * Constant-time string comparison for secret material: both sides are
 * hashed first, so neither length nor content leaks through timing.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Derive the session-bound CSRF token: HMAC-SHA256 over the session token
 * with a per-server-start random secret (never persisted). A web page
 * without the session token cannot obtain or guess this value, and rotating
 * the session invalidates it.
 */
export function deriveCsrfToken(sessionToken: string, serverSecret: Buffer): string {
  return createHmac("sha256", serverSecret).update(`csrf:${sessionToken}`, "utf8").digest("base64url");
}
