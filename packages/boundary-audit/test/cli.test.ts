import { describe, expect, it } from "vitest";
import { runBoundaryAuditCli } from "../src/cli.js";
import { fixturePackage, makeTmpRoot, writeTree } from "./helpers.js";

/**
 * CLI contract tests on hermetic fixture trees: exit 0 = pass, 1 = boundary
 * violations, 2 = usage or precondition error. The CLI intentionally has no
 * override flags, so fixture core packages are named after entries of the
 * BUILT-IN manifest; the commercial fixture package carries the marker and
 * is therefore exempt from manifest membership by design. The
 * real-repository run is recorded in reports/M7-04-commercial-boundary.md
 * (mechanism verification), deliberately NOT pinned here as a test, so this
 * package does not add a second per-package-Add baseline next to
 * release-audit's pinned count.
 */

const CORE = "@role-orchestrator/contracts"; // an entry of OPEN_CORE_PACKAGE_MANIFEST
const PAYWALL = "@role-orchestrator/paywall-ex"; // commercial-marked, unlisted by design

function cleanTree(repoRoot: string): void {
  writeTree(repoRoot, {
    "packages/contracts/package.json": fixturePackage({
      name: CORE,
      dependencies: { zod: "^4.6.5" }
    }),
    "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
  });
}

describe("ro-boundary-audit CLI contract (fixture trees)", () => {
  it("a passing tree exits 0 with parseable JSON verdict pass", async () => {
    const root = makeTmpRoot("boundary-cli-pass-");
    cleanTree(root);
    const result = await runBoundaryAuditCli([root]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as { verdict: string; violations: unknown[] };
    expect(parsed.verdict).toBe("pass");
    expect(parsed.violations).toEqual([]);
  });

  it("a violating tree exits 1 with the violations in the JSON output", async () => {
    const root = makeTmpRoot("boundary-cli-fail-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE,
        dependencies: { [PAYWALL]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const result = await runBoundaryAuditCli([root]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.output) as {
      verdict: string;
      violations: readonly { rule: string }[];
    };
    expect(parsed.verdict).toBe("fail");
    expect(parsed.violations.map((v) => v.rule)).toEqual(["commercial-dep-in-core"]);
  });

  it("a nonexistent repoRoot exits 2 with the precondition message", async () => {
    const result = await runBoundaryAuditCli(["Z:/definitely/not/a/repo-root"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("boundary-audit precondition failed");
  });

  it("more than one positional argument is a usage error (exit 2)", async () => {
    const result = await runBoundaryAuditCli(["somewhere", "else"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("usage: ro-boundary-audit [repoRoot]");
  });

  it("an unknown flag is a usage error, never silently parsed as a repoRoot (exit 2)", async () => {
    const root = makeTmpRoot("boundary-cli-flag-");
    cleanTree(root);
    const result = await runBoundaryAuditCli(["--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("usage: ro-boundary-audit [repoRoot]");
    expect(result.output).toContain("flags are not supported");
  });
});
