import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  auditCommercialBoundary,
  findRuntimeCycles,
  A01_COMMERCIAL_STATEMENT,
  A02_COMMERCIAL_STATEMENT,
  COMMERCIAL_BOUNDARY_STATEMENT,
  COMMERCIAL_MARKER_FIELD,
  CORE_EXTERNAL_RUNTIME_ALLOWLIST,
  DESIGN_ONLY_DISCLOSURE,
  OPEN_CORE_PACKAGE_MANIFEST,
  type BoundaryAuditInput,
  type BoundaryViolationRule
} from "../src/index.js";
import { AuditTargetMissingError, ManifestParseError } from "../src/errors.js";
import { parseWorkspaceManifest } from "../src/index.js";
import { fixturePackage, makeTmpRoot, writeTree } from "./helpers.js";

/**
 * M7-04 hermetic rule-branch tests: every audit rule branch is exercised on
 * a fixture tree under the OS temp dir (no network, no git, no real CLI).
 * The fixtures include the deliberately violating samples required by the
 * M7-04 ask (commercial-dep, allowlist-external dep, dependency cycle).
 */

const CORE_A = "@role-orchestrator/core-a";
const CORE_B = "@role-orchestrator/core-b";
const PAYWALL = "@role-orchestrator/paywall";

function rulesOf(violations: readonly { rule: BoundaryViolationRule }[]): BoundaryViolationRule[] {
  return [...new Set(violations.map((v) => v.rule))].sort();
}

/** Standard small fixture options: two core packages, one commercial. */
function baseOptions(repoRoot: string): BoundaryAuditInput {
  return {
    repoRoot,
    corePackages: [CORE_A, CORE_B],
    coreExternalAllowlist: ["zod"]
  };
}

describe("boundary audit: rule branches (hermetic fixtures)", () => {
  it("clean tree passes: no commercial packages, allowlisted externals, acyclic graph", () => {
    const root = makeTmpRoot("boundary-clean-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        dependencies: { zod: "^4.6.5" }
      }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        dependencies: { [CORE_A]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({
        name: PAYWALL,
        commercialMarker: true,
        // Commercial packages MAY sit outside the core allowlist.
        dependencies: { "left-pad": "^1.3.0" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("pass");
    expect(result.violations).toEqual([]);
    expect(result.commercialPackages).toEqual([PAYWALL]);
    expect(result.workspacePackageCount).toBe(3);
    expect(result.runtimeWorkspaceEdges).toEqual([`${CORE_B} -> ${CORE_A}`]);
    // Every result carries the honesty statements.
    expect(result.boundaryStatement).toBe(COMMERCIAL_BOUNDARY_STATEMENT);
    expect(result.designDisclosure).toBe(DESIGN_ONLY_DISCLOSURE);
    expect(result.markerField).toBe(COMMERCIAL_MARKER_FIELD);
  });

  it("R1 violation fixture: core dependencies on a commercial package is caught", () => {
    const root = makeTmpRoot("boundary-r1-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({ name: CORE_A }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        dependencies: { [PAYWALL]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      rule: "commercial-dep-in-core",
      packageName: CORE_B,
      dependencyName: PAYWALL
    });
    expect(result.violations[0]?.detail).toContain("startup path");
  });

  it("R1b violation fixture: core devDependencies on a commercial package is caught (build path)", () => {
    const root = makeTmpRoot("boundary-r1b-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({ name: CORE_A }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        devDependencies: { [PAYWALL]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({
        name: PAYWALL,
        commercialMarker: true,
        devDependencies: { [CORE_A]: "workspace:*" } // commercial -> core dev edge is fine
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      rule: "commercial-devdep-in-core",
      packageName: CORE_B,
      dependencyName: PAYWALL
    });
    expect(result.violations[0]?.detail).toContain("build path");
  });

  it("R2 violation fixture: core external runtime dependency outside the allowlist is caught", () => {
    const root = makeTmpRoot("boundary-r2-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        dependencies: { "left-pad": "^1.3.0", zod: "^4.6.5" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      rule: "external-dep-outside-allowlist",
      packageName: CORE_A,
      dependencyName: "left-pad"
    });
    expect(result.violations[0]?.detail).toContain("[zod]");
    // The allowlisted external itself produces no finding.
    expect(result.violations.some((v) => v.dependencyName === "zod")).toBe(false);
  });

  it("R3 violation fixture: a runtime dependency cycle is caught, normalized and reported once", () => {
    const root = makeTmpRoot("boundary-r3-");
    writeTree(root, {
      "packages/a/package.json": fixturePackage({
        name: CORE_A,
        dependencies: { [CORE_B]: "workspace:*" }
      }),
      "packages/b/package.json": fixturePackage({
        name: CORE_B,
        dependencies: { [CORE_A]: "workspace:*" }
      }),
      // Dev-only back edge does NOT create a runtime cycle finding (it is
      // still boundary-checked directionally by R1/R1b).
      "packages/c/package.json": fixturePackage({ name: PAYWALL })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    const cycles = result.violations.filter((v) => v.rule === "workspace-dependency-cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.detail).toBe(
      `workspace runtime dependency cycle: ${CORE_A} -> ${CORE_B} -> ${CORE_A}`
    );
  });

  it("R3 degenerate fixture: a self-dependency is a one-node cycle", () => {
    const root = makeTmpRoot("boundary-r3-self-");
    writeTree(root, {
      "packages/a/package.json": fixturePackage({
        name: CORE_A,
        dependencies: { [CORE_A]: "workspace:*" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(rulesOf(result.violations)).toEqual(["workspace-dependency-cycle"]);
    expect(result.violations[0]?.detail).toContain(`${CORE_A} -> ${CORE_A}`);
  });

  it("R4a violation fixture: an unlisted non-commercial package is manifest drift", () => {
    const root = makeTmpRoot("boundary-r4a-");
    writeTree(root, {
      "packages/newcore/package.json": fixturePackage({ name: "@role-orchestrator/newcore" })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(rulesOf(result.violations)).toEqual(["core-manifest-drift"]);
    expect(result.violations[0]?.packageName).toBe("@role-orchestrator/newcore");
  });

  it("R4b violation fixture: a commercial package listed as core is a contradiction", () => {
    const root = makeTmpRoot("boundary-r4b-");
    writeTree(root, {
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const result = auditCommercialBoundary({ ...baseOptions(root), corePackages: [PAYWALL] });
    expect(rulesOf(result.violations)).toEqual(["core-manifest-contradiction"]);
  });

  it("R4c violation fixtures: non-boolean marker AND alias marker key both caught; package stays under core scrutiny", () => {
    const root = makeTmpRoot("boundary-r4c-");
    writeTree(root, {
      // String "true" instead of boolean: NOT commercial, anomaly recorded,
      // and its outside-allowlist external keeps being flagged (fail-closed).
      "packages/sneaky/package.json": fixturePackage({
        name: CORE_A,
        commercialMarker: "true",
        dependencies: { "left-pad": "^1.3.0" }
      }),
      "packages/aliased/package.json": fixturePackage({
        name: CORE_B,
        extraKeys: { isCommercial: true }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(rulesOf(result.violations)).toEqual([
      "external-dep-outside-allowlist",
      "malformed-commercial-marker"
    ]);
    expect(result.violations.filter((v) => v.rule === "malformed-commercial-marker")).toHaveLength(2);
    expect(result.commercialPackages).toEqual([]); // neither package escaped core scrutiny
    const sneaky = result.violations.find(
      (v) => v.rule === "malformed-commercial-marker" && v.packageName === CORE_A
    );
    expect(sneaky?.detail).toContain("must be the boolean true/false, got string");
  });

  it("R5 violation fixture: a dangling workspace reference is caught (and not misread as external)", () => {
    const root = makeTmpRoot("boundary-r5-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        dependencies: { "@role-orchestrator/ghost": "workspace:*" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(rulesOf(result.violations)).toEqual(["dangling-workspace-dep"]);
    expect(result.violations[0]).toMatchObject({
      packageName: CORE_A,
      dependencyName: "@role-orchestrator/ghost"
    });
  });

  it("a stray directory without package.json is skipped, not a finding", () => {
    const root = makeTmpRoot("boundary-stray-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({ name: CORE_A }),
      "packages/notes-file/README.md": "not a package\n"
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("pass");
    expect(result.workspacePackageCount).toBe(1);
  });

  it("the audit is deterministic: two runs over the same tree serialize identically", () => {
    const root = makeTmpRoot("boundary-det-");
    writeTree(root, {
      "packages/b/package.json": fixturePackage({ name: CORE_B }),
      "packages/a/package.json": fixturePackage({
        name: CORE_A,
        dependencies: { "left-pad": "^1.0.0" }
      }),
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const first = JSON.stringify(auditCommercialBoundary(baseOptions(root)));
    const second = JSON.stringify(auditCommercialBoundary(baseOptions(root)));
    expect(first).toBe(second);
    expect(() => JSON.parse(first)).not.toThrow();
  });
});

describe("HARDENING-1: optionalDependencies and peerDependencies are audited channels", () => {
  it("R1 via optionalDependencies: a core OPTIONAL dependency on a commercial package is caught (runtime edge)", () => {
    const root = makeTmpRoot("boundary-opt-r1-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({ name: CORE_A }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        optionalDependencies: { [PAYWALL]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      rule: "commercial-dep-in-core",
      packageName: CORE_B,
      dependencyName: PAYWALL
    });
    expect(result.violations[0]?.detail).toContain("optionalDependencies");
    expect(result.violations[0]?.detail).toContain("optional runtime path");
  });

  it("R1b via peerDependencies: a core PEER dependency on a commercial package is caught (build/integration edge)", () => {
    const root = makeTmpRoot("boundary-peer-r1b-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({ name: CORE_A }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        peerDependencies: { [PAYWALL]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      rule: "commercial-devdep-in-core",
      packageName: CORE_B,
      dependencyName: PAYWALL
    });
    expect(result.violations[0]?.detail).toContain("peerDependencies");
    expect(result.violations[0]?.detail).toContain("peer/integration path");
  });

  it("R2 via optionalDependencies AND peerDependencies: unallowlisted externals in both sections are caught", () => {
    const root = makeTmpRoot("boundary-opt-r2-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        optionalDependencies: { "left-pad": "^1.3.0" },
        peerDependencies: { "some-unallowlisted-peer": "^2.0.0" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("fail");
    const r2 = result.violations.filter((v) => v.rule === "external-dep-outside-allowlist");
    expect(r2).toHaveLength(2);
    expect(r2.map((v) => v.dependencyName).sort()).toEqual(["left-pad", "some-unallowlisted-peer"]);
    expect(r2.map((v) => v.detail).join("\n")).toContain("via optionalDependencies");
    expect(r2.map((v) => v.detail).join("\n")).toContain("via peerDependencies");
  });

  it("R5 via optionalDependencies AND peerDependencies: dangling workspace refs in both sections are caught", () => {
    const root = makeTmpRoot("boundary-opt-r5-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        optionalDependencies: { "@role-orchestrator/ghost-opt": "workspace:*" },
        peerDependencies: { "@role-orchestrator/ghost-peer": "workspace:^" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(rulesOf(result.violations)).toEqual(["dangling-workspace-dep"]);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.dependencyName).sort()).toEqual([
      "@role-orchestrator/ghost-opt",
      "@role-orchestrator/ghost-peer"
    ]);
    expect(result.violations.map((v) => v.detail).join("\n")).toContain("optionalDependencies");
    expect(result.violations.map((v) => v.detail).join("\n")).toContain("peerDependencies");
  });

  it("negative: a legitimate optional external (allowlisted) and a legitimate peer (workspace core) raise nothing", () => {
    const root = makeTmpRoot("boundary-opt-clean-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        optionalDependencies: { zod: "^4.6.5" },
        peerDependencies: { [CORE_B]: "workspace:*" }
      }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        peerDependencies: { zod: "^4.6.5" } // core peers an allowlisted external
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    expect(result.verdict).toBe("pass");
    expect(result.violations).toEqual([]);
  });

  it("optional/peer edges do NOT enter the R3 runtime cycle graph (cycles stay hard-runtime findings)", () => {
    const root = makeTmpRoot("boundary-opt-cycle-");
    writeTree(root, {
      "packages/a/package.json": fixturePackage({
        name: CORE_A,
        optionalDependencies: { [CORE_B]: "workspace:*" }
      }),
      "packages/b/package.json": fixturePackage({
        name: CORE_B,
        dependencies: { [CORE_A]: "workspace:*" }
      })
    });
    const result = auditCommercialBoundary(baseOptions(root));
    // The optional back edge A->B is boundary-checked (here: clean), but the
    // runtime cycle graph keeps depending only on hard `dependencies` edges,
    // so this remains a pass and runtimeWorkspaceEdges stays hard-runtime.
    expect(result.verdict).toBe("pass");
    expect(result.runtimeWorkspaceEdges).toEqual([`${CORE_B} -> ${CORE_A}`]);
  });

  it("the extended audit stays deterministic on trees WITH optional/peer edges", () => {
    const root = makeTmpRoot("boundary-opt-det-");
    writeTree(root, {
      "packages/contracts/package.json": fixturePackage({
        name: CORE_A,
        optionalDependencies: { [PAYWALL]: "workspace:*", "left-pad": "^1.0.0" },
        peerDependencies: { "@role-orchestrator/ghost": "workspace:*" }
      }),
      "packages/engine/package.json": fixturePackage({
        name: CORE_B,
        peerDependencies: { [PAYWALL]: "workspace:*" }
      }),
      "packages/paywall/package.json": fixturePackage({ name: PAYWALL, commercialMarker: true })
    });
    const first = JSON.stringify(auditCommercialBoundary(baseOptions(root)));
    const second = JSON.stringify(auditCommercialBoundary(baseOptions(root)));
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as { violations: readonly { rule: string }[] };
    expect(parsed.violations.map((v) => v.rule).sort()).toEqual([
      "commercial-dep-in-core",
      "commercial-devdep-in-core",
      "dangling-workspace-dep",
      "external-dep-outside-allowlist"
    ]);
  });

  it("malformed optional/peer sections throw ManifestParseError like the classic sections", () => {
    const badSpecifier = { zod: 4 } as unknown as Readonly<Record<string, string>>;
    const notAnObject = "zod" as unknown as Readonly<Record<string, string>>;
    expect(() =>
      parseWorkspaceManifest(
        "broken",
        fixturePackage({ name: CORE_A, optionalDependencies: badSpecifier }),
        "packages/broken/package.json"
      )
    ).toThrow(ManifestParseError);
    expect(() =>
      parseWorkspaceManifest(
        "broken",
        fixturePackage({ name: CORE_A, peerDependencies: notAnObject }),
        "packages/broken/package.json"
      )
    ).toThrow(ManifestParseError);
    const parsed = parseWorkspaceManifest(
      "ok",
      fixturePackage({ name: CORE_A, optionalDependencies: { zod: "^4" } }),
      "packages/ok/package.json"
    );
    expect(parsed.optionalDependencies).toEqual({ zod: "^4" });
    expect(parsed.peerDependencies).toEqual({});
  });
});

describe("boundary audit: input validation and preconditions", () => {
  it("unknown input fields are rejected (strict schema)", () => {
    const root = makeTmpRoot("boundary-strict-");
    expect(() =>
      auditCommercialBoundary({ repoRoot: root, smuggled: true } as BoundaryAuditInput)
    ).toThrow(/unrecognized|strict/i);
  });

  it("a missing repo root or packages directory throws AuditTargetMissingError", () => {
    const root = makeTmpRoot("boundary-missing-");
    expect(() => auditCommercialBoundary({ repoRoot: path.join(root, "nope") })).toThrow(
      AuditTargetMissingError
    );
    expect(() => auditCommercialBoundary({ repoRoot: root })).toThrow(AuditTargetMissingError);
  });

  it("an unparseable package.json throws ManifestParseError", () => {
    const root = makeTmpRoot("boundary-badjson-");
    writeTree(root, { "packages/broken/package.json": "{ not json" });
    expect(() => auditCommercialBoundary(baseOptions(root))).toThrow(ManifestParseError);
  });

  it("a package.json without a name throws ManifestParseError", () => {
    const root = makeTmpRoot("boundary-noname-");
    writeTree(root, { "packages/noname/package.json": '{"version":"0.1.0"}' });
    expect(() => auditCommercialBoundary(baseOptions(root))).toThrow(ManifestParseError);
  });

  it("findRuntimeCycles: diamond (no cycle) passes, three-node ring normalizes to smallest start", () => {
    const diamond = new Map<string, readonly string[]>([
      ["a", ["b", "c"]],
      ["b", ["d"]],
      ["c", ["d"]],
      ["d", []]
    ]);
    expect(findRuntimeCycles(diamond)).toEqual([]);
    const ring = new Map<string, readonly string[]>([
      ["c", ["a"]],
      ["a", ["b"]],
      ["b", ["c"]]
    ]);
    expect(findRuntimeCycles(ring)).toEqual([["a", "b", "c"]]);
  });
});

describe("boundary audit: built-in inventories and pinned statements", () => {
  it("the built-in open-core manifest is closed, sorted, unique, fully scoped and includes this auditor", () => {
    expect([...OPEN_CORE_PACKAGE_MANIFEST].sort()).toEqual([...OPEN_CORE_PACKAGE_MANIFEST]);
    expect(new Set(OPEN_CORE_PACKAGE_MANIFEST).size).toBe(OPEN_CORE_PACKAGE_MANIFEST.length);
    expect(OPEN_CORE_PACKAGE_MANIFEST.every((name) => name.startsWith("@role-orchestrator/"))).toBe(
      true
    );
    expect(OPEN_CORE_PACKAGE_MANIFEST).toContain("@role-orchestrator/boundary-audit");
  });

  it("the built-in external allowlist is the frozen M11 whitelist on top of ws/yaml/zod, sorted", () => {
    // M11-01 registration (disclosed in the batch record): the desktop
    // renderer's four runtime npm dependencies join the R2 allowlist — the
    // maintainer-frozen UI stack (docs/BACKLOG.md M11 技术栈). Build tooling
    // (vite/@vitejs/plugin-react/typescript) stays dev-only, outside R2.
    expect(CORE_EXTERNAL_RUNTIME_ALLOWLIST).toEqual([
      "lucide-react",
      "react",
      "react-dom",
      "react-router-dom",
      "ws",
      "yaml",
      "zod"
    ]);
  });

  it("the marker field is the literal 'commercial'", () => {
    expect(COMMERCIAL_MARKER_FIELD).toBe("commercial");
  });

  it("the A01/A02 commercial-plane statements and the design-only disclosure are pinned verbatim", () => {
    expect(COMMERCIAL_BOUNDARY_STATEMENT).toContain("OPEN_CORE_PACKAGE_MANIFEST");
    expect(COMMERCIAL_BOUNDARY_STATEMENT).toContain('"commercial": true');
    expect(COMMERCIAL_BOUNDARY_STATEMENT).toContain("must not enter the open core's startup or build path");
    // A01: single-select binding through the SAME authority, no second path.
    expect(A01_COMMERCIAL_STATEMENT).toContain("A01 single-select binding holds unchanged");
    expect(A01_COMMERCIAL_STATEMENT).toContain("binds to exactly one Profile");
    expect(A01_COMMERCIAL_STATEMENT).toContain("MUST NOT ship an alternative profile-selection path");
    // A02: override refusal at every layer, closed vocabulary, no relaxation.
    expect(A02_COMMERCIAL_STATEMENT).toContain("A02 override rejection holds unchanged");
    expect(A02_COMMERCIAL_STATEMENT).toContain("FORBIDDEN_OVERRIDE_KEYS");
    expect(A02_COMMERCIAL_STATEMENT).toContain("can never relax, alias, or bypass");
    // Honesty: the design-only disclosure is part of the shipped data.
    expect(DESIGN_ONLY_DISCLOSURE).toContain("NO commercial-edition code exists");
    expect(DESIGN_ONLY_DISCLOSURE).toContain("MECHANISM verification");
    expect(DESIGN_ONLY_DISCLOSURE).toContain("NOT existence verification");
  });
});
