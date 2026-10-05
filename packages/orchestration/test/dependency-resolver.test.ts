/**
 * M10-02 M5 — the dependency-baseline rule. Moved from the e2e-baseline
 * driver (driver.ts baselineFor); these cells pin the shared semantics the
 * three pumps converge on in step 2: last accepted dependency wins, none
 * falls back to the run's base commit (production's single "execute" node —
 * 恒 run.baseSha — is the empty-dependency case).
 */
import { describe, expect, it } from "vitest";
import { baselineFor, buildParents } from "../src/dependency-resolver.js";
import type { AcceptedOutputs } from "../src/dependency-resolver.js";

const BASE = "base0000000000000000000000000000000000000000";
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function outputs(entries: Record<string, { branch: string; headSha: string }>): AcceptedOutputs {
  return new Map(Object.entries(entries));
}

describe("baselineFor (M5 dependency-resolver)", () => {
  it("no dependencies -> the run's base commit (the production single-node case)", () => {
    expect(baselineFor([], outputs({ a: { branch: "b", headSha: SHA_A } }), BASE)).toBe(BASE);
  });

  it("the LAST dependency with an accepted output wins (dependencies walked backwards)", () => {
    const accepted = outputs({
      a: { branch: "branch-a", headSha: SHA_A },
      b: { branch: "branch-b", headSha: SHA_B }
    });
    expect(baselineFor(["a", "b"], accepted, BASE)).toBe(SHA_B);
    expect(baselineFor(["b", "a"], accepted, BASE)).toBe(SHA_A);
  });

  it("a dependency WITHOUT an accepted output falls through to earlier ones", () => {
    const accepted = outputs({ a: { branch: "branch-a", headSha: SHA_A } });
    expect(baselineFor(["missing", "a", "also-missing"], accepted, BASE)).toBe(SHA_A);
  });

  it("no accepted outputs at all -> the run's base commit", () => {
    expect(baselineFor(["a", "b"], outputs({}), BASE)).toBe(BASE);
  });
});

describe("buildParents (M5 dependency-resolver)", () => {
  it("maps every dependency, in order, to nodeId/branch/headSha", () => {
    const accepted = outputs({
      a: { branch: "branch-a", headSha: SHA_A },
      b: { branch: "branch-b", headSha: SHA_B }
    });
    expect(buildParents("integrate", ["a", "b"], accepted)).toEqual([
      { nodeId: "a", branch: "branch-a", headSha: SHA_A },
      { nodeId: "b", branch: "branch-b", headSha: SHA_B }
    ]);
  });

  it("refuses a dependency without an accepted output (pump-contract violation)", () => {
    expect(() => buildParents("integrate", ["a"], outputs({}))).toThrowError(
      'integration node "integrate" depends on "a" which has no accepted output yet'
    );
  });
});
