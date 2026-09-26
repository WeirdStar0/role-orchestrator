/**
 * A35 data plane — the frozen M0-03/M0-04 measurements and the capability
 * matrix cells + blocked assumptions that record them.
 *
 * What is pinned here: the registry STILL records the measured implicit
 * loading as real (observation cells verified), the explicit-control
 * dimensions as NOT verified (fail-closed), the unattended write modes as
 * blocked, and no assumption id that claims CLI-internal executions are
 * suppressed/billable can pass the gate. Weakening any of these flips a test
 * red. The real-CLI behavior itself was measured in M0-03/M0-04 (and belongs
 * to their extensions); this package only verifies the control plane's
 * handling of that measured invisibility.
 */
import { describe, expect, test } from "vitest";
import {
  BLOCKED_ASSUMPTIONS,
  CAPABILITY_RECORDS,
  checkAssumption,
  isUsable,
  statusOf
} from "@role-orchestrator/capability-gate";
import {
  A35_ASSUMPTION_EXPECTATIONS,
  A35_CAPABILITY_CELL_EXPECTATIONS,
  M0_IMPLICIT_LOADING_EVIDENCE
} from "../src/index.js";

describe("frozen M0 data-plane evidence (claude init / codex stream)", () => {
  test("claude: 9 MCP / 13 agents / 133 skills / 4 plugins / 171 slash commands + hooks + subagent_stats", () => {
    const claude = M0_IMPLICIT_LOADING_EVIDENCE.find((entry) => entry.runtime === "claude");
    expect(claude).toBeDefined();
    if (!claude) return; // narrowed below
    const byKind = new Map(claude.facts.map((fact) => [fact.kind, fact]));
    expect(byKind.get("mcp-servers")?.count).toBe(9);
    expect(byKind.get("agents")?.count).toBe(13);
    expect(byKind.get("skills")?.count).toBe(133);
    expect(byKind.get("plugins")?.count).toBe(4);
    expect(byKind.get("slash-commands")?.count).toBe(171);
    expect(byKind.get("session-start-hooks")).toBeDefined();
    expect(byKind.get("subagent-stats")?.detail).toContain("subagent_stats");
    expect(claude.ledgerVisibility).toBe("invisible");
    expect(claude.sourceReport).toContain("M0-03");
  });

  test("codex: in-stream skills budget hint measured; MCP manifest invisible (流不可见 ≠ 未加载)", () => {
    const codex = M0_IMPLICIT_LOADING_EVIDENCE.find((entry) => entry.runtime === "codex");
    expect(codex).toBeDefined();
    if (!codex) return;
    const byKind = new Map(codex.facts.map((fact) => [fact.kind, fact]));
    expect(byKind.get("in-stream-skill-budget-hint")?.detail).toContain("skills");
    expect(byKind.get("mcp-manifest-invisible")?.detail).toContain("不等于");
    expect(codex.ledgerVisibility).toBe("invisible");
    expect(codex.sourceReport).toContain("M0-04");
  });

  test("the observation cells cited by the evidence exist in the registry verbatim", () => {
    for (const entry of M0_IMPLICIT_LOADING_EVIDENCE) {
      const ids = CAPABILITY_RECORDS.map((record) => record.capability);
      expect(ids).toContain(entry.observationCellId);
      expect(ids).toContain(entry.controlCellId);
    }
  });
});

describe("A35 capability cells pinned at their current statuses", () => {
  test("observations verified; explicit-control unverified; unattended write blocked", () => {
    for (const expectation of A35_CAPABILITY_CELL_EXPECTATIONS) {
      const lookup = statusOf(expectation.capability);
      expect(lookup.known, expectation.capability).toBe(true);
      expect(lookup.status, `${expectation.capability}: ${expectation.why}`).toBe(
        expectation.expectedStatus
      );
    }
  });

  test("only verified counts as usable — both implicit-control cells are unusable", () => {
    expect(isUsable(statusOf("claude.implicit-loading.explicit-control").status)).toBe(false);
    expect(isUsable(statusOf("codex.implicit-loading.mcp").status)).toBe(false);
    expect(isUsable(statusOf("claude.unattended-write-mode").status)).toBe(false);
    expect(isUsable(statusOf("codex.unattended-write-mode").status)).toBe(false);
  });

  test("codex MCP cell keeps the fail-closed wording: invisible in stream ≠ not loaded", () => {
    const cell = statusOf("codex.implicit-loading.mcp");
    expect(cell.summary).toContain("不可见");
    expect(cell.evidence.length).toBeGreaterThanOrEqual(1);
  });
});

describe("A35 blocked assumptions pinned", () => {
  test("each expected assumption is listed, blocked, with its required control", () => {
    for (const expectation of A35_ASSUMPTION_EXPECTATIONS) {
      const decision = checkAssumption(expectation.id);
      expect(decision.listed, expectation.id).toBe(true);
      expect(decision.blocked, `${expectation.id}: ${expectation.why}`).toBe(true);
      expect(decision.requiredControl, expectation.id).toBe(expectation.requiredControl);
    }
  });

  test("the clean-baseline assumption names the measured inventories in its rationale", () => {
    const entry = BLOCKED_ASSUMPTIONS.find(
      (candidate) => candidate.id === "implicit-loading.unmanaged-clean-baseline"
    );
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.rationale).toContain("9 个用户级 MCP server");
    expect(entry.rationale).toContain("133 个 skills");
    expect(entry.rationale).toContain("13 个 agents");
  });

  test("no assumption id can smuggle 'CLI-internal executions are handled' past the gate", () => {
    for (const claim of [
      "implicit-loading.internal-executions-counted",
      "implicit-loading.internal-executions-billable",
      "claude.implicit-loading.fully-suppressed"
    ]) {
      const decision = checkAssumption(claim);
      // Fail-closed: an id absent from the registry is denied by default and
      // never treated as approved (unknown-deny).
      expect(decision.listed, claim).toBe(false);
      expect(decision.blocked, claim).toBe(true);
      expect(decision.requiredControl, claim).toBe("unknown-deny");
    }
  });
});
