/**
 * Shared fixtures for the flow tests: the checkpoint action proposal (the
 * same controlled unscoped-write shape the M4-02 checkpoint suite pins) and
 * small typed helpers.
 */
import type { ActionProposal } from "@role-orchestrator/checkpoint";
import { AP_FILE_REL, AP_FILE_CONTENT } from "./scenario.js";

let proposalCounter = 0;

/**
 * A controlled unscoped-write proposal (graded HIGH: the unscoped write plus
 * the repo.write permission increment), bound to the approval flow's real
 * output file. Distinct ids per call so digests never collide across runs.
 */
export function approvalFlowProposal(): ActionProposal {
  proposalCounter += 1;
  const n = String(proposalCounter);
  return {
    schemaVersion: 1,
    proposalId: `propose-approval-flow-${n}`,
    action: {
      argv: [
        "fake-agent",
        "write",
        "--path",
        `worktrees/a1/${AP_FILE_REL}`,
        "--content",
        Buffer.from(AP_FILE_CONTENT, "utf8").length.toString(10)
      ],
      dimensions: ["write"],
      writeScope: "unscoped",
      requiredPermissions: ["repo.write"],
      requiredCapabilities: ["claude.noninteractive-entry"],
      targetSha: null,
      requiresInteractiveApproval: false
    },
    source: {
      eventType: "approval_requested",
      sourceType: "control_request",
      eventSeq: 3,
      requestId: `req-approval-flow-${n}`
    }
  };
}

/** Non-null with a label — the strict-TS honest alternative to `!`. */
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}
