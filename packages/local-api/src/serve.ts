/**
 * M8-03a: the standalone-process entry for this package (bin:
 * role-orchestrator-local-api-serve).
 *
 * The desktop shell (M8-03a, Tauri host) starts the local API as a CHILD
 * PROCESS; this module is that process boundary. Constraints that shape it
 * (ADR reports/M8-03-desktop-shell-adr.md + repo hard rules):
 *
 * - The one JSON diagnostic line on stdout is a HINT for the parent process
 *   (bound port + token file location), NEVER a success verdict. Whether the
 *   API is in position is decided exclusively by an HTTP probe receiving a
 *   response (guard pipeline included). The token file PATH is not a secret
 *   (the file itself is current-user-only with 0o600 semantics — token.ts);
 *   the token VALUE never passes through here, and the shell never handles
 *   the token at all.
 * - Every CLI input is validated zod-strict: unknown flags, duplicate flags,
 *   missing or malformed values are refused with a usage line, not guessed.
 * - The store file may be created/initialized by openDatabase, but its
 *   parent directory must already exist — serve never mkdir -p implicitly.
 *   serve is ALSO the product database's first schema initialization point:
 *   after openDatabase it applies the controlled-expansion migration chain
 *   (see the call site below), so an empty db reaches the current schema
 *   before any HTTP route can read a missing table.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { applyControlledExpansionMigrations } from "@role-orchestrator/expand";
import { openDatabase } from "@role-orchestrator/store";
import { LocalApiConfigurationError, LocalApiError } from "./errors.js";
import { startLocalApiServer, type LocalApiServer } from "./server.js";

/** One-line usage appended to every argument error message. */
const USAGE =
  "usage: role-orchestrator-local-api-serve --db <path> [--port <0..65535>]  (port 0 = ephemeral)";

/** Malformed serve CLI input; the message always carries the usage line. */
export class ServeArgsError extends LocalApiError {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = "ServeArgsError";
  }
}

/**
 * Strict serve-argument contract: exactly the two flags, nothing else.
 * `port` defaults to 0 (ephemeral) so a second instance never fights the
 * first over a fixed port.
 */
export const ServeArgsSchema = z.strictObject({
  /** Store file to open/initialize; its parent directory must already exist. */
  db: z.string().min(1),
  /** TCP port; 0 (the default) binds an ephemeral port. */
  port: z.number().int().min(0).max(65535).default(0)
});

export type ServeArgs = z.infer<typeof ServeArgsSchema>;

const PORT_PATTERN = /^\d+$/;

/**
 * Parse `--db <path>` / `--port <N>` argv pairs. Unknown flags, duplicate
 * flags, a flag with no value (a following `--flag` token is a MISSING
 * value, never an implicit consume) and non-integer or out-of-range ports
 * all throw `ServeArgsError` with a usage line.
 */
export function parseServeArgs(argv: readonly string[]): ServeArgs {
  const collected: { db?: string; port?: number } = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag !== "--db" && flag !== "--port") {
      throw new ServeArgsError(
        `unknown argument ${JSON.stringify(flag ?? "")}; only --db <path> and --port <N> are accepted`
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ServeArgsError(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--db") {
      if (collected.db !== undefined) {
        throw new ServeArgsError("--db was given more than once; exactly one database path is accepted");
      }
      collected.db = value;
    } else {
      if (collected.port !== undefined) {
        throw new ServeArgsError("--port was given more than once; exactly one port is accepted");
      }
      if (!PORT_PATTERN.test(value)) {
        throw new ServeArgsError(`--port expects an integer 0..65535, got ${JSON.stringify(value)}`);
      }
      collected.port = Number(value);
    }
  }
  // The schema is the fail-closed second layer behind the walker above.
  const parsed = ServeArgsSchema.safeParse(collected);
  if (!parsed.success) {
    throw new ServeArgsError(
      `invalid serve arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  return parsed.data;
}

export interface ServeOptions {
  /** Store file path; its parent directory must already exist. */
  readonly db: string;
  /** TCP port; omitted or 0 binds an ephemeral port. */
  readonly port?: number | undefined;
}

export interface ServeHandle {
  readonly server: LocalApiServer;
  readonly db: DatabaseSync;
  /** Idempotent and single-flight: closes the HTTP/event-stream server, then
   * the store; repeat callers await the SAME in-flight promise (never a
   * short-circuited fake completion while the first close is still running). */
  readonly shutdown: () => Promise<void>;
}

/**
 * Open/initialize the store, start the loopback-only API server and emit the
 * one-line listening diagnostic (see module doc: a hint, not a verdict).
 * Returns a handle with an idempotent `shutdown`; SIGINT/SIGTERM are wired
 * to it for the standalone-process case.
 */
export async function runServe(options: ServeOptions): Promise<ServeHandle> {
  // openDatabase may CREATE the database file itself (open/initialize), but
  // the directory it lands in must already exist — a typo'd path must fail
  // loudly, not silently relocate into a freshly created directory tree.
  const parentDir = dirname(options.db);
  let parentIsDirectory = false;
  try {
    parentIsDirectory = statSync(parentDir).isDirectory();
  } catch (error) {
    throw new LocalApiConfigurationError(
      `serve: database directory "${parentDir}" does not exist; refusing to create directories implicitly`,
      { cause: error }
    );
  }
  if (!parentIsDirectory) {
    throw new LocalApiConfigurationError(`serve: "${parentDir}" is not a directory`);
  }

  const db = openDatabase(options.db);
  // serve 是产品数据库的第一个初始化点:桌面壳(M8-03a)把本进程 spawn 到一个
  // 可能完全不存在的空库文件上,而下方每一个 /api 路由读取的表都由迁移链建立
  // ——v0.1.0 只调 openDatabase(PRAGMA,不建表),首启页面即报
  // `no such table: executions`。必须在启动 HTTP 服务之前把空库带到当前
  // schema(CONTROLLED_EXPANSION_MIGRATIONS,001..013+015+016+017;与
  // browser-e2e world.ts 的组合根用法一致)。
  //
  // 幂等语义:applyMigrations 逐版本先 INSERT schema_migrations(版本是
  // PRIMARY KEY,重复应用在 DDL 之前即被拒绝)再执行 DDL,pending 为空时
  // 提前返回——对已初始化的库重复调用是零迁移 no-op,因此每次 serve 启动
  // 都可以安全执行,无需(也不得)维护「是否已迁移」的进程外状态。
  //
  // `now` 取每次调用捕获一次的墙上时钟(框架默认值,此处显式写出):
  // 它只是 schema_migrations.applied_at 的记录性元数据,schema 结果与
  // 传固定值完全一致;world.ts 钉固定时间戳是 e2e 夹具确定性需求,产品
  // 入口如实记录迁移发生的时刻。
  try {
    await applyControlledExpansionMigrations(db, { now: new Date().toISOString() });
  } catch (error) {
    db.close(); // 迁移失败绝不泄漏 store 连接(与下方 server 启动失败同纪律)
    throw error;
  }
  let server: LocalApiServer;
  try {
    server = await startLocalApiServer({ db, port: options.port ?? 0 });
  } catch (error) {
    db.close(); // never leak the store when the server cannot start
    throw error;
  }

  // Diagnostic forwarding ONLY (module doc): emitted once, after listen.
  // Success downstream is judged by HTTP probing, never by this line.
  process.stdout.write(
    `${JSON.stringify({
      event: "listening",
      boundAddress: server.boundAddress,
      port: server.port,
      tokenFile: server.tokenFile
    })}\n`
  );

  // 幂等且单飞(single-flight)的 shutdown:同一时刻只有一条 in-flight
  // 关闭链,所有调用方(信号处理器、嵌入方、测试)拿到的是同一个 promise。
  // 不用「closed 布尔标志短路」:标志会让并发调用在关闭仍在途时得到一个
  // 已 resolve 的假完成(审查 minor 的根源)。
  let shutdownInFlight: Promise<void> | null = null;
  let exitChain: Promise<void> | null = null;
  const onSignal = (): void => {
    // 首个信号建立唯一的「shutdown 完成 → exit」链,.then(exit) 恰挂一次;
    // 后续信号看见退出链已存在即直接返回——否则第二个信号会在
    // server.close() 仍在途时提前 process.exit(0)(审查 minor:双重信号
    // 竞态)。硬杀(TerminateProcess)仍可绕过本路径(OS 回收,WAL 恢复)。
    exitChain ??= shutdown().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  const shutdown = (): Promise<void> => {
    shutdownInFlight ??= (async (): Promise<void> => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      await server.close();
      db.close();
    })();
    return shutdownInFlight;
  };

  // Best-effort signal shutdown: POSIX delivers both signals; Windows can
  // deliver SIGINT (console Ctrl+C) but has no real SIGTERM — the handlers
  // are registered anyway, and a hard kill (TerminateProcess) may always
  // bypass them: the OS reclaims the socket and the SQLite WAL recovers on
  // the next open. Exit on signal is explicit so a console Ctrl+C never
  // leaves a half-closed listener behind.
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return { server, db, shutdown };
}
