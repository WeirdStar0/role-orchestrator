/**
 * Shared helpers for the M5-04 live-event WebSocket tests: a small
 * frame-queue client over the `ws` package plus helpers to await frames,
 * closes and the server-side backpressure observability handle.
 */
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { ServerFrame } from "../src/index.js";

export const LIVE_PATH = "/api/v1/events/live";

/** A tiny queue-based WS client for the live endpoint. */
export class LiveClient {
  readonly ws: WebSocket;
  private readonly queue: ServerFrame[] = [];
  private readonly waiters: Array<{
    readonly predicate: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
  }> = [];
  private readonly openPromise: Promise<void>;
  readonly received: ServerFrame[] = [];

  constructor(
    port: number,
    options: {
      readonly headers?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    } = {}
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${String(port)}${LIVE_PATH}`, {
      headers: { ...(options.headers ?? {}) },
      handshakeTimeout: options.timeoutMs ?? 5_000
    });
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (error: Error & { code?: string }) => reject(error));
    });
    this.ws.on("message", (data: unknown) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      this.received.push(frame);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (waiterIndex >= 0) {
        const waiter = this.waiters[waiterIndex];
        if (waiter !== undefined) {
          this.waiters.splice(waiterIndex, 1);
          waiter.resolve(frame);
        }
      } else {
        this.queue.push(frame);
      }
    });
  }

  async open(): Promise<void> {
    await this.openPromise;
  }

  /** Authenticate as the first message (first-message-auth path). */
  auth(token: string): void {
    this.send({ type: "auth", token });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  subscribe(executionId: string, cursor: { afterSeq?: number; afterEventId?: string } = {}): void {
    this.send({ type: "subscribe", executionId, ...cursor });
  }

  /** Await the NEXT frame matching the predicate (frames before it are kept). */
  waitFor(predicate: (frame: ServerFrame) => boolean, timeoutMs = 5_000): Promise<ServerFrame> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex >= 0) {
      const frame = this.queue[queuedIndex];
      this.queue.splice(queuedIndex, 1);
      return Promise.resolve(frame as ServerFrame);
    }
    return new Promise<ServerFrame>((resolve, reject) => {
      const entry: {
        readonly predicate: (frame: ServerFrame) => boolean;
        resolve: (frame: ServerFrame) => void;
      } = {
        predicate,
        resolve: (frame: ServerFrame) => {
          clearTimeout(timer);
          resolve(frame);
        }
      };
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(entry);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(new Error("timed out waiting for frame"));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  /** All currently queued frames (oldest first) without waiting. */
  drainQueue(): ServerFrame[] {
    const out = this.queue.splice(0, this.queue.length);
    return out;
  }

  /** Collect `count` event frames (waiting as needed). */
  async collectEventFrames(count: number, timeoutMs = 10_000): Promise<ServerFrame[]> {
    const collected: ServerFrame[] = [];
    while (collected.length < count) {
      const frame = await this.waitFor((candidate) => candidate.type === "event", timeoutMs);
      collected.push(frame);
    }
    return collected;
  }

  close(): void {
    this.ws.close();
  }

  terminate(): void {
    this.ws.terminate();
  }

  /** Resolves when the connection is closed; carries the close code. */
  onceClosed(): Promise<{ readonly code: number; readonly reason: string }> {
    return new Promise((resolve) => {
      this.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
      this.ws.once("error", (error: Error & { code?: string }) => {
        // A refused upgrade (non-101) surfaces as an error with the status.
        const status = (error as Error & { statusCode?: number }).statusCode;
        resolve({ code: status ?? 0, reason: error.message });
      });
    });
  }

  async waitUntilClosed(timeoutMs = 5_000): Promise<{ readonly code: number; readonly reason: string }> {
    const closed = this.onceClosed();
    const result = await Promise.race([
      closed,
      delay(timeoutMs).then(() => ({ code: -1, reason: "still open" }))
    ]);
    return result;
  }

  /** Pause the underlying TCP socket (a "stuck" reader for backpressure). */
  pauseSocket(): void {
    (this.ws as unknown as { _socket: { pause(): void } })._socket.pause();
  }

  resumeSocket(): void {
    (this.ws as unknown as { _socket: { resume(): void } })._socket.resume();
  }
}

/** Await until `predicate` holds, sampling every `intervalMs`. */
export async function waitForCondition(
  predicate: () => boolean,
  options: { readonly timeoutMs: number; readonly intervalMs?: number; readonly message: string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(options.intervalMs ?? 10);
  }
  throw new Error(`condition not met within ${String(options.timeoutMs)}ms: ${options.message}`);
}
