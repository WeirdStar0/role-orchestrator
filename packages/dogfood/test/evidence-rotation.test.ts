/**
 * POLISH-1 — dogfood evidence run-directory rotation, pinned behaviour.
 *
 * Layers tested:
 *  1. the PURE decision (`planRunDirRotation` / `splitRunDirName`) — the
 *     batch's specified case (25 fake directories -> keep newest 20, delete
 *     5), the under-K zero-deletion case, and the "never touches anything
 *     outside the current label" guarantee;
 *  2. the wiring — `rotateRunDirs` against a real temp root (hermetic), and
 *     `Evidence.start` against the REAL evidence root with a dedicated
 *     self-cleaning label: default rotation ON, `{ rotate: false }` OFF.
 *
 * The dogfood package has no env gate: rotation is the shipped default for
 * its single test label, because nothing reads evidence directories back.
 * No real claude/codex and no network: hermetic by construction.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOGFOOD_EVIDENCE_ROTATION_KEEP,
  Evidence,
  planRunDirRotation,
  rotateRunDirs,
  RUN_DIR_STAMP_PATTERN,
  splitRunDirName
} from "../src/evidence.js";

/** Synthetic ascending stamps: `stamps(25)[0]` is the OLDEST. */
function stamps(count: number): string[] {
  const base = Date.UTC(2026, 8, 26, 0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) =>
    new Date(base + i * 1_000).toISOString().replace(/[:.]/g, "-")
  );
}

const LABEL = "dogfood-chain";

function runDirName(label: string, stamp: string): string {
  return `${label}-${stamp}`;
}

/** The REAL evidence root, from this test file's location (test/ -> ../evidence). */
function realEvidenceRoot(): string {
  return fileURLToPath(new URL("../evidence", import.meta.url));
}

describe("splitRunDirName", () => {
  it("parses <label>-<stamp> and rejects everything that is not a run directory", () => {
    const stamp = "2026-09-26T02-06-27-557Z";
    expect(splitRunDirName(`${LABEL}-${stamp}`)).toEqual({ label: LABEL, stamp });
    expect(splitRunDirName("driver.log.txt")).toBeNull();
    expect(splitRunDirName("dogfood-timeline.json")).toBeNull();
    expect(splitRunDirName("random-dir")).toBeNull();
    expect(splitRunDirName(stamp)).toBeNull();
    expect(splitRunDirName(`x${stamp}`)).toBeNull();
    // shape-only stamp validation (see the browser-e2e sibling test)
    expect(splitRunDirName(`${LABEL}-2026-13-99T99-99-99-999Z`)).toEqual({
      label: LABEL,
      stamp: "2026-13-99T99-99-99-999Z"
    });
    expect(splitRunDirName(`${LABEL}-not-a-stamp`)).toBeNull();
    expect(splitRunDirName(`-${stamp}`)).toBeNull();
    expect(RUN_DIR_STAMP_PATTERN.test(`${stamp}X`)).toBe(false);
  });
});

describe("planRunDirRotation (pure)", () => {
  it("25 fake directories -> keep newest 20, delete exactly the 5 oldest (batch-specified case)", () => {
    const all = stamps(25); // [0] oldest ... [24] newest
    const entries = all.map((stamp) => runDirName(LABEL, stamp));
    const current = runDirName(LABEL, all[24] as string);
    const plan = planRunDirRotation(entries, current, 20);
    expect(plan.keep).toEqual(entries.slice(5).reverse()); // newest 20, newest first
    expect(plan.delete).toEqual(entries.slice(0, 5)); // oldest 5, oldest first
    expect(plan.delete).not.toContain(current);
  });

  it("fewer than K directories -> zero deletions", () => {
    const all = stamps(3);
    const entries = all.map((stamp) => runDirName(LABEL, stamp));
    const current = runDirName(LABEL, all[2] as string);
    const plan = planRunDirRotation(entries, current, DOGFOOD_EVIDENCE_ROTATION_KEEP);
    expect(plan.delete).toEqual([]);
    expect(plan.keep).toEqual([...entries].reverse()); // newest first
  });

  it("never keeps or deletes anything outside the current label's run directories", () => {
    const all = stamps(25);
    const entries = [
      ...all.map((stamp) => runDirName(LABEL, stamp)),
      runDirName("other-label", all[0] as string), // other label, ancient
      "driver.log.txt", // a file
      "dogfood-timeline.json", // a file
      "unrelated-directory", // no stamp
      `${LABEL}-not-a-stamp` // same prefix, malformed stamp
    ];
    const current = runDirName(LABEL, all[24] as string);
    const plan = planRunDirRotation(entries, current, 20);
    expect(plan.delete).toEqual(entries.slice(0, 5));
    expect(plan.keep.every((name) => name.startsWith(`${LABEL}-2`))).toBe(true);
    expect(plan.delete.every((name) => name.startsWith(`${LABEL}-2`))).toBe(true);
  });

  it("the current directory is never a deletion victim, even at keepCount=1", () => {
    const all = stamps(5);
    const entries = all.map((stamp) => runDirName(LABEL, stamp));
    const current = runDirName(LABEL, all[4] as string);
    const plan = planRunDirRotation(entries, current, 1);
    expect(plan.keep).toEqual([current]);
    expect(plan.delete).toEqual(entries.slice(0, 4)); // oldest first
    expect(plan.delete).not.toContain(current);
  });

  it("an unparseable current directory name refuses to rotate at all", () => {
    const all = stamps(25);
    const entries = all.map((stamp) => runDirName(LABEL, stamp));
    for (const bad of ["weird", "driver.log.txt", ""]) {
      const plan = planRunDirRotation(entries, bad, 20);
      expect(plan.keep).toEqual([]);
      expect(plan.delete).toEqual([]);
    }
  });
});

describe("rotateRunDirs (real fs, temp root)", () => {
  it("deletes exactly the 5 oldest same-label directories; unrelated entries are untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "dogfood-rotation-"));
    try {
      const all = stamps(25);
      for (const stamp of all) {
        const dir = join(root, runDirName(LABEL, stamp));
        mkdirSync(dir);
        writeFileSync(join(dir, "driver.log.txt"), "x", "utf8");
      }
      // unrelated entries that must survive
      mkdirSync(join(root, runDirName("other-label", all[0] as string)));
      mkdirSync(join(root, `${LABEL}-not-a-stamp`));
      writeFileSync(join(root, "keepme.txt"), "y", "utf8");

      const current = runDirName(LABEL, all[24] as string);
      const outcome = rotateRunDirs(root, current, 20);
      expect(outcome.failed).toEqual([]);
      expect(outcome.deleted).toEqual(all.slice(0, 5).map((stamp) => runDirName(LABEL, stamp)));

      const remaining = readdirSync(root).sort();
      expect(remaining).toContain("keepme.txt");
      expect(remaining).toContain(runDirName("other-label", all[0] as string));
      expect(remaining).toContain(`${LABEL}-not-a-stamp`);
      const keptLabelDirs = remaining.filter((name) => name.startsWith(`${LABEL}-2`));
      expect(keptLabelDirs.length).toBe(20);
      expect(existsSync(join(root, current))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Evidence.start wiring (real evidence root, self-cleaning label)", () => {
  const WIRING_LABEL = "evidence-rotation-wiring-selftest";
  const wiringStamps = stamps(24); // 24 fake + 1 real = 25 -> keep 22 -> delete 3

  function wiringDirs(): string[] {
    return readdirSync(realEvidenceRoot())
      .filter((name) => name.startsWith(`${WIRING_LABEL}-`))
      .sort();
  }

  function seedWiringDirs(): void {
    mkdirSync(realEvidenceRoot(), { recursive: true });
    for (const stamp of wiringStamps) {
      const dir = join(realEvidenceRoot(), runDirName(WIRING_LABEL, stamp));
      mkdirSync(dir);
      writeFileSync(join(dir, "driver.log.txt"), "wiring fixture", "utf8");
    }
  }

  function cleanWiringDirs(): void {
    for (const name of wiringDirs()) {
      rmSync(join(realEvidenceRoot(), name), { recursive: true, force: true });
    }
  }

  it("by default (no options), Evidence.start rotates: its label is trimmed to the newest K", () => {
    seedWiringDirs();
    try {
      const evidence = Evidence.start(WIRING_LABEL, { note: "POLISH-1 rotation wiring self-test" });
      const dirs = wiringDirs();
      expect(dirs.length).toBe(DOGFOOD_EVIDENCE_ROTATION_KEEP);
      expect(existsSync(evidence.dir)).toBe(true);
      expect(existsSync(join(evidence.dir, "driver.log.txt"))).toBe(true);
    } finally {
      cleanWiringDirs();
    }
    expect(wiringDirs()).toEqual([]);
  });

  it("with { rotate: false }, Evidence.start does not rotate", () => {
    seedWiringDirs();
    try {
      const evidence = Evidence.start(WIRING_LABEL, { note: "POLISH-1 rotate-off self-test" }, { rotate: false });
      expect(wiringDirs().length).toBe(wiringStamps.length + 1); // nothing deleted
      expect(existsSync(evidence.dir)).toBe(true);
    } finally {
      cleanWiringDirs();
    }
    expect(wiringDirs()).toEqual([]);
  });
});
