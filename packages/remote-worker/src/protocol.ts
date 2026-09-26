/**
 * The remote-worker wire protocol (M7-03), as strict closed schemas.
 *
 * Every message is `strictObject`: unknown fields are REJECTED, never passed
 * through. Free text goes through `secretFreeText` (bounded, printable, no
 * credential shapes). What the protocol deliberately CANNOT express:
 * - a secret value (only `ref:` slots; `SecretRefSchema` refuses everything else);
 * - a "hardened" granted posture (the assign command's posture field is the
 *   literal "local-trusted" — a granted Hardened claim is unrepresentable, A31);
 * - an open payload bag (each event type carries its own closed field set, so
 *   credential material has no place to ride — structural A42).
 */
import { z } from "zod";
import { IdSchema, withUniqueItems } from "@role-orchestrator/contracts";
import { TransportAuthSchemeSchema } from "./auth.js";
import { GrantedPostureSchema } from "./posture.js";
import { SecretRefSchema, secretFreeText } from "./secrets.js";

/** sha256 content digests: 64 lowercase hex chars. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "digest must be 64 lowercase hex characters"
});

/** Protocol message ids share the worker-event id shape. */
export const MessageIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
  message: "message id must match ^[a-z0-9][a-z0-9._-]{0,63}$"
});

/** Fixed-width UTC ISO timestamps (lexicographic order = chronological). */
export const ProtocolTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
  message: "timestamp must be a fixed-width UTC ISO string (Date.prototype.toISOString form)"
});

/** Simulated process references inside the worker's (simulated) process tree. */
export const ProcessRefSchema = z.string().regex(/^proc-[a-z0-9-]{1,32}$/, {
  message: "process ref must match ^proc-[a-z0-9-]{1,32}$"
});
export type ProcessRef = z.output<typeof ProcessRefSchema>;

/** Why a cancel was issued (closed vocabulary; new reasons are schema changes). */
export const CANCEL_REASONS = ["user", "policy", "budget", "timeout"] as const;
export const CancelReasonSchema = z.enum(CANCEL_REASONS);

// ---------------------------------------------------------------------------
// Orchestrator -> worker commands
// ---------------------------------------------------------------------------

const AssignCommandFields = {
  kind: z.literal("assign"),
  commandId: MessageIdSchema,
  executionId: IdSchema,
  runId: IdSchema,
  workDigest: Sha256HexSchema,
  /** The remote slot this execution holds (the lease authority's resource key). */
  resourceKey: z.string().regex(/^[a-z][a-z0-9:._-]{0,127}$/),
  fencingToken: z.number().int().min(1),
  leaseExpiresAt: ProtocolTimestampSchema,
  /** Opaque reference to the synchronized worktree bundle — never file contents. */
  worktreeBundleRef: MessageIdSchema,
  /** Remote secret-store slots; the orchestrator never sends values. */
  secretRefs: withUniqueItems(z.array(SecretRefSchema).max(8)),
  /** The granted posture travels with the assignment; "hardened" cannot be granted (A31). */
  posture: GrantedPostureSchema,
  /** The transport auth scheme the (future) real channel used — design data on the wire. */
  authScheme: TransportAuthSchemeSchema
};

export const AssignCommandSchema = z.strictObject(AssignCommandFields);
export type AssignCommand = z.output<typeof AssignCommandSchema>;

export const CancelCommandSchema = z.strictObject({
  kind: z.literal("cancel"),
  commandId: MessageIdSchema,
  executionId: IdSchema,
  reason: CancelReasonSchema
});
export type CancelCommand = z.output<typeof CancelCommandSchema>;

export const WorkerCommandSchema = z.discriminatedUnion("kind", [AssignCommandSchema, CancelCommandSchema]);
export type WorkerCommand = z.output<typeof WorkerCommandSchema>;

// ---------------------------------------------------------------------------
// Worker -> orchestrator events
// ---------------------------------------------------------------------------

export const WORKER_EVENT_TYPES = [
  "ack-assign",
  "progress",
  "heartbeat",
  "result",
  "cancel-confirmed",
  "cancel-unconfirmed",
  "cancel-after-terminal"
] as const;
export const WorkerEventTypeSchema = z.enum(WORKER_EVENT_TYPES);

const EventEnvelope = {
  eventId: MessageIdSchema,
  executionId: IdSchema,
  /** Per-(worker,execution) monotonic sequence — duplicates keep the SAME seq. */
  seq: z.number().int().min(1),
  /** The fencing token the worker believes it holds; validated on arrival. */
  fencingToken: z.number().int().min(1),
  occurredAt: ProtocolTimestampSchema
};

export const AckAssignEventSchema = z.strictObject({
  ...EventEnvelope,
  type: z.literal("ack-assign"),
  ackedCommandId: MessageIdSchema
});

export const ProgressEventSchema = z.strictObject({
  ...EventEnvelope,
  type: z.literal("progress"),
  note: secretFreeText(256)
});

export const HeartbeatEventSchema = z.strictObject({
  ...EventEnvelope,
  type: z.literal("heartbeat")
});

/**
 * The terminal work result. A "success" claim REQUIRES a result digest (the
 * A06 discipline: no evidence, no success); "error" carries the exit code.
 */
export const ResultEventSchema = z
  .strictObject({
    ...EventEnvelope,
    type: z.literal("result"),
    result: z.enum(["success", "error"]),
    resultDigest: Sha256HexSchema.nullable(),
    exitCode: z.number().int().min(0).max(255).nullable()
  })
  .refine((event) => event.result === "success" ? event.resultDigest !== null : true, {
    message: "a success result requires a resultDigest (no evidence, no success)",
    path: ["resultDigest"]
  });

/** Receipt of a completed remote tree-kill (A26): structural honesty built in. */
export const ProcessTreeReceiptSchema = z
  .strictObject({
    terminated: withUniqueItems(z.array(ProcessRefSchema)),
    unresolved: withUniqueItems(z.array(ProcessRefSchema))
  })
  .refine((receipt) => receipt.terminated.length + receipt.unresolved.length > 0, {
    message: "a tree receipt must list at least one process as terminated or unresolved"
  });
export type ProcessTreeReceipt = z.output<typeof ProcessTreeReceiptSchema>;

export const CancelConfirmedEventSchema = z.strictObject({
  ...EventEnvelope,
  type: z.literal("cancel-confirmed"),
  ackedCommandId: MessageIdSchema,
  /** A CONFIRMED cancel means everything died: unresolved entries are structurally impossible here. */
  receipt: ProcessTreeReceiptSchema.refine((receipt) => receipt.unresolved.length === 0, {
    message: "a cancel-confirmed receipt must not list unresolved processes (that is cancel-unconfirmed's job)"
  })
});

export const CancelUnconfirmedEventSchema = z.strictObject({
  ...EventEnvelope,
  type: z.literal("cancel-unconfirmed"),
  ackedCommandId: MessageIdSchema,
  receipt: ProcessTreeReceiptSchema,
  note: secretFreeText(256)
});

export const CancelAfterTerminalEventSchema = z.strictObject({
  ...EventEnvelope,
  type: z.literal("cancel-after-terminal"),
  ackedCommandId: MessageIdSchema,
  terminalEventId: MessageIdSchema
});

export const WorkerEventSchema = z.discriminatedUnion("type", [
  AckAssignEventSchema,
  ProgressEventSchema,
  HeartbeatEventSchema,
  ResultEventSchema,
  CancelConfirmedEventSchema,
  CancelUnconfirmedEventSchema,
  CancelAfterTerminalEventSchema
]);
export type WorkerEvent = z.output<typeof WorkerEventSchema>;

/** True for events that can settle the session's single terminal outcome. */
export function isTerminalEventType(event: WorkerEvent): boolean {
  return (
    event.type === "result" || event.type === "cancel-confirmed" || event.type === "cancel-unconfirmed"
  );
}
