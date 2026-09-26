import { strict as assert } from "node:assert";
import { AssignCommandSchema, type AssignCommand } from "../src/protocol.js";
import { createRemoteWorld, iso, type RemoteWorld } from "../src/world.js";
import { RemoteExecutionSession } from "../src/session.js";
import type { SessionStartInput } from "../src/session.js";

/** Shared fixtures for the schema/posture suites. */

export const T0 = "2026-09-22T00:00:00.000Z";
export const RESOURCE_KEY = "remote-worker:slot-1";
export const WORK_DIGEST = "aa".repeat(32);
export const RESULT_DIGEST = "bb".repeat(32);

/** A fully valid assign command; tests mutate one field at a time. */
export function sampleAssignCommand(overrides: Partial<AssignCommand> = {}): AssignCommand {
  const base = {
    kind: "assign" as const,
    commandId: "cmd-assign-1",
    executionId: "exec-1",
    runId: "run-1",
    workDigest: WORK_DIGEST,
    resourceKey: RESOURCE_KEY,
    fencingToken: 1,
    leaseExpiresAt: iso(60_000),
    worktreeBundleRef: "bundle-1",
    secretRefs: ["ref:remote-cli-credential"],
    posture: "local-trusted" as const,
    authScheme: "lease-token" as const
  };
  const merged = { ...base, ...overrides };
  return AssignCommandSchema.parse(merged);
}

export interface TestSessionHandle {
  readonly world: RemoteWorld;
  readonly session: RemoteExecutionSession;
  close(): void;
}

/** A fresh world with one started session on the shared slot. */
export function openStartedSession(executionId = "exec-1"): TestSessionHandle {
  const world = createRemoteWorld();
  const session = new RemoteExecutionSession({
    authority: world.authority,
    transport: world.transport,
    executionId,
    resourceKey: RESOURCE_KEY
  });
  const input: SessionStartInput = {
    leaseId: "lease-1",
    runId: "run-1",
    workDigest: WORK_DIGEST,
    worktreeBundleRef: "bundle-1",
    secretRefs: ["ref:remote-cli-credential"],
    posture: "local-trusted",
    authScheme: "lease-token",
    expiresAt: iso(60_000),
    now: T0
  };
  const claim = session.start(input);
  assert.equal(claim.claimed, true);
  return {
    world,
    session,
    close: () => world.close()
  };
}
