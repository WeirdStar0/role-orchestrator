/**
 * A19 channel decision + structured proposal extraction (M4-02).
 *
 * Grounding: docs/CLI_ADAPTERS.md 审批能力不可假定一致 — "优先采用各 CLI
 * 经过验证的原生结构化审批/控制通道。没有可靠 interactiveApproval 时采用
 * '节点检查点'"; docs/ACCEPTANCE.md A19 — "使用检查点或拒绝，不伪造暂停能力".
 * The decisions here are asserted against the capability-gate registry DATA
 * (M0-06), never against hardcoded outcomes.
 */
import { describe, expect, test } from "vitest";
import { BLOCKED_ASSUMPTIONS, statusOf } from "@role-orchestrator/capability-gate";
import {
  decideProposalDisposition,
  extractActionProposals,
  interactiveApprovalChannel,
  type ProtocolEventView
} from "../src/index.js";
import { sampleProposal } from "./helpers.js";

function approvalRequestedEvent(toolInput: unknown): ProtocolEventView {
  return {
    type: "approval_requested",
    sourceType: "control_request",
    seq: 7,
    payload: {
      requestId: "req-1",
      ...(toolInput === undefined ? {} : { toolInput: toolInput as never })
    }
  };
}

describe("interactive approval channel (gate data, read live)", () => {
  test("no bundled runtime has a verified interactive approval channel", () => {
    for (const runtime of ["claude", "codex"] as const) {
      const channel = interactiveApprovalChannel(runtime);
      expect(channel.verified).toBe(false);
      for (const entry of channel.statuses) {
        // The cells exist in the M0-06 registry but are unverified there.
        expect(statusOf(entry.capability).known).toBe(true);
        expect(entry.status).toBe("unverified");
      }
    }
  });

  test("claude maps to its permission-approval-behavior cell, codex to its rejection-path cell", () => {
    expect(interactiveApprovalChannel("claude").capabilityIds).toEqual([
      "claude.permission-approval-behavior"
    ]);
    expect(interactiveApprovalChannel("codex").capabilityIds).toEqual([
      "codex.approval-sandbox-rejection-path"
    ]);
  });
});

describe("decideProposalDisposition (A19)", () => {
  test("an ordinary proposal from a no-channel CLI takes the CHECKPOINT path", () => {
    for (const runtime of ["claude", "codex"] as const) {
      const decision = decideProposalDisposition({
        runtime,
        proposal: sampleProposal(undefined, `propose-${runtime}`)
      });
      expect(decision.disposition).toBe("checkpoint");
      // The gate pins the node-checkpoint control for BOTH runtimes'
      // unattended execution; ids come from the registry, never hardcoded.
      expect(decision.checkpointAssumptionIds.length).toBeGreaterThan(0);
      for (const id of decision.checkpointAssumptionIds) {
        const assumption = BLOCKED_ASSUMPTIONS.find((entry) => entry.id === id);
        expect(assumption).toBeDefined();
        expect(assumption?.requiredControl).toBe("node-checkpoint");
        expect(id.startsWith(`${runtime}.`)).toBe(true);
      }
      const codexAssumption = decision.checkpointAssumptionIds.includes(
        "codex.default-mode-unattended-write"
      );
      const claudeAssumption = decision.checkpointAssumptionIds.includes(
        "claude.mid-run-approval-in-noninteractive"
      );
      if (runtime === "codex") expect(codexAssumption).toBe(true);
      if (runtime === "claude") expect(claudeAssumption).toBe(true);
    }
  });

  test("a proposal relying on the unverified mid-run channel is REFUSED (fail-closed)", () => {
    const decision = decideProposalDisposition({
      runtime: "codex",
      proposal: sampleProposal({ requiresInteractiveApproval: true }, "propose-interactive")
    });
    expect(decision.disposition).toBe("reject-unverified-channel");
    expect(decision.channel.verified).toBe(false);
  });

  test("the refusal keys on live gate status: a verified channel would NOT refuse", () => {
    // The decision reads the gate; this pins the SHAPE of that dependence:
    // with requiresInteractiveApproval the disposition is a refusal exactly
    // while the channel is unverified. (No runtime is verified today, so the
    // refusal must fire for both.)
    for (const runtime of ["claude", "codex"] as const) {
      const channel = interactiveApprovalChannel(runtime);
      const decision = decideProposalDisposition({
        runtime,
        proposal: sampleProposal({ requiresInteractiveApproval: true })
      });
      expect(decision.disposition === "reject-unverified-channel").toBe(!channel.verified);
    }
  });
});

describe("extractActionProposals", () => {
  test("parses a structured proposal from an approval_requested toolInput", () => {
    const proposal = sampleProposal(undefined, "propose-extract-1");
    const result = extractActionProposals([
      {
        type: "started",
        sourceType: "system",
        seq: 1,
        payload: { sessionId: "s" }
      },
      {
        type: "approval_requested",
        sourceType: "control_request",
        seq: 2,
        payload: { requestId: "req-9", toolInput: { actionProposal: proposal } as never }
      }
    ]);
    expect(result.unparsable).toHaveLength(0);
    expect(result.proposals).toHaveLength(1);
    const extracted = result.proposals[0];
    expect(extracted?.eventId).toBe("seq-2:approval_requested");
    expect(extracted?.proposal.proposalId).toBe("propose-extract-1");
    expect(extracted?.proposal.action.argv).toEqual(proposal.action.argv);
    expect(extracted?.proposal.source.requestId).toBe("req-9");
    expect(extracted?.proposal.source.eventSeq).toBe(2);
  });

  test("parses a proposal embedded in a result payload (businessResult.actionProposal)", () => {
    const proposal = sampleProposal(undefined, "propose-extract-2");
    const result = extractActionProposals([
      {
        type: "result_reported",
        sourceType: "result",
        seq: 12,
        payload: {
          subtype: "success",
          isError: false,
          businessResult: { outcome: "completed", actionProposal: proposal } as never
        }
      }
    ]);
    expect(result.unparsable).toHaveLength(0);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.proposal.proposalId).toBe("propose-extract-2");
  });

  test("an approval_requested WITHOUT a structured proposal is unparsable, never approximated", () => {
    const result = extractActionProposals([
      approvalRequestedEvent({ command: "rm -rf /" })
    ]);
    expect(result.proposals).toHaveLength(0);
    expect(result.unparsable).toHaveLength(1);
    expect(result.unparsable[0]?.reason).toContain("fail-closed");
  });

  test("a malformed proposal (unknown fields, broken write pairing) is unparsable", () => {
    const proposal = sampleProposal(undefined, "propose-bad");
    const tampered = {
      ...proposal,
      action: { ...proposal.action, unexpectedField: true, writeScope: null }
    };
    const result = extractActionProposals([
      approvalRequestedEvent({ actionProposal: tampered })
    ]);
    expect(result.proposals).toHaveLength(0);
    expect(result.unparsable).toHaveLength(1);
    expect(result.unparsable[0]?.reason).toContain("writeScope");
  });

  test("ordinary events and result payloads without proposals are ignored", () => {
    const result = extractActionProposals([
      { type: "message_delta", sourceType: "assistant", seq: 1, payload: { text: "hi" } },
      {
        type: "result_reported",
        sourceType: "turn.completed",
        seq: 2,
        payload: { businessResult: { outcome: "completed" } as never }
      }
    ]);
    expect(result.proposals).toHaveLength(0);
    expect(result.unparsable).toHaveLength(0);
  });
});
