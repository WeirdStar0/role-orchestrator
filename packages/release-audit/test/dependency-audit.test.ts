import { describe, expect, it } from "vitest";
import { auditDependencies } from "../src/dependency-audit.js";
import { AuditTargetMissingError, LockfileParseError } from "../src/errors.js";
import { makeTmpRoot, writeTree } from "./helpers.js";

function fixtureRepo(tree: Record<string, string>): string {
  const root = makeTmpRoot("ro-audit-deps-");
  writeTree(root, tree);
  return root;
}

const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      devpkg:
        specifier: ^2.0.0
        version: 2.0.0

  packages/a:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0
      '@role-orchestrator/contracts':
        specifier: workspace:*
        version: link:../contracts

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}
    dependencies:
      tiny-dep:
        specifier: ^1.0.0
        version: 1.0.0

  tiny-dep@1.0.0:
    resolution: {integrity: sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==}

  devpkg@2.0.0:
    resolution: {integrity: sha512-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC==}

  remote-pkg@3.0.0:
    resolution: {tarball: https://mirror.example.com/remote-pkg/-/remote-pkg-3.0.0.tgz}
`;

const INSTALLED_LEFT_PAD = JSON.stringify({ name: "left-pad", version: "1.3.0", license: "MIT" });
const INSTALLED_TINY_DEP = JSON.stringify({ name: "tiny-dep", version: "1.0.0", license: "BSD-3-Clause" });
const INSTALLED_DEVPKG = JSON.stringify({ name: "devpkg", version: "2.0.0", license: "Apache-2.0" });

function baseTree(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "root", private: true, devDependencies: { devpkg: "^2.0.0" } }),
    "packages/a/package.json": JSON.stringify({
      name: "@role-orchestrator/a",
      dependencies: { "left-pad": "^1.3.0", "@role-orchestrator/contracts": "workspace:*" },
      devDependencies: {}
    }),
    "pnpm-lock.yaml": LOCK,
    "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/package.json": INSTALLED_LEFT_PAD,
    "node_modules/.pnpm/tiny-dep@1.0.0/node_modules/tiny-dep/package.json": INSTALLED_TINY_DEP,
    "node_modules/.pnpm/devpkg@2.0.0/node_modules/devpkg/package.json": INSTALLED_DEVPKG,
    "THIRD_PARTY_NOTICES.md": "# notices\n\nStatic python deps only.\n"
  };
}

describe("auditDependencies", () => {
  it("audits every external package: registry, integrity, license from installed manifests, runtime reachability", () => {
    const root = fixtureRepo(baseTree());
    const result = auditDependencies({ repoRoot: root });
    const names = result.externalPackages.map((d) => d.name).sort();
    expect(names).toEqual(["devpkg", "left-pad", "remote-pkg", "tiny-dep"]);

    const leftPad = result.externalPackages.find((d) => d.name === "left-pad");
    expect(leftPad?.license).toBe("MIT");
    expect(leftPad?.licenseSource).toBe("installed-manifest");
    expect(leftPad?.integrityPinned).toBe(true);
    expect(leftPad?.registry).toBe("https://registry.npmjs.org/");
    expect(leftPad?.direct).toBe(true);
    expect(leftPad?.runtime).toBe(true);

    const tinyDep = result.externalPackages.find((d) => d.name === "tiny-dep");
    expect(tinyDep?.direct).toBe(false);
    // tiny-dep is only reachable through left-pad's runtime dependencies.
    expect(tinyDep?.runtime).toBe(true);

    const devpkg = result.externalPackages.find((d) => d.name === "devpkg");
    expect(devpkg?.runtime).toBe(false);

    expect(result.specifierMismatches).toEqual([]);
    // The fixture's tarball-only entry (remote-pkg) has no integrity hash by
    // construction — exactly what the audit must surface.
    expect(result.missingIntegrity).toEqual(["remote-pkg@3.0.0"]);
    expect(result.workspacePackageCount).toBe(2);
  });

  it("reports not-installed platform packages honestly instead of guessing a license", () => {
    const root = fixtureRepo(baseTree());
    const result = auditDependencies({ repoRoot: root });
    expect(result.notInstalledLocally).toContain("remote-pkg@3.0.0");
    const remote = result.externalPackages.find((d) => d.name === "remote-pkg");
    expect(remote?.license).toBeNull();
    expect(remote?.licenseSource).toBe("not-installed-locally");
  });

  it("surfaces non-default tarball sources as custom registry entries", () => {
    const root = fixtureRepo(baseTree());
    const result = auditDependencies({ repoRoot: root });
    expect(result.customRegistryEntries).toHaveLength(1);
    expect(result.customRegistryEntries[0]).toContain("mirror.example.com");
  });

  it("detects package.json vs lockfile specifier mismatches", () => {
    const tree = baseTree();
    tree["packages/a/package.json"] = JSON.stringify({
      name: "@role-orchestrator/a",
      dependencies: { "left-pad": "^2.0.0" }
    });
    const root = fixtureRepo(tree);
    const result = auditDependencies({ repoRoot: root });
    expect(result.specifierMismatches).toHaveLength(1);
    expect(result.specifierMismatches[0]).toContain("left-pad");
    expect(result.specifierMismatches[0]).toContain("^2.0.0");
  });

  it("flags lockfile entries without an integrity pin", () => {
    const lock = LOCK.replace(
      "  tiny-dep@1.0.0:\n    resolution: {integrity: sha512-BBBB",
      "  tiny-dep@1.0.0:\n    resolution: {integrity: \"\"}\n    junk: sha512-BBBB"
    );
    const tree = baseTree();
    tree["pnpm-lock.yaml"] = lock;
    const root = fixtureRepo(tree);
    const result = auditDependencies({ repoRoot: root });
    expect(result.missingIntegrity).toContain("tiny-dep@1.0.0");
  });

  it("computes THIRD_PARTY_NOTICES coverage against exact package names", () => {
    const tree = baseTree();
    tree["THIRD_PARTY_NOTICES.md"] = "# notices\n\nleft-pad is recorded here. PyYAML too.\n";
    const root = fixtureRepo(tree);
    const result = auditDependencies({ repoRoot: root });
    expect(result.noticesCovered).toEqual(["left-pad"]);
    expect(result.noticesUncovered).toEqual(["devpkg", "remote-pkg", "tiny-dep"]);
  });

  it("surfaces .npmrc registry overrides when present", () => {
    const tree = baseTree();
    tree[".npmrc"] = "registry=https://private.example.com/npm/\n";
    const root = fixtureRepo(tree);
    const result = auditDependencies({ repoRoot: root });
    expect(result.npmrcRegistryOverrides).toEqual(["registry=https://private.example.com/npm/"]);
  });

  it("missing lockfile and malformed YAML are typed precondition errors", () => {
    const empty = makeTmpRoot("ro-audit-deps-empty-");
    expect(() => auditDependencies({ repoRoot: empty })).toThrowError(AuditTargetMissingError);

    const broken = fixtureRepo({ "pnpm-lock.yaml": "importers:\n  .:\n    deps: [unclosed\n" });
    expect(() => auditDependencies({ repoRoot: broken })).toThrowError(LockfileParseError);
  });
});
