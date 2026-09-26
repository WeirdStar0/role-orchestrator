/**
 * Risk grading tests (M4-01): dimension-driven grading per
 * docs/SECURITY_MODEL.md 风险分级 + capability-gate registry linkage, and
 * the A19 boundary (unattended writes require a node checkpoint; no fake
 * mid-run pause exists anywhere in the assessment vocabulary).
 */
import { describe, expect, it } from "vitest";
import { BLOCKED_ASSUMPTIONS } from "@role-orchestrator/capability-gate";
import {
  createApproval,
  gradeRisk,
  checkpointAssumptionIdsFor
} from "../src/index.js";
import { ApprovalForbiddenArgvError } from "../src/index.js";
import { T0, createApprovalWorld, highRiskAction, sampleAction } from "./helpers.js";

describe("low risk (docs/SECURITY_MODEL.md 低风险)", () => {
  it("read-only analysis within the authorized scope", () => {
    const assessment = gradeRisk(
      sampleAction({
        dimensions: ["readonly"],
        writeScope: null,
        requiredPermissions: ["repo.read", "git.read"],
        grantedPermissions: ["repo.read", "git.read", "repo.write"]
      })
    );
    expect(assessment.grade).toBe("low");
    expect(assessment.requiresApproval).toBe(false);
    expect(assessment.permissionIncrements).toEqual([]);
    expect(assessment.reasons.map((reason) => reason.code)).toContain("readonly-analysis");
  });

  it("controlled local modification: validation-temp write scope", () => {
    const assessment = gradeRisk(sampleAction({ writeScope: "validation-temp" }));
    expect(assessment.grade).toBe("low");
    expect(assessment.requiresApproval).toBe(false);
    expect(assessment.reasons.map((reason) => reason.code)).toContain("controlled-local-modification");
  });

  it("controlled local modification: managed-worktree write scope", () => {
    const assessment = gradeRisk(sampleAction());
    expect(assessment.grade).toBe("low");
    expect(assessment.requiresApproval).toBe(false);
  });
});

describe("medium risk (R19: Coordinator records the decision)", () => {
  it("commit on the tool-hosted task branch", () => {
    const assessment = gradeRisk(sampleAction({ writeScope: "task-branch" }));
    expect(assessment.grade).toBe("medium");
    expect(assessment.requiresApproval).toBe(false);
    expect(assessment.reasons.map((reason) => reason.code)).toContain("coordinator-decision");
  });
});

describe("high risk (docs/SECURITY_MODEL.md 高风险 — user approval required)", () => {
  const highCases: readonly [string, ReturnType<typeof sampleAction>][] = [
    [
      "permission elevation (the 权限增量)",
      sampleAction({ requiredPermissions: ["repo.write", "dag.propose"] })
    ],
    ["network access", sampleAction({ dimensions: ["write", "network"], writeScope: "managed-worktree" })],
    ["deletion", sampleAction({ dimensions: ["write", "delete"], writeScope: "managed-worktree" })],
    ["external side effect", sampleAction({ dimensions: ["external-side-effect"], writeScope: null })],
    ["main-branch delivery", sampleAction({ dimensions: ["main-branch-delivery"], writeScope: null })],
    ["unscoped write", sampleAction({ writeScope: "unscoped" })]
  ];

  for (const [label, action] of highCases) {
    it(`grades high and requires approval: ${label}`, () => {
      const assessment = gradeRisk(action);
      expect(assessment.grade).toBe("high");
      expect(assessment.requiresApproval).toBe(true);
    });
  }

  it("reports the derived permission increments with the elevation reason", () => {
    const assessment = gradeRisk(sampleAction({ requiredPermissions: ["repo.write", "git.read", "dag.propose"] }));
    expect(assessment.permissionIncrements).toEqual(["dag.propose", "git.read"]);
    const elevation = assessment.reasons.find((reason) => reason.code === "permission-elevation");
    expect(elevation?.detail).toContain("dag.propose");
    expect(elevation?.detail).toContain("git.read");
  });
});

describe("capability-gate linkage (unknown 拒绝)", () => {
  it("a verified capability does not raise the grade", () => {
    const assessment = gradeRisk(sampleAction({ requiredCapabilities: ["codex.noninteractive-entry"] }));
    expect(assessment.grade).toBe("low");
  });

  it("an unverified capability id grades high", () => {
    const assessment = gradeRisk(
      sampleAction({ requiredCapabilities: ["codex.noninteractive-entry", "codex.structured-business-output"] })
    );
    expect(assessment.grade).toBe("high");
    expect(assessment.requiresApproval).toBe(true);
    expect(assessment.reasons.some((reason) => reason.detail.includes("unverified"))).toBe(true);
  });

  it("an UNKNOWN capability id grades high (fail-closed, never treated as verified)", () => {
    const assessment = gradeRisk(
      sampleAction({ requiredCapabilities: ["codex.noninteractive-entry", "codex.made-up-capability"] })
    );
    expect(assessment.grade).toBe("high");
    expect(assessment.reasons.some((reason) => reason.detail.includes("unknown id"))).toBe(true);
  });

  it("blocked assumption ids for the node-checkpoint control come from gate data", () => {
    const codexIds = checkpointAssumptionIdsFor("codex");
    const claudeIds = checkpointAssumptionIdsFor("claude");
    expect(codexIds).toContain("codex.default-mode-unattended-write");
    expect(claudeIds).toContain("claude.mid-run-approval-in-noninteractive");
    // every reported id really carries the node-checkpoint control in the registry
    for (const id of [...codexIds, ...claudeIds]) {
      const entry = BLOCKED_ASSUMPTIONS.find((assumption) => assumption.id === id);
      expect(entry?.requiredControl).toBe("node-checkpoint");
    }
  });
});

describe("blocked argv patterns", () => {
  it("a forbidden pattern (--dangerously-skip-permissions) grades high and is flagged", () => {
    const assessment = gradeRisk(
      sampleAction({ argv: ["fake-codex", "--dangerously-skip-permissions", "exec"] })
    );
    expect(assessment.grade).toBe("high");
    expect(assessment.blockedPatterns).toEqual([
      { id: "argv.permission-skip-flags", requiredControl: "forbidden" }
    ]);
  });

  it("createApproval REFUSES a forbidden pattern outright — no approval row exists", () => {
    const world = createApprovalWorld("forbidden");
    try {
      let error: unknown = null;
      try {
        createApproval(world.db, {
          idempotencyKey: "idem-forbidden",
          action: sampleAction({ argv: ["fake-codex", "exec", "--dangerously-skip-permissions"] }),
          ttlSeconds: 3600,
          now: T0
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ApprovalForbiddenArgvError);
      const rows = world.db.prepare("SELECT COUNT(*) AS n FROM approvals").get();
      expect(rows?.n).toBe(0);
    } finally {
      world.close();
    }
  });

  it("an explicit-authorization pattern (--skip-git-repo-check) grades high but is approvable", () => {
    const assessment = gradeRisk(sampleAction({ argv: ["fake-codex", "exec", "--skip-git-repo-check"] }));
    expect(assessment.grade).toBe("high");
    expect(assessment.requiresApproval).toBe(true);
    expect(assessment.blockedPatterns).toEqual([
      { id: "argv.environment-gate-bypass", requiredControl: "explicit-authorization" }
    ]);
  });

  it("matches patterns per argv element, never across element boundaries", () => {
    // "--skip" + "-git-repo-check" as separate elements must NOT manufacture a match.
    const assessment = gradeRisk(sampleAction({ argv: ["fake-codex", "--skip", "-git-repo-check"] }));
    expect(assessment.blockedPatterns).toEqual([]);
  });
});

describe("A19: unattended writes need a node checkpoint, never a mid-run pause", () => {
  it("a write action on codex requires a checkpoint and cites the gate assumption", () => {
    const assessment = gradeRisk(sampleAction());
    expect(assessment.requiresCheckpoint).toBe(true);
    expect(assessment.checkpointAssumptionIds).toEqual(["codex.default-mode-unattended-write"]);
  });

  it("a write action on claude requires a checkpoint and cites the gate assumption", () => {
    const assessment = gradeRisk(
      sampleAction({ runtime: "claude", requiredCapabilities: ["claude.noninteractive-entry"] })
    );
    expect(assessment.requiresCheckpoint).toBe(true);
    expect(assessment.checkpointAssumptionIds).toEqual(["claude.mid-run-approval-in-noninteractive"]);
  });

  it("a read-only action does not demand the write checkpoint", () => {
    const assessment = gradeRisk(sampleAction({ dimensions: ["readonly"], writeScope: null }));
    expect(assessment.requiresCheckpoint).toBe(false);
  });

  it("the assessment offers no pause/mid-run/resume concept (structure, not prose)", () => {
    const assessment = gradeRisk(highRiskAction());
    // Exactly these fields exist — there is no pause/resume/approval-channel field.
    expect(Object.keys(assessment).sort()).toEqual(
      [
        "blockedPatterns",
        "checkpointAssumptionIds",
        "grade",
        "permissionIncrements",
        "reasons",
        "requiresApproval",
        "requiresCheckpoint"
      ].sort()
    );
    // No reason CODE mentions a pause semantic (the gate assumption ID that
    // names the blocked mid-run claim is data, not a capability we offer).
    for (const reason of assessment.reasons) {
      expect(reason.code.toLowerCase()).not.toContain("pause");
      expect(reason.code.toLowerCase()).not.toContain("resume");
    }
  });
});

describe("schema strictness (unknown fields rejected)", () => {
  it("rejects an unknown top-level field", () => {
    expect(() =>
      gradeRisk({
        ...sampleAction(),
        sneakyExtra: true
      } as unknown as Parameters<typeof gradeRisk>[0])
    ).toThrow();
  });

  it("rejects an undeclared dimension value (fail-closed vocabulary)", () => {
    expect(() =>
      gradeRisk({
        ...sampleAction(),
        dimensions: ["teleport"]
      } as unknown as Parameters<typeof gradeRisk>[0])
    ).toThrow();
  });

  it("rejects a write dimension without a write scope", () => {
    expect(() => gradeRisk(sampleAction({ writeScope: null }))).toThrow();
  });

  it("rejects a writeScope without the write dimension", () => {
    expect(() =>
      gradeRisk(sampleAction({ dimensions: ["readonly"], writeScope: "managed-worktree" }))
    ).toThrow();
  });
});
