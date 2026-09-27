/**
 * POLISH-1 — evidence run-directory rotation, pinned behaviour.
 *
 * Three layers are tested:
 *  1. the PURE decision (`planRunDirRotation` / `splitRunDirName`) — the
 *     batch's specified case (25 fake directories -> keep newest 20, delete
 *     5), the under-K zero-deletion case, and the "never touches anything
 *     outside the current label" guarantee;
 *  2. the env gate (`evidenceRotationEnabled`) — rotation is opt-in,
 *     strictly `BROWSER_E2E_EVIDENCE_ROTATION === "1"`;
 *  3. the wiring — `rotateRunDirs` against a real temp root (hermetic), and
 *     `Evidence.start` against the REAL evidence root with a dedicated
 *     self-cleaning label (net-zero footprint: the test removes every
 *     directory of its label afterwards).
 *
 * No real claude/codex, no browser, no network: hermetic by construction.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ROTATION_ENV,
  Evidence,
  EVIDENCE_ROTATION_KEEP,
  evidenceRotationEnabled,
  planRunDirRotation,
  rotateRunDirs,
  RUN_DIR_STAMP_PATTERN,
  splitRunDirName
} from "../src/evidence.js";

/** Synthetic ascending stamps: `stamps(25)[0]` is the OLDEST.
 *  Base 2020-01-01 (POLISH-2 T4): fixtures must stay strictly older than any
 *  real run directory (real stamps use the wall clock); the previous
 *  2026-09-26 base was within wall-clock reach, so a rolled-back clock could
 *  rank fixtures newer than the real run and break the wiring assertions. */
function stamps(count: number): string[] {
  const base = Date.UTC(2020, 0, 1, 0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) =>
    new Date(base + i * 1_000).toISOString().replace(/[:.]/g, "-")
  );
}

const LABEL = "flow-1-sequential";

function runDirName(label: string, stamp: string): string {
  return `${label}-${stamp}`;
}

/** The REAL evidence root, from this test file's location (test/ -> ../evidence). */
function realEvidenceRoot(): string {
  return fileURLToPath(new URL("../evidence", import.meta.url));
}

describe("splitRunDirName", () => {
  it("parses <label>-<stamp> and rejects everything that is not a run directory", () => {
    const stamp = "2026-09-26T02-06-27-892Z";
    expect(splitRunDirName(`${LABEL}-${stamp}`)).toEqual({ label: LABEL, stamp });
    // plain files and unrelated directories are never run directories
    expect(splitRunDirName("driver.log.txt")).toBeNull();
    expect(splitRunDirName("00-some-screenshot.png")).toBeNull();
    expect(splitRunDirName("random-dir")).toBeNull();
    // stamp-only name has no label
    expect(splitRunDirName(stamp)).toBeNull();
    // missing separator between label and stamp
    expect(splitRunDirName(`x${stamp}`)).toBeNull();
    // stamp validation is SHAPE-only (digits), not calendar-aware: a
    // digit-shaped but impossible date still parses — stamps are machine-
    // generated via toISOString(), never hand-written, and rotation only
    // orders them lexicographically
    expect(splitRunDirName(`${LABEL}-2026-13-99T99-99-99-999Z`)).toEqual({
      label: LABEL,
      stamp: "2026-13-99T99-99-99-999Z"
    });
    expect(splitRunDirName(`${LABEL}-not-a-stamp`)).toBeNull();
    // empty label
    expect(splitRunDirName(`-${stamp}`)).toBeNull();
    // stamp pattern is anchored: a longer suffix does not parse
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
    const plan = planRunDirRotation(entries, current, EVIDENCE_ROTATION_KEEP);
    expect(plan.delete).toEqual([]);
    expect(plan.keep).toEqual([...entries].reverse()); // newest first
  });

  it("never keeps or deletes anything outside the current label's run directories", () => {
    const all = stamps(25);
    const entries = [
      ...all.map((stamp) => runDirName(LABEL, stamp)),
      runDirName("flow-2-parallel", all[0] as string), // other label, ancient
      runDirName("regression-a39-ws-replay", all[1] as string), // other label
      "driver.log.txt", // a file
      "00-screenshot.png", // a file
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

  it("POLISH-2 drift anchor: the canonical vector plans identically to the dogfood sibling (deep-equal)", () => {
    // This exact vector is duplicated verbatim in
    // packages/dogfood/test/evidence-rotation.test.ts (POLISH-1 #15):
    // identical canonical input (same directory-name set, same keepCount)
    // must produce the identical plan in both packages, so any single-side
    // behaviour change fails HERE in the test diff instead of drifting
    // silently between the two evidence writers.
    const entries = [
      "anchor-label-2020-01-01T00-00-00-000Z",
      "anchor-label-2020-01-01T00-00-01-000Z",
      "anchor-label-2020-01-01T00-00-02-000Z",
      "anchor-label-2020-01-01T00-00-03-000Z",
      "anchor-label-2020-01-01T00-00-04-000Z",
      "anchor-other-label-2020-01-01T00-00-00-000Z", // another label -> ignored
      "anchor-plain-file.txt" // not a run directory -> ignored
    ];
    const plan = planRunDirRotation(entries, "anchor-label-2020-01-01T00-00-04-000Z", 2);
    expect(plan).toEqual({
      keep: ["anchor-label-2020-01-01T00-00-04-000Z", "anchor-label-2020-01-01T00-00-03-000Z"],
      delete: [
        "anchor-label-2020-01-01T00-00-00-000Z",
        "anchor-label-2020-01-01T00-00-01-000Z",
        "anchor-label-2020-01-01T00-00-02-000Z"
      ]
    });
  });
});

describe("evidenceRotationEnabled (env gate)", () => {
  it("is OFF by default and strictly requires the value \"1\"", () => {
    expect(evidenceRotationEnabled({})).toBe(false);
    expect(evidenceRotationEnabled({ [EVIDENCE_ROTATION_ENV]: "1" })).toBe(true);
    expect(evidenceRotationEnabled({ [EVIDENCE_ROTATION_ENV]: "0" })).toBe(false);
    expect(evidenceRotationEnabled({ [EVIDENCE_ROTATION_ENV]: "true" })).toBe(false);
    expect(evidenceRotationEnabled({ [EVIDENCE_ROTATION_ENV]: "" })).toBe(false);
  });
});

describe("rotateRunDirs (real fs, temp root)", () => {
  it("deletes exactly the 5 oldest same-label directories; unrelated entries are untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "browser-e2e-rotation-"));
    try {
      const all = stamps(25);
      for (const stamp of all) {
        const dir = join(root, runDirName(LABEL, stamp));
        mkdirSync(dir);
        writeFileSync(join(dir, "driver.log.txt"), "x", "utf8");
      }
      // unrelated entries that must survive
      mkdirSync(join(root, runDirName("flow-2-parallel", all[0] as string)));
      mkdirSync(join(root, `${LABEL}-not-a-stamp`));
      writeFileSync(join(root, "keepme.txt"), "y", "utf8");

      const current = runDirName(LABEL, all[24] as string);
      const outcome = rotateRunDirs(root, current, 20);
      expect(outcome.failed).toEqual([]);
      expect(outcome.deleted).toEqual(all.slice(0, 5).map((stamp) => runDirName(LABEL, stamp)));

      const remaining = readdirSync(root).sort();
      expect(remaining).toContain("keepme.txt");
      expect(remaining).toContain(runDirName("flow-2-parallel", all[0] as string));
      expect(remaining).toContain(`${LABEL}-not-a-stamp`);
      const keptLabelDirs = remaining.filter((name) => name.startsWith(`${LABEL}-2`));
      expect(keptLabelDirs.length).toBe(20);
      expect(existsSync(join(root, current))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unreadable root is a no-op, and a failing removeTree is reported, never thrown", () => {
    const missing = join(tmpdir(), "browser-e2e-rotation-missing-");
    expect(rotateRunDirs(missing, `${LABEL}-2026-09-26T00-00-00-000Z`, 20).deleted).toEqual([]);

    const boom = new Error("EBUSY (simulated)");
    const outcome = rotateRunDirs("root-does-not-matter", `${LABEL}-2026-09-26T00-00-04-000Z`, 1, {
      readdir: () => [
        "flow-1-sequential-2026-09-26T00-00-00-000Z",
        "flow-1-sequential-2026-09-26T00-00-01-000Z",
        "flow-1-sequential-2026-09-26T00-00-04-000Z"
      ],
      removeTree: (dir) => {
        if (dir.includes("00-00-00-000Z")) throw boom;
      }
    });
    expect(outcome.deleted).toEqual(["flow-1-sequential-2026-09-26T00-00-01-000Z"]);
    expect(outcome.failed).toEqual([{ dir: "flow-1-sequential-2026-09-26T00-00-00-000Z", error: String(boom) }]);
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

  it("with rotate: true, Evidence.start trims its label to the newest K directories", () => {
    seedWiringDirs();
    try {
      const evidence = Evidence.start(WIRING_LABEL, { note: "POLISH-1 rotation wiring self-test" }, { rotate: true });
      const dirs = wiringDirs();
      expect(dirs.length).toBe(EVIDENCE_ROTATION_KEEP);
      expect(existsSync(evidence.dir)).toBe(true);
      expect(existsSync(join(evidence.dir, "driver.log.txt"))).toBe(true);
    } finally {
      cleanWiringDirs();
    }
    expect(wiringDirs()).toEqual([]);
  });

  it("without the env var, Evidence.start does not rotate (library default is OFF)", () => {
    const previous = process.env[EVIDENCE_ROTATION_ENV];
    delete process.env[EVIDENCE_ROTATION_ENV];
    try {
      seedWiringDirs();
      const before = wiringDirs().length;
      Evidence.start(WIRING_LABEL, { note: "POLISH-1 default-off self-test" });
      expect(wiringDirs().length).toBe(before + 1); // nothing deleted
    } finally {
      process.env[EVIDENCE_ROTATION_ENV] = previous;
      cleanWiringDirs();
    }
    expect(wiringDirs()).toEqual([]);
  });
});
