import { describe, expect, it } from "vitest";
import { REMOTE_FAULT_MATRIX, assertMatrixTargetCoverage } from "../src/matrix.js";
import type { RemoteFaultCase } from "../src/matrix.js";

/**
 * THE evidence runner (M7-03): every fault case in REMOTE_FAULT_MATRIX is
 * executed here, in registry order, by its own pinned test — the test name
 * is the evidence citation used by reports/M7-03-remote-worker.md. A failing
 * case fails loudly; nothing is skipped (protocol simulation is
 * platform-independent), and no case may appear in the document's evidence
 * tables without appearing in this walk.
 */
describe("remote-worker fault matrix (M7-03)", () => {
  it("matrix registry is total: 11 unique cases, each naming all four targets", () => {
    assertMatrixTargetCoverage();
    expect(REMOTE_FAULT_MATRIX.length).toBe(11);
    const ids = REMOTE_FAULT_MATRIX.map((remoteCase) => remoteCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The acceptance mapping the design document pins:
    expect(REMOTE_FAULT_MATRIX.filter((c) => c.acceptance.includes("A22")).map((c) => c.id)).toEqual([
      "RW-TRX-01",
      "RW-TRX-02",
      "RW-LSN-01",
      "RW-CXL-04",
      "RW-OUT-01"
    ]);
    expect(REMOTE_FAULT_MATRIX.filter((c) => c.acceptance.includes("A26")).map((c) => c.id)).toEqual([
      "RW-CXL-01",
      "RW-CXL-02",
      "RW-CXL-03",
      "RW-CXL-04"
    ]);
    expect(REMOTE_FAULT_MATRIX.filter((c) => c.acceptance.includes("A31")).map((c) => c.id)).toEqual([
      "RW-POST-01"
    ]);
    expect(REMOTE_FAULT_MATRIX.filter((c) => c.acceptance.includes("A42")).map((c) => c.id)).toEqual([
      "RW-SEC-01"
    ]);
  });

  for (const remoteCase of REMOTE_FAULT_MATRIX as readonly RemoteFaultCase[]) {
    it(`${remoteCase.id} ${remoteCase.evidenceTest}`, () => {
      const started = Date.now();
      expect(() => remoteCase.run()).not.toThrow();
      // Trivial wall-clock guard: protocol cases are synchronous and must
      // stay that way (no timers, no waits — hermetic by construction).
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  }
});
