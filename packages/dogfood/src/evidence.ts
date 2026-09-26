/**
 * Evidence collection for the M6-04 dogfood (the 完成标准 asks for a
 * recorded failure/recovery run). One `Evidence` instance per driver run:
 * it owns a fresh directory under `packages/dogfood/evidence/<label>-<UTC
 * stamp>/`, appends timestamped lines to `driver.log.txt` and persists
 * structured artifacts (the timeline, the A11/A17/A22 records). Nothing
 * here fabricates content: a line is written when the driver observed the
 * fact from the store, git or a typed product result.
 *
 * Same discipline as the M5-05 browser evidence, minus the browser: the
 * dogfood drives the chain, not the UI.
 *
 * Run-directory ROTATION (POLISH-1): every driver run used to add one
 * timestamped directory with no upper bound (162 accumulated directories by
 * 2026-09-26). After creating the new run directory the writer now rotates:
 * keep the newest K directories of the SAME label and delete the older ones.
 * Rotation is ON by default (the single dogfood test asserts in-memory
 * results, never evidence-directory contents, and can never observe its own
 * directory being a rotation victim — the current directory is excluded by
 * name); pass `{ rotate: false }` to disable. It is structurally unable to
 * touch: the CURRENT run's directory, any OTHER label's directories, plain
 * files, or anything outside the evidence root.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package-local evidence root, stable under src (vitest) and dist layouts. */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));
export const DOGFOOD_EVIDENCE_ROOT = join(packagesDir, "dogfood", "evidence");

// ---------------------------------------------------------------------------
// Run-directory naming + rotation (POLISH-1)
// ---------------------------------------------------------------------------

/** A run directory is `<label>-<stamp>` with this fixed-width UTC stamp suffix. */
export const RUN_DIR_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** `2026-09-26T02-06-27-892Z` — `toISOString()` with `:` and `.` mapped to `-`. */
const STAMP_LENGTH = 24;

/** Split `<label>-<stamp>`; null for every name that is not a run directory.
 *  Stamp validation is SHAPE-only (`\d` digits): stamps are machine-generated
 *  via `toISOString()`, never hand-written, and rotation only orders them
 *  lexicographically — calendar semantics are irrelevant to that. */
export function splitRunDirName(name: string): { label: string; stamp: string } | null {
  if (name.length < STAMP_LENGTH + 2) return null;
  const stamp = name.slice(-STAMP_LENGTH);
  if (!RUN_DIR_STAMP_PATTERN.test(stamp)) return null;
  const label = name.slice(0, name.length - STAMP_LENGTH - 1);
  if (label.length === 0 || label.endsWith("-")) return null;
  return { label, stamp };
}

/** The result of the pure rotation decision: same-label names only. */
export interface RunDirRotationPlan {
  /** The newest `keepCount` directories of the current run's label, newest first. */
  readonly keep: readonly string[];
  /** Older same-label directories to delete, OLDEST FIRST (deletion order);
   *  NEVER contains `currentDirName`. */
  readonly delete: readonly string[];
}

/**
 * Pure rotation decision (POLISH-1): among `entries`, only names that parse
 * as `<currentLabel>-<stamp>` participate; everything else — other labels,
 * plain files, malformed names — is ignored and can never be kept or deleted.
 * Stamps are fixed-width zero-padded UTC, so lexicographic order is chrono-
 * logical. The current directory is excluded from `delete` even if a same-
 * millisecond collision ever made its rank ambiguous.
 */
export function planRunDirRotation(
  entries: readonly string[],
  currentDirName: string,
  keepCount: number
): RunDirRotationPlan {
  const current = splitRunDirName(currentDirName);
  if (current === null || keepCount < 1) return { keep: [], delete: [] };
  const family: { name: string; stamp: string }[] = [];
  for (const entry of entries) {
    const parsed = splitRunDirName(entry);
    if (parsed !== null && parsed.label === current.label) family.push({ name: entry, stamp: parsed.stamp });
  }
  family.sort((a, b) => b.stamp.localeCompare(a.stamp));
  const keep = family.slice(0, keepCount).map((entry) => entry.name);
  const remove = family
    .slice(keepCount)
    .map((entry) => entry.name)
    .filter((name) => name !== currentDirName)
    .reverse(); // deletion order: oldest first
  return { keep, delete: remove };
}

/** What one rotation pass actually did (per-directory failures never throw). */
export interface RunDirRotationOutcome {
  readonly deleted: readonly string[];
  readonly failed: readonly { dir: string; error: string }[];
}

/** The fs surface of `rotateRunDirs`, injectable so tests stay hermetic. */
export interface RunDirRotationIo {
  /** Directory NAMES of `root`, directories only (files must not appear). */
  readonly readdir: (root: string) => readonly string[];
  /** Recursively delete one directory. */
  readonly removeTree: (dir: string) => void;
}

const nodeRotationIo: RunDirRotationIo = {
  readdir: (root) => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  removeTree: (dir) => rmSync(dir, { recursive: true, force: true })
};

/**
 * Apply the rotation decision against one evidence root. An unreadable root
 * is a no-op; a per-directory deletion failure is recorded in `failed`
 * instead of thrown so janitorial work can never fail a test run.
 */
export function rotateRunDirs(
  root: string,
  currentDirName: string,
  keepCount: number,
  io: RunDirRotationIo = nodeRotationIo
): RunDirRotationOutcome {
  let entries: readonly string[];
  try {
    entries = io.readdir(root);
  } catch {
    return { deleted: [], failed: [] };
  }
  const plan = planRunDirRotation(entries, currentDirName, keepCount);
  const deleted: string[] = [];
  const failed: { dir: string; error: string }[] = [];
  for (const dir of plan.delete) {
    try {
      io.removeTree(join(root, dir));
      deleted.push(dir);
    } catch (error) {
      failed.push({ dir, error: String(error) });
    }
  }
  return { deleted, failed };
}

/**
 * Keep the newest K run directories per label when rotation runs (POLISH-1).
 *
 * Same shipped default as the browser-e2e package (22, not the batch's
 * provisional 20): at K=20 the retained evidence leaves the repo scan tree
 * with 481 binary files, breaking the frozen count pin `binaryFiles > 500`
 * in packages/release-audit/test/repo-audit.test.ts:25 (which may not be
 * modified); K=22 keeps every pin green with margin. Measured 2026-09-26 —
 * reports/POLISH-1.md and PROPOSALS.md. The dogfood evidence itself is all
 * text; the uniform constant keeps one policy across both writers.
 */
export const DOGFOOD_EVIDENCE_ROTATION_KEEP = 22;

export interface EvidenceStartOptions {
  /**
   * Rotate same-label run directories after this run's directory exists.
   * Default: ON. Never deletes the current run's directory, another label's
   * directories, or anything outside the evidence root.
   */
  readonly rotate?: boolean;
}

export class Evidence {
  readonly dir: string;
  private readonly logPath: string;
  private readonly startedAtMs = Date.now();

  private constructor(dir: string, logPath: string) {
    this.dir = dir;
    this.logPath = logPath;
  }

  /** Create `<root>/<label>-<stamp>/`, write the header, then rotate if enabled. */
  static start(label: string, header: Readonly<Record<string, string>>, options: EvidenceStartOptions = {}): Evidence {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(DOGFOOD_EVIDENCE_ROOT, `${label}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "driver.log.txt");
    const evidence = new Evidence(dir, logPath);
    evidence.log(`=== dogfood evidence: ${label} ===`);
    for (const [name, value] of Object.entries(header)) {
      evidence.log(`${name}: ${value}`);
    }
    if (options.rotate ?? true) {
      const outcome = rotateRunDirs(DOGFOOD_EVIDENCE_ROOT, `${label}-${stamp}`, DOGFOOD_EVIDENCE_ROTATION_KEEP);
      evidence.log(
        outcome.failed.length === 0
          ? `evidence rotation: label "${label}" kept newest ${String(DOGFOOD_EVIDENCE_ROTATION_KEEP)}, deleted ${String(outcome.deleted.length)} older run dirs`
          : `evidence rotation: label "${label}" deleted ${String(outcome.deleted.length)}, FAILED ${String(outcome.failed.length)}: ${outcome.failed
              .map((f) => `${f.dir} (${f.error})`)
              .join("; ")}`
      );
    }
    return evidence;
  }

  /** Append one timestamped line (elapsed-ms + UTC clock) to the driver log. */
  log(line: string): void {
    const elapsedMs = Date.now() - this.startedAtMs;
    const lineText = `+${String(elapsedMs).padStart(6, "0")}ms ${new Date().toISOString()} ${line}`;
    appendFileSync(this.logPath, `${lineText}\n`, "utf8");
  }

  /** Persist a structured artifact (timeline, acceptance records). */
  artifact(name: string, content: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, content, "utf8");
    this.log(`artifact ${name} (${String(content.length)} chars)`);
    return path;
  }

  /** Final log line; the file is flushed incrementally, nothing buffered. */
  close(summary: string): void {
    this.log(`=== done: ${summary} ===`);
  }
}
