/**
 * M9-03 "角色与模型配置页" — the read / atomic-write-back carrier behind
 * GET/PUT /api/v1/profiles/full.
 *
 * Format discipline (hard red line — 复用既有解析器,不重写解析): the profiles
 * source file is, per the M9-01 serve contract, strict JSON matching the
 * FROZEN contracts ProfilesFileSchema (serve.ts's own usage line states YAML
 * is not parsed because no yaml dependency may be added; config/
 * profiles.example.yaml stays the human reference converted to this JSON).
 * Both endpoints therefore validate through the EXISTING parser —
 * `parseProfilesFile` (orchestrator.ts), i.e. ProfilesFileSchema over
 * JSON.parse — and never through a second, rewritten one. A PUT body whose
 * content fails that parser is refused with 422 and the original file is
 * untouched.
 *
 * Atomic write-back (hard red line — 临时文件+rename,失败不破坏原文件): a
 * validated write never edits the file in place. The content lands in a
 * temporary file in the SAME directory as the source (rename must not cross
 * filesystems), is fsync'd, and is then renamed over the source (atomic on
 * POSIX; node's rename on Windows uses MoveFileEx with
 * MOVEFILE_REPLACE_EXISTING, so it replaces the existing file). Any failure
 * before the rename leaves the original byte-for-byte unchanged and removes
 * the temporary file; the rename itself is the single atomic commit point.
 *
 * What a write-back does NOT do (honest boundary, surfaced in the UI too):
 * it does not hot-reload this process's in-memory profiles — the orchestrator
 * loaded them once at composition time. The change is picked up at the next
 * serve start; until then GET /api/v1/profiles (the selection dropdown) and
 * POST /api/v1/runs keep answering from the startup definitions. Semantics
 * after a write-back, stated precisely (M9-04 review handover #62 — the
 * earlier "same-id/different-definition meets the drift gate" phrasing was
 * wrong for model-only edits): NEW tasks run on the revision frozen at the
 * profile's FIRST creation; later same-id edits (model included) neither mint
 * a new revision nor affect already-created tasks — to change a model, create
 * a profile with a DIFFERENT id. The drift gate (409
 * PROFILE_DEFINITION_CONFLICT at run creation) compares exactly runtime /
 * executable / executionTarget / configDir / credentialGroup /
 * maxConcurrency / timeoutSeconds — seven fields; `model` is not one of
 * them. Drift remains a deliberate human decision, not an upsert.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { GraphEditRejectionError } from "./errors.js";
import { parseProfilesFile, type ProfileDefinition } from "./orchestrator.js";

/**
 * GET /api/v1/profiles/full view: the source path, the file's CURRENT full
 * text, and the parse result derived from THAT text through the existing
 * parser. A currently unparseable file (hand-edited between starts) is still
 * a viewable config: rawText carries the bytes, parseError names the reason
 * and profiles is null — the editor can then fix and PUT the corrected text.
 * The parsed entries are served in full (executable/configDir/credentialGroup
 * included) because the raw text already carries every field — this endpoint
 * is the maintainer's config-file surface, unlike the reduced selection
 * dropdown GET /api/v1/profiles whose shape is unchanged.
 */
export interface ProfilesFullView {
  readonly sourcePath: string;
  readonly rawText: string;
  readonly parseError: string | null;
  readonly profiles: readonly ProfileDefinition[] | null;
}

/** Human-readable reason when the existing parser refuses the content. */
function parseErrorText(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message !== "") {
    return error.message;
  }
  return String(error);
}

/**
 * Read the source file and parse its CURRENT text. Read failures throw the
 * typed 409 (the source is absent/unreadable — nothing to view or write
 * back to); a parse failure is NOT a throw: the view carries rawText +
 * parseError so the maintainer can repair exactly what is on disk.
 */
export function readProfilesFull(sourcePath: string): ProfilesFullView {
  let rawText: string;
  try {
    rawText = readFileSync(sourcePath, "utf8");
  } catch (error) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `the configured profiles source file "${sourcePath}" could not be read ` +
        "(removed after start, or unreadable); there is no config to serve or write back to",
      { cause: error }
    );
  }
  try {
    return { sourcePath, rawText, parseError: null, profiles: parseProfilesFile(rawText) };
  } catch (error) {
    return { sourcePath, rawText, parseError: parseErrorText(error), profiles: null };
  }
}

/**
 * Validate `content` through the EXISTING parser and, only if it parses,
 * atomically replace the source file (temp file + fsync + rename). Returns
 * the parsed profiles (what the file now says). Refusals:
 * - content that fails the frozen ProfilesFileSchema → 422
 *   PROFILES_CONTENT_INVALID with the parser's readable reason; the original
 *   file is untouched (validation precedes any filesystem mutation);
 * - a vanished source FILE or destination directory → 409
 *   PROFILE_SOURCE_ABSENT (consistent with GET's view of the same state:
 *   the configured source is gone, and silently re-creating a config an
 *   operator may have deleted on purpose would be a fail-open surprise —
 *   serve does not create files or directories implicitly);
 * - an OS-level write/rename failure → the typed 409 carrier is NOT right
 *   for that (the source exists; the ENVIRONMENT failed) — the raw OS error
 *   propagates and the HTTP layer answers 500 with a redacted message, temp
 *   file cleaned up, original still untouched.
 */
export function writeProfilesFullAtomic(
  sourcePath: string,
  content: string
): readonly ProfileDefinition[] {
  // 1. Validate FIRST (the existing parser; no rewrite): a refused content
  //    must never touch the filesystem at all.
  let parsed: readonly ProfileDefinition[];
  try {
    parsed = parseProfilesFile(content);
  } catch (error) {
    throw new GraphEditRejectionError(
      422,
      "PROFILES_CONTENT_INVALID",
      "the submitted profiles content does not match the frozen profiles schema " +
        "(ProfilesFileSchema, the same parser serve --profiles applies at startup); " +
        "the original file was NOT modified. Parser reason: " + parseErrorText(error),
      { cause: error }
    );
  }

  // 2. The source must still exist (it existed at startup — its disappearance
  //    is an external act the write-back refuses, never paper over) and its
  //    directory must still be a directory (serve never mkdir -p for user
  //    data; rename must also stay on one filesystem, i.e. in that
  //    directory).
  const directory = dirname(sourcePath);
  let sourceExists = false;
  try {
    sourceExists = statSync(sourcePath).isFile();
  } catch (error) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `the configured profiles source file "${sourcePath}" no longer exists; refusing to write ` +
        "(serve does not re-create a deleted config implicitly)",
      { cause: error }
    );
  }
  if (!sourceExists) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `"${sourcePath}" is not a regular file; refusing to write the profiles source`
    );
  }
  let directoryIsDirectory = false;
  try {
    directoryIsDirectory = statSync(directory).isDirectory();
  } catch (error) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `the profiles source directory "${directory}" no longer exists; refusing to write ` +
        "(serve does not create directories implicitly)",
      { cause: error }
    );
  }
  if (!directoryIsDirectory) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `"${directory}" is not a directory; refusing to write the profiles source`
    );
  }

  // 3. Temp file in the SAME directory (rename must stay on one filesystem),
  //    written + fsync'd, then renamed over the source — the single atomic
  //    commit point. Every failure path removes the temp file; none of them
  //    has touched the original.
  const temporaryPath = join(
    directory,
    `.${basename(sourcePath)}.m9-03-tmp-${process.pid.toString(36)}-${randomBytes(6).toString("hex")}`
  );
  let handle: number = -1;
  try {
    // 'wx': the random suffix makes a collision astronomically unlikely, and
    // failing loudly beats silently truncating some other file.
    handle = openSync(temporaryPath, "wx");
    // utf8 is writeSync's default string encoding; the returned count is
    // asserted against the full utf8 byte length (M9-04 review handover #56):
    // a short write refuses the write-back loudly (the catch below removes
    // the temporary file, and the original has not been touched — the temp
    // file isolation means the refusal can never damage the source).
    const written = writeSync(handle, content);
    const expectedBytes = Buffer.byteLength(content, "utf8");
    if (written !== expectedBytes) {
      throw new Error(
        `profiles write-back: short write on the temporary file ` +
          `(${String(written)} of ${String(expectedBytes)} bytes) — write-back refused; ` +
          "the original file is untouched"
      );
    }
    fsyncSync(handle);
    closeSync(handle);
    handle = -1;
    renameSync(temporaryPath, sourcePath);
  } catch (error) {
    if (handle !== -1) {
      try { closeSync(handle); } catch { /* already closed */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* nothing to clean up */ }
    throw error;
  }
  return parsed;
}

/**
 * M11-02 first-run CREATE sibling of `writeProfilesFullAtomic`: same
 * discipline (validate through the EXISTING frozen parser first — the
 * original/destination is never touched by a refusal — then temp file in
 * the SAME directory + fsync + rename as the single atomic commit point),
 * but CREATE semantics:
 * - the destination must NOT exist (that is the replace sibling's job; the
 *   two refusals are complementary, which is what keeps first-run's
 *   already-configured gate race-safe);
 * - the parent directory must already exist (serve never mkdir -p user
 *   data — a typo'd declared path fails loudly, it does not relocate);
 * - a LAST-LOOK stat immediately before the rename re-refuses (409) if the
 *   destination appeared while the temp file was being written. The residual
 *   create/replace race window is the rename itself (single-operator local
 *   surface; the status check + the idempotency gate remain the primary
 *   protection) — stated here rather than pretended away.
 */
export function createProfilesFileAtomic(
  sourcePath: string,
  content: string,
  /**
   * M11-03 review handover D: the LAST-LOOK regular-file probe, injectable
   * for the primitive-level race test (the same seam pattern as
   * cli-discovery's isFile). Default is the real statSync-based check; the
   * precondition and parent-directory stats above stay real in every
   * configuration — only the rename-time re-check is substitutable, which is
   * exactly the branch a synchronous test cannot otherwise reach.
   */
  lastLookIsFile: ((candidate: string) => boolean) | undefined = undefined
): readonly ProfileDefinition[] {
  // 1. Validate FIRST (the existing parser; no rewrite): a refused content
  //    must never touch the filesystem at all.
  let parsed: readonly ProfileDefinition[];
  try {
    parsed = parseProfilesFile(content);
  } catch (error) {
    throw new GraphEditRejectionError(
      422,
      "PROFILES_CONTENT_INVALID",
      "the profiles content to create does not match the frozen profiles schema " +
        "(ProfilesFileSchema); no file was created. Parser reason: " + parseErrorText(error),
      { cause: error }
    );
  }

  // 2. The parent directory must exist (no implicit mkdir) and the
  //    destination must not (create semantics — the replace sibling refuses
  //    the complementary state).
  const directory = dirname(sourcePath);
  let directoryIsDirectory = false;
  try {
    directoryIsDirectory = statSync(directory).isDirectory();
  } catch (error) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `the profiles destination directory "${directory}" does not exist; refusing to create ` +
        "the file (serve does not create directories implicitly)",
      { cause: error }
    );
  }
  if (!directoryIsDirectory) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      `"${directory}" is not a directory; refusing to create the profiles source`
    );
  }
  let destinationExists = false;
  try {
    destinationExists = statSync(sourcePath).isFile();
  } catch {
    destinationExists = false;
  }
  if (destinationExists) {
    throw new GraphEditRejectionError(
      409,
      "PROFILES_ALREADY_EXISTS",
      `"${sourcePath}" already exists; first-run creates a profiles file only while it is absent — ` +
        "an existing file (even a broken one) is replaced only through the first-run replace path " +
        "or PUT /api/v1/profiles/full"
    );
  }

  // 3. Temp file in the SAME directory (rename must stay on one filesystem),
  //    written + fsync'd, last-look re-stat, then renamed — the single atomic
  //    commit point. Every failure path removes the temp file.
  const temporaryPath = join(
    directory,
    `.${basename(sourcePath)}.m11-02-tmp-${process.pid.toString(36)}-${randomBytes(6).toString("hex")}`
  );
  let handle: number = -1;
  try {
    handle = openSync(temporaryPath, "wx");
    const written = writeSync(handle, content);
    const expectedBytes = Buffer.byteLength(content, "utf8");
    if (written !== expectedBytes) {
      throw new Error(
        `profiles create: short write on the temporary file ` +
          `(${String(written)} of ${String(expectedBytes)} bytes) — creation refused; ` +
          "no profiles file was created"
      );
    }
    fsyncSync(handle);
    closeSync(handle);
    handle = -1;
    let appeared = false;
    try {
      appeared =
        lastLookIsFile !== undefined
          ? lastLookIsFile(sourcePath) === true
          : statSync(sourcePath).isFile();
    } catch {
      appeared = false;
    }
    if (appeared) {
      throw new GraphEditRejectionError(
        409,
        "PROFILES_ALREADY_EXISTS",
        `the profiles source "${sourcePath}" appeared while first-run was preparing the write; ` +
          "creation refused, nothing was overwritten"
      );
    }
    renameSync(temporaryPath, sourcePath);
  } catch (error) {
    if (handle !== -1) {
      try { closeSync(handle); } catch { /* already closed */ }
    }
    try { unlinkSync(temporaryPath); } catch { /* nothing to clean up */ }
    throw error;
  }
  return parsed;
}
