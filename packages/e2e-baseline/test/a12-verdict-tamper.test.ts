/**
 * ACCEPTANCE A12 — Reviewer 后 candidateSha 改变：旧审查结果失效。
 *
 * The baseline run REALLY changes the candidate after the pass: a follow-up
 * writer node produces a new accepted output, the second integration merges
 * it onto the task branch, and a NEW candidateSha (C2, superset of C1) is
 * recorded. Asserted:
 *  - the pass verdict is bound to exactly C1 (which IS the integration
 *    record's candidateSha);
 *  - querying the SAME run+reviewer for the NEW candidate C2 answers
 *    `invalidated` with the recorded candidates listed and NO verdict — the
 *    old pass does not apply to the changed candidate;
 *  - querying C1 again still answers `valid` — invalidation is exact binding,
 *    not record deletion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getReviewVerdict } from "@role-orchestrator/review";
import { getIntegrationRecord } from "@role-orchestrator/integration";
import { FOLLOWUP_FILE_CONTENT, FOLLOWUP_FILE_REL } from "../src/index.js";
import { required, runFullBaseline, type BaselineHarness } from "./helpers.js";

let harness: BaselineHarness | undefined;

beforeAll(async () => {
  harness = await runFullBaseline("a12");
});

afterAll(() => {
  harness?.cleanup();
});

function h(): BaselineHarness {
  if (harness === undefined) throw new Error("baseline harness not initialised");
  return harness;
}

describe("A12: candidateSha 改变后旧 verdict 失效", () => {
  it("pass verdict 绑定的 candidateSha 与集成产物完全一致", () => {
    const c1 = required(h().result.candidates["integrate"], "candidate C1");
    const record = required(
      getIntegrationRecord(h().world.db, { runId: h().runId, nodeId: "integrate" }),
      "integration record (integrate)"
    );
    expect(record.candidateSha).toBe(c1);

    const reviewTrace = required(
      h().result.trace.find((entry) => entry.nodeId === "review"),
      "review trace"
    );
    expect(required(reviewTrace.review, "review detail").candidateSha).toBe(c1);

    const verdict = getReviewVerdict(h().world.db, {
      runId: h().runId,
      nodeId: "review",
      candidateSha: c1
    });
    expect(verdict.kind).toBe("valid");
    if (verdict.kind !== "valid") throw new Error("unreachable");
    expect(verdict.verdict).toBe("pass");
    expect(verdict.candidateSha).toBe(c1);
    expect(verdict.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    expect(verdict.findings).toEqual([]);
  });

  it("候选真实变化后（新集成产生 C2），旧 pass 对新候选不再适用", async () => {
    const c1 = required(h().result.candidates["integrate"], "candidate C1");
    const c2 = required(h().result.candidates["integrate-followup"], "candidate C2");
    expect(c2).not.toBe(c1);
    // C2 is a REAL new candidate: it contains what C1 contained PLUS the
    // follow-up output (ancestry is asserted in the A09 suite; content here).
    expect(await h().fileAt(c2, FOLLOWUP_FILE_REL)).toBe(FOLLOWUP_FILE_CONTENT);

    const verdict = getReviewVerdict(h().world.db, {
      runId: h().runId,
      nodeId: "review",
      candidateSha: c2
    });
    expect(verdict.kind).toBe("invalidated");
    if (verdict.kind !== "invalidated") throw new Error("unreachable");
    expect(verdict.queriedCandidateSha).toBe(c2);
    expect(verdict.recordedCandidateShas).toEqual([c1]);
    expect("verdict" in verdict).toBe(false);
    expect("evidenceRefs" in verdict).toBe(false);
  });

  it("失效是精确绑定语义：C1 的查询依然命中原 pass 记录", () => {
    const c1 = required(h().result.candidates["integrate"], "candidate C1");
    const again = getReviewVerdict(h().world.db, {
      runId: h().runId,
      nodeId: "review",
      candidateSha: c1
    });
    expect(again.kind).toBe("valid");
    if (again.kind !== "valid") throw new Error("unreachable");
    expect(again.verdict).toBe("pass");
    // A fabricated candidate is likewise answered invalidated, never guessed.
    const fabricated = getReviewVerdict(h().world.db, {
      runId: h().runId,
      nodeId: "review",
      candidateSha: "a".repeat(40)
    });
    expect(fabricated.kind).toBe("invalidated");
  });
});
