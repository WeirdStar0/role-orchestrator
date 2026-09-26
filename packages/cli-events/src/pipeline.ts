/**
 * EventStreamPipeline: combines byte-level JSONL reassembly, dialect
 * normalization, duplicate suppression, and a captured stderr side-channel
 * into one stream result.
 *
 * Defined behaviors (docs/CLI_ADAPTERS.md, "事件规范"):
 * - chunked lines and multi-byte UTF-8 across chunks reassemble correctly;
 * - empty / whitespace-only lines are skipped and counted;
 * - lines beyond maxLineBytes or a stream beyond maxTotalBytes fail the
 *   stream closed (protocol error, later input ignored);
 * - stderr is captured (capped) but never parsed as protocol events;
 * - a trailing incomplete JSON line is a protocol error ("unterminated-json")
 *   while a trailing complete JSON object without a newline is accepted;
 * - duplicate lines (identical content) are skipped after the first;
 * - lines that parse but carry no recognizable event type become diagnostic
 *   events; they can never satisfy the final-result requirement.
 */
import { createHash } from "node:crypto";
import type { JsonValue, NormalizedEvent } from "@role-orchestrator/contracts";
import {
  DEFAULT_STREAM_LIMITS,
  JsonlByteLineSplitter,
  type JsonlStreamLimits,
  type ProtocolError
} from "./jsonl.js";
import { buildNormalizedEvents, type Dialect, type PartialEvent } from "./normalizer.js";

/** Cap for captured stderr text; stderr is diagnostic, never protocol. */
const MAX_STDERR_CHARS = 65_536;

export interface PipelineStats {
  /** Protocol bytes consumed from stdout (including line newlines). */
  stdoutBytes: number;
  /** Non-empty protocol lines seen (before dedup and parse). */
  linesSeen: number;
  emptyLinesSkipped: number;
  duplicatesSkipped: number;
  eventsEmitted: number;
  stderrBytes: number;
}

export interface StreamResult {
  readonly events: readonly NormalizedEvent[];
  readonly protocolErrors: readonly ProtocolError[];
  readonly stats: PipelineStats;
  readonly stderrText: string;
  readonly stderrTruncated: boolean;
}

export interface EventStreamPipelineOptions {
  readonly dialect: Dialect;
  readonly executionId: string;
  /** Injectable clock for deterministic tests; defaults to wall time. */
  readonly now?: (() => string) | undefined;
  readonly limits?: Partial<JsonlStreamLimits> | undefined;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function toBuffer(chunk: Uint8Array | string): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export class EventStreamPipeline {
  private readonly limits: JsonlStreamLimits;
  private readonly splitter: JsonlByteLineSplitter;
  private readonly events: NormalizedEvent[] = [];
  private readonly protocolErrors: ProtocolError[] = [];
  private readonly seenLineHashes = new Set<string>();
  private readonly stderrParts: string[] = [];
  private readonly options: EventStreamPipelineOptions;
  private stats: PipelineStats = {
    stdoutBytes: 0,
    linesSeen: 0,
    emptyLinesSkipped: 0,
    duplicatesSkipped: 0,
    eventsEmitted: 0,
    stderrBytes: 0
  };
  private stderrChars = 0;
  private stderrTruncated = false;
  private seq = 0;
  private firstLineSeen = false;
  private ended = false;
  private drainedUpTo = 0;
  private snapshot: StreamResult | null = null;

  constructor(options: EventStreamPipelineOptions) {
    this.options = options;
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...(options.limits ?? {}) };
    this.splitter = new JsonlByteLineSplitter(this.limits, this.handleLine, (error) => {
      this.protocolErrors.push(error);
    });
  }

  /** Feeds raw stdout bytes (any chunking). */
  feedStdout(chunk: Uint8Array | string): void {
    this.splitter.feed(toBuffer(chunk));
  }

  /**
   * Feeds raw stderr bytes. Mixed stderr output is captured for diagnostics
   * and never parsed into protocol events, so noisy stderr cannot corrupt or
   * fake the event stream.
   */
  feedStderr(chunk: Uint8Array | string): void {
    const buffer = toBuffer(chunk);
    this.stats.stderrBytes += buffer.length;
    if (this.stderrTruncated) return;
    const text = buffer.toString("utf8");
    const remaining = MAX_STDERR_CHARS - this.stderrChars;
    if (text.length > remaining) {
      this.stderrParts.push(text.slice(0, Math.max(0, remaining)));
      this.stderrChars = MAX_STDERR_CHARS;
      this.stderrTruncated = true;
      return;
    }
    this.stderrParts.push(text);
    this.stderrChars += text.length;
  }

  /**
   * Appends a process_exited event for the owning execution. Adapters call
   * this once the process wait completes, before finalize().
   */
  emitProcessExited(info: { exitCode: number | null; signal?: string | null }): NormalizedEvent {
    const payload: Record<string, JsonValue> = {
      exitCode: info.exitCode,
      signal: info.signal ?? null
    };
    const event = this.envelope(
      { type: "process_exited", sourceType: "process_exit", payload },
      createHash("sha256").update(`process-exited:${String(info.exitCode)}:${String(this.seq)}`).digest("hex"),
      0
    );
    this.events.push(event);
    this.stats.eventsEmitted += 1;
    this.snapshot = null;
    return event;
  }

  /**
   * Flushes the stream end and returns the frozen stream result. Safe to
   * call multiple times; later feeds after finalize are ignored by the
   * splitter, and the returned arrays are copies.
   */
  finalize(): StreamResult {
    if (!this.ended) {
      this.ended = true;
      this.splitter.end();
    }
    if (this.snapshot === null) {
      this.snapshot = {
        events: [...this.events],
        protocolErrors: [...this.protocolErrors],
        stats: { ...this.stats },
        stderrText: this.stderrParts.join(""),
        stderrTruncated: this.stderrTruncated
      };
    }
    return this.snapshot;
  }

  /**
   * Incremental consumer hook: returns the normalized events emitted since
   * the previous `drainNewEvents()` call (or construction) as a copy. Unlike
   * `finalize()` this does NOT end the stream — later feeds keep working — so
   * a persistence layer can append events to durable storage while the child
   * process is still running and still call `finalize()` at stream end for
   * the complete frozen result. `finalize()` continues to return ALL events
   * regardless of what has been drained.
   */
  drainNewEvents(): readonly NormalizedEvent[] {
    const out = this.events.slice(this.drainedUpTo);
    this.drainedUpTo = this.events.length;
    return out;
  }

  private readonly handleLine = (text: string, lineBytes: number, isFinalChunk: boolean): void => {
    this.stats.stdoutBytes += lineBytes;
    let line = text;
    if (!this.firstLineSeen) {
      this.firstLineSeen = true;
      if (line.startsWith("﻿" /* BOM */)) {
        line = line.slice(1);
      }
    }
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.trim() === "") {
      this.stats.emptyLinesSkipped += 1;
      return;
    }
    this.stats.linesSeen += 1;

    const hash = createHash("sha256").update(line, "utf8").digest("hex");
    if (this.seenLineHashes.has(hash)) {
      this.stats.duplicatesSkipped += 1;
      return;
    }
    this.seenLineHashes.add(hash);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.protocolErrors.push({
        kind: isFinalChunk ? "unterminated-json" : "unparseable-json",
        message: isFinalChunk
          ? "stream ended with an incomplete JSON line (truncated output)"
          : "protocol line is not valid JSON",
        preview: line.slice(0, 200),
        lineBytes
      });
      return;
    }

    const partials = buildNormalizedEvents(this.options.dialect, parsed);
    for (let subIndex = 0; subIndex < partials.length; subIndex += 1) {
      const partial = partials[subIndex];
      if (partial === undefined) continue;
      this.events.push(this.envelope(partial, hash, subIndex));
      this.stats.eventsEmitted += 1;
    }
  };

  private envelope(partial: PartialEvent, hash: string, subIndex: number): NormalizedEvent {
    this.seq += 1;
    // The event id is scoped to the EXECUTION plus the line content: replaying
    // one execution's stream stays idempotent (same id on every replay), while
    // two DIFFERENT executions that happen to emit byte-identical synthetic or
    // real lines still get distinct rows — otherwise the store's
    // replay-idempotent insert (ON CONFLICT(id) DO NOTHING) would silently
    // attribute the second execution's protocol log to the first, breaking
    // per-node traceability (found by the M2-06 end-to-end baseline).
    const scoped = createHash("sha256")
      .update(`${this.options.executionId}\u0000${hash}`, "utf8")
      .digest("hex");
    return {
      schemaVersion: 1,
      eventId: `evt_${scoped.slice(0, 32)}_${subIndex}`,
      executionId: this.options.executionId,
      seq: this.seq,
      type: partial.type,
      sourceType: partial.sourceType,
      occurredAt: (this.options.now ?? defaultNow)(),
      payload: partial.payload
    };
  }
}
