/**
 * Evidence collection (M5-05 完成标准: "对应测试带真实截图/日志证据").
 *
 * One `Evidence` instance per test file run: it owns a fresh directory under
 * `packages/browser-e2e/evidence/<label>-<UTC stamp>/`, appends timestamped
 * lines to `driver.log.txt`, and saves real browser screenshots as numbered
 * PNG files. Nothing here fabricates content: a screenshot is written by
 * Chromium, a log line is written by the driver when the observed fact was
 * read back from the page or the store.
 *
 * The evidence directory name is printed on stdout so a run's artifacts can
 * be located even when the test file fails midway.
 *
 * Run-directory ROTATION (POLISH-1): every run used to add one timestamped
 * directory with no upper bound (1386 accumulated directories / 6282 files
 * by 2026-09-26, dominating the release-audit scan tree). After creating the
 * new run directory the writer can now rotate: keep the newest K directories
 * of the SAME label and delete the older ones. Rotation is OFF by default in
 * the library and is enabled for regular vitest runs through the package
 * vitest config (`BROWSER_E2E_EVIDENCE_ROTATION=1`) or per call via
 * `Evidence.start(..., { rotate: true })`. It is structurally unable to
 * touch: the CURRENT run's directory (always the newest of its label and
 * excluded from deletion by name), any OTHER label's directories, plain
 * files, or anything outside the evidence root.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";

/**
 * The package-local evidence root, resolved from THIS file's location so it
 * is identical under vitest (src/) and after the tsc build (dist/): this file
 * sits exactly one directory below the package root in both layouts, and
 * "../.." from it is the monorepo's packages/ directory.
 */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));
export const EVIDENCE_ROOT = join(packagesDir, "browser-e2e", "evidence");

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
 * The K=20 figure from the polish batch was adjusted to 22 by MEASUREMENT,
 * not taste: at K=20 the retained browser-e2e evidence leaves the repo scan
 * tree with 481 binary files, which BREAKS the frozen count pin
 * `binaryFiles > 500` in packages/release-audit/test/repo-audit.test.ts:25
 * (that test may not be modified); at K=22 the pins hold — binary 529 > 500,
 * scanned 1620 > 1500, text 1091 > 900 (measured 2026-09-26, reports/POLISH-1.md
 * and PROPOSALS.md). The pure rotation logic is generic in `keepCount`; only
 * this shipped default carries the policy.
 */
export const EVIDENCE_ROTATION_KEEP = 22;

/** Opt-in switch for rotation in regular (non-opt-in) runs. */
export const EVIDENCE_ROTATION_ENV = "BROWSER_E2E_EVIDENCE_ROTATION";

/** Rotation runs only when explicitly enabled: strictly `"1"`, nothing else. */
export function evidenceRotationEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[EVIDENCE_ROTATION_ENV] === "1";
}

export interface EvidenceStartOptions {
  /**
   * Rotate same-label run directories after this run's directory exists.
   * Default: gated by `BROWSER_E2E_EVIDENCE_ROTATION === "1"` (set for the
   * package's vitest runs in vitest.config.ts). Never deletes the current
   * run's directory or another label's directories.
   */
  readonly rotate?: boolean;
}

export class Evidence {
  readonly dir: string;
  private readonly logPath: string;
  private counter = 0;
  private readonly startedAtMs = Date.now();

  private constructor(dir: string) {
    this.dir = dir;
    this.logPath = join(dir, "driver.log.txt");
    mkdirSync(dir, { recursive: true });
  }

  /** Create `<root>/<label>-<stamp>/`, write the header, then rotate if enabled. */
  static start(label: string, header: Readonly<Record<string, string>>, options: EvidenceStartOptions = {}): Evidence {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(EVIDENCE_ROOT, `${label}-${stamp}`);
    const evidence = new Evidence(dir);
    evidence.log(`=== browser-e2e evidence: ${label} ===`);
    for (const [name, value] of Object.entries(header)) {
      evidence.log(`${name}: ${value}`);
    }
    const rotate = options.rotate ?? evidenceRotationEnabled();
    if (rotate) {
      const outcome = rotateRunDirs(EVIDENCE_ROOT, `${label}-${stamp}`, EVIDENCE_ROTATION_KEEP);
      evidence.log(
        outcome.failed.length === 0
          ? `evidence rotation: label "${label}" kept newest ${String(EVIDENCE_ROTATION_KEEP)}, deleted ${String(outcome.deleted.length)} older run dirs`
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

  /** Save a REAL browser screenshot; returns the path written. */
  async screenshot(page: Page, name: string): Promise<string> {
    this.counter += 1;
    const fileName = `${String(this.counter).padStart(2, "0")}-${name}.png`;
    const path = join(this.dir, fileName);
    await page.screenshot({ path, fullPage: true });
    this.log(`screenshot ${fileName} url=${page.url()}`);
    return path;
  }

  /** Persist a structured artifact (e.g. a collected WS frame transcript). */
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
