/**
 * A36 落盘前脱敏 (redact-before-persist), pinned at the storage boundary:
 *
 * The engine's event persistence path (persistDrainedEvents for protocol
 * batches, appendRedactedEvent for lifecycle writes) must redact every
 * payload string BEFORE the row reaches the `events` table. These tests read
 * the RAW stored rows back (the exact payload text in the database, not an
 * API view) and assert the secret value is gone and the placeholder is
 * present — the at-rest semantics the acceptance A36 requires.
 *
 * Consistency: the store computes its checksum over the exact stored
 * (already redacted) payload, so `verifyEventChecksums` stays green.
 */
import { describe, expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { NormalizedEvent } from "@role-orchestrator/contracts";
import {
  createActiveAttempt,
  getEvent,
  listEventsForExecution,
  verifyEventChecksums
} from "@role-orchestrator/store";
import { createSeededDb, seedFakeRun } from "./helpers.js";
import {
  appendRedactedEvent,
  persistDrainedEvents,
  redactEventPayload
} from "../src/index.js";

const T0 = "2026-09-22T00:00:00.000Z";

/** Seed just enough rows for the events FK (project -> run -> execution). */
async function seedExecutionRow(db: DatabaseSync, executionId: string): Promise<void> {
  await seedFakeRun(db, {});
  createActiveAttempt(db, {
    id: executionId,
    runId: "run-1",
    nodeId: "node-1",
    definitionRevision: "rev-1",
    attempt: 1,
    dispatchToken: `dt-${executionId}`,
    phase: "RUNNING",
    sessionId: null,
    now: T0
  });
}

function hostileDiagnostic(executionId: string, seq: number, eventId: string): NormalizedEvent {
  return {
    schemaVersion: 1,
    eventId,
    executionId,
    seq,
    type: "diagnostic",
    sourceType: "synthetic.diagnostic",
    occurredAt: T0,
    payload: {
      summary: "upstream said Authorization: Bearer livecred1234567890",
      detail: "config api-key=sk-proj-abcdef1234567890 leaked",
      negative: "mode=production and token=short stay untouched"
    }
  };
}

describe("A36: engine persists events already redacted (落盘前脱敏)", () => {
  test("persistDrainedEvents stores hostile payloads redacted in the raw rows", async () => {
    const { db, close } = createSeededDb("redact-batch");
    try {
      await seedExecutionRow(db, "exec-redact-batch");
      const batch = persistDrainedEvents(db, "claude", "exec-redact-batch", [
        hostileDiagnostic("exec-redact-batch", 1, "evt-redact-1")
      ]);
      expect(batch.stored).toBe(1);

      // RAW stored row — the exact payload text in the events table.
      const raw = getEvent(db, "evt-redact-1");
      expect(raw).not.toBeNull();
      expect(raw?.payload).not.toContain("livecred1234567890");
      expect(raw?.payload).not.toContain("sk-proj-abcdef1234567890");
      expect(raw?.payload).toContain("Bearer [REDACTED]");
      expect(raw?.payload).toContain("api-key=[REDACTED]");
      // Negative samples survive untouched; structure (keys) unchanged.
      expect(raw?.payload).toContain("token=short stay");
      expect(JSON.parse(raw?.payload ?? "{}")).toHaveProperty("summary");
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("appendRedactedEvent redacts lifecycle-style payloads before the write", async () => {
    const { db, close } = createSeededDb("redact-lifecycle");
    try {
      await seedExecutionRow(db, "exec-redact-lc");
      const result = appendRedactedEvent(db, {
        id: "evt-redact-lc-1",
        executionId: "exec-redact-lc",
        seq: 1_000_000_001,
        type: "lifecycle_outcome",
        payload: {
          cancelReason: "worker token=qqqwwwEEE111 leaked into kill evidence",
          stderr: "fatal: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig"
        },
        occurredAt: T0
      });
      expect(result).toBe("stored");

      const raw = getEvent(db, "evt-redact-lc-1");
      expect(raw).not.toBeNull();
      expect(raw?.payload).not.toContain("qqqwwwEEE111");
      expect(raw?.payload).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(raw?.payload).toContain("token=[REDACTED]");
      expect(raw?.payload).toContain("Bearer [REDACTED]");
      expect(verifyEventChecksums(db)).toEqual([]);
    } finally {
      close();
    }
  });

  test("redaction is idempotent and listEventsForExecution shows no raw secret", async () => {
    const { db, close } = createSeededDb("redact-idempotent");
    try {
      await seedExecutionRow(db, "exec-redact-idem");
      const once = redactEventPayload({ summary: "Authorization: Bearer abcdef123456" });
      const twice = redactEventPayload(once);
      expect(twice).toEqual(once);
      expect(JSON.stringify(twice)).not.toContain("abcdef123456");

      persistDrainedEvents(db, "claude", "exec-redact-idem", [
        hostileDiagnostic("exec-redact-idem", 1, "evt-redact-idem-1")
      ]);
      const rawPayloads = listEventsForExecution(db, "exec-redact-idem").map((event) => event.payload);
      expect(rawPayloads.join("\n")).not.toContain("livecred1234567890");
      expect(rawPayloads.join("\n")).toContain("[REDACTED]");
    } finally {
      close();
    }
  });
});
