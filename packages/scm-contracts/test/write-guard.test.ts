/**
 * Controlled writes (M7-01): the guard chain and the A17-by-analogy binding.
 *
 * Every refusal here is REAL machinery, not documentation: consumption goes
 * through @role-orchestrator/approval's actual guarded CAS (createApproval →
 * approveApproval → consumeApproval) on a real SQLite world under the system
 * temp directory — the same single-consumption semantics the local approval
 * lifecycle enforces.
 */
import { describe, expect, it } from "vitest";
import {
  ApprovalAlreadyConsumedError,
  ApprovalExpiredError,
  ApprovalStateError,
  createApproval,
  requireApproval
} from "@role-orchestrator/approval";
import {
  ScmApprovalDigestMismatchError,
  ScmApprovalRequiredError,
  ScmProviderNotVerifiedError,
  ScmRequestValidationError,
  createControlledScmWriteClient,
  scmWriteActionDescriptor,
  scmWriteActionDigest,
  scmWriteRiskAssessment,
  type ScmApprovalRef
} from "../src/index.js";
import {
  EXECUTION_ID,
  SHA_OTHER,
  T1,
  T_PLUS_2H,
  createApprovedApproval,
  createApprovalWorld,
  createPullRequestCommand,
  githubCapability,
  githubCredential,
  issueCommentCommand,
  recordingAuditSink,
  recordingWriteTransport,
  storeConsume,
  verifiedVerification
} from "./helpers.js";
import type { ScmCreateIssueCommentCommand } from "../src/index.js";

const CLOCK = { now: T1 };

/** A write client with the real store wired as the consumption gate. */
function makeWriteClient(world: ReturnType<typeof createApprovalWorld>, projection?: unknown) {
  const transport = recordingWriteTransport(
    projection ?? { commentId: "c-1", createdAt: "2026-09-24T00:00:01.000Z" }
  );
  const client = createControlledScmWriteClient({
    capability: githubCapability(),
    transport,
    credential: githubCredential(),
    consume: storeConsume(world, CLOCK),
    verification: verifiedVerification()
  });
  return { transport, client };
}

function approvedRef(
  world: ReturnType<typeof createApprovalWorld>,
  command: Record<string, unknown>,
  key: string
): ScmApprovalRef {
  const action = scmWriteActionDescriptor("github", {
    operation: "createIssueComment",
    command: command as ScmCreateIssueCommentCommand
  });
  const approvalId = createApprovedApproval(world, action, key);
  return { approvalId, actionDigest: scmWriteActionDigest("github", { operation: "createIssueComment", command: command as ScmCreateIssueCommentCommand }) };
}

describe("construction-time verification gate", () => {
  it("with the shipped matrix the write client cannot even be constructed", () => {
    expect(() =>
      createControlledScmWriteClient({
        capability: githubCapability(),
        transport: recordingWriteTransport({}),
        credential: githubCredential(),
        consume: storeConsume(createApprovalWorld("gate"), CLOCK)
      })
    ).toThrow(ScmProviderNotVerifiedError);
  });
});

describe("missing ApprovalRef: the dedicated runtime refusal", () => {
  it("throws ScmApprovalRequiredError before validation, verification or I/O (untyped caller)", async () => {
    const world = createApprovalWorld("missing-ref");
    try {
      const { transport, client } = makeWriteClient(world);
      const looseCall = (...args: unknown[]) => (client.createIssueComment as (...inner: unknown[]) => Promise<unknown>).call(client, ...args);
      await expect(looseCall(issueCommentCommand())).rejects.toBeInstanceOf(ScmApprovalRequiredError);
      expect(transport.createIssueComment).not.toHaveBeenCalled();
    } finally {
      world.close();
    }
  });

  it("null is refused the same way", async () => {
    const world = createApprovalWorld("null-ref");
    try {
      const { client } = makeWriteClient(world);
      const looseCall = (...args: unknown[]) => (client.createIssueComment as (...inner: unknown[]) => Promise<unknown>).call(client, ...args);
      await expect(looseCall(issueCommentCommand(), null)).rejects.toBeInstanceOf(ScmApprovalRequiredError);
    } finally {
      world.close();
    }
  });

  it("the refusal precedes the verification gate: a surface flipped to unverified still answers ScmApprovalRequiredError first", async () => {
    // A client constructed while verified, then the lookup flips unverified:
    // a missing ApprovalRef must still hit the dedicated error BEFORE the
    // provider gate — the ordering itself is the pinned contract.
    const world = createApprovalWorld("absolute-ref");
    try {
      let verified = true;
      const client = createControlledScmWriteClient({
        capability: githubCapability(),
        transport: recordingWriteTransport({}),
        credential: githubCredential(),
        consume: storeConsume(world, CLOCK),
        verification: () => (verified ? { status: "verified", evidence: "e" } : { status: "unverified", evidence: null })
      });
      const looseCall = (...args: unknown[]) =>
        (client.createIssueComment as (...inner: unknown[]) => Promise<unknown>).call(client, ...args);
      verified = false;
      await expect(looseCall(issueCommentCommand())).rejects.toBeInstanceOf(ScmApprovalRequiredError);
      // ...and with a ref present, the unverified surface is refused next:
      await expect(
        client.createIssueComment(issueCommentCommand() as ScmCreateIssueCommentCommand, {
          approvalId: "approval-1",
          actionDigest: "0".repeat(64)
        })
      ).rejects.toBeInstanceOf(ScmProviderNotVerifiedError);
    } finally {
      world.close();
    }
  });
});

describe("guard chain after the ref is present", () => {
  it("a malformed approvalRef is refused without consuming or transporting", async () => {
    const world = createApprovalWorld("bad-ref-shape");
    try {
      const { transport, client } = makeWriteClient(world);
      await expect(
        client.createIssueComment(issueCommentCommand() as ScmCreateIssueCommentCommand, {
          approvalId: "approval-1",
          actionDigest: "not-a-digest"
        })
      ).rejects.toBeInstanceOf(ScmRequestValidationError);
      expect(transport.createIssueComment).not.toHaveBeenCalled();
    } finally {
      world.close();
    }
  });

  it("an undeclared operation is refused against the capability", async () => {
    const world = createApprovalWorld("undeclared-op");
    try {
      const client = createControlledScmWriteClient({
        capability: githubCapability({ writes: ["createPullRequest"] }),
        transport: recordingWriteTransport({}),
        credential: githubCredential(),
        consume: storeConsume(world, CLOCK),
        verification: verifiedVerification()
      });
      const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
      const ref = approvedRef(world, issueCommentCommand(), "undeclared");
      await expect(client.createIssueComment(command, ref)).rejects.toThrow(/does not declare operation/);
    } finally {
      world.close();
    }
  });

  it("a command failing the strict schema is refused", async () => {
    const world = createApprovalWorld("bad-command");
    try {
      const { transport, client } = makeWriteClient(world);
      await expect(
        client.createIssueComment(
          issueCommentCommand({ issueNumber: "seven" }) as ScmCreateIssueCommentCommand,
          { approvalId: "approval-1", actionDigest: "0".repeat(64) }
        )
      ).rejects.toBeInstanceOf(ScmRequestValidationError);
      expect(transport.createIssueComment).not.toHaveBeenCalled();
    } finally {
      world.close();
    }
  });
});

describe("A17 by analogy: digest binding to the exact command", () => {
  const mutations: readonly [string, (command: Record<string, unknown>) => Record<string, unknown>][] = [
    ["the issue number changes", (c) => ({ ...c, issueNumber: 43 })],
    ["the body changes", (c) => ({ ...c, body: "Changed text after approval." })],
    ["the repo owner changes", (c) => ({ ...c, repo: { owner: "other-org", name: "example-repo" } })],
    ["the repo name changes", (c) => ({ ...c, repo: { owner: "example-org", name: "other-repo" } })],
    ["the head SHA changes", (c) => ({ ...c, binding: { ...(c.binding as Record<string, unknown>), headSha: SHA_OTHER } })],
    ["the base SHA changes", (c) => ({ ...c, binding: { ...(c.binding as Record<string, unknown>), baseSha: SHA_OTHER } })],
    ["the worktree path changes", (c) => ({ ...c, binding: { ...(c.binding as Record<string, unknown>), worktreePath: "h:/worktrees/other" } })],
    ["the profile revision changes", (c) => ({ ...c, binding: { ...(c.binding as Record<string, unknown>), profileRevision: "rev-2" } })],
    ["the runtime changes", (c) => ({ ...c, binding: { ...(c.binding as Record<string, unknown>), runtime: "claude" } })],
    // The digest binds the DERIVED permission INCREMENT set (required minus granted,
    // approval semantics): granting repo.write up front empties the increment set.
    [
      "the permission increments change",
      (c) => ({ ...c, binding: { ...(c.binding as Record<string, unknown>), grantedPermissions: ["repo.read", "repo.write"] } })
    ]
  ];

  it("the digest is stable for the identical command", () => {
    const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
    const digestOne = scmWriteActionDigest("github", { operation: "createIssueComment", command });
    const digestTwo = scmWriteActionDigest("github", { operation: "createIssueComment", command });
    expect(digestOne).toBe(digestTwo);
  });

  for (const [label, mutate] of mutations) {
    it(`refuses consumption with a typed error when ${label} after approval`, async () => {
      const world = createApprovalWorld("digest-mismatch");
      try {
        const ref = approvedRef(world, issueCommentCommand(), `a17-${label}`);
        const mutated = mutate(issueCommentCommand()) as ScmCreateIssueCommentCommand;
        const { transport, client } = makeWriteClient(world);
        await expect(client.createIssueComment(mutated, ref)).rejects.toBeInstanceOf(
          ScmApprovalDigestMismatchError
        );
        expect(transport.createIssueComment).not.toHaveBeenCalled();
        // The failed attempt never burns the approval.
        const record = requireApproval(world.db, ref.approvalId);
        expect(record.status).toBe("APPROVED");
      } finally {
        world.close();
      }
    });
  }

  it("an approvalRef minted for a DIFFERENT operation is refused (cross-operation replay)", async () => {
    const world = createApprovalWorld("cross-op");
    try {
      // Approval exists for the PR command; the ref is presented to an issue
      // comment write — the presented command hashes differently.
      const prCommand = createPullRequestCommand();
      const prAction = scmWriteActionDescriptor("github", {
        operation: "createPullRequest",
        command: prCommand as never
      });
      const approvalId = createApprovedApproval(world, prAction, "cross-op-pr");
      const prRef: ScmApprovalRef = {
        approvalId,
        actionDigest: scmWriteActionDigest("github", {
          operation: "createPullRequest",
          command: prCommand as never
        })
      };
      const { transport, client } = makeWriteClient(world);
      await expect(
        client.createIssueComment(issueCommentCommand() as ScmCreateIssueCommentCommand, prRef)
      ).rejects.toBeInstanceOf(ScmApprovalDigestMismatchError);
      expect(transport.createIssueComment).not.toHaveBeenCalled();
      expect(requireApproval(world.db, prRef.approvalId).status).toBe("APPROVED");
    } finally {
      world.close();
    }
  });
});

describe("single consumption end-to-end through the REAL approval CAS", () => {
  it("happy path: consume once, write once, receipt + store row agree", async () => {
    const world = createApprovalWorld("happy");
    try {
      const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
      const ref = approvedRef(world, issueCommentCommand(), "happy");
      const { transport, client } = makeWriteClient(world);
      const receipt = await client.createIssueComment(command, ref);
      expect(transport.createIssueComment).toHaveBeenCalledTimes(1);
      expect(receipt).toMatchObject({
        provider: "github",
        operation: "createIssueComment",
        repo: { owner: "example-org", name: "example-repo" },
        issueNumber: 42,
        commentId: "c-1"
      });
      // No content, no credentials in the receipt:
      expect(JSON.stringify(receipt)).not.toContain("Integration candidate");
      const record = requireApproval(world.db, ref.approvalId);
      expect(record.status).toBe("CONSUMED");
      expect(record.consumedByExecutionId).toBe("exec-1");
    } finally {
      world.close();
    }
  });

  it("a second write with the SAME approvalRef is rejected by the store (A18)", async () => {
    const world = createApprovalWorld("double");
    try {
      const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
      const ref = approvedRef(world, issueCommentCommand(), "double");
      const { transport, client } = makeWriteClient(world);
      await client.createIssueComment(command, ref);
      await expect(client.createIssueComment(command, ref)).rejects.toBeInstanceOf(
        ApprovalAlreadyConsumedError
      );
      expect(transport.createIssueComment).toHaveBeenCalledTimes(1);
    } finally {
      world.close();
    }
  });

  it("a PENDING (unapproved) approval is refused by the store (ApprovalStateError)", async () => {
    const world = createApprovalWorld("pending");
    try {
      const action = scmWriteActionDescriptor("github", {
        operation: "createIssueComment",
        command: issueCommentCommand() as ScmCreateIssueCommentCommand
      });
      const { approval } = createApproval(world.db, {
        idempotencyKey: "pending-key",
        action,
        ttlSeconds: 3600,
        now: T1
      });
      const { transport, client } = makeWriteClient(world);
      await expect(
        client.createIssueComment(issueCommentCommand() as ScmCreateIssueCommentCommand, {
          approvalId: approval.id,
          actionDigest: scmWriteActionDigest("github", {
            operation: "createIssueComment",
            command: issueCommentCommand() as ScmCreateIssueCommentCommand
          })
        })
      ).rejects.toBeInstanceOf(ApprovalStateError);
      expect(transport.createIssueComment).not.toHaveBeenCalled();
    } finally {
      world.close();
    }
  });

  it("an expired approval is refused by the store (ApprovalExpiredError)", async () => {
    const world = createApprovalWorld("expired");
    try {
      const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
      const ref = approvedRef(world, issueCommentCommand(), "expired");
      const { transport } = makeWriteClient(world);
      const expiredClock = { now: T_PLUS_2H };
      const expiredClient = createControlledScmWriteClient({
        capability: githubCapability(),
        transport,
        credential: githubCredential(),
        consume: storeConsume(world, expiredClock),
        verification: verifiedVerification()
      });
      await expect(expiredClient.createIssueComment(command, ref)).rejects.toBeInstanceOf(
        ApprovalExpiredError
      );
      expect(transport.createIssueComment).not.toHaveBeenCalled();
    } finally {
      world.close();
    }
  });

  it("an unknown approval id is refused by the store (UnknownApprovalError propagates)", async () => {
    const world = createApprovalWorld("unknown");
    try {
      const { transport, client } = makeWriteClient(world);
      await expect(
        client.createIssueComment(issueCommentCommand() as ScmCreateIssueCommentCommand, {
          approvalId: "approval-does-not-exist",
          actionDigest: scmWriteActionDigest("github", {
            operation: "createIssueComment",
            command: issueCommentCommand() as ScmCreateIssueCommentCommand
          })
        })
      ).rejects.toThrow(/no approval/);
      expect(transport.createIssueComment).not.toHaveBeenCalled();
    } finally {
      world.close();
    }
  });
});

describe("transport failure AFTER consumption (HARDENING-1, review minor #18)", () => {
  /** A deterministic, test-owned transport failure type. */
  class FixtureTransportError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "FixtureTransportError";
    }
  }

  it("consume wins the CAS, then transport rejects: approval stays CONSUMED, the typed transport error propagates, and the audit records the after-consumption failure", async () => {
    const world = createApprovalWorld("post-consume-fail");
    try {
      const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
      const ref = approvedRef(world, issueCommentCommand(), "post-consume-fail");
      const audit = recordingAuditSink();
      const transport = recordingWriteTransport({ commentId: "c-1", createdAt: "2026-09-24T00:00:01.000Z" });
      transport.createIssueComment.mockRejectedValueOnce(new FixtureTransportError("fixture network down"));
      const client = createControlledScmWriteClient({
        capability: githubCapability(),
        transport,
        credential: githubCredential(),
        consume: storeConsume(world, CLOCK),
        verification: verifiedVerification(),
        audit
      });

      // The deterministic transport failure propagates unwrapped; no receipt
      // value exists (the receipt is only built after the transport
      // projection, so this rejection IS the absence-of-receipt proof).
      await expect(client.createIssueComment(command, ref)).rejects.toThrow(FixtureTransportError);

      // (a) The approval was spent at the CAS — consumption is the commit
      // point, NOT the transport. A "transport-first" reordering would leave
      // the record APPROVED here, so this assertion is order-sensitive.
      const record = requireApproval(world.db, ref.approvalId);
      expect(record.status).toBe("CONSUMED");
      expect(record.consumedByExecutionId).toBe(EXECUTION_ID);

      // (b) The failure event carries the after-consumption semantics AND the
      // consumption evidence's execution id — the id is only knowable because
      // consume ran BEFORE the transport call; a transport-first ordering has
      // no evidence at failure time and cannot produce this event.
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        kind: "scm.write",
        operation: "createIssueComment",
        outcome: "failed",
        refusalCode: "transport-contract",
        approvalId: ref.approvalId,
        executionId: EXECUTION_ID,
        repo: { owner: "example-org", name: "example-repo" }
      });
      expect(audit.events[0]?.detail).toContain("transport failed after consumption");
      expect(audit.events[0]?.detail).toContain("FixtureTransportError");

      // (c) Retrying the SAME ApprovalRef is CAS-refused: no second consume,
      // no second transport call, no silent auto-retry (A22 discipline).
      await expect(client.createIssueComment(command, ref)).rejects.toBeInstanceOf(
        ApprovalAlreadyConsumedError
      );
      expect(transport.createIssueComment).toHaveBeenCalledTimes(1);
      expect(audit.events.map((event) => event.outcome)).toEqual(["failed", "refused"]);
      expect(audit.events[1]).toMatchObject({ refusalCode: "approval-already-consumed" });
    } finally {
      world.close();
    }
  });

  it("the consume-then-transport order is observable: the retry's refusal event follows the failure event, never a second transport call", async () => {
    const world = createApprovalWorld("post-consume-retry-order");
    try {
      const command = issueCommentCommand() as ScmCreateIssueCommentCommand;
      const ref = approvedRef(world, issueCommentCommand(), "post-consume-retry-order");
      const audit = recordingAuditSink();
      const transport = recordingWriteTransport({ commentId: "c-1", createdAt: "2026-09-24T00:00:01.000Z" });
      transport.createIssueComment.mockRejectedValue(new FixtureTransportError("fixture network down"));
      const client = createControlledScmWriteClient({
        capability: githubCapability(),
        transport,
        credential: githubCredential(),
        consume: storeConsume(world, CLOCK),
        verification: verifiedVerification(),
        audit
      });

      await expect(client.createIssueComment(command, ref)).rejects.toBeInstanceOf(FixtureTransportError);
      await expect(client.createIssueComment(command, ref)).rejects.toBeInstanceOf(ApprovalAlreadyConsumedError);
      await expect(client.createIssueComment(command, ref)).rejects.toBeInstanceOf(ApprovalAlreadyConsumedError);

      // Event SEQUENCE only consistent with consume-before-transport:
      // [failed after consumption (executionId from the consume evidence),
      //  refused approval-already-consumed, refused approval-already-consumed].
      // Under a transport-first ordering the first attempt would refuse at the
      // transport with nothing consumed, and the SAME ref would still be
      // spendable afterwards — a second transport call would be observable.
      expect(audit.events.map((event) => [event.outcome, event.refusalCode])).toEqual([
        ["failed", "transport-contract"],
        ["refused", "approval-already-consumed"],
        ["refused", "approval-already-consumed"]
      ]);
      expect(audit.events.map((event) => event.executionId)).toEqual([EXECUTION_ID, null, null]);
      expect(transport.createIssueComment).toHaveBeenCalledTimes(1);
      expect(requireApproval(world.db, ref.approvalId).status).toBe("CONSUMED");
    } finally {
      world.close();
    }
  });
});

describe("risk grading invariant: remote writes always require user approval", () => {
  const commands: readonly [string, Record<string, unknown>][] = [
    ["createIssueComment", issueCommentCommand()],
    ["createPullRequest", createPullRequestCommand()]
  ];

  for (const provider of ["github", "gitlab"] as const) {
    for (const [operation, command] of commands) {
      it(`${provider}/${operation} grades high (requiresApproval) with the expected reasons`, () => {
        const assessment = scmWriteRiskAssessment(provider, {
          operation: operation as "createIssueComment" | "createPullRequest",
          command: command as never
        });
        expect(assessment.grade).toBe("high");
        expect(assessment.requiresApproval).toBe(true);
        const codes = assessment.reasons.map((reason) => reason.code);
        expect(codes).toContain("external-side-effect");
        expect(codes).toContain("network");
        expect(codes).toContain("write-unscoped");
        expect(codes).toContain("capability-not-verified");
      });
    }
  }
});

describe("audit events for the write flow", () => {
  it("emits refused + success events; no event content ever carries command text", async () => {
    const world = createApprovalWorld("audit");
    try {
      const audit = recordingAuditSink();
      const projection = { commentId: "c-9", createdAt: "2026-09-24T00:00:01.000Z" };
      const client = createControlledScmWriteClient({
        capability: githubCapability(),
        transport: recordingWriteTransport(projection),
        credential: githubCredential(),
        consume: storeConsume(world, CLOCK),
        verification: verifiedVerification(),
        audit
      });
      const command = issueCommentCommand({ body: "Body mentioning ghp_1234567890abcdefghij" });
      const ref = approvedRef(world, command, "audit");
      const receipt = await client.createIssueComment(command as ScmCreateIssueCommentCommand, ref);
      expect(receipt.commentId).toBe("c-9");

      const looseCall = (...args: unknown[]) => (client.createIssueComment as (...inner: unknown[]) => Promise<unknown>).call(client, ...args);
      await expect(looseCall(command)).rejects.toBeInstanceOf(ScmApprovalRequiredError);

      const serialized = JSON.stringify(audit.events);
      expect(serialized).not.toContain("ghp_1234567890abcdefghij");
      expect(serialized).not.toContain("Body mentioning");
      expect(audit.events.map((event) => event.outcome)).toEqual(["success", "refused"]);
      expect(audit.events[0]).toMatchObject({ outcome: "success", approvalId: ref.approvalId });
      expect(audit.events[1]).toMatchObject({ outcome: "refused", refusalCode: "approval-required" });
    } finally {
      world.close();
    }
  });
});
