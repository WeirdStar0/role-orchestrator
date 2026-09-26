/**
 * M5-04 — the live execution-event subscription over WebSocket (A39:
 * "WebSocket 掉线和重复事件 → cursor 重放并按 eventId 去重"), replacing the
 * previously documented "later milestone" gap. Design, in order:
 *
 * UPGRADE GUARDS — an upgrade request passes the SAME guard pipeline as every
 * HTTP request BEFORE any socket is accepted (A30 continuity): loopback peer,
 * exact-loopback Host (DNS-rebinding-safe), Origin allowlist (read-level: a
 * missing Origin is fine, a cross-site one is refused with a raw 403 on the
 * upgrading socket), and — optionally — `Authorization: Bearer <token>`.
 *
 * FIRST-MESSAGE AUTH — browsers cannot set headers on a WebSocket, and this
 * server never accepts tokens in URLs (they leak into logs), so a client that
 * did not present a Bearer header at upgrade must send
 * `{"type":"auth","token":"..."}` as its FIRST frame within `authTimeoutMs`.
 * Wrong/absent auth closes 4002; a timeout closes 4001. Token comparison is
 * constant-time; tokens are never logged.
 *
 * CURSOR REPLAY — `{"type":"subscribe","executionId","afterSeq"?|` +
 * `"afterEventId"?}` starts the stream at the cursor: events with
 * `seq > afterSeq` (an `afterEventId` is resolved to its stored seq, a wrong
 * execution or unknown id closes 4004). Delivery is AT LEAST ONCE by design
 * (docs/API_AND_EVENTS.md: "重放允许至少一次投递，客户端按 eventId 去重"):
 * every frame carries the store's eventId (the sha256(executionId + line
 * content) derivation from cli-events, idempotent across replays), so a
 * client deduplicates on reconnect and never loses an event — INCLUDING the
 * terminal ones (result/process exit/lifecycle rows are durable; the engine
 * commits `lifecycle_outcome` in the same transaction that sets the terminal
 * phase, so a terminal phase never hides undelivered events).
 *
 * BACKPRESSURE — replay pages through the store with
 * `listEventPageForExecution` (row-count AND byte-budget capped), and the
 * pump only fetches the next page once `ws.bufferedAmount` has drained below
 * `highWaterBytes`. A 64 MiB-scale event log therefore streams through a
 * bounded buffer (page ≤ 256 KiB, ≤ 1 MiB in flight per connection) instead
 * of materializing in daemon memory, and a slow or paused reader slows the
 * pump instead of growing the queue without bound.
 *
 * TERMINAL NOTICE — when the stream is caught up AND the execution phase is
 * no longer active (SUCCEEDED/FAILED/INTERRUPTED/CANCELLED), one
 * `{"type":"execution-terminal","phase":...}` frame is sent. Polling continues
 * until the socket closes (a poll is one cursor-bounded query), so late
 * events can never be silently dropped either way.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { redactText } from "@role-orchestrator/cli-events";
import {
  ACTIVE_ATTEMPT_PHASES,
  getEvent,
  getExecution,
  getTaskRun,
  listEventPageForExecution
} from "@role-orchestrator/store";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { Socket as NetSocket } from "node:net";
import { LocalApiConfigurationError } from "./errors.js";
import { constantTimeEquals } from "./token.js";
import {
  checkHostHeader,
  checkOriginHeader,
  isLoopbackRemoteAddress
} from "./guard.js";
import { buildEventEnvelopeView } from "./views.js";

/** Server → client frame vocabulary. Frames are JSON text frames. */
export type ServerFrame =
  | { readonly type: "ready"; readonly executionId: string; readonly cursor: number; readonly phase: string }
  | { readonly type: "event"; readonly event: ReturnType<typeof buildEventEnvelopeView> }
  | { readonly type: "catchup"; readonly cursor: number }
  | { readonly type: "execution-terminal"; readonly phase: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

const AuthMessageSchema = z.strictObject({
  type: z.literal("auth"),
  token: z.string().min(1).max(256)
});

const SubscribeMessageSchema = z.strictObject({
  type: z.literal("subscribe"),
  executionId: z.string().min(1).max(128),
  afterSeq: z.number().int().min(0).optional(),
  afterEventId: z.string().min(1).max(256).optional()
});

const AnyMessageSchema = z.discriminatedUnion("type", [
  AuthMessageSchema,
  SubscribeMessageSchema
]);

const EventStreamOptionsSchema = z.strictObject({
  /** Delay between catch-up polls for new events. */
  pollIntervalMs: z.number().int().min(1).max(60_000).default(250),
  /** How long a connection may wait for its first auth frame. */
  authTimeoutMs: z.number().int().min(1).max(60_000).default(5_000),
  /** Keepalive ping period; 0 disables ping/pong. */
  pingIntervalMs: z.number().int().min(0).max(600_000).default(30_000),
  /** Replay page: row-count cap (mirrors the REST event page cap). */
  pageLimitEvents: z.number().int().min(1).max(1000).default(200),
  /** Replay page: payload-byte cap — the daemon memory bound per page. */
  pageByteBudget: z.number().int().min(1).max(16 * 1024 * 1024).default(262_144),
  /** Pump waits while `ws.bufferedAmount` is at or above this many bytes. */
  highWaterBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(1_048_576),
  /** Upper bound on concurrent live subscriptions. */
  maxConnections: z.number().int().min(1).max(1024).default(64),
  /** Inbound frame cap (subscribe/auth frames are tiny). */
  maxPayloadBytes: z.number().int().min(1024).max(1024 * 1024).default(65_536)
});

export interface EventStreamOptions extends z.input<typeof EventStreamOptionsSchema> {}

interface ResolvedEventStreamOptions extends z.output<typeof EventStreamOptionsSchema> {}

const LIVE_PATH_REGEX = /^\/api\/v1\/events\/live$/;

/** WS close codes (4000-4999 application range). */
const CLOSE_AUTH_TIMEOUT = 4001;
const CLOSE_AUTH_REJECTED = 4002;
const CLOSE_PROTOCOL = 4003;
const CLOSE_NOT_FOUND = 4004;

type ConnectionState = "await-auth" | "await-subscribe" | "streaming";

interface Connection {
  readonly id: string;
  readonly ws: WebSocket;
  state: ConnectionState;
  closed: boolean;
  executionId: string | null;
  projectId: string | null;
  runId: string | null;
  cursorSeq: number;
  terminalNotified: boolean;
  pumpActive: boolean;
  authTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  pongAlive: boolean;
  missedPongs: number;
}

/** Runtime values the upgrade guard needs (the same binding the HTTP path uses). */
export interface EventStreamRuntime {
  readonly port: number;
  readonly token: string;
}

export interface EventStreamHandle {
  /** Number of currently open live subscriptions. */
  connectionCount(): number;
  /** Per-connection outbound queue depth in bytes (backpressure observability). */
  connectionBufferedBytes(): readonly number[];
  /** Close every connection and stop accepting upgrades. */
  close(): Promise<void>;
}

function logLine(text: string): void {
  process.stdout.write(`${redactText(text).text}\n`);
}

function frameText(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

function sendFrame(connection: Connection, frame: ServerFrame): void {
  if (connection.closed || connection.ws.readyState !== WebSocket.OPEN) return;
  connection.ws.send(frameText(frame));
}

function sendErrorAndClose(connection: Connection, code: string, message: string, closeCode: number): void {
  sendFrame(connection, { type: "error", code, message });
  if (!connection.closed && connection.ws.readyState === WebSocket.OPEN) {
    connection.ws.close(closeCode, code);
  }
}

/** Raw HTTP refusal written onto an upgrading socket that failed the guards. */
function refuseUpgrade(socket: Duplex, statusCode: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  const reason = statusCode === 400 ? "Bad Request" : statusCode === 403 ? "Forbidden" : statusCode === 404 ? "Not Found" : "Service Unavailable";
  socket.write(
    `HTTP/1.1 ${String(statusCode)} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "X-Content-Type-Options: nosniff\r\n" +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${String(Buffer.byteLength(body, "utf8"))}\r\n` +
      "\r\n" +
      body
  );
  socket.destroy();
}

function rawDataToText(data: unknown): string | null {
  let buffer: Buffer | null = null;
  if (Buffer.isBuffer(data)) buffer = data;
  else if (Array.isArray(data)) buffer = Buffer.concat(data);
  else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  if (buffer === null) return null;
  return buffer.toString("utf8");
}

/**
 * Attach the live-event WebSocket endpoint (`/api/v1/events/live`, per the
 * `WS /events/live` row of docs/API_AND_EVENTS.md) to an ALREADY-LISTENING
 * loopback HTTP server. Returns an observability + lifecycle handle.
 */
export function attachEventStreamServer(
  httpServer: HttpServer,
  db: DatabaseSync,
  runtime: EventStreamRuntime,
  rawOptions: EventStreamOptions = {}
): EventStreamHandle {
  let options: ResolvedEventStreamOptions;
  try {
    options = EventStreamOptionsSchema.parse(rawOptions);
  } catch (error) {
    throw new LocalApiConfigurationError("invalid event-stream options", { cause: error });
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes,
    // No per-message compression: it is a memory-amplification surface with
    // no benefit on loopback.
    perMessageDeflate: false
  });
  const connections = new Set<Connection>();

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // ---- guard pipeline (mirrors handleRequest; upgrade is a read) ---------
    // The upgrading socket is the raw TCP socket (net.Socket at runtime).
    if (!isLoopbackRemoteAddress((socket as NetSocket).remoteAddress)) {
      refuseUpgrade(socket, 403, "REMOTE_NOT_LOOPBACK", "this API only serves loopback connections");
      return;
    }
    if (req.url === undefined) {
      refuseUpgrade(socket, 400, "URL_MALFORMED", "the request URL could not be parsed");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url, `http://127.0.0.1:${String(runtime.port)}`);
    } catch {
      refuseUpgrade(socket, 400, "URL_MALFORMED", "the request URL could not be parsed");
      return;
    }
    if (!LIVE_PATH_REGEX.test(url.pathname)) {
      refuseUpgrade(socket, 404, "NOT_FOUND", "unknown websocket path");
      return;
    }
    if ([...url.searchParams.keys()].length > 0) {
      // Query strings are refused outright: this server never accepts tokens
      // (or anything else) in URLs.
      refuseUpgrade(socket, 400, "INPUT_REJECTED", "query parameters are not accepted on the live endpoint");
      return;
    }
    const hostDecision = checkHostHeader(req.headers["host"], runtime.port);
    if (!hostDecision.ok) {
      refuseUpgrade(socket, hostDecision.statusCode, hostDecision.code, hostDecision.reason);
      return;
    }
    const originHeader = req.headers["origin"];
    const originDecision = checkOriginHeader(
      typeof originHeader === "string" ? originHeader : undefined,
      runtime.port,
      false
    );
    if (!originDecision.ok) {
      refuseUpgrade(socket, originDecision.statusCode, originDecision.code, originDecision.reason);
      return;
    }
    // Bearer at upgrade is OPTIONAL (browsers cannot send it) but a WRONG
    // bearer is refused immediately instead of after the handshake.
    let preAuthenticated = false;
    const authHeader = req.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.trim() !== "") {
      const match = /^Bearer\s+(.+)$/.exec(authHeader.trim());
      if (match === null || match[1] === undefined || !constantTimeEquals(match[1], runtime.token)) {
        refuseUpgrade(socket, 403, "TOKEN_INVALID", "the presented session token is not valid for this server");
        return;
      }
      preAuthenticated = true;
    }
    if (connections.size >= options.maxConnections) {
      refuseUpgrade(socket, 503, "TOO_MANY_CONNECTIONS", "too many live subscriptions");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      registerConnection(ws, preAuthenticated);
    });
  };

  const registerConnection = (ws: WebSocket, preAuthenticated: boolean): void => {
    const connection: Connection = {
      id: randomUUID(),
      ws,
      state: preAuthenticated ? "await-subscribe" : "await-auth",
      closed: false,
      executionId: null,
      projectId: null,
      runId: null,
      cursorSeq: 0,
      terminalNotified: false,
      pumpActive: false,
      authTimer: null,
      pollTimer: null,
      pingTimer: null,
      pongAlive: true,
      missedPongs: 0
    };
    connections.add(connection);
    logLine(`ws-live ${connection.id} -> accepted (${preAuthenticated ? "bearer" : "first-message-auth"})`);

    if (!preAuthenticated) {
      connection.authTimer = setTimeout(() => {
        if (!connection.closed && connection.state === "await-auth") {
          sendErrorAndClose(
            connection,
            "AUTH_TIMEOUT",
            "no auth frame arrived; the first frame must be {\"type\":\"auth\",\"token\":\"...\"}",
            CLOSE_AUTH_TIMEOUT
          );
        }
      }, options.authTimeoutMs);
    }

    if (options.pingIntervalMs > 0) {
      connection.pingTimer = setInterval(() => {
        if (connection.closed) return;
        if (!connection.pongAlive) {
          connection.missedPongs += 1;
        } else {
          connection.missedPongs = 0;
        }
        if (connection.missedPongs >= 2) {
          connection.ws.terminate();
          return;
        }
        connection.pongAlive = false;
        ws.ping();
      }, options.pingIntervalMs);
    }

    ws.on("message", (data: unknown) => {
      handleClientFrame(connection, data);
    });
    ws.on("pong", () => {
      connection.pongAlive = true;
    });
    ws.on("error", () => {
      teardown(connection);
    });
    ws.on("close", () => {
      teardown(connection);
    });
  };

  const teardown = (connection: Connection): void => {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.authTimer !== null) clearTimeout(connection.authTimer);
    if (connection.pollTimer !== null) clearInterval(connection.pollTimer);
    if (connection.pingTimer !== null) clearInterval(connection.pingTimer);
    connections.delete(connection);
    logLine(`ws-live ${connection.id} -> closed`);
  };

  const handleClientFrame = (connection: Connection, data: unknown): void => {
    if (connection.closed) return;
    const text = rawDataToText(data);
    if (text === null || text.length > options.maxPayloadBytes) {
      sendErrorAndClose(connection, "PROTOCOL_ERROR", "frames must be small JSON text", CLOSE_PROTOCOL);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      sendErrorAndClose(connection, "PROTOCOL_ERROR", "frames must be valid JSON", CLOSE_PROTOCOL);
      return;
    }
    const shape = AnyMessageSchema.safeParse(parsed);
    if (!shape.success) {
      sendErrorAndClose(
        connection,
        "PROTOCOL_ERROR",
        `unknown frame; expected ${connection.state === "await-auth" ? '{"type":"auth",...}' : '{"type":"subscribe",...}'}`,
        CLOSE_PROTOCOL
      );
      return;
    }
    if (shape.data.type === "auth") {
      if (connection.state !== "await-auth") {
        sendErrorAndClose(connection, "PROTOCOL_ERROR", "auth already completed", CLOSE_PROTOCOL);
        return;
      }
      if (!constantTimeEquals(shape.data.token, runtime.token)) {
        sendErrorAndClose(connection, "AUTH_REJECTED", "the presented session token is not valid for this server", CLOSE_AUTH_REJECTED);
        return;
      }
      if (connection.authTimer !== null) clearTimeout(connection.authTimer);
      connection.authTimer = null;
      connection.state = "await-subscribe";
      return;
    }
    // subscribe frame
    if (connection.state !== "await-subscribe") {
      sendErrorAndClose(
        connection,
        "PROTOCOL_ERROR",
        connection.state === "await-auth"
          ? "authenticate first"
          : "this connection already has a subscription; reconnect for another",
        CLOSE_PROTOCOL
      );
      return;
    }
    startStream(connection, shape.data);
  };

  const startStream = (
    connection: Connection,
    subscribe: z.output<typeof SubscribeMessageSchema>
  ): void => {
    const execution = getExecution(db, subscribe.executionId);
    if (execution === null) {
      sendErrorAndClose(connection, "NOT_FOUND", `no such execution "${subscribe.executionId}"`, CLOSE_NOT_FOUND);
      return;
    }
    const run = getTaskRun(db, execution.runId);
    connection.projectId = run?.projectId ?? null;
    connection.runId = execution.runId;
    connection.executionId = execution.id;

    // Cursor resolution: afterEventId wins when present (it pins the exact
    // event the client last saw); afterSeq is the numeric form; default 0.
    if (subscribe.afterEventId !== undefined) {
      const cursorEvent = getEvent(db, subscribe.afterEventId);
      if (cursorEvent === null || cursorEvent.executionId !== execution.id) {
        sendErrorAndClose(
          connection,
          "CURSOR_NOT_FOUND",
          `afterEventId "${subscribe.afterEventId}" is not an event of execution "${execution.id}"`,
          CLOSE_NOT_FOUND
        );
        return;
      }
      connection.cursorSeq = cursorEvent.seq;
    } else if (subscribe.afterSeq !== undefined) {
      connection.cursorSeq = subscribe.afterSeq;
    } else {
      connection.cursorSeq = 0;
    }

    connection.state = "streaming";
    sendFrame(connection, {
      type: "ready",
      executionId: execution.id,
      cursor: connection.cursorSeq,
      phase: execution.phase
    });
    logLine(`ws-live ${connection.id} -> subscribe ${execution.id} from seq ${String(connection.cursorSeq)}`);

    connection.pollTimer = setInterval(() => {
      if (!connection.pumpActive && !connection.closed) void pump(connection);
    }, options.pollIntervalMs);
    void pump(connection);
  };

  /**
   * Drain the store into the socket page by page, respecting the outbound
   * high-water mark. Overlapping invocations are collapsed by `pumpActive`.
   */
  const pump = async (connection: Connection): Promise<void> => {
    if (connection.pumpActive || connection.closed || connection.executionId === null) return;
    connection.pumpActive = true;
    try {
      for (;;) {
        if (connection.closed) return;
        if (connection.ws.bufferedAmount >= options.highWaterBytes) {
          await waitForDrain(connection);
          continue;
        }
        const page = listEventPageForExecution(db, {
          executionId: connection.executionId,
          afterSeq: connection.cursorSeq,
          limit: options.pageLimitEvents,
          byteBudget: options.pageByteBudget
        });
        for (const event of page.events) {
          // A36 egress pass — the same redaction the REST events route uses.
          const envelope = buildEventEnvelopeView({
            projectId: connection.projectId,
            runId: connection.runId ?? "",
            executionId: connection.executionId,
            event
          });
          sendFrame(connection, { type: "event", event: envelope });
          connection.cursorSeq = event.seq;
        }
        if (page.events.length === 0 || !page.hasMore) {
          sendFrame(connection, { type: "catchup", cursor: connection.cursorSeq });
          maybeTerminalNotice(connection);
          return;
        }
      }
    } catch (error) {
      // Malformed durable state (LocalApiStateError from the projection) or a
      // store fault: fail closed instead of streaming a degraded page.
      const message = error instanceof Error ? error.message : String(error);
      sendErrorAndClose(connection, "STATE_FAULT", redactText(message).text, 1011);
      teardown(connection);
    } finally {
      connection.pumpActive = false;
    }
  };

  const waitForDrain = (connection: Connection): Promise<void> =>
    new Promise((resolve) => {
      const timer = setInterval(() => {
        if (connection.closed || connection.ws.bufferedAmount < options.highWaterBytes) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });

  const maybeTerminalNotice = (connection: Connection): void => {
    if (connection.terminalNotified || connection.closed || connection.executionId === null) return;
    const execution = getExecution(db, connection.executionId);
    if (execution === null) return;
    const active = (ACTIVE_ATTEMPT_PHASES as readonly string[]).includes(execution.phase);
    if (active) return;
    connection.terminalNotified = true;
    sendFrame(connection, { type: "execution-terminal", phase: execution.phase });
    logLine(`ws-live ${connection.id} -> terminal ${execution.phase}`);
  };

  httpServer.on("upgrade", handleUpgrade);

  return {
    connectionCount: () => connections.size,
    connectionBufferedBytes: () => [...connections].map((connection) => connection.ws.bufferedAmount),
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.off("upgrade", handleUpgrade);
        for (const connection of connections) {
          if (connection.authTimer !== null) clearTimeout(connection.authTimer);
          if (connection.pollTimer !== null) clearInterval(connection.pollTimer);
          if (connection.pingTimer !== null) clearInterval(connection.pingTimer);
          connection.closed = true;
          if (connection.ws.readyState === WebSocket.OPEN) {
            connection.ws.close(1001, "server shutting down");
          } else {
            connection.ws.terminate();
          }
        }
        wss.close(() => resolve());
      })
  };
}
