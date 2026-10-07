/**
 * M11-03 — the synchronous one-shot gate behind the wizard's generate
 * buttons (M11-02 review handover C). The suite pins the property the fix
 * DEPENDS on: the claim is synchronous, so a second take() before a release
 * is refused even with zero render cycles in between (exactly the
 * double-click window the async phase-check could not close).
 */
import { describe, expect, it } from "vitest";
import { createOneShotGate } from "./oneShotGate";

describe("createOneShotGate (handover C: synchronous double-fire guard)", () => {
  it("claims exactly once; further takes are refused until release", () => {
    const gate = createOneShotGate();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    expect(gate.take()).toBe(false);
    gate.release();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });

  it("back-to-back double-click simulation: two synchronous takes yield ONE claim", () => {
    const gate = createOneShotGate();
    // This is the double-click window: no await, no render cycle between
    // the two handlers — the async React-state guard passed both.
    const firstClick = gate.take();
    const secondClick = gate.take();
    expect(firstClick).toBe(true);
    expect(secondClick).toBe(false);
  });

  it("release on failure re-arms the gate (a refused POST must be retryable)", () => {
    const gate = createOneShotGate();
    expect(gate.take()).toBe(true);
    gate.release();
    expect(gate.take()).toBe(true);
  });

  it("gates are independent instances", () => {
    const a = createOneShotGate();
    const b = createOneShotGate();
    expect(a.take()).toBe(true);
    expect(b.take()).toBe(true);
  });
});
