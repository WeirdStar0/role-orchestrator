import { describe, expect, it } from "vitest";
import { runReleaseAuditCli } from "../src/cli.js";
import { makeTmpRoot, repoRoot } from "./helpers.js";

describe("runReleaseAuditCli", () => {
  // Load-sensitive at max turbo --force concurrency: explicit 20s test budget, zero assertion changes (HARDENING-1 §6; disclosed in reports/HARDENING-2.md).
  it("runs the full audit on this repository and exits 0 with parseable JSON", { timeout: 20_000 }, async () => {
    const result = await runReleaseAuditCli(["all", repoRoot]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output) as {
      section: string;
      blocking: string[];
      secrets?: { verdict: string };
      dependencies?: { specifierMismatches: string[] };
      license?: { status: string };
      governance?: { codeowners: { status: string } };
    };
    expect(report.section).toBe("all");
    expect(report.blocking).toEqual([]);
    expect(report.secrets?.verdict).toBe("known-reservations-only");
    expect(report.dependencies?.specifierMismatches).toEqual([]);
    expect(report.license?.status).toBe("candidate-matches-canonical");
    // Governance-baseline updates (maintainer-approved; disclosed in
    // PROPOSALS.md): CODEOWNERS carries active ownership rules (rules-present
    // replaced placeholder-only, 2026-09-25), and the maintainer handle is the
    // real @WeirdStar0, recorded 2026-09-25 per the PROPOSALS.md disclosure
    // 「治理披露：维护者 handle 替换占位符（2026-09-25）」 — there is no
    // placeholder pending anymore.
    expect(report.governance?.codeowners.status).toBe("rules-present");
  });

  // Same real-repo walk, same load sensitivity: it timed out at the 5000ms default under full turbo --force concurrency (HARDENING-1 §5; re-observed in the HARDENING-2 batch), so it gets the same explicit 20s test budget, zero assertion changes.
  it("a single section returns only that section", { timeout: 20_000 }, async () => {
    const result = await runReleaseAuditCli(["secrets", repoRoot]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.output) as { section: string; secrets?: unknown; dependencies?: unknown };
    expect(report.section).toBe("secrets");
    expect(report.secrets).toBeDefined();
    expect(report.dependencies).toBeUndefined();
  });

  it("findings outside reservations flip the exit code to 1", async () => {
    const root = makeTmpRoot("ro-audit-cli-find-");
    const { writeTree } = await import("./helpers.js");
    writeTree(root, { "src/config.yaml": "key: sk-ant-api03-0000000000000000\n" });
    const result = await runReleaseAuditCli(["secrets", root]);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.output) as { blocking: string[] };
    expect(report.blocking.length).toBeGreaterThan(0);
    expect(report.blocking[0]).toContain("needs judgment");
  });

  it("an unknown section is a usage error (exit 2)", async () => {
    const result = await runReleaseAuditCli(["nonsense"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("usage:");
  });

  it("an unusable repoRoot is a precondition error (exit 2), never a fake pass", async () => {
    const result = await runReleaseAuditCli(["all", "Z:/definitely/not/there"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("precondition failed");
  });
});
