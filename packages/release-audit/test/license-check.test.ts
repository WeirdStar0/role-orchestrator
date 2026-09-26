import { copyFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLicenseCandidate,
  canonicalApacheFixturePath,
  normalizeWording,
  sha256Of,
  CANONICAL_APACHE_2_0_SHA256
} from "../src/license-check.js";
import { makeTmpRoot, repoRoot, writeTree } from "./helpers.js";

describe("checkLicenseCandidate", () => {
  it("the shipped canonical fixture is the verbatim apache.org text", () => {
    expect(sha256Of(canonicalApacheFixturePath())).toBe(CANONICAL_APACHE_2_0_SHA256);
  });

  it("the repository candidate matches the canonical WORDING (layout-only differences allowed)", () => {
    const root = makeTmpRoot("ro-audit-lic-");
    copyFileSync(path.join(repoRoot, "LICENSE.proposed.txt"), path.join(root, "LICENSE.proposed.txt"));
    const result = checkLicenseCandidate({ repoRoot: root });
    expect(result.candidateExists).toBe(true);
    expect(result.wordingIdentical).toBe(true);
    expect(result.status).toBe("candidate-matches-canonical");
    expect(result.firstDivergences).toEqual([]);
    expect(result.formalization).toBe("pending-maintainer-confirmation");
    // Recorded honestly: the candidate is NOT byte-identical to the apache.org file.
    expect(result.byteIdentical).toBe(false);
    expect(result.candidateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a reworded candidate is reported as diverging with the first divergences", () => {
    const root = makeTmpRoot("ro-audit-lic-div-");
    writeTree(root, { "LICENSE.proposed.txt": "MIT License\n\nPermission is hereby granted...\n" });
    const result = checkLicenseCandidate({ repoRoot: root });
    expect(result.status).toBe("candidate-diverges");
    expect(result.wordingIdentical).toBe(false);
    expect(result.firstDivergences.length).toBeGreaterThan(0);
  });

  it("a missing candidate and a present formal LICENSE are distinguished", () => {
    const root = makeTmpRoot("ro-audit-lic-miss-");
    const missing = checkLicenseCandidate({ repoRoot: root });
    expect(missing.candidateExists).toBe(false);
    expect(missing.status).toBe("candidate-missing");
    expect(missing.formalization).toBe("pending-maintainer-confirmation");

    writeFileSync(path.join(root, "LICENSE"), "Apache License\n");
    const formalized = checkLicenseCandidate({ repoRoot: root });
    expect(formalized.formalization).toBe("formalized");
  });

  it("normalizeWording is layout-insensitive but wording-sensitive", () => {
    expect(normalizeWording("  a  b\nc\r\n\nd")).toBe("a b\nc\nd");
    expect(normalizeWording("a b")).not.toBe(normalizeWording("a  c"));
  });
});
