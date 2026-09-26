import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AckAssignEventSchema,
  AssignCommandSchema,
  CancelCommandSchema,
  CancelConfirmedEventSchema,
  CancelUnconfirmedEventSchema,
  CancelAfterTerminalEventSchema,
  HeartbeatEventSchema,
  ProgressEventSchema,
  ResultEventSchema,
  WorkerEventSchema,
  type WorkerEvent
} from "../src/protocol.js";
import { matchesSecretShape } from "../src/secrets.js";
import { WorkerLeaseAuthority } from "../src/lease.js";
import { FencingRejectedError } from "../src/errors.js";
import { RemoteExecutionSession } from "../src/session.js";
import { iso, withWorld } from "../src/world.js";
import { openStartedSession, RESOURCE_KEY, RESULT_DIGEST, sampleAssignCommand, T0, WORK_DIGEST } from "./helpers.js";

function expectFencingReason(
  operation: () => void,
  reason: "no-live-lease" | "stale-token" | "lease-expired"
): void {
  let thrown: unknown = null;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(FencingRejectedError);
  expect((thrown as FencingRejectedError).reason).toBe(reason);
}

/**
 * Schema and lease-authority discipline (M7-03): strict schemas reject
 * unknown fields and bad shapes; the fencing authority rejects every
 * stale/expired/holder-less write; the session pipeline order is pinned.
 */
describe("remote-worker protocol schemas are strict (unknown fields rejected)", () => {
  it("assign: valid sample parses; every extra field is rejected", () => {
    expect(sampleAssignCommand().executionId).toBe("exec-1");
    expect(() => AssignCommandSchema.parse({ ...sampleAssignCommand(), credential: "x" })).toThrow(z.ZodError);
    expect(() => AssignCommandSchema.parse({ ...sampleAssignCommand(), extra: { nested: true } })).toThrow(z.ZodError);
  });

  it("assign: bad enum/literal/digest fields are rejected", () => {
    expect(() => sampleAssignCommand({ posture: "hardened" as unknown as "local-trusted" })).toThrow(z.ZodError);
    expect(() => sampleAssignCommand({ authScheme: "ssh-host-key" as unknown as "lease-token" })).toThrow(z.ZodError);
    expect(() => sampleAssignCommand({ workDigest: "not-a-digest" })).toThrow(z.ZodError);
    expect(() => sampleAssignCommand({ fencingToken: 0 })).toThrow(z.ZodError);
    expect(() => sampleAssignCommand({ leaseExpiresAt: "2026-09-22T00:01:00Z" /* wrong width */ })).toThrow(z.ZodError);
    expect(() => sampleAssignCommand({ secretRefs: ["ref:ok", "ref:ok"] /* duplicates */ })).toThrow(z.ZodError);
  });

  it("cancel: unknown reason and unknown fields rejected", () => {
    expect(() => CancelCommandSchema.parse({
      kind: "cancel",
      commandId: "cmd-cancel-1",
      executionId: "exec-1",
      reason: "because" as unknown as "user"
    })).toThrow(z.ZodError);
    expect(() => CancelCommandSchema.parse({
      kind: "cancel",
      commandId: "cmd-cancel-1",
      executionId: "exec-1",
      reason: "user",
      force: true
    })).toThrow(z.ZodError);
  });

  it("events: unknown fields and unknown event types rejected", () => {
    const envelope = {
      eventId: "exec-1-evt-1",
      executionId: "exec-1",
      seq: 1,
      fencingToken: 1,
      occurredAt: T0
    };
    expect(() => HeartbeatEventSchema.parse({ ...envelope, type: "heartbeat", extra: 1 })).toThrow(z.ZodError);
    expect(() => WorkerEventSchema.parse({ ...envelope, type: "worker-miracle" })).toThrow(z.ZodError);
    expect(() => AckAssignEventSchema.parse({ ...envelope, type: "ack-assign", ackedCommandId: "cmd-1", note: "extra" })).toThrow(z.ZodError);
    expect(() => ProgressEventSchema.parse({ ...envelope, type: "progress", note: "" /* empty */ })).toThrow(z.ZodError);
  });

  it("result: success without a digest is rejected (no evidence, no success); error allows null digest", () => {
    const envelope = { eventId: "exec-1-evt-2", executionId: "exec-1", seq: 2, fencingToken: 1, occurredAt: T0 };
    expect(() =>
      ResultEventSchema.parse({ ...envelope, type: "result", result: "success", resultDigest: null, exitCode: 0 })
    ).toThrow(/resultDigest/);
    expect(() =>
      ResultEventSchema.parse({ ...envelope, type: "result", result: "error", resultDigest: null, exitCode: 1 })
    ).not.toThrow();
    expect(() =>
      ResultEventSchema.parse({ ...envelope, type: "result", result: "success", resultDigest: RESULT_DIGEST, exitCode: 0 })
    ).not.toThrow();
    // Exit codes outside the process vocabulary are rejected.
    expect(() =>
      ResultEventSchema.parse({ ...envelope, type: "result", result: "error", resultDigest: null, exitCode: 256 })
    ).toThrow(z.ZodError);
  });

  it("cancel receipts: unresolved must be listed; empty receipts rejected; hardened postures not grantable", () => {
    const envelope = { eventId: "exec-1-evt-3", executionId: "exec-1", seq: 3, fencingToken: 1, occurredAt: T0 };
    const receipt = { terminated: ["proc-root", "proc-child-1"], unresolved: ["proc-grandchild-1"] };
    expect(() => CancelUnconfirmedEventSchema.parse({ ...envelope, type: "cancel-unconfirmed", ackedCommandId: "c1", receipt, note: "n" })).not.toThrow();
    expect(() => CancelUnconfirmedEventSchema.parse({
      ...envelope, type: "cancel-unconfirmed", ackedCommandId: "c1",
      receipt: { terminated: [], unresolved: [] }, note: "n"
    })).toThrow(/at least one process/);
    expect(() => CancelConfirmedEventSchema.parse({ ...envelope, type: "cancel-confirmed", ackedCommandId: "c1", receipt })).toThrow(
      /at least one process|unresolved/
    );
    expect(() => CancelAfterTerminalEventSchema.parse({ ...envelope, type: "cancel-after-terminal", ackedCommandId: "c1", terminalEventId: "exec-1-evt-2" })).not.toThrow();
  });

  it("secret shapes: every family is detected in text", () => {
    expect(matchesSecretShape("prefix sk-ant-SENTINELSENTINEL1 suffix")).toBe("anthropic-key");
    expect(matchesSecretShape("AKIAIOSFODNN7EXAMPLE")).toBe("aws-access-key");
    expect(matchesSecretShape("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("private-key-block");
    expect(matchesSecretShape("totally clean text")).toBe(null);
  });
});

describe("fencing authority (reusing @role-orchestrator/store lease semantics)", () => {
  it("token monotonicity + write validation across claim / expiry / reconcile / re-claim", () => {
    withWorld((world) => {
      const authority = world.authority;
      const first = authority.claim({
        leaseId: "lease-1",
        executionId: "exec-1",
        resourceKey: RESOURCE_KEY,
        expiresAt: iso(60_000),
        now: T0
      });
      assertLiveToken(first, 1);

      // Current holder's write inside the TTL passes.
      expect(authority.validateWriteBack({ resourceKey: RESOURCE_KEY, fencingToken: 1, now: iso(59_000) }).ok).toBe(true);

      // A different token while lease-1 is live is stale.
      expectFencingReason(() => authority.validateWriteBack({ resourceKey: RESOURCE_KEY, fencingToken: 2, now: iso(59_000) }), "stale-token");

      // Expired holder: matching token, refused with lease-expired.
      expectFencingReason(() => authority.validateWriteBack({ resourceKey: RESOURCE_KEY, fencingToken: 1, now: iso(60_000) }), "lease-expired");

      // Release -> no-live-lease for the old token.
      expect(authority.release("lease-1", iso(30_000))).toBe(true);
      expectFencingReason(() => authority.validateWriteBack({ resourceKey: RESOURCE_KEY, fencingToken: 1, now: iso(31_000) }), "no-live-lease");

      // Re-claim continues the monotonic sequence.
      const second = authority.claim({
        leaseId: "lease-2",
        executionId: "exec-2",
        resourceKey: RESOURCE_KEY,
        expiresAt: iso(120_000),
        now: iso(31_000)
      });
      assertLiveToken(second, 2);
      expect(authority.validateWriteBack({ resourceKey: RESOURCE_KEY, fencingToken: 2, now: iso(31_000) }).ok).toBe(true);

      // Concurrent claim on a LIVE lease is `held`, not stolen.
      const third = authority.claim({
        leaseId: "lease-3",
        executionId: "exec-3",
        resourceKey: RESOURCE_KEY,
        expiresAt: iso(180_000),
        now: iso(32_000)
      });
      expect(third).toEqual({ granted: false, reason: "held" });
    });
  });

  it("claim input validation: expiresAt must be after now; keys/patterns enforced", () => {
    withWorld((world) => {
      const authority: WorkerLeaseAuthority = world.authority;
      expect(() =>
        authority.claim({
          leaseId: "lease-1",
          executionId: "exec-1",
          resourceKey: RESOURCE_KEY,
          expiresAt: T0,
          now: T0
        })
      ).toThrow(/expiresAt/);
      expect(() =>
        authority.claim({
          leaseId: "lease-1",
          executionId: "exec-1",
          resourceKey: "BAD KEY WITH SPACES",
          expiresAt: iso(60_000),
          now: T0
        })
      ).toThrow(z.ZodError);
    });
  });
});

describe("session pipeline order is the contract", () => {
  it("foreign execution events throw when routed to the session; strict re-parse guards hand-rolled events", () => {
    const handle = openStartedSession("exec-1");
    try {
      const { world, session } = handle;
      // Hand-routed foreign event: the session's own guard fires loudly.
      expect(() =>
        session.ingest({
          eventId: "other-evt-1",
          executionId: "exec-other",
          seq: 1,
          fencingToken: 1,
          occurredAt: T0,
          type: "heartbeat"
        }, T0)
      ).toThrow(/belongs to execution "exec-other"/);

      // A structurally invalid hand-rolled event fails the strict re-parse
      // before anything else runs.
      expect(() =>
        session.ingest({
          eventId: "exec-1-evt-9",
          executionId: "exec-1",
          seq: 1,
          fencingToken: 1,
          occurredAt: T0,
          type: "heartbeat",
          smuggled: "field"
        } as unknown as WorkerEvent, T0)
      ).toThrow(z.ZodError);

      // Bus routing: events for other executions stay queued on the shared
      // transport; a session's drain takes only its own.
      world.transport.emit({
        eventId: "other-evt-2",
        executionId: "exec-other",
        seq: 2,
        fencingToken: 1,
        occurredAt: T0,
        type: "heartbeat"
      });
      world.transport.emit({
        eventId: "exec-1-evt-1",
        executionId: "exec-1",
        seq: 1,
        fencingToken: 1,
        occurredAt: T0,
        type: "heartbeat"
      });
      session.drainInbound(T0);
      expect(session.counters.heartbeatsObserved).toBe(1);
      expect(world.transport.drainInbound("exec-other")).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it("start refuses a second claim on the same slot with needs-reconcile/held instead of silently sharing", () => {
    const first = openStartedSession("exec-1");
    try {
      const world = first.world;
      const second = new RemoteExecutionSession({
        authority: world.authority,
        transport: world.transport,
        executionId: "exec-2",
        resourceKey: RESOURCE_KEY
      });
      const claim = second.start({
        leaseId: "lease-2",
        runId: "run-1",
        workDigest: WORK_DIGEST,
        worktreeBundleRef: "bundle-1",
        secretRefs: [],
        posture: "local-trusted",
        authScheme: "lease-token",
        expiresAt: iso(120_000),
        now: T0
      });
      expect(claim).toEqual({ claimed: false, reason: "held" });
      expect(second.outcome).toBe(null);
    } finally {
      first.close();
    }
  });

  it("start with a sealed cable releases the claim determinately (launch failure, not unknown outcome)", () => {
    withWorld((world) => {
      world.transport.seal();
      const session = new RemoteExecutionSession({
        authority: world.authority,
        transport: world.transport,
        executionId: "exec-1",
        resourceKey: RESOURCE_KEY
      });
      expect(() =>
        session.start({
          leaseId: "lease-1",
          runId: "run-1",
          workDigest: WORK_DIGEST,
          worktreeBundleRef: "bundle-1",
          secretRefs: [],
          posture: "local-trusted",
          authScheme: "lease-token",
          expiresAt: iso(60_000),
          now: T0
        })
      ).toThrow(/transport is sealed/);
      expect(world.authority.liveLease(RESOURCE_KEY)).toBe(null);
      expect(session.evidenceLog.some((line) => line.includes("start-sealed-send-released-lease"))).toBe(true);
    });
  });
});

function assertLiveToken(
  claim: { granted: true; lease: { fencingToken: number } } | { granted: false; reason: string },
  expected: number
): void {
  if (!claim.granted) throw new Error(`expected a granted claim, got ${claim.reason}`);
  expect(claim.lease.fencingToken).toBe(expected);
}
