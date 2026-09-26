/**
 * actionDigest pinning (M4-01, A17 core): the digest is a pure function of
 * the action descriptor's canonical serialization. These tests FREEZE the
 * format: same input -> same digest; ANY element change -> different digest;
 * the golden value pins the exact serialization so an unconscious format
 * change fails here first.
 */
import { describe, expect, it } from "vitest";
import { ACTION_DIGEST_SCHEMA_VERSION, actionDigest, canonicalActionDescriptor } from "../src/index.js";
import { SHA_A, SHA_B, SHA_C, sampleAction } from "./helpers.js";

// Fully literal golden action (no shared counter, no machine-specific paths)
// so the pinned digest is reproducible everywhere.
const GOLDEN_ACTION = sampleAction({
  argv: ["fake-codex", "exec", "--json", "--scenario", "golden"]
});
// Computed once and pinned: sha256 over the canonical serialization of
// GOLDEN_ACTION with schemaVersion 1.
const GOLDEN_DIGEST = "46663ee6e349b07e76e95a29ee7552a7997daeca1210d0ff53b96a780124d020";

describe("actionDigest determinism and format pinning", () => {
  it("is deterministic for identical inputs", () => {
    expect(actionDigest(GOLDEN_ACTION)).toBe(actionDigest(GOLDEN_ACTION));
  });

  it("matches the pinned golden digest (format freeze)", () => {
    expect(ACTION_DIGEST_SCHEMA_VERSION).toBe(1);
    expect(actionDigest(GOLDEN_ACTION)).toBe(GOLDEN_DIGEST);
  });

  it("serializes canonically: sorted keys, argv array order preserved", () => {
    const canonical = canonicalActionDescriptor(GOLDEN_ACTION);
    const parsed: unknown = JSON.parse(canonical);
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual(
      [
        "argv",
        "cwd",
        "dimensions",
        "profileRevision",
        "permissionIncrements",
        "repo",
        "requiredCapabilities",
        "runtime",
        "schemaVersion",
        "writeScope"
      ].sort()
    );
    const record = parsed as { argv: string[] };
    expect(record.argv).toEqual(GOLDEN_ACTION.argv);
  });

  it("is a 64-hex sha256", () => {
    expect(actionDigest(GOLDEN_ACTION)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("any element change produces a different digest (A17 foundation)", () => {
  const base = actionDigest(GOLDEN_ACTION);
  const expectDifferent = (label: string, mutate: () => Parameters<typeof actionDigest>[0]) => {
    it(`changes when ${label}`, () => {
      const mutated = mutate();
      expect(actionDigest(mutated)).not.toBe(base);
      // and is again deterministic for the mutated action
      expect(actionDigest(mutated)).toBe(actionDigest(mutated));
    });
  };

  expectDifferent("argv[0] changes", () =>
    sampleAction({ argv: ["other-cli", "exec", "--json", "--scenario", "golden"] })
  );
  expectDifferent("a middle argv element changes", () =>
    sampleAction({ argv: ["fake-codex", "exec", "--json", "--scenario", "CHANGED"] })
  );
  expectDifferent("an argv element is appended", () =>
    sampleAction({ argv: [...GOLDEN_ACTION.argv, "--extra"] })
  );
  expectDifferent("argv order is permuted", () =>
    sampleAction({ argv: [...GOLDEN_ACTION.argv].reverse() })
  );
  expectDifferent("cwd changes", () => sampleAction({ cwd: "h:/other/cwd" }));
  expectDifferent("repo root changes", () => ({
    ...GOLDEN_ACTION,
    repo: { ...GOLDEN_ACTION.repo, root: "h:/repos/other" }
  }));
  expectDifferent("baseSha changes", () => ({
    ...GOLDEN_ACTION,
    repo: { ...GOLDEN_ACTION.repo, baseSha: SHA_C }
  }));
  expectDifferent("targetSha changes", () => ({
    ...GOLDEN_ACTION,
    repo: { ...GOLDEN_ACTION.repo, targetSha: SHA_C }
  }));
  expectDifferent("targetSha is cleared", () => ({
    ...GOLDEN_ACTION,
    repo: { ...GOLDEN_ACTION.repo, targetSha: null }
  }));
  expectDifferent("profileRevision changes", () => sampleAction({ profileRevision: "rev-2" }));
  expectDifferent("a permission increment appears", () =>
    sampleAction({ requiredPermissions: ["repo.write", "git.read"] })
  );
  expectDifferent("a granted permission disappears (increment grows)", () =>
    sampleAction({ grantedPermissions: [] })
  );
  expectDifferent("a dimension is added", () =>
    sampleAction({ dimensions: ["write", "network"] })
  );
  expectDifferent("writeScope changes", () => sampleAction({ writeScope: "task-branch" }));
  expectDifferent("a required capability is added", () =>
    sampleAction({ requiredCapabilities: ["codex.noninteractive-entry", "codex.resume"] })
  );
});

describe("increment set identity", () => {
  // A shared literal argv so the only varying element is the permission sets.
  const fixedArgv = ["fake-codex", "exec", "--json", "--scenario", "perm-set"];

  it("input order of the same permission SET does not change the digest", () => {
    const first = actionDigest(
      sampleAction({
        argv: fixedArgv,
        requiredPermissions: ["repo.write", "git.read"],
        grantedPermissions: ["repo.read"]
      })
    );
    const second = actionDigest(
      sampleAction({
        argv: fixedArgv,
        requiredPermissions: ["git.read", "repo.write"],
        grantedPermissions: ["repo.read"]
      })
    );
    expect(first).toBe(second);
  });

  it("duplicate permission entries are rejected by the strict schema", () => {
    // Validation happens at the digest/grading boundary (ActionDescriptorSchema.parse).
    expect(() =>
      actionDigest(
        sampleAction({ argv: fixedArgv, requiredPermissions: ["repo.write", "repo.write"] })
      )
    ).toThrow();
  });
});

describe("digest covers the SHA triple exactly", () => {
  it("two actions differing only in targetSha never collide", () => {
    const one = actionDigest(sampleAction({ repo: { root: "h:/r", baseSha: SHA_A, targetSha: SHA_B } }));
    const two = actionDigest(sampleAction({ repo: { root: "h:/r", baseSha: SHA_A, targetSha: SHA_C } }));
    expect(one).not.toBe(two);
  });
});
