import { describe, expect, it } from "vitest";
import { scanSecrets } from "../src/secrets-scan.js";
import { auditDependencies } from "../src/dependency-audit.js";
import { checkLicenseCandidate } from "../src/license-check.js";
import { inventoryGovernance } from "../src/governance.js";
import { repoRoot } from "./helpers.js";

/**
 * M6-03 integration: the audit runs against THIS repository and its outcome
 * is pinned. If one of these assertions fails, either the repository gained
 * a release-blocking condition or the audit rules changed — both require a
 * human look, never a mechanical assertion relaxation.
 */

describe("release audit of this repository (M6-03)", () => {
  // Load-sensitive at max turbo --force concurrency: explicit 20s test budget, zero assertion changes (HARDENING-1 §6; disclosed in reports/HARDENING-2.md).
  it("secret scan: verdict is known-reservations-only with ZERO needs-judgment findings (A42/A36)", { timeout: 20_000 }, () => {
    const result = scanSecrets({ repoRoot });
    expect(result.verdict).toBe("known-reservations-only");
    const unjudged = result.findings.filter((f) => f.classification === "needs-judgment");
    expect(unjudged).toEqual([]);
    // The walk actually covered the repository.
    expect(result.scannedFiles).toBeGreaterThan(1500);
    expect(result.textFiles).toBeGreaterThan(900);
    expect(result.binaryFiles).toBeGreaterThan(500);
    // Reservation evidence was seen (desensitized fixtures + E2E screenshots).
    expect(result.reservationFiles.some((f) => f.startsWith("packages/cli-events/fixtures-real/"))).toBe(true);
    expect(result.reservationFiles.some((f) => f.startsWith("packages/browser-e2e/evidence/"))).toBe(true);
    // Every recorded hit is a classified known reservation/sentinel, and the
    // release-audit own tests provide the planted sentinels for the rules.
    for (const finding of result.findings) {
      expect(["test-sentinel", "known-fake-sentinel"]).toContain(finding.classification);
    }
    const rulesSeen = new Set(result.findings.map((f) => f.rule));
    expect(rulesSeen.has("anthropic-key")).toBe(true);
    expect(rulesSeen.has("bearer-credential")).toBe(true);
    expect(rulesSeen.has("openai-style-key")).toBe(true);
  });

  it("dependency audit: specifier agreement, full integrity pinning, default registry only", () => {
    const result = auditDependencies({ repoRoot });
    // M7-04: packages/boundary-audit is the 35th workspace project (count
    // baseline updated per the M6-04/M7-01/M7-02/M7-03 precedent; adds zero
    // new external npm dependencies — see PROPOSALS.md).
    expect(result.workspacePackageCount).toBe(35);
    expect(result.specifierMismatches).toEqual([]);
    expect(result.missingIntegrity).toEqual([]);
    expect(result.customRegistryEntries).toEqual([]);
    expect(result.npmrcRegistryOverrides).toEqual([]);
    expect(result.externalPackages.length).toBe(84);
  });

  it("dependency audit: every installed license is known; only MPL-2.0 lightningcss needs review", () => {
    const result = auditDependencies({ repoRoot });
    expect(result.licenseSummary).toEqual({
      MIT: 44,
      "(not-installed-locally)": 30,
      "Apache-2.0": 4,
      "MPL-2.0": 2,
      ISC: 3,
      "BSD-3-Clause": 1
    });
    expect(result.unknownLicenses).toEqual([]);
    expect(result.reviewLicenses.map((d) => `${d.name}@${d.version}`)).toEqual([
      "lightningcss@1.33.0",
      "lightningcss-win32-x64-msvc@1.33.0"
    ]);
    // The not-installed set must ONLY be platform-optional native/binary
    // packages — anything else would hide a real license gap.
    const unexpected = result.notInstalledLocally.filter(
      (entry) =>
        !entry.includes("binding-") &&
        !entry.startsWith("lightningcss-") &&
        !entry.startsWith("@turbo/") &&
        entry !== "fsevents@2.3.3"
    );
    expect(unexpected).toEqual([]);
  });

  it("dependency audit: runtime externals are exactly ws/yaml/zod; THIRD_PARTY_NOTICES covers all 84", () => {
    const result = auditDependencies({ repoRoot });
    expect(result.externalPackages.filter((d) => d.runtime).map((d) => d.name).sort()).toEqual(["ws", "yaml", "zod"]);
    // Governance-baseline update (2026-09-25, maintainer-approved; disclosed in
    // PROPOSALS.md): THIRD_PARTY_NOTICES.md now lists all 84 npm dependency
    // names with their license status, so full coverage is the new pin. The
    // previous pin (covered=[] / uncovered=84) is preserved in PROPOSALS.md.
    expect(result.noticesCovered.length).toBe(84);
    expect(result.noticesUncovered).toEqual([]);
  });

  it("license candidate: wording-identical to canonical Apache-2.0; formal LICENSE in place", () => {
    const result = checkLicenseCandidate({ repoRoot });
    expect(result.status).toBe("candidate-matches-canonical");
    expect(result.wordingIdentical).toBe(true);
    expect(result.byteIdentical).toBe(false);
    expect(result.candidateSha256).toBe("af975c9737b3bdcdcf7ec3512b3dc936f91cc58a3c9152a8e4b0803f667df6b9");
    expect(result.canonicalFixtureSha256).toBe("cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
    // Governance-baseline update (2026-09-25, maintainer-approved): the formal
    // LICENSE file now exists (verbatim copy of the candidate), so the
    // formalization state flipped from pending to formalized.
    expect(result.formalization).toBe("formalized");
    expect(result.formalLicenseExists).toBe(true);
  });

  it("governance: Codeowners rules present (placeholder handle), private channel documented-unconfigured, release approval still pending", () => {
    const result = inventoryGovernance({ repoRoot });
    // Governance-baseline update (2026-09-25, maintainer-approved): CODEOWNERS
    // now carries active ownership rules (placeholder handle pending the real
    // one), MAINTAINERS.md records the maintainer identity, and LICENSE is
    // formalized. Private channel enablement and release approval remain
    // maintainer actions and stay in their pending/documented states.
    expect(result.codeowners.status).toBe("rules-present");
    expect(result.codeowners.activeRules.length).toBe(7);
    expect(result.codeowners.templateMarkerPresent).toBe(false);
    expect(result.privateChannel.status).toBe("not-configured-documented");
    expect(result.privateChannel.statesChannelNotConfigured).toBe(true);
    expect(result.privateChannel.contactPointsFound).toEqual([]);
    expect(result.licenseDecision.status).toBe("formalized");
    expect(result.releaseApproval.status).toBe("pending-maintainer");
    expect(result.maintainerIdentityRecorded).toBe(true);
  });
});
