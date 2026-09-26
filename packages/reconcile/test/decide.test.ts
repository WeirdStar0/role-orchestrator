/**
 * The pure decision table of `decideExecution` — total, no I/O, no processes.
 * Every "cannot know" path must land on recovery-required (fail-closed);
 * every determinate death/never-started path lands on interrupted; a
 * within-tolerance identity match lands on observed-running (A27 basis).
 */
import { describe, expect, test } from "vitest";
import type { ProcessIdentityRecord } from "@role-orchestrator/store";
import { decideExecution, outcomeForReason, type DecisionEvidence } from "../src/decide.js";
import type { ProcessProbe } from "../src/probe.js";

const TOLERANCE = 5_000;
const STORED = "2026-09-22T02:00:00.000Z";

function evidence(overrides: {
  phase?: DecisionEvidence["phase"];
  pid?: { pid: number; creationTime: string; target?: ProcessIdentityRecord["target"] } | null;
  probe: ProcessProbe;
}): DecisionEvidence {
  return {
    phase: overrides.phase ?? "RUNNING",
    pidIdentity:
      overrides.pid === null
        ? null
        : {
            pid: overrides.pid?.pid ?? 4242,
            creationTime: overrides.pid?.creationTime ?? STORED,
            executionNonce: "nonce-1",
            target: overrides.pid?.target ?? "windows-native"
          },
    probe: overrides.probe,
    sideEffects: { pendingDispatchIds: ["ob-1"], hasProtocolEvents: false },
    identityToleranceMs: TOLERANCE
  };
}

const found = (creationTimeIso: string): ProcessProbe => ({
  kind: "found",
  identity: { pid: 4242, name: "node.exe", parentPid: 1000, creationTimeIso }
});

describe("decideExecution decision table", () => {
  test("PREPARING without pid is a determinate never-started (interrupted)", () => {
    const plan = decideExecution(evidence({ phase: "PREPARING", pid: null, probe: { kind: "not-found" } }));
    expect(plan.outcome).toBe("interrupted");
    expect(plan.detail.reason).toBe("never-started-preparing");
  });

  test("A24 window: STARTING/RUNNING/FINALIZING without pid is recovery-required", () => {
    for (const phase of ["STARTING", "RUNNING", "FINALIZING"] as const) {
      const plan = decideExecution(evidence({ phase, pid: null, probe: { kind: "not-found" } }));
      expect(plan.outcome).toBe("recovery-required");
      expect(plan.detail.reason).toBe("launch-window-undetermined");
    }
  });

  test("probe not-found is a determinate death (interrupted)", () => {
    const plan = decideExecution(evidence({ probe: { kind: "not-found" } }));
    expect(plan.outcome).toBe("interrupted");
    expect(plan.detail.reason).toBe("process-gone");
  });

  test("identity within tolerance is observed-running (both skew directions)", () => {
    for (const observed of ["2026-09-22T01:59:57.000Z", "2026-09-22T02:00:04.500Z"]) {
      const plan = decideExecution(evidence({ probe: found(observed) }));
      expect(plan.outcome).toBe("observed-running");
      expect(plan.detail.reason).toBe("process-alive-identity-confirmed");
    }
  });

  test("live holder created later than the identity is PID reuse (interrupted, A27)", () => {
    const plan = decideExecution(evidence({ probe: found("2026-09-22T02:00:06.000Z") }));
    expect(plan.outcome).toBe("interrupted");
    expect(plan.detail.reason).toBe("pid-reused-identity-mismatch");
    expect(plan.detail.explanation).toContain("reused");
  });

  test("live holder created earlier than the identity is a time anomaly (recovery-required)", () => {
    const plan = decideExecution(evidence({ probe: found("2026-09-22T01:59:50.000Z") }));
    expect(plan.outcome).toBe("recovery-required");
    expect(plan.detail.reason).toBe("identity-time-anomaly");
  });

  test("probe failure is fail-closed: recovery-required, never a guessed death", () => {
    const plan = decideExecution(
      evidence({ probe: { kind: "indeterminate", reason: "powershell spawn error: boom" } })
    );
    expect(plan.outcome).toBe("recovery-required");
    expect(plan.detail.reason).toBe("probe-indeterminate");
  });

  test("live holder without parseable creation time is recovery-required", () => {
    const probe: ProcessProbe = {
      kind: "found",
      identity: { pid: 4242, name: "node.exe", parentPid: 1000, creationTimeIso: null }
    };
    const plan = decideExecution(evidence({ probe }));
    expect(plan.outcome).toBe("recovery-required");
    expect(plan.detail.reason).toBe("probe-identity-incomplete");
  });

  test("microsecond ISO from Win32_Process parses (7 fractional digits)", () => {
    const plan = decideExecution(evidence({ probe: found("2026-09-22T02:00:00.1031910Z") }));
    expect(plan.outcome).toBe("observed-running");
  });

  test("non-windows-native targets are never probed cross-namespace (A29)", () => {
    const plan = decideExecution(
      evidence({ pid: { pid: 7, creationTime: STORED, target: "wsl" }, probe: found(STORED) })
    );
    expect(plan.outcome).toBe("recovery-required");
    expect(plan.detail.reason).toBe("probe-unsupported-target");
  });

  test("every reason maps to exactly the outcome its name promises", () => {
    expect(outcomeForReason("process-gone")).toBe("interrupted");
    expect(outcomeForReason("pid-reused-identity-mismatch")).toBe("interrupted");
    expect(outcomeForReason("never-started-preparing")).toBe("interrupted");
    expect(outcomeForReason("recovery-resolved")).toBe("interrupted");
    for (const reason of [
      "launch-window-undetermined",
      "probe-indeterminate",
      "probe-unsupported-target",
      "probe-identity-incomplete",
      "identity-time-anomaly"
    ] as const) {
      expect(outcomeForReason(reason)).toBe("recovery-required");
    }
    expect(outcomeForReason("process-alive-identity-confirmed")).toBe("observed-running");
  });
});
