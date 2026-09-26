/**
 * Byte-level JSONL line reassembly with explicit, fail-closed limits.
 *
 * Input is fed as arbitrary byte chunks (a "chunk" here is whatever the OS
 * pipe delivered, with no line or code-point alignment). Lines are only
 * decoded once their terminating newline byte (0x0A) has been seen, so:
 * - lines split across many chunks are reassembled;
 * - multi-byte UTF-8 sequences split across chunks are safe, because 0x0A
 *   never occurs inside a multi-byte sequence and decoding happens per
 *   complete line;
 * - a trailing chunk without a newline is handed to the consumer flagged as
 *   `isFinalUnterminatedChunk` via `end()`, letting the caller distinguish a
 *   legitimately newline-less last line from mid-JSON truncation.
 *
 * Limit policy (fail-closed): once the per-line or total-size limit is
 * violated, the splitter records the violation and ignores all further input.
 * A parser that kept going could miss the real final result event and
 * misreport success; refusing to continue keeps every later outcome verdict
 * honest.
 */

export type ProtocolErrorKind =
  | "unparseable-json"
  | "unterminated-json"
  | "line-limit-exceeded"
  | "total-limit-exceeded";

export interface ProtocolError {
  readonly kind: ProtocolErrorKind;
  readonly message: string;
  readonly lineBytes?: number | undefined;
  readonly preview?: string | undefined;
}

export interface JsonlStreamLimits {
  /** Maximum bytes for a single protocol line (including its newline). */
  readonly maxLineBytes: number;
  /** Maximum total protocol bytes accepted per stream. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_STREAM_LIMITS: JsonlStreamLimits = {
  maxLineBytes: 1_048_576, // 1 MiB
  maxTotalBytes: 67_108_864 // 64 MiB
};

/** Consumer callback for each reassembled line. */
export type LineHandler = (
  line: string,
  lineBytes: number,
  isFinalUnterminatedChunk: boolean
) => void;

export class JsonlByteLineSplitter {
  private buffer: Buffer = Buffer.alloc(0);
  private consumedBytes = 0;
  private failure: ProtocolError | null = null;

  constructor(
    private readonly limits: JsonlStreamLimits,
    private readonly onLine: LineHandler,
    private readonly onError: (error: ProtocolError) => void
  ) {}

  /** True once a limit has been violated; all further feeds are ignored. */
  get failed(): boolean {
    return this.failure !== null;
  }

  get failureReason(): ProtocolError | null {
    return this.failure;
  }

  feed(chunk: Uint8Array | string): void {
    if (this.failure !== null) return;
    const incoming = toBuffer(chunk);
    if (incoming.length === 0) return;
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(incoming) : Buffer.concat([this.buffer, incoming]);

    let newlineIndex = this.buffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const bytesWithNewline = newlineIndex + 1;
      if (bytesWithNewline > this.limits.maxLineBytes) {
        this.fail({
          kind: "line-limit-exceeded",
          message: `protocol line exceeds maxLineBytes=${this.limits.maxLineBytes}`,
          lineBytes: bytesWithNewline
        });
        return;
      }
      const lineText = this.buffer.subarray(0, newlineIndex).toString("utf8");
      this.consumedBytes += bytesWithNewline;
      // Copy the remainder so the large parent buffer can be collected.
      this.buffer = Buffer.from(this.buffer.subarray(bytesWithNewline));
      this.onLine(lineText, bytesWithNewline, false);
      if (this.failure !== null) return;
      newlineIndex = this.buffer.indexOf(0x0a);
    }

    this.enforceRemainingLimits();
  }

  /**
   * Flushes the stream end. A non-empty remainder is delivered as a final
   * line flagged `isFinalUnterminatedChunk`; the consumer decides whether it
   * is acceptable (complete JSON) or a truncation (broken JSON).
   */
  end(): void {
    if (this.failure !== null) return;
    if (this.buffer.length === 0) return;
    if (this.buffer.length > this.limits.maxLineBytes) {
      this.fail({
        kind: "line-limit-exceeded",
        message: `trailing chunk exceeds maxLineBytes=${this.limits.maxLineBytes}`,
        lineBytes: this.buffer.length
      });
      return;
    }
    const lineText = this.buffer.toString("utf8");
    const lineBytes = this.buffer.length;
    this.consumedBytes += lineBytes;
    this.buffer = Buffer.alloc(0);
    this.onLine(lineText, lineBytes, true);
  }

  private enforceRemainingLimits(): void {
    if (this.buffer.length > this.limits.maxLineBytes) {
      this.fail({
        kind: "line-limit-exceeded",
        message: `unterminated line already exceeds maxLineBytes=${this.limits.maxLineBytes}`,
        lineBytes: this.buffer.length
      });
      return;
    }
    if (this.consumedBytes + this.buffer.length > this.limits.maxTotalBytes) {
      this.fail({
        kind: "total-limit-exceeded",
        message: `stream exceeds maxTotalBytes=${this.limits.maxTotalBytes}`,
        lineBytes: this.consumedBytes + this.buffer.length
      });
    }
  }

  private fail(error: ProtocolError): void {
    this.failure = error;
    this.buffer = Buffer.alloc(0);
    this.onError(error);
  }
}

/** @internal */
function toBuffer(chunk: Uint8Array | string): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
