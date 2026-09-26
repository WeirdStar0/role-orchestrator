/**
 * Incremental line collection and polling waits for spawned processes.
 * Same ideas as the cli-events test helpers, reimplemented locally so this
 * package does not reach into another package's test directory.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Collects decoded stdout/stderr lines incrementally as the child writes them. */
export class LineCollector {
  readonly lines: string[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private remainder = "";

  attach(stream: NodeJS.ReadableStream): void {
    stream.on("data", (chunk: Buffer) => {
      this.remainder += this.decoder.write(chunk);
      let index = this.remainder.indexOf("\n");
      while (index >= 0) {
        const line = this.remainder.slice(0, index);
        this.remainder = this.remainder.slice(index + 1);
        if (line.trim() !== "") this.lines.push(line);
        index = this.remainder.indexOf("\n");
      }
    });
  }

  /** Flushes any tail that was not newline-terminated. */
  finish(): void {
    const tail = this.remainder + this.decoder.end();
    if (tail.trim() !== "") this.lines.push(tail);
    this.remainder = "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Polls until a collected line matches; fails with diagnostics on timeout. */
export async function waitForLine(
  collector: LineCollector,
  predicate: (line: string) => boolean,
  timeoutMs: number,
  label: string
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of collector.lines) {
      if (predicate(line)) return line;
    }
    await sleep(25);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}; saw ${collector.lines.length} lines, last: ` +
      (collector.lines[collector.lines.length - 1] ?? "(none)").slice(0, 200)
  );
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Standard wait for a spawned child's exit event. */
export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export function exitPromise(child: ChildProcessWithoutNullStreams): Promise<ExitInfo> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/** Depth-first search for a key anywhere inside parsed JSON. */
export function findJsonValue(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record[key] !== undefined) return record[key];
    for (const item of Object.values(record)) {
      const found = findJsonValue(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
