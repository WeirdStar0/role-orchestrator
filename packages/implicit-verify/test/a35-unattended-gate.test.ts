/**
 * A35 control plane — the unattended/无人值守 refusal, pinned at BOTH control
 * points with a real scheduling integration:
 *
 * 1. the composed unattended-write decision probe refuses for both runtimes
 *    (capability-gate statuses + blocked assumptions + the scheduling layer's
 *    own dispatch gate);
 * 2. a real dispatch through the scheduler queue that REQUIRES an
 *    unverified/blocked implicit-loading capability cell is GATE_BLOCKED
 *    before any quota grant, execution row, node transition or dispatch
 *    outbox message exists;
 * 3. the positive control (same rig, no unverified requirement) dispatches —
 *    proving the refusals above come from the gate, not from a broken rig.
 */
import { describe, expect, test } from "vitest";
import type { GateCliId } from "@role-orchestrator/capability-gate";
import { getNodeState } from "@role-orchestrator/dag";
import {
  enqueueReadyNodes,
  evaluateDispatchGate,
  getQueueEntry,
  pollQueue
} from "@role-orchestrator/scheduler";
import {
  countOutboxMessages,
  listPendingOutboxMessages
} from "@role-orchestrator/store";
import {
  evaluateUnattendedWriteDecision,
  quotaLedgerCensus
} from "../src/index.js";
import {
  createImplicitVerifyDb,
  iso,
  pollInput,
  seedProfile,
  seedProject,
  seedReadyRun
} from "./helpers.js";

describe("unattended-write decision (composed control-plane probe)", () => {
  for (const runtime of ["claude", "codex"] as const) {
    test(`${runtime}: unattended write is refused by every limb of the control plane`, () => {
      const decision = evaluateUnattendedWriteDecision(runtime satisfies GateCliId);
      expect(decision.allowed).toBe(false);
      expect(decision.unattendedCellStatus).toBe("blocked");
      expect(decision.implicitControlCellStatus).toBe("unverified");
      expect(decision.reasons.length).toBeGreaterThanOrEqual(3);
      // Every consulted assumption is blocked and names its required control.
      expect(decision.consultedAssumptions.length).toBeGreaterThanOrEqual(2);
      for (const assumption of decision.consultedAssumptions) {
        expect(assumption.blocked).toBe(true);
        expect(["node-checkpoint", "explicit-management"]).toContain(assumption.requiredControl);
      }
      // The SCHEDULING layer's own gate refuses the same dispatch.
      expect(decision.dispatchGate.allowed).toBe(false);
      expect(decision.dispatchGate.status).toBe("blocked");
    });
  }

  test("the gate refuses an unverified implicit-control requirement directly", () => {
    const codexMcp = evaluateDispatchGate("codex", "codex.implicit-loading.mcp");
    expect(codexMcp.allowed).toBe(false);
    expect(codexMcp.status).toBe("unverified");
    const claudeControl = evaluateDispatchGate("claude", "claude.implicit-loading.explicit-control");
    expect(claudeControl.allowed).toBe(false);
    expect(claudeControl.status).toBe("unverified");
  });

  test("a hypothetical 'implicit loading fully suppressed' capability is denied by default", () => {
    const decision = evaluateDispatchGate("claude", "claude.implicit-loading.fully-suppressed");
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe("unverified");
    expect(decision.reason).toContain("unknown");
  });
});

describe("scheduler integration: unattended dispatch never reaches quota or state", () => {
  test("requiredCapability = blocked unattended-write cell → GATE_BLOCKED, zero ledgers touched", async () => {
    const { db, close } = createImplicitVerifyDb("unattended-blocked");
    try {
      await seedProfile(db, { profileId: "claude-main", runtime: "claude", credentialGroup: "personal", maxConcurrency: 2 });
      seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
      await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1"] });

      const enqueued = enqueueReadyNodes(db, {
        runId: "run-1",
        now: iso(1_000),
        requiredCapability: "claude.unattended-write-mode"
      });
      expect(enqueued.enqueued).toHaveLength(1);

      const result = pollQueue(db, pollInput(iso(2_000)));
      expect(result.dispatched).toHaveLength(0);
      expect(result.gateBlocked).toHaveLength(1);
      const blocked = result.gateBlocked[0];
      if (!blocked) throw new Error("expected a gate-blocked outcome");
      expect(blocked.capability).toBe("claude.unattended-write-mode");
      expect(blocked.status).toBe("blocked");
      expect(blocked.reason).toContain("blocked");

      // NOTHING else happened: no execution, no quota grant, no node
      // transition, no dispatch outbox message. The queue row records the
      // refusal instead of dropping it.
      expect(getNodeState(db, { runId: "run-1", nodeId: "n1" })?.state).toBe("READY");
      expect(countOutboxMessages(db, { pendingOnly: false })).toBe(0);
      expect(quotaLedgerCensus(db).grantRowsTotal).toBe(0);
      const entry = getQueueEntry(db, enqueued.enqueued[0]?.id ?? "");
      expect(entry?.state).toBe("GATE_BLOCKED");
      expect(entry?.lastReason).toContain("blocked");
      const executionCount = db.prepare("SELECT COUNT(*) AS n FROM executions").get()?.n;
      expect(Number(executionCount)).toBe(0);
    } finally {
      close();
    }
  });

  test("requiredCapability = unverified codex-MCP cell → refused with fail-closed status", async () => {
    const { db, close } = createImplicitVerifyDb("unverified-mcp");
    try {
      await seedProfile(db, { profileId: "codex-main", runtime: "codex", credentialGroup: "personal", maxConcurrency: 2 });
      seedProject(db, { projectId: "proj-1", profileId: "codex-main" });
      await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1"] });

      enqueueReadyNodes(db, { runId: "run-1", now: iso(1_000), requiredCapability: "codex.implicit-loading.mcp" });
      const result = pollQueue(db, pollInput(iso(2_000)));

      expect(result.dispatched).toHaveLength(0);
      expect(result.gateBlocked).toHaveLength(1);
      expect(result.gateBlocked[0]?.status).toBe("unverified");
      expect(result.gateBlocked[0]?.reason).toContain("unverified");
      expect(quotaLedgerCensus(db).grantRowsTotal).toBe(0);
      expect(countOutboxMessages(db, { pendingOnly: false })).toBe(0);
    } finally {
      close();
    }
  });

  test("positive control: same rig without the unverified requirement dispatches normally", async () => {
    const { db, close } = createImplicitVerifyDb("positive-control");
    try {
      await seedProfile(db, { profileId: "claude-main", runtime: "claude", credentialGroup: "personal", maxConcurrency: 2 });
      seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
      await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1"] });

      enqueueReadyNodes(db, { runId: "run-1", now: iso(1_000), requiredCapability: null });
      const result = pollQueue(db, pollInput(iso(2_000)));

      expect(result.dispatched).toHaveLength(1);
      expect(result.gateBlocked).toHaveLength(0);
      // The claim produced exactly the counted quota grants of the three
      // levels + credential lock, one execution and one dispatch message.
      const census = quotaLedgerCensus(db);
      expect(census.grantRowsTotal).toBe(4);
      expect(census.grantsByDimension).toEqual({ global: 1, project: 1, profile: 1, credential: 1 });
      expect(census.liveGrantsGlobal.total).toBe(1);
      expect(countOutboxMessages(db, { pendingOnly: false })).toBe(1);
      expect(getNodeState(db, { runId: "run-1", nodeId: "n1" })?.state).toBe("RUNNING");
      const pending = listPendingOutboxMessages(db);
      expect(JSON.parse(pending[0]?.payload ?? "{}")).toMatchObject({ profileId: "claude-main" });
    } finally {
      close();
    }
  });
});
