/**
 * The fault-case run functions (M7-03). Each function drives the full
 * simulation world through ONE injected fault and asserts the expected
 * protocol behavior with `node:assert` — the same pattern as fault-matrix:
 * no vitest in src, so each run is callable from tests AND from future
 * tooling. Every thrown assertion IS the evidence the design document's
 * fault tables cite.
 *
 * All cases are protocol-level simulations: no container, no network, no
 * real process is involved anywhere (see tenancy.ts SIMULATION_DISCLOSURE).
 */
import { strict as assert } from "node:assert";
import { EXECUTION_TARGETS } from "@role-orchestrator/contracts";
import {
  CancelUndeliverableError,
  FencingRejectedError,
  HardenedPostureUnavailableError,
  SecretMaterialRejectedError
} from "./errors.js";
import { AUTH_SCHEME_PROFILES } from "./auth.js";
import {
  BOUNDARY_EVIDENCE_BY_TARGET,
  resolvePosture
} from "./posture.js";
import {
  AssignCommandSchema,
  type ProcessRef,
  type WorkerEvent
} from "./protocol.js";
import { SECRET_SHAPE_RULES, assertNoSecretMaterial, matchesSecretShape, secretFreeText } from "./secrets.js";
import { NOT_MULTI_TENANT_MARKER, SIMULATION_DISCLOSURE, TENANCY_BOUNDARY_STATEMENT } from "./tenancy.js";
import { RemoteExecutionSession } from "./session.js";
import { SimulatedRemoteWorker } from "./worker.js";
import { assertMatrixTargetCoverage } from "./matrix.js";
import { iso, withWorld, type RemoteWorld } from "./world.js";

const RESOURCE_KEY = "remote-worker:slot-1";
const WORK_DIGEST = "aa".repeat(32);
const RESULT_DIGEST = "bb".repeat(32);
const WORKTREE_BUNDLE_REF = "bundle-1";

interface StartOptions {
  readonly executionId: string;
  readonly leaseId: string;
  readonly expiresAtMs?: number;
}

function startSession(world: RemoteWorld, options: StartOptions): RemoteExecutionSession {
  const session = new RemoteExecutionSession({
    authority: world.authority,
    transport: world.transport,
    executionId: options.executionId,
    resourceKey: RESOURCE_KEY
  });
  const claim = session.start({
    leaseId: options.leaseId,
    runId: "run-1",
    workDigest: WORK_DIGEST,
    worktreeBundleRef: WORKTREE_BUNDLE_REF,
    secretRefs: ["ref:remote-cli-credential"],
    posture: "local-trusted",
    authScheme: "lease-token",
    expiresAt: iso(options.expiresAtMs ?? 60_000),
    now: world.clock.now
  });
  assert.equal(claim.claimed, true, "the first claim on a fresh slot must be granted");
  return session;
}

/** Deliver the queued orchestrator commands to the worker and drain the acks. */
function pump(world: RemoteWorld, session: RemoteExecutionSession): void {
  session.pump(world.clock.now, world.worker);
}

function assertFencingRejected(
  operation: () => void,
  reason: "no-live-lease" | "stale-token" | "lease-expired"
): void {
  let thrown: unknown = null;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof FencingRejectedError, `expected FencingRejectedError(${reason})`);
  assert.equal((thrown as FencingRejectedError).reason, reason);
}

// ---------------------------------------------------------------------------
// RW-TRX-01 — sealed cable, zombie worker, expired-lease write-back
// ---------------------------------------------------------------------------

export function runTransportZombieWriteBackExpiredLease(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    // Healthy phase: heartbeats flow and are fenced in.
    world.clock.advanceMs(30_000);
    world.worker.emitHeartbeat();
    world.worker.emitHeartbeat();
    session.drainInbound(world.clock.now);
    assert.equal(session.counters.heartbeatsObserved, 2);

    // The cable is cut; the worker KEEPS RUNNING (zombie) and its result is
    // buffered by the at-least-once retry outbox.
    world.transport.seal();
    world.clock.advanceMs(70_000); // now T0+100s > lease expiry T0+60s
    world.worker.keepRunning();
    world.worker.complete("success", RESULT_DIGEST, 0);
    assert.equal(world.worker.bufferedEventCount, 1, "the zombie's result waits in the retry outbox");

    // Reconnect: the buffered result is delivered LATE.
    world.transport.heal();
    world.worker.retryBufferedEvents();
    session.drainInbound(world.clock.now);

    // Fencing refuses the overstay write-back by DATA (lease-expired) and
    // the session did NOT apply it.
    assert.equal(session.counters.rejectedByFencing, 1);
    assert.ok(session.evidenceLog.some((line) => line.includes("lease-expired")));
    assert.equal(session.outcome, null, "a fenced write-back never settles the session");

    // The slot is still OCCUPIED by the expired lease: no auto steal.
    const blocked = world.authority.claim({
      leaseId: "lease-2",
      executionId: "exec-2",
      resourceKey: RESOURCE_KEY,
      expiresAt: iso(120_000),
      now: world.clock.now
    });
    assert.deepEqual(blocked, { granted: false, reason: "needs-reconcile" });

    // The explicit A22 landing: unknown outcome, RECOVERY_REQUIRED, no re-run.
    const outcome = session.observeUnknownOutcome(["transport-sealed", "lease-expired"], world.clock.now);
    assert.equal(outcome.kind, "unknown-recovery-required");
    assert.equal(outcome.nodeState, "RECOVERY_REQUIRED");
    assert.equal(outcome.autoRerun, false);
  });
}

// ---------------------------------------------------------------------------
// RW-TRX-02 — zombie write-back vs a RE-LEASED slot (stale token)
// ---------------------------------------------------------------------------

export function runTransportZombieWriteBackStaleToken(): void {
  withWorld((world) => {
    const session1 = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session1);
    world.worker.beginWork();
    world.transport.seal();
    world.clock.advanceMs(70_000);
    world.worker.complete("success", RESULT_DIGEST, 0); // buffered zombie result (token 1)

    // Explicit reconcile frees the slot; the cable heals (reconnect); a NEW
    // attempt takes the slot with token 2.
    assert.equal(world.authority.reconcileExpired(world.clock.now), 1);
    world.transport.heal();
    const session2 = new RemoteExecutionSession({
      authority: world.authority,
      transport: world.transport,
      executionId: "exec-2",
      resourceKey: RESOURCE_KEY
    });
    const claim2 = session2.start({
      leaseId: "lease-2",
      runId: "run-1",
      workDigest: WORK_DIGEST,
      worktreeBundleRef: WORKTREE_BUNDLE_REF,
      secretRefs: ["ref:remote-cli-credential"],
      posture: "local-trusted",
      authScheme: "lease-token",
      expiresAt: iso(160_000),
      now: world.clock.now
    });
    assert.equal(claim2.claimed, true);
    const token2 = world.authority.liveLease(RESOURCE_KEY)?.fencingToken;
    assert.equal(token2, 2, "fencing tokens are monotonic per resource (old token 1 -> new token 2)");

    // A re-leased slot implies the old holder is written off: the new
    // attempt runs on a NEW worker process (a fresh simulation object).
    const newWorkerCommands = world.transport.deliverCommandsToWorker();
    assert.equal(newWorkerCommands.length, 1);
    const assignCommand = AssignCommandSchema.parse(newWorkerCommands[0]);
    const successor = new SimulatedRemoteWorker({ transport: world.transport, clock: () => world.clock.now });
    successor.receiveCommand(assignCommand);
    successor.beginWork();

    // The zombie's late buffered write-back arrives first: STALE token refused.
    world.worker.retryBufferedEvents();
    session1.drainInbound(world.clock.now);
    assert.equal(session1.counters.rejectedByFencing, 1);
    assert.ok(session1.evidenceLog.some((line) => line.includes("stale-token")));
    assert.equal(session1.outcome, null);

    // The NEW holder's write-back is accepted on the SAME slot, undisturbed.
    successor.complete("success", RESULT_DIGEST, 0);
    session2.drainInbound(world.clock.now);
    assert.equal(session2.outcome?.kind, "result-delivered");
  });
}

// ---------------------------------------------------------------------------
// RW-LSN-01 — expired lease blocks the slot until explicit reconcile
// ---------------------------------------------------------------------------

export function runLeaseExpiryBlocksSlot(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    // No transport fault at all: the worker simply overstays its TTL.
    world.clock.advanceMs(70_000);
    world.worker.complete("success", RESULT_DIGEST, 0);
    session.drainInbound(world.clock.now);

    assertFencingRejected(() => {
      world.authority.validateWriteBack({
        resourceKey: RESOURCE_KEY,
        fencingToken: 1,
        now: world.clock.now
      });
    }, "lease-expired");
    assert.equal(session.counters.rejectedByFencing, 1);
    assert.equal(session.outcome, null);

    // Timeout alone never frees the slot (store semantics: 超时只代表需 reconcile).
    const blocked = world.authority.claim({
      leaseId: "lease-2",
      executionId: "exec-2",
      resourceKey: RESOURCE_KEY,
      expiresAt: iso(160_000),
      now: world.clock.now
    });
    assert.deepEqual(blocked, { granted: false, reason: "needs-reconcile" });

    // The ONLY exit is the explicit reconcile step.
    assert.equal(world.authority.reconcileExpired(world.clock.now), 1);
    const afterReconcile = world.authority.claim({
      leaseId: "lease-2",
      executionId: "exec-2",
      resourceKey: RESOURCE_KEY,
      expiresAt: iso(160_000),
      now: world.clock.now
    });
    assert.equal(afterReconcile.granted, true);
    if (afterReconcile.granted) {
      assert.equal(afterReconcile.lease.fencingToken, 2);
    }
  });
}

// ---------------------------------------------------------------------------
// RW-CXL-01 — cancel in time: whole (simulated) tree terminated
// ---------------------------------------------------------------------------

export function runCancelConfirmedTreeTerminated(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    const sent = session.cancel("user", world.clock.now);
    assert.deepEqual(sent, { sent: true });
    pump(world, session);

    const outcome = session.outcome;
    assert.notEqual(outcome, null);
    assert.equal(outcome?.kind, "cancelled-confirmed");
    if (outcome?.kind === "cancelled-confirmed") {
      assert.deepEqual(
        [...outcome.terminated].sort(),
        ["proc-child-1", "proc-grandchild-1", "proc-root"].sort()
      );
    }
    assert.equal(world.authority.liveLease(RESOURCE_KEY), null, "terminal hand-back released the slot");
    assert.ok(session.counters.eventsApplied >= 2, "ack + cancel receipt both applied");
  });
}

// ---------------------------------------------------------------------------
// RW-CXL-02 — cancel racing a finished worker: exactly one terminal outcome
// ---------------------------------------------------------------------------

export function runCancelRaceAfterTerminal(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    // The worker finishes; its result sits on the wire. THEN the cancel is
    // sent (the classic in-flight race), before the orchestrator drains.
    world.worker.complete("success", RESULT_DIGEST, 0);
    const sent = session.cancel("user", world.clock.now);
    assert.deepEqual(sent, { sent: true });

    pump(world, session);

    assert.equal(session.outcome?.kind, "result-delivered", "the result wins the race");
    if (session.outcome?.kind === "result-delivered") {
      assert.equal(session.outcome.result, "success");
      assert.equal(session.outcome.resultDigest, RESULT_DIGEST);
    }
    assert.ok(
      session.counters.postTerminalIgnored >= 1,
      "the worker's cancel-after-terminal answer is counted, never applied as a second outcome"
    );
    assert.equal(world.authority.liveLease(RESOURCE_KEY), null);
  });
}

// ---------------------------------------------------------------------------
// RW-CXL-03 — unterminable grandchild: honest cancel-unconfirmed
// ---------------------------------------------------------------------------

export function runCancelUnconfirmedHonestReport(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.injectUnterminable(["proc-grandchild-1"] satisfies ProcessRef[]);
    world.worker.beginWork();

    session.cancel("user", world.clock.now);
    pump(world, session);

    const outcome = session.outcome;
    assert.equal(outcome?.kind, "cancel-unconfirmed");
    if (outcome?.kind === "cancel-unconfirmed") {
      assert.deepEqual([...outcome.terminated].sort(), ["proc-child-1", "proc-root"].sort());
      assert.deepEqual([...outcome.unresolved], ["proc-grandchild-1"]);
    }
    // The worker itself keeps running (cancel-partial) — and any later work
    // result can no longer change the settled outcome.
    world.worker.complete("success", RESULT_DIGEST, 0);
    session.drainInbound(world.clock.now);
    assert.equal(session.outcome?.kind, "cancel-unconfirmed");
    assert.equal(session.counters.postTerminalIgnored, 1);
  });
}

// ---------------------------------------------------------------------------
// RW-CXL-04 — cancel undeliverable: unknown, not assumed dead
// ---------------------------------------------------------------------------

export function runCancelUndeliverableSealedCable(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    world.transport.seal();
    assert.throws(() => session.cancel("user", world.clock.now), CancelUndeliverableError);
    assert.equal(session.outcome, null, "an undeliverable cancel never fabricates termination");

    world.clock.advanceMs(70_000);
    const outcome = session.observeUnknownOutcome(["cancel-undeliverable", "transport-sealed"], world.clock.now);
    assert.equal(outcome.kind, "unknown-recovery-required");
    assert.equal(outcome.nodeState, "RECOVERY_REQUIRED");
    assert.equal(outcome.autoRerun, false);
  });
}

// ---------------------------------------------------------------------------
// RW-EVT-01 — duplicate delivery absorbed by the idempotency key
// ---------------------------------------------------------------------------

export function runEventsDuplicateDelivery(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    // After ack-assign (evt-1) the result event will be evt-2 — deterministic.
    world.transport.armDuplicateDelivery("exec-1-evt-2");
    world.worker.complete("success", RESULT_DIGEST, 0);
    session.drainInbound(world.clock.now);

    assert.equal(session.outcome?.kind, "result-delivered");
    assert.equal(session.counters.duplicatesIgnored, 1, "exactly one duplicate was absorbed");
    assert.equal(
      session.evidenceLog.filter((line) => line.startsWith("lease-released-on-terminal")).length,
      1,
      "the terminal side effect ran exactly once"
    );
    assert.equal(world.authority.liveLease(RESOURCE_KEY), null);

    // A SECOND duplicate wave (a reconnect replay) is absorbed the same way,
    // and dedup happens BEFORE post-terminal counting.
    const replay = {
      eventId: "exec-1-evt-2",
      executionId: "exec-1",
      seq: 2,
      fencingToken: 1,
      occurredAt: world.clock.now,
      type: "result",
      result: "success",
      resultDigest: RESULT_DIGEST,
      exitCode: 0
    } as const;
    world.transport.emit(replay satisfies WorkerEvent as WorkerEvent);
    world.transport.emit(replay satisfies WorkerEvent as WorkerEvent);
    session.drainInbound(world.clock.now);
    assert.equal(session.counters.duplicatesIgnored, 3, "replays stay deduplicated");
    assert.equal(session.counters.postTerminalIgnored, 0, "dedup happens BEFORE post-terminal counting");
  });
}

// ---------------------------------------------------------------------------
// RW-OUT-01 — silent loss: RECOVERY_REQUIRED, nothing auto re-runs
// ---------------------------------------------------------------------------

export function runOutcomeUnknownNoAutoRerun(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();
    world.worker.emitHeartbeat();
    session.drainInbound(world.clock.now);

    // Silent loss WITHOUT a transport fault: the worker object crashes.
    world.worker.crash();
    world.clock.advanceMs(70_000); // past lease expiry

    // The expiry ALONE changed nothing: no auto terminal, no auto reclaim.
    assert.equal(session.outcome, null, "lease expiry is only a reconcile signal, never an outcome");
    const blocked = world.authority.claim({
      leaseId: "lease-2",
      executionId: "exec-2",
      resourceKey: RESOURCE_KEY,
      expiresAt: iso(160_000),
      now: world.clock.now
    });
    assert.deepEqual(blocked, { granted: false, reason: "needs-reconcile" });

    // The explicit human-driven landing:
    const outcome = session.observeUnknownOutcome(["worker-silent-loss", "lease-expired"], world.clock.now);
    assert.equal(outcome.kind, "unknown-recovery-required");
    assert.equal(outcome.nodeState, "RECOVERY_REQUIRED");
    assert.equal(outcome.autoRerun, false);
    // Repeat observation is idempotent.
    const again = session.observeUnknownOutcome(["worker-silent-loss"], world.clock.now);
    assert.equal(again, outcome);

    // Still no slot for anyone else until the operator runs the reconcile step.
    const stillBlocked = world.authority.claim({
      leaseId: "lease-3",
      executionId: "exec-3",
      resourceKey: RESOURCE_KEY,
      expiresAt: iso(300_000),
      now: world.clock.now
    });
    assert.deepEqual(stillBlocked, { granted: false, reason: "needs-reconcile" });
    assert.equal(world.authority.reconcileExpired(world.clock.now), 1, "only the explicit reconcile frees the slot");
  });
}

// ---------------------------------------------------------------------------
// RW-SEC-01 — secret minimal exposure
// ---------------------------------------------------------------------------

export function runSecretsMinimalExposure(): void {
  withWorld((world) => {
    const session = startSession(world, { executionId: "exec-1", leaseId: "lease-1" });
    pump(world, session);
    world.worker.beginWork();

    // Every known credential SHAPE is detected (sentinel constructions only —
    // no real credential exists in this repository).
    for (const { rule } of SECRET_SHAPE_RULES) {
      assert.notEqual(matchesSecretShape(sentinelFor(rule)), null, `rule ${rule} must detect its sentinel`);
    }
    assert.throws(
      () => assertNoSecretMaterial("note", "plain password=hunter2hunter2hunter2 assignment"),
      SecretMaterialRejectedError
    );
    assert.throws(
      () => secretFreeText(256).parse(`ok then ghp_${GH_SENTINEL_TAIL}`),
      (error: unknown) => error instanceof Error && error.message.includes("credential-shaped")
    );

    // The assign command cannot carry a value where a ref belongs.
    assert.throws(() =>
      AssignCommandSchema.parse({
        kind: "assign",
        commandId: "cmd-1",
        executionId: "exec-9",
        runId: "run-1",
        workDigest: WORK_DIGEST,
        resourceKey: RESOURCE_KEY,
        fencingToken: 1,
        leaseExpiresAt: iso(60_000),
        worktreeBundleRef: "bundle-1",
        secretRefs: [AWS_EXAMPLE_SENTINEL],
        posture: "local-trusted",
        authScheme: "lease-token"
      })
    );

    // Normal run to produce worker state + session evidence.
    world.worker.complete("success", RESULT_DIGEST, 0);
    session.drainInbound(world.clock.now);
    const serialized = JSON.stringify({
      worker: world.worker.debugState(),
      evidence: session.evidenceLog,
      counters: session.counters
    });
    assert.equal(matchesSecretShape(serialized), null, "no credential shape may leak into state or evidence");
    assert.deepEqual(world.worker.debugState().secretRefNames, ["ref:remote-cli-credential"]);
  });
}

/**
 * Sentinel tails are assembled at RUNTIME (same methodology as the release
 * audit's own rule table, whose literal text cannot self-match its value
 * rules): this src file must contain no credential-shaped LITERAL, so the
 * repo-wide scan's `needs-judgment` verdict stays reserved for unknown
 * content. The assembled values are obviously fake.
 */
const SENTINEL_FILL = "SENTINEL".repeat(4);
const AWS_EXAMPLE_TAIL = "IOSFODNN7" + "EXAMPLE";
const AWS_EXAMPLE_SENTINEL = `AKIA${AWS_EXAMPLE_TAIL}`;
const GH_SENTINEL_TAIL = "SENTINEL0SENTINEL012345";
const PRIVATE_KEY_SENTINEL = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;

/** Deterministic sentinel per rule name (obviously fake; nothing real anywhere). */
function sentinelFor(rule: string): string {
  const fill = SENTINEL_FILL;
  switch (rule) {
    case "anthropic-key":
      return `sk-ant-${fill}`;
    case "openai-style-key":
      return `sk-${fill}`;
    case "github-pat":
      return `ghp_${fill}`;
    case "github-fine-grained-pat":
      return `github_pat_${fill}`;
    case "gitlab-pat":
      return `glpat-${fill}`;
    case "aws-access-key":
      return AWS_EXAMPLE_SENTINEL;
    case "slack-token":
      return `xoxb-${fill}`;
    case "private-key-block":
      return PRIVATE_KEY_SENTINEL;
    case "bearer-credential":
      return `Bearer ${fill}`;
    case "credential-assignment":
      return "password=hunter2hunter2hunter2";
    default:
      throw new Error(`unknown rule ${rule}`);
  }
}

// ---------------------------------------------------------------------------
// RW-POST-01 — Hardened refused per target
// ---------------------------------------------------------------------------

export function runPostureHardenedRefused(): void {
  // The evidence table cannot claim verified, per target, per boundary.
  for (const target of EXECUTION_TARGETS) {
    const evidence = BOUNDARY_EVIDENCE_BY_TARGET[target];
    assert.equal(evidence.filesystem.verification, "unverified");
    assert.equal(evidence.filesystem.evidence, null);
    assert.equal(evidence.network.verification, "unverified");
    assert.equal(evidence.network.evidence, null);
    assert.equal(evidence.remoteCancellation.verification, "unverified");
    assert.equal(evidence.remoteCancellation.evidence, null);

    // The Hardened request is refused per target with the honest reason.
    assert.throws(() => resolvePosture("hardened", target), HardenedPostureUnavailableError);
    let message = "";
    try {
      resolvePosture("hardened", target);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    assert.ok(message.includes(target), "the refusal names the target");
    assert.ok(message.includes("A31"), "the refusal cites the acceptance rule");

    // The grantable posture stays local-trusted, WITH its caveats.
    const resolved = resolvePosture("local-trusted", target);
    assert.equal(resolved.granted, "local-trusted");
    assert.ok(resolved.caveats.length >= 3);
    assert.ok(resolved.caveats.some((line) => line.includes(NOT_MULTI_TENANT_MARKER)));
  }

  // The wire protocol cannot carry a hardened grant either.
  assert.throws(() =>
    AssignCommandSchema.parse({
      kind: "assign",
      commandId: "cmd-hardened",
      executionId: "exec-9",
      runId: "run-1",
      workDigest: WORK_DIGEST,
      resourceKey: RESOURCE_KEY,
      fencingToken: 1,
      leaseExpiresAt: iso(60_000),
      worktreeBundleRef: "bundle-1",
      secretRefs: [],
      posture: "hardened",
      authScheme: "lease-token"
    })
  );

  // Boundary statements are pinned data.
  assert.ok(TENANCY_BOUNDARY_STATEMENT.includes(NOT_MULTI_TENANT_MARKER));
  assert.ok(SIMULATION_DISCLOSURE.includes("protocol-level simulation"));
  assert.ok(SIMULATION_DISCLOSURE.includes("NEVER"));

  // The auth comparison data: three schemes, all unverified with null evidence.
  const schemes = Object.keys(AUTH_SCHEME_PROFILES).sort();
  assert.deepEqual(schemes, ["lease-token", "loopback-token", "mtls"]);
  for (const profile of Object.values(AUTH_SCHEME_PROFILES)) {
    assert.equal(profile.verification.verification, "unverified");
    assert.equal(profile.verification.evidence, null);
    assert.ok(profile.threatSurface.length > 0);
  }

  // Matrix coverage is total over the four targets.
  assertMatrixTargetCoverage();
}
