/**
 * Shared helpers for cli-events tests: spawning the built fake-cli bins,
 * incremental line collection with generous polling waits (no fixed sleeps),
 * Windows-aware process-tree termination, and deterministic chunk splitters
 * for the parser tests.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export const testDir = path.dirname(fileURLToPath(import.meta.url));
export const fakeCliRoot = path.resolve(testDir, "..", "..", "fake-cli");
export const fakeCliFixturesDir = path.join(fakeCliRoot, "fixtures");
export const fakeCliDistDir = path.join(fakeCliRoot, "dist");

export type FakeDialect = "claude" | "codex";

export function fakeBinPath(dialect: FakeDialect): string {
  const bin = path.join(fakeCliDistDir, "bin", dialect === "claude" ? "fake-claude.js" : "fake-codex.js");
  if (!existsSync(bin)) {
    throw new Error(
      `fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root before testing.`
    );
  }
  return bin;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Collects decoded stdout lines incrementally as the child writes them. */
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

export interface FakeRun {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: LineCollector;
  readonly stderr: LineCollector;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function spawnFake(dialect: FakeDialect, args: readonly string[]): FakeRun {
  const child = spawn(process.execPath, [fakeBinPath(dialect), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32"
  });
  const stdout = new LineCollector();
  const stderr = new LineCollector();
  stdout.attach(child.stdout);
  stderr.attach(child.stderr);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout, stderr, exit };
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

/**
 * Kills the whole process tree. Windows: taskkill /T /F (the product's own
 * M0-05 mechanism). POSIX: SIGKILL the process group (the fake roots are
 * spawned detached, so children share the group).
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      taskkill.once("exit", () => resolve());
      taskkill.once("error", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Polls until the PID no longer exists (process.kill(pid, 0) raises ESRCH). */
export async function expectPidDead(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
    await sleep(100);
  }
  throw new Error(`pid ${pid} is still alive ${timeoutMs}ms after termination`);
}

/** Deterministic pseudo-random byte chunking for parser tests. */
export function splitBuffer(buffer: Buffer, seed: number, maxChunkLen = 13): Buffer[] {
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const len = 1 + (next() % maxChunkLen);
    chunks.push(buffer.subarray(offset, Math.min(offset + len, buffer.length)));
    offset += len;
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  return chunks;
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
