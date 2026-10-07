/**
 * M11-03 — the synchronous one-shot gate behind the wizard's "generate" and
 * other one-time buttons (M11-02 review handover C: the generateDefaults
 * double-fire fix).
 *
 * WHY this exists: React state updates are asynchronous, so a guard that
 * only CHECKS component state (`if (setup.phase !== "ready") return`) lets a
 * rapid double-click through TWICE — both clicks observe the pre-update
 * phase and both fire the POST. The fix is a gate whose claim is
 * SYNCHRONOUS: the first click takes the gate before any render cycle can
 * run, the second click sees it taken and returns. The component still
 * updates state for the UI (button disabled etc.) — the gate is the
 * correctness boundary, the state is the presentation.
 *
 * Pure and framework-free so the synchronous-claim semantics are unit-test
 * pinned (renderToString-based suites cannot click buttons).
 */
export interface OneShotGate {
  /**
   * Claim the gate. TRUE exactly once per `release()` cycle: the first call
   * after a release claims it, every further call before the next release
   * is refused.
   */
  take(): boolean;
  /** Release the gate (the operation settled — success or failure alike). */
  release(): void;
}

export function createOneShotGate(): OneShotGate {
  let taken = false;
  return {
    take(): boolean {
      if (taken) return false;
      taken = true;
      return true;
    },
    release(): void {
      taken = false;
    }
  };
}
