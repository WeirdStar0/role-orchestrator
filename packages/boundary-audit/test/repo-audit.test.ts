/**
 * M11-01 — the boundary audit of THIS repository, pinned like release-audit's
 * repo audit: if these assertions fail, the workspace gained a package or an
 * external runtime edge outside the registered boundary — both require a
 * human look (extend OPEN_CORE_PACKAGE_MANIFEST / CORE_EXTERNAL_RUNTIME_
 * ALLOWLIST with disclosure), never a mechanical relaxation.
 */
import { describe, expect, it } from "vitest";
import { auditCommercialBoundary } from "../src/index.js";

// Resolve the repository root relative to this package (packages/boundary-audit).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("boundary audit of this repository (M11-01 registration)", () => {
  it("scans packages/ AND apps/; 37 workspace packages, zero violations", () => {
    const result = auditCommercialBoundary({ repoRoot: ROOT, additionalPackageDirs: ["apps"] });
    // 36 packages/* + apps/desktop-ui (the M11-01 registration; the count
    // baseline precedent is M6-04/M7-01/.../M10-02 — disclosed each time).
    expect(result.workspacePackageCount).toBe(37);
    expect(result.violations).toEqual([]);
    expect(result.verdict).toBe("pass");
    // The desktop renderer is inside the open-core manifest...
    expect(result.corePackagesUsed).toContain("@role-orchestrator/desktop-ui");
    expect(result.corePackagesUsed).toHaveLength(37);
    // ...and its frozen UI stack is the exact R2 allowance extension.
    expect(result.externalAllowlistUsed).toEqual([
      "lucide-react",
      "react",
      "react-dom",
      "react-router-dom",
      "ws",
      "yaml",
      "zod"
    ]);
  });

  it("the default scan (packages/ only) sees only 36 packages — the apps/ member is INVISIBLE without the additional scan", () => {
    // Why the repo pin MUST pass additionalPackageDirs: a default-scan-only
    // caller does not fail on the desktop renderer — it never discovers it
    // (R4a drift only fires for DISCOVERED packages). The registration is
    // therefore pinned by the scan-both assertion above; this test documents
    // the visibility gap so it can never be mistaken for coverage.
    const result = auditCommercialBoundary({ repoRoot: ROOT });
    expect(result.workspacePackageCount).toBe(36);
    expect(result.corePackagesUsed).toContain("@role-orchestrator/desktop-ui");
  });
});
