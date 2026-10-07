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
    // The walk actually covered the repository. The strict volume pins
    // (1500/900/500 — POLISH-1 K=22 tuning) describe the RELEASE-machine
    // working tree where the rotated browser-e2e evidence pngs enter the
    // walk; they apply verbatim whenever those binaries are present. On a
    // fresh checkout (no evidence in the walk) only the committed-tree
    // floors apply — the verdict and classification assertions above stay
    // unconditional in both environments. M8-05 recalibration (2026-09-30,
    // disclosed in PROPOSALS.md): cargo `target` build output joined the
    // default excluded dirs (generated-output class, zero findings
    // contributed); measured walk on this tree is now 1811 scanned /
    // 1280 text / 530 binary — all three pins hold with margin, and fresh
    // checkouts never had target contents, so the committed-tree floors
    // are unchanged.
    if (result.binaryFiles > 0) {
      expect(result.scannedFiles).toBeGreaterThan(1500);
      expect(result.textFiles).toBeGreaterThan(900);
      expect(result.binaryFiles).toBeGreaterThan(500);
    } else {
      // 819 git-tracked files + margin: a silently-empty walk cannot pass.
      expect(result.scannedFiles).toBeGreaterThan(700);
      expect(result.textFiles).toBeGreaterThan(500);
    }
    // Reservation evidence was seen (desensitized fixtures are committed;
    // the E2E screenshots enter the walk only on evidence-bearing trees).
    expect(result.reservationFiles.some((f) => f.startsWith("packages/cli-events/fixtures-real/"))).toBe(true);
    if (result.binaryFiles > 0) {
      expect(result.reservationFiles.some((f) => f.startsWith("packages/browser-e2e/evidence/"))).toBe(true);
    }
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
    // M11-01: apps/desktop-ui is the 38th workspace project (count baseline
    // updated per the M6-04/…/M10-02 precedent; FOUR new runtime npm
    // dependencies — the maintainer-frozen UI stack react/react-dom/
    // react-router-dom/lucide-react, see the M11 whitelist in
    // docs/BACKLOG.md). The count is pnpm-lock.yaml importers (root "." +
    // every workspace package), so it is one above boundary-audit's
    // OPEN_CORE_PACKAGE_MANIFEST name count (37 names: no root entry) — two
    // counters, deliberately not conflated (M10-02 review round 2, B1).
    expect(result.workspacePackageCount).toBe(38);
    expect(result.specifierMismatches).toEqual([]);
    expect(result.missingIntegrity).toEqual([]);
    expect(result.customRegistryEntries).toEqual([]);
    expect(result.npmrcRegistryOverrides).toEqual([]);
    // M8-05: esbuild ^0.28.2 as a devDependency of packages/local-api (build
    // tool for the serve sidecar bundle, never a runtime edge) brings itself
    // plus its 26 platform-optional @esbuild/* binaries into the lockfile:
    // 84 → 111 distinct external name@version entries (disclosed in
    // PROPOSALS.md; the previous 84-pin premise "esbuild already present as a
    // vitest transitive dep" was factually wrong — vite 8 lists esbuild only
    // as an UNINSTALLED optional peer).
    // M11-01: the desktop renderer's frozen UI stack (react/react-dom/
    // react-router-dom/lucide-react) plus its transitive closure
    // (@types/react, @types/react-dom, @vitejs/plugin-react, cookie, csstype,
    // react-router, scheduler, set-cookie-parser) grows the table 111 → 123.
    expect(result.externalPackages.length).toBe(123);
  });

  it("dependency audit: every installed license is known; only MPL-2.0 lightningcss needs review", () => {
    const result = auditDependencies({ repoRoot });
    // M8-05: esbuild + @esbuild/win32-x64 install locally (both MIT, 44 → 46);
    // the other 25 @esbuild/* platform binaries are os/cpu-gated and not
    // installed on this machine (30 → 55).
    // M11-01: the UI stack installs locally — 11 MIT entries (@types/react,
    // @types/react-dom, @vitejs/plugin-react, cookie, csstype, react,
    // react-dom, react-router, react-router-dom, scheduler,
    // set-cookie-parser) and 1 ISC (lucide-react): MIT 46 → 57, ISC 3 → 4,
    // not-installed unchanged (no new platform-gated package).
    expect(result.licenseSummary).toEqual({
      MIT: 57,
      "(not-installed-locally)": 55,
      "Apache-2.0": 4,
      "MPL-2.0": 2,
      ISC: 4,
      "BSD-3-Clause": 1
    });
    expect(result.unknownLicenses).toEqual([]);
    // lightningcss ships per-platform native binaries as optional deps; the
    // installed binary name follows the RUNNING platform.
    const lightningcssBinary = {
      win32: "lightningcss-win32-x64-msvc",
      linux: "lightningcss-linux-x64-gnu",
      darwin: "lightningcss-darwin-arm64"
    }[process.platform as "win32" | "linux" | "darwin"];
    expect(result.reviewLicenses.map((d) => `${d.name}@${d.version}`)).toEqual([
      "lightningcss@1.33.0",
      `${lightningcssBinary}@1.33.0`
    ]);
    // The not-installed set must ONLY be platform-optional native/binary
    // packages — anything else would hide a real license gap. M8-05 adds the
    // @esbuild/* os/cpu-gated platform binaries to the same allowlist class.
    const unexpected = result.notInstalledLocally.filter(
      (entry) =>
        !entry.includes("binding-") &&
        !entry.startsWith("lightningcss-") &&
        !entry.startsWith("@turbo/") &&
        !entry.startsWith("@esbuild/") &&
        entry !== "fsevents@2.3.3"
    );
    expect(unexpected).toEqual([]);
  });

  it("dependency audit: runtime externals are exactly ws/yaml/zod + the frozen M11 UI stack; THIRD_PARTY_NOTICES covers all 123", () => {
    const result = auditDependencies({ repoRoot });
    // M8-05 invariant: esbuild stays dev-only. M11-01: the desktop renderer
    // adds the FOUR whitelisted UI runtime dependencies (boundary-audit's R2
    // allowlist is the same registration); everything else it carries is
    // devDependencies (vite/@vitejs/plugin-react/typescript/@types/*).
    expect(result.externalPackages.filter((d) => d.runtime).map((d) => d.name).sort()).toEqual([
      "lucide-react",
      "react",
      "react-dom",
      "react-router-dom",
      "ws",
      "yaml",
      "zod"
    ]);
    // Governance-baseline update (2026-09-25, maintainer-approved; disclosed in
    // PROPOSALS.md): THIRD_PARTY_NOTICES.md now lists all 84 npm dependency
    // names with their license status, so full coverage is the new pin. The
    // previous pin (covered=[] / uncovered=84) is preserved in PROPOSALS.md.
    // M8-05 (2026-09-30): +27 entries (esbuild + 26 @esbuild/* platform
    // binaries), all covered — full coverage pin moves 84 → 111.
    // M11-01 (2026-10-07): +12 entries (the UI stack's transitive closure),
    // all covered — full coverage pin moves 111 → 123.
    expect(result.noticesCovered.length).toBe(123);
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

  it("governance: Codeowners rules present, private channel configured (email), release approval still pending", () => {
    const result = inventoryGovernance({ repoRoot });
    // Governance-baseline update (2026-09-25, maintainer-approved): CODEOWNERS
    // now carries active ownership rules, MAINTAINERS.md records the maintainer
    // identity, and LICENSE is formalized.
    // Governance-baseline update (2026-09-26, maintainer-approved): the private
    // security contact (weirdstar@outlook.com) is configured in SECURITY.md
    // after the GitHub PVR UI option proved unavailable on the maintainer's
    // account; disclosed in PROPOSALS.md. Release approval remains a
    // maintainer action.
    expect(result.codeowners.status).toBe("rules-present");
    expect(result.codeowners.activeRules.length).toBe(7);
    expect(result.codeowners.templateMarkerPresent).toBe(false);
    expect(result.privateChannel.status).toBe("contact-points-present");
    expect(result.privateChannel.statesChannelNotConfigured).toBe(true);
    expect(result.privateChannel.contactPointsFound).toEqual(["weirdstar@outlook.com"]);
    expect(result.licenseDecision.status).toBe("formalized");
    expect(result.releaseApproval.status).toBe("pending-maintainer");
    expect(result.maintainerIdentityRecorded).toBe(true);
  });
});
