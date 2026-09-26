/**
 * Tests for the M0-06 capability-gate registry.
 *
 * Coverage contract: EVERY registry entry (blocked argv pattern, blocked
 * assumption, capability status record) is exercised below, plus the
 * fail-closed queries (unknown assumption id / unknown capability id) and the
 * isUsable rule that only "verified" counts as usable.
 */
import { describe, expect, test } from "vitest";
import {
  BLOCKED_ARGV_PATTERNS,
  BLOCKED_ASSUMPTIONS,
  CAPABILITY_RECORDS,
  blockedPatternFor,
  checkAssumption,
  isBlocked,
  isUsable,
  statusOf
} from "../src/index.js";
import { CAPABILITY_STATUSES } from "../src/schema.js";

describe("registry data integrity", () => {
  test("every registry array is non-empty", () => {
    expect(BLOCKED_ARGV_PATTERNS.length).toBeGreaterThanOrEqual(2);
    expect(BLOCKED_ASSUMPTIONS.length).toBeGreaterThanOrEqual(7);
    expect(CAPABILITY_RECORDS.length).toBeGreaterThanOrEqual(30);
  });

  test("ids are unique within and across the blocked registries", () => {
    const blockedIds = [
      ...BLOCKED_ARGV_PATTERNS.map((entry) => entry.id),
      ...BLOCKED_ASSUMPTIONS.map((entry) => entry.id)
    ];
    expect(new Set(blockedIds).size).toBe(blockedIds.length);
  });

  test("capability ids are unique and every record has one of the four statuses", () => {
    const ids = CAPABILITY_RECORDS.map((record) => record.capability);
    expect(new Set(ids).size).toBe(ids.length);
    for (const record of CAPABILITY_RECORDS) {
      expect(CAPABILITY_STATUSES).toContain(record.status);
      expect(record.evidence.length).toBeGreaterThanOrEqual(1);
      expect(record.summary.length).toBeGreaterThan(0);
    }
  });

  test("both CLIs are represented with verified and non-verified cells", () => {
    for (const cli of ["claude", "codex"] as const) {
      const cells = CAPABILITY_RECORDS.filter((record) => record.cli === cli);
      expect(cells.length).toBeGreaterThanOrEqual(10);
      expect(cells.some((record) => record.status === "verified")).toBe(true);
      expect(cells.some((record) => record.status === "unverified")).toBe(true);
    }
    // The two unattended-write usage modes are the matrix's blocked cells.
    expect(statusOf("claude.unattended-write-mode").status).toBe("blocked");
    expect(statusOf("codex.unattended-write-mode").status).toBe("blocked");
  });
});

describe("blocked argv patterns (every entry)", () => {
  // Hand-written samples per entry, each representing the real-world flag the
  // pattern exists to catch.
  const MATCH_SAMPLES: Record<string, string[]> = {
    "argv.permission-skip-flags": [
      "--dangerously-skip-permissions",
      "claude -p --output-format stream-json --dangerously-skip-permissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "codex exec --json --sandbox danger-full-access",
      // Case-insensitive: variants must not slip through by casing.
      "--DANGEROUSLY-SKIP-PERMISSIONS"
    ],
    "argv.environment-gate-bypass": [
      "--skip-git-repo-check",
      "codex exec --skip-git-repo-check --json -"
    ]
  };

  const BENIGN_ARGV_SAMPLES = [
    "",
    "-p --output-format stream-json --verbose",
    "codex exec --json -",
    "--model gpt-6-astra",
    "--resume <session-id>",
    "--verbose"
  ];

  test("each blocked pattern matches its samples via isBlocked and blockedPatternFor", () => {
    for (const entry of BLOCKED_ARGV_PATTERNS) {
      const samples = MATCH_SAMPLES[entry.id];
      expect(samples, `missing match samples for ${entry.id}`).toBeDefined();
      for (const sample of samples ?? []) {
        const hit = blockedPatternFor(sample);
        expect(isBlocked(sample), `isBlocked(${sample})`).toBe(true);
        expect(hit?.id, `blockedPatternFor(${sample})`).toBe(entry.id);
      }
    }
  });

  test("benign argv never matches any blocked pattern", () => {
    for (const sample of BENIGN_ARGV_SAMPLES) {
      expect(isBlocked(sample), `isBlocked(${JSON.stringify(sample)})`).toBe(false);
      expect(blockedPatternFor(sample)).toBeNull();
    }
  });

  test("each entry carries a rationale and accepted evidence", () => {
    for (const entry of BLOCKED_ARGV_PATTERNS) {
      expect(entry.rationale.length).toBeGreaterThan(20);
      expect(entry.evidence.length).toBeGreaterThanOrEqual(1);
      expect(["forbidden", "explicit-authorization"]).toContain(entry.requiredControl);
    }
  });
});

describe("blocked assumptions (every entry)", () => {
  test("each registered assumption is listed and blocked with its own control", () => {
    for (const entry of BLOCKED_ASSUMPTIONS) {
      const decision = checkAssumption(entry.id);
      expect(decision.listed).toBe(true);
      expect(decision.blocked).toBe(true);
      expect(decision.requiredControl).toBe(entry.requiredControl);
      expect(decision.reason).toBe(entry.title);
    }
  });

  test("the pinned dangerous claims are all blocked (M0-06 minimum set)", () => {
    const minimumSet = [
      "codex.default-mode-unattended-write",
      "claude.mid-run-approval-in-noninteractive",
      "implicit-loading.unmanaged-clean-baseline",
      "success.exit0-or-subtype-as-business-success",
      "process.pid-only-identity",
      "platform.cross-namespace-pid",
      "claim.unverified-capability-as-supported"
    ];
    for (const id of minimumSet) {
      expect(BLOCKED_ASSUMPTIONS.some((entry) => entry.id === id), id).toBe(true);
      expect(checkAssumption(id).blocked).toBe(true);
    }
  });

  test("unknown assumption ids are denied by default (fail-closed)", () => {
    const decision = checkAssumption("no.such.assumption");
    expect(decision.listed).toBe(false);
    expect(decision.blocked).toBe(true);
    expect(decision.requiredControl).toBe("unknown-deny");
  });

  test("each entry quotes the exact claim and cites accepted evidence", () => {
    for (const entry of BLOCKED_ASSUMPTIONS) {
      expect(entry.claim.length).toBeGreaterThan(10);
      expect(entry.evidence.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("capability status lookup (every entry)", () => {
  test("statusOf returns the exact record for every registered capability", () => {
    for (const record of CAPABILITY_RECORDS) {
      const lookup = statusOf(record.capability);
      expect(lookup).toEqual({
        capability: record.capability,
        known: true,
        cli: record.cli,
        status: record.status,
        summary: record.summary,
        evidence: record.evidence
      });
    }
  });

  test("unknown capability ids report unverified (never verified, never allowed)", () => {
    const lookup = statusOf("claude.definitely-not-a-registered-capability");
    expect(lookup.known).toBe(false);
    expect(lookup.cli).toBeNull();
    expect(lookup.status).toBe("unverified");
    expect(isUsable(lookup.status)).toBe(false);
  });

  test("isUsable is true only for verified (能力未知不标记支持)", () => {
    expect(isUsable("verified")).toBe(true);
    expect(isUsable("unsupported")).toBe(false);
    expect(isUsable("unverified")).toBe(false);
    expect(isUsable("blocked")).toBe(false);
  });

  test("pinned cells reflect the M0-06 matrix", () => {
    // claude success-path stream shape was never captured (429 window + 2
    // failed retries on 2026-09-22) — must stay unverified.
    expect(statusOf("claude.stream-parsing.success-path").status).toBe("unverified");
    expect(isUsable(statusOf("claude.stream-parsing.success-path").status)).toBe(false);
    // The is_error trap is real-evidence verified.
    expect(statusOf("claude.success-verdict.failure-detection").status).toBe("verified");
    // codex default-mode writes executing without approval is verified…
    expect(statusOf("codex.permission-default-writes-executed").status).toBe("verified");
    // …and exactly because of that, unattended write modes are blocked.
    expect(statusOf("codex.unattended-write-mode").status).toBe("blocked");
    expect(isUsable(statusOf("codex.unattended-write-mode").status)).toBe(false);
    // All non-win32 platforms stay unverified (never measured).
    expect(statusOf("claude.platform-difference.other-platforms").status).toBe("unverified");
    expect(statusOf("codex.platform-difference.other-platforms").status).toBe("unverified");
    // codex MCP implicit loading is invisible in the stream: unknown-deny.
    expect(statusOf("codex.implicit-loading.mcp").status).toBe("unverified");
  });
});

/**
 * M6-01 pin of the A31/A32 boundary AS IT EXISTS TODAY: no runtime mode
 * claims Hardened, because no capability cell provides its prerequisite —
 * a verified strong-sandbox/approval rejection path. The registry is where
 * that invariant lives, so it is pinned here: flipping either sandbox-
 * adjacent cell to "verified" (or adding any Hardened-granting cell)
 * without real evidence now fails this test. A31 itself (a secret-reading
 * test script actually blocked inside a claimed-Hardened mode) stays
 * unverified until a platform with a verified strong sandbox exists.
 */
describe("A31/A32 posture: no Hardened-granting evidence exists (M6-01)", () => {
  test("the sandbox/approval-rejection cells are unverified — not usable for a Hardened claim", () => {
    for (const id of ["codex.approval-sandbox-rejection-path", "claude.permission-approval-behavior"]) {
      const cell = statusOf(id);
      expect(cell.known, `${id} must be a registered cell`).toBe(true);
      expect(cell.status, `${id} has no real rejection-path evidence`).toBe("unverified");
      expect(isUsable(cell.status), `${id} must not count as usable`).toBe(false);
    }
  });

  test("the unattended-write modes stay blocked on both CLIs", () => {
    expect(statusOf("claude.unattended-write-mode").status).toBe("blocked");
    expect(statusOf("codex.unattended-write-mode").status).toBe("blocked");
  });

  test("treating unverified capabilities as supported is a blocked assumption (unknown-deny)", () => {
    const decision = checkAssumption("claim.unverified-capability-as-supported");
    expect(decision.blocked).toBe(true);
    expect(decision.requiredControl).toBe("unknown-deny");
    // Unknown capability ids cannot back a Hardened claim either.
    expect(isUsable(statusOf("madeup.hardened-sandbox-proof").status)).toBe(false);
  });
});
